local Runtime = require("moonbit_runtime")
local Files = require("moonbit_files")
local Core = require("moonbit_core")
local Prepare = require("moonbit_prepare")

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
local file_exists = Files.exists
local moon_mod_version = Files.moon_mod_version
local copy_file = Files.copy
local files_equal = Files.equal

function M.new(dependencies)
    dependencies = dependencies or {}
    local instance = {
        runtime = dependencies.runtime or Runtime,
        opener = dependencies.opener or io.open,
        executor = dependencies.executor or os.execute,
        rename = dependencies.rename or os.rename,
        remove = dependencies.remove or os.remove,
        getenv = dependencies.getenv or os.getenv,
    }
    instance.core = dependencies.core or Core.new(instance)
    instance.prepare = dependencies.prepare or Prepare.new(instance)
    return setmetatable(instance, M)
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
    return self.core:staged(stage, os_name)
end

function M:validate_core(stage_core, version, os_name)
    return self.core:validate(stage_core, version, os_name)
end

function M:promote_core(stage_core, destination, backup, os_name)
    return self.core:promote(stage_core, destination, backup, os_name)
end

function M:commit_core(transaction)
    return self.core:commit(transaction)
end

function M:rollback_core(transaction)
    return self.core:rollback(transaction)
end

function M:repair_permissions(root, os_name)
    return self.prepare:repair_permissions(root, os_name)
end

function M:make_moonx(root, os_name)
    return self.prepare:make_moonx(root, os_name)
end

function M:make_helper_shims(root, os_name)
    return self.prepare:make_helper_shims(root, os_name)
end

function M:bundle(root, os_name)
    return self.prepare:bundle(root, os_name)
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
M.read_all = Files.read_all
M.write_all = Files.write_all

return M
