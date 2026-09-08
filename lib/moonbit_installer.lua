local Manifest = require("moonbit_manifest")
local Runtime = require("moonbit_runtime")
local Sha256 = require("moonbit_sha256")
local Toolchain = require("moonbit_toolchain")

local M = {}
M.__index = M

local function stringify_error(message)
    return tostring(message)
end

function M.new(dependencies)
    dependencies = dependencies or {}
    local runtime = dependencies.runtime or Runtime
    local toolchain = dependencies.toolchain
    if not toolchain then
        toolchain = Toolchain.new({
            runtime = runtime,
            sha_module = dependencies.sha_module,
            opener = dependencies.opener,
            executor = dependencies.executor,
            rename = dependencies.rename,
            remove = dependencies.remove,
            getenv = dependencies.getenv,
        })
    end
    return setmetatable({
        runtime = runtime,
        toolchain = toolchain,
        manifest = dependencies.manifest or Manifest.new(),
        http = dependencies.http or require("http"),
        archiver = dependencies.archiver,
        sha_module = dependencies.sha_module,
        opener = dependencies.opener or io.open,
        executor = dependencies.executor or os.execute,
        remove = dependencies.remove or os.remove,
    }, M)
end

-- Keep a small test seam at the installer boundary while toolchain mutation
-- itself lives in moonbit_toolchain.
function M:_required_toolchain(root, os_name)
    return self.toolchain:validate_toolchain(root, os_name)
end

function M:_staged_core(stage, os_name)
    return self.toolchain:staged_core(stage, os_name)
end

function M:_install_core(stage_core, destination, backup, _, os_name)
    local transaction = self.toolchain:promote_core(stage_core, destination, backup, os_name)
    return self.toolchain:commit_core(transaction)
end

function M:_make_moonx(root, os_name)
    return self.toolchain:make_moonx(root, os_name)
end

function M:_bundle(root, os_name)
    return self.toolchain:bundle(root, os_name)
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
    -- Keep the final archive suffix: mise and standalone vfox detect the format from the
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
    -- remain outside protected calls. Every reported failure is cleaned up.
    self.remove(archive)
    self.runtime.remove_tree(stage, os_name, self.executor)
    self.runtime.make_dir(stage, os_name, self.executor)

    print("vfox-moonbit: downloading matching core for " .. version)
    local download_error = self.http.download_file({ url = artifact.url, headers = {} }, archive)
    if download_error ~= nil then
        abort("failed to download the matching MoonBit core: " .. tostring(download_error))
    end

    print("vfox-moonbit: verifying core SHA-256")
    local hash_ok, actual = pcall(Sha256.file, archive, self.sha_module, self.opener)
    if not hash_ok then
        abort(actual)
    end
    if string.lower(actual) ~= artifact.sha256 then
        abort("MoonBit core SHA-256 mismatch; expected " .. artifact.sha256 .. ", got " .. tostring(actual))
    end

    local archive_module = self.runtime.archiver(self.archiver)
    print("vfox-moonbit: extracting verified core")
    local extract_error = archive_module.decompress(archive, stage)
    if extract_error ~= nil then
        abort("failed to extract the verified MoonBit core: " .. tostring(extract_error))
    end

    local ok, install_error = pcall(function()
        local stage_core = self:_staged_core(stage, os_name)
        print("vfox-moonbit: preparing core bundles")
        self.toolchain:install_core_and_prepare(stage_core, destination, backup, root, version, os_name)
    end)

    cleanup()
    if not ok then
        error(stringify_error(install_error), 0)
    end
end

M.copy_file = Toolchain.copy_file
M.moon_mod_version = Toolchain.moon_mod_version
M.stringify_error = stringify_error

return M
