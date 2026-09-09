local Runtime = require("moonbit_runtime")

local M = {}
M.__index = M

local REQUIRED_EXECUTABLES = {
    "moon",
    "moonc",
    "moonfmt",
    "mooninfo",
    "moonrun",
    "moon-lsp",
    "moon-ide",
}

local HELPER_EXECUTABLES = { "moon-lsp", "moon-ide" }

local function read_all(path, opener)
    local handle, open_error = opener(path, "rb")
    if not handle then
        return nil, open_error
    end
    local content = handle:read("*a")
    handle:close()
    return content
end

local function write_all(path, content, opener)
    local handle, open_error = opener(path, "wb")
    if not handle then
        return nil, open_error
    end
    local ok, write_error = handle:write(content)
    local close_ok, close_error = handle:close()
    if not ok then
        return nil, write_error
    end
    if close_ok == nil then
        return nil, close_error
    end
    return true
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

local function files_equal(source, destination, opener)
    local source_handle, source_error = opener(source, "rb")
    if not source_handle then
        return nil, source_error
    end
    local destination_handle, destination_error = opener(destination, "rb")
    if not destination_handle then
        source_handle:close()
        return nil, destination_error
    end

    while true do
        local source_chunk, source_read_error = source_handle:read(1024 * 1024)
        local destination_chunk, destination_read_error = destination_handle:read(1024 * 1024)
        if source_read_error or destination_read_error then
            source_handle:close()
            destination_handle:close()
            return nil, source_read_error or destination_read_error
        end
        if source_chunk ~= destination_chunk then
            source_handle:close()
            destination_handle:close()
            return false
        end
        if source_chunk == nil then
            source_handle:close()
            destination_handle:close()
            return true
        end
    end
end

function M.new(dependencies)
    dependencies = dependencies or {}
    return setmetatable({
        runtime = dependencies.runtime or Runtime,
        sha_module = dependencies.sha_module,
        opener = dependencies.opener or io.open,
        executor = dependencies.executor or os.execute,
        rename = dependencies.rename or os.rename,
        remove = dependencies.remove or os.remove,
        getenv = dependencies.getenv or os.getenv,
    }, M)
end

function M:validate_toolchain(root, os_name)
    local suffix = os_name == "windows" and ".exe" or ""
    for _, executable in ipairs(REQUIRED_EXECUTABLES) do
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

function M:staged_core(stage, os_name)
    -- Standalone vfox may strip an archive's single root directory while mise's
    -- vfox backend preserves it. Normalize only these verified layouts.
    local nested = self.runtime.join(os_name, stage, "core")
    if file_exists(self.runtime.join(os_name, nested, "moon.mod"), self.opener) then
        return nested
    end
    if file_exists(self.runtime.join(os_name, stage, "moon.mod"), self.opener) then
        return stage
    end
    return nested
end

function M:validate_core(stage_core, version, os_name)
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
end

function M:promote_core(stage_core, destination, backup, os_name)
    local moon_mod = self.runtime.join(os_name, destination, "moon.mod")
    self.runtime.remove_tree(backup, os_name, self.executor)

    local had_destination = file_exists(moon_mod, self.opener)
    if had_destination then
        local moved, move_error = self.rename(destination, backup)
        if not moved then
            error("cannot stage the existing MoonBit core: " .. tostring(move_error))
        end
    end

    local installed, install_error = self.rename(stage_core, destination)
    if not installed then
        if had_destination then
            self.rename(backup, destination)
        end
        error("cannot move the verified MoonBit core into place: " .. tostring(install_error))
    end

    return {
        backup = backup,
        destination = destination,
        failed = backup .. "-failed",
        had_destination = had_destination,
        os_name = os_name,
    }
end

function M:commit_core(transaction)
    self.runtime.remove_tree(transaction.backup, transaction.os_name, self.executor)
end

function M:rollback_core(transaction)
    self.runtime.remove_tree(transaction.failed, transaction.os_name, self.executor)
    local moved, move_error = self.rename(transaction.destination, transaction.failed)
    local destination_remains = false
    if not moved then
        local moon_mod = self.runtime.join(transaction.os_name, transaction.destination, "moon.mod")
        destination_remains = file_exists(moon_mod, self.opener)
    end
    if destination_remains then
        error("cannot quarantine the failed MoonBit core: " .. tostring(move_error))
    end
    if transaction.had_destination then
        local restored, restore_error = self.rename(transaction.backup, transaction.destination)
        if not restored then
            error("cannot restore the previous MoonBit core: " .. tostring(restore_error))
        end
    end
    if moved then
        self.runtime.remove_tree(transaction.failed, transaction.os_name, self.executor)
    end
end

function M:repair_permissions(root, os_name)
    if os_name == "windows" then
        return
    end
    local bin = self.runtime.join(os_name, root, "bin")
    for _, executable in ipairs(REQUIRED_EXECUTABLES) do
        local path = self.runtime.join(os_name, bin, executable)
        self.runtime.run("chmod +x " .. self.runtime.quote_unix(path), self.executor)
    end
    local tcc = self.runtime.join(os_name, bin, "internal", "tcc")
    self.runtime.run("chmod +x " .. self.runtime.quote_unix(tcc), self.executor)
end

function M:make_moonx(root, os_name)
    local bin = self.runtime.join(os_name, root, "bin")
    local suffix = os_name == "windows" and ".exe" or ""
    local moon = self.runtime.join(os_name, bin, "moon" .. suffix)
    local moonx = self.runtime.join(os_name, bin, "moonx" .. suffix)
    self.remove(moonx)

    if os_name == "windows" then
        local script = "New-Item -ItemType HardLink -Path " .. self.runtime.quote_powershell(moonx)
        script = script .. " -Target " .. self.runtime.quote_powershell(moon)
        script = script .. " | Out-Null"
        local command = self.runtime.checked_powershell_command(script)
        local first, second, third = self.executor(command)
        if not self.runtime.execute_succeeded(first, second, third) then
            local copied, copy_error = copy_file(moon, moonx, self.opener)
            if not copied then
                error("cannot create moonx.exe: " .. tostring(copy_error))
            end
        end
        local matching, compare_error = files_equal(moon, moonx, self.opener)
        if not matching then
            local detail = compare_error and ": " .. tostring(compare_error) or ""
            error("moonx.exe does not match moon.exe after link/copy" .. detail)
        end
    else
        self.runtime.run("ln -sfn moon " .. self.runtime.quote_unix(moonx), self.executor)
    end
end

function M:_unix_helper(root, helper, os_name)
    local target = self.runtime.join(os_name, root, "bin", helper)
    local toolchain_root = "MOON_TOOLCHAIN_ROOT=" .. self.runtime.quote_unix(root)
    local helper_home = "MOON_HOME=" .. self.runtime.quote_unix(root)
    local executable = "exec " .. self.runtime.quote_unix(target) .. ' "$@"'
    return table.concat({
        "#!/bin/sh",
        table.concat({ toolchain_root, helper_home, executable }, " "),
        "",
    }, "\n")
end

function M:_windows_helper(helper)
    return table.concat({
        "@echo off",
        'for %%I in ("%~dp0..") do set "MOON_TOOLCHAIN_ROOT=%%~fI"',
        'set "MOON_HOME=%MOON_TOOLCHAIN_ROOT%"',
        '"%MOON_TOOLCHAIN_ROOT%\\bin\\' .. helper .. '.exe" %*',
        "",
    }, "\r\n")
end

function M:make_helper_shims(root, os_name)
    local shims = self.runtime.join(os_name, root, "shims")
    self.runtime.make_dir(shims, os_name, self.executor)
    for _, helper in ipairs(HELPER_EXECUTABLES) do
        local extension = os_name == "windows" and ".cmd" or ""
        local shim = self.runtime.join(os_name, shims, helper .. extension)
        local temporary = shim .. ".part"
        self.remove(temporary)
        local content = os_name == "windows" and self:_windows_helper(helper)
            or self:_unix_helper(root, helper, os_name)
        local written, write_error = write_all(temporary, content, self.opener)
        if not written then
            self.remove(temporary)
            error("cannot write MoonBit helper shim: " .. tostring(write_error))
        end
        self.remove(shim)
        local installed, install_error = self.rename(temporary, shim)
        if not installed then
            self.remove(temporary)
            error("cannot install MoonBit helper shim: " .. tostring(install_error))
        end
        if os_name ~= "windows" then
            self.runtime.run("chmod +x " .. self.runtime.quote_unix(shim), self.executor)
        end
    end
end

function M:bundle(root, os_name)
    local bin = self.runtime.join(os_name, root, "bin")
    local core = self.runtime.join(os_name, root, "lib", "core")
    local bundle_home = self.runtime.join(os_name, root, ".vfox-moonbit-bundle-home")
    local moon = self.runtime.join(os_name, bin, os_name == "windows" and "moon.exe" or "moon")
    local commands = {
        { "bundle", "--warn-list", "-a", "--all" },
        { "bundle", "--warn-list", "-a", "--target", "wasm-gc", "--quiet" },
    }

    self.runtime.remove_tree(bundle_home, os_name, self.executor)
    self.runtime.make_dir(bundle_home, os_name, self.executor)
    local ok, bundle_error = pcall(function()
        for _, arguments in ipairs(commands) do
            local description = "moon " .. table.concat(arguments, " ")
            print("vfox-moonbit: " .. description)
            local command
            if os_name == "windows" then
                local command_parts = {
                    "&",
                    self.runtime.quote_powershell(moon),
                    "-C",
                    self.runtime.quote_powershell(core),
                }
                for _, argument in ipairs(arguments) do
                    command_parts[#command_parts + 1] = self.runtime.quote_powershell(argument)
                end
                local script = table.concat({
                    "$env:MOON_TOOLCHAIN_ROOT = " .. self.runtime.quote_powershell(root),
                    "$env:MOON_HOME = " .. self.runtime.quote_powershell(bundle_home),
                    "$env:PATH = " .. self.runtime.quote_powershell(bin .. ";") .. " + $env:PATH",
                    table.concat(command_parts, " "),
                    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
                }, "; ")
                command = self.runtime.checked_powershell_command(script)
            else
                local path = bin .. ":" .. (self.getenv("PATH") or "")
                local pieces = {
                    "MOON_TOOLCHAIN_ROOT=" .. self.runtime.quote_unix(root),
                    "MOON_HOME=" .. self.runtime.quote_unix(bundle_home),
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
            print("vfox-moonbit: completed " .. description)
        end
    end)
    local cleanup_ok, cleanup_error = pcall(self.runtime.remove_tree, bundle_home, os_name, self.executor)
    if not ok then
        error(tostring(bundle_error), 0)
    end
    if not cleanup_ok then
        error(tostring(cleanup_error), 0)
    end
end

function M:install_core_and_prepare(stage_core, destination, backup, root, version, os_name)
    self:validate_core(stage_core, version, os_name)
    local transaction = self:promote_core(stage_core, destination, backup, os_name)
    local ok, prepare_error = pcall(function()
        self:repair_permissions(root, os_name)
        self:bundle(root, os_name)
        print("vfox-moonbit: creating moonx")
        self:make_moonx(root, os_name)
        print("vfox-moonbit: creating helper shims")
        self:make_helper_shims(root, os_name)
    end)
    if not ok then
        local rollback_ok, rollback_error = pcall(function()
            self:rollback_core(transaction)
        end)
        if not rollback_ok then
            error(tostring(prepare_error) .. "; rollback failed: " .. tostring(rollback_error), 0)
        end
        error(tostring(prepare_error), 0)
    end
    self:commit_core(transaction)
end

M.REQUIRED_EXECUTABLES = REQUIRED_EXECUTABLES
M.HELPER_EXECUTABLES = HELPER_EXECUTABLES
M.copy_file = copy_file
M.file_exists = file_exists
M.files_equal = files_equal
M.moon_mod_version = moon_mod_version
M.read_all = read_all
M.write_all = write_all

return M
