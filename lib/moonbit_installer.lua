local Manifest = require("moonbit_manifest")
local Runtime = require("moonbit_runtime")
local Sha256 = require("moonbit_sha256")

local M = {}
M.__index = M

local function stringify_error(message)
    return tostring(message)
end

local function read_all(path, opener)
    local handle, open_error = opener(path, "rb")
    if not handle then
        return nil, open_error
    end
    local content = handle:read("*a")
    handle:close()
    return content
end

local function file_exists(path, opener)
    local handle = opener(path, "rb")
    if handle then
        handle:close()
        return true
    end
    return false
end

local function moon_mod_version(path, opener)
    local content, read_error = read_all(path, opener)
    if not content then
        return nil, read_error
    end
    for line in content:gmatch("[^\r\n]+") do
        local version = line:match('^%s*version%s*=%s*"([^"]+)"%s*$')
        if version then
            return version
        end
    end
    return nil, "moon.mod does not contain a top-level version"
end

local function copy_file(source, destination, opener)
    local input, input_error = opener(source, "rb")
    if not input then
        return nil, input_error
    end
    local output, output_error = opener(destination, "wb")
    if not output then
        input:close()
        return nil, output_error
    end
    while true do
        local chunk = input:read(1024 * 1024)
        if not chunk then
            break
        end
        local ok, write_error = output:write(chunk)
        if not ok then
            input:close()
            output:close()
            return nil, write_error
        end
    end
    input:close()
    output:close()
    return true
end

function M.new(dependencies)
    dependencies = dependencies or {}
    local instance = {
        runtime = dependencies.runtime or Runtime,
        manifest = dependencies.manifest or Manifest.new(),
        http = dependencies.http or require("http"),
        archiver = dependencies.archiver,
        sha_module = dependencies.sha_module,
        opener = dependencies.opener or io.open,
        executor = dependencies.executor or os.execute,
        rename = dependencies.rename or os.rename,
        remove = dependencies.remove or os.remove,
        getenv = dependencies.getenv or os.getenv,
    }
    return setmetatable(instance, M)
end

function M:_required_toolchain(root, os_name)
    local suffix = os_name == "windows" and ".exe" or ""
    local required = { "moon", "moonc", "moonfmt", "mooninfo", "moonrun", "moon-lsp" }
    for _, executable in ipairs(required) do
        local path = self.runtime.join(os_name, root, "bin", executable .. suffix)
        if not file_exists(path, self.opener) then
            error("official MoonBit toolchain is missing required executable: " .. path)
        end
    end
    if os_name ~= "windows" then
        local tcc = self.runtime.join(os_name, root, "bin", "internal", "tcc")
        if not file_exists(tcc, self.opener) then
            error("official MoonBit toolchain is missing required executable: " .. tcc)
        end
    end
end

function M:_staged_core(stage, os_name)
    -- Standalone vfox 0.4 strips an archive's single root directory while
    -- mise's vfox backend preserves it. The archive hash was already verified,
    -- so normalize only these two known extraction layouts.
    local nested = self.runtime.join(os_name, stage, "core")
    if file_exists(self.runtime.join(os_name, nested, "moon.mod"), self.opener) then
        return nested
    end
    if file_exists(self.runtime.join(os_name, stage, "moon.mod"), self.opener) then
        return stage
    end
    return nested
end

function M:_install_core(stage_core, destination, backup, version, os_name)
    local moon_mod = self.runtime.join(os_name, destination, "moon.mod")
    if file_exists(moon_mod, self.opener) then
        local installed_version = moon_mod_version(moon_mod, self.opener)
        if installed_version == version then
            self.runtime.remove_tree(stage_core, os_name, self.executor)
            return
        end
    end

    self.runtime.remove_tree(backup, os_name, self.executor)
    local had_destination, rename_error = self.rename(destination, backup)
    if not had_destination and file_exists(moon_mod, self.opener) then
        error("cannot stage the existing MoonBit core: " .. tostring(rename_error))
    end

    local installed, install_error = self.rename(stage_core, destination)
    if not installed then
        if had_destination then
            self.rename(backup, destination)
        end
        error("cannot move the verified MoonBit core into place: " .. tostring(install_error))
    end
    self.runtime.remove_tree(backup, os_name, self.executor)
end

function M:_make_moonx(root, os_name)
    local bin = self.runtime.join(os_name, root, "bin")
    local suffix = os_name == "windows" and ".exe" or ""
    local moon = self.runtime.join(os_name, bin, "moon" .. suffix)
    local moonx = self.runtime.join(os_name, bin, "moonx" .. suffix)
    self.remove(moonx)

    if os_name == "windows" then
        local command_parts = {
            "mklink /H",
            self.runtime.quote_windows(moonx),
            self.runtime.quote_windows(moon),
            ">NUL",
        }
        local command = table.concat(command_parts, " ")
        local first, second, third = self.executor(command)
        if not self.runtime.execute_succeeded(first, second, third) then
            local copied, copy_error = copy_file(moon, moonx, self.opener)
            if not copied then
                error("cannot create moonx.exe: " .. tostring(copy_error))
            end
        end
        local moon_hash = Sha256.file(moon, self.sha_module, self.opener)
        local moonx_hash = Sha256.file(moonx, self.sha_module, self.opener)
        if moon_hash ~= moonx_hash then
            error("moonx.exe does not match moon.exe after link/copy")
        end
    else
        local command = "ln -sfn moon " .. self.runtime.quote_unix(moonx)
        self.runtime.run(command, self.executor)
        self.runtime.run("chmod +x -- " .. self.runtime.quote_unix(bin) .. "/*", self.executor)
        local tcc = self.runtime.join(os_name, bin, "internal", "tcc")
        self.runtime.run("chmod -R +x -- " .. self.runtime.quote_unix(tcc), self.executor)
    end
end

function M:_bundle(root, os_name)
    local bin = self.runtime.join(os_name, root, "bin")
    local core = self.runtime.join(os_name, root, "lib", "core")
    local moon = self.runtime.join(os_name, bin, os_name == "windows" and "moon.exe" or "moon")
    local commands = {
        { "bundle", "--warn-list", "-a", "--all" },
        { "bundle", "--warn-list", "-a", "--target", "wasm-gc", "--quiet" },
    }

    for _, arguments in ipairs(commands) do
        local command
        if os_name == "windows" then
            local path = bin .. ";" .. (self.getenv("PATH") or "")
            local command_parts = { self.runtime.quote_windows(moon), "-C", self.runtime.quote_windows(core) }
            for _, argument in ipairs(arguments) do
                command_parts[#command_parts + 1] = argument
            end
            command = table.concat({
                "set " .. self.runtime.quote_windows("MOON_HOME=" .. root),
                "set " .. self.runtime.quote_windows("PATH=" .. path),
                table.concat(command_parts, " "),
            }, " && ")
        else
            local path = bin .. ":" .. (self.getenv("PATH") or "")
            local pieces = {
                "MOON_HOME=" .. self.runtime.quote_unix(root),
                "PATH=" .. self.runtime.quote_unix(path),
                self.runtime.quote_unix(moon),
                "-C",
                self.runtime.quote_unix(core),
            }
            for _, argument in ipairs(arguments) do
                pieces[#pieces + 1] = self.runtime.quote_unix(argument)
            end
            command = table.concat(pieces, " ")
        end
        self.runtime.run(command, self.executor)
    end
end

function M:install(ctx, runtime_global)
    local root, version = self.runtime.context(ctx)
    if not Manifest.is_exact_version(version) then
        error("PostInstall requires a resolved exact MoonBit version")
    end
    local platform, os_name = self.runtime.platform(runtime_global)
    if not self.runtime.command_exists("git", os_name, self.executor) then
        error("Git is required by MoonBit but was not found on PATH; install Git and retry the mise/vfox installation")
    end
    self:_required_toolchain(root, os_name)

    -- Refetch the immutable exact record. Never refetch latest here: latest may
    -- have advanced since PreInstall selected the toolchain.
    local document = self.manifest:exact(version)
    local artifact = document.platforms[platform].core
    local extension = artifact.format == "zip" and "zip" or "tar.gz"
    -- Keep the final archive suffix: mise/vfox 0.4 detects the format from the
    -- path, while the .part marker still makes incomplete files unambiguous.
    local archive = self.runtime.join(os_name, root, ".vfox-moonbit-core.part." .. extension)
    local stage = self.runtime.join(os_name, root, ".vfox-moonbit-core-stage")
    local destination = self.runtime.join(os_name, root, "lib", "core")
    local backup = self.runtime.join(os_name, root, ".vfox-moonbit-core-backup")

    local function cleanup()
        self.remove(archive)
        pcall(self.runtime.remove_tree, stage, os_name, self.executor)
    end

    local function abort(message)
        cleanup()
        error(tostring(message), 0)
    end

    -- vfox's HTTP implementation yields while downloading. Lua 5.1 cannot
    -- yield across pcall/xpcall, so network and archiver calls deliberately
    -- remain outside protected calls. Every reported failure is cleaned up
    -- explicitly instead.
    self.remove(archive)
    self.runtime.remove_tree(stage, os_name, self.executor)
    self.runtime.make_dir(stage, os_name, self.executor)

    local download_error = self.http.download_file({ url = artifact.url, headers = {} }, archive)
    if download_error ~= nil then
        abort("failed to download the matching MoonBit core: " .. tostring(download_error))
    end

    local hash_ok, actual = pcall(Sha256.file, archive, self.sha_module, self.opener)
    if not hash_ok then
        abort(actual)
    end
    if string.lower(actual) ~= artifact.sha256 then
        abort("MoonBit core SHA-256 mismatch; expected " .. artifact.sha256 .. ", got " .. tostring(actual))
    end

    local archive_module = self.runtime.archiver(self.archiver)
    local extract_error = archive_module.decompress(archive, stage)
    if extract_error ~= nil then
        abort("failed to extract the verified MoonBit core: " .. tostring(extract_error))
    end

    local ok, install_error = pcall(function()
        local stage_core = self:_staged_core(stage, os_name)
        local staged_version, version_error =
            moon_mod_version(self.runtime.join(os_name, stage_core, "moon.mod"), self.opener)
        if staged_version ~= version then
            error(
                "MoonBit core version mismatch: expected "
                    .. version
                    .. ", got "
                    .. tostring(staged_version or version_error)
            )
        end
        local builtin = self.runtime.join(os_name, stage_core, "builtin", "moon.pkg")
        if not file_exists(builtin, self.opener) then
            error("MoonBit core archive is missing required path: builtin/moon.pkg")
        end

        self:_install_core(stage_core, destination, backup, version, os_name)
        self:_make_moonx(root, os_name)
        self:_bundle(root, os_name)
    end)

    cleanup()
    if not ok then
        error(stringify_error(install_error), 0)
    end
end

M.moon_mod_version = moon_mod_version
M.copy_file = copy_file
M.stringify_error = stringify_error

return M
