local Files = require("moonbit_files")
local Runtime = require("moonbit_runtime")

local M = {}
M.__index = M

function M.new(dependencies)
    dependencies = dependencies or {}
    return setmetatable({
        runtime = dependencies.runtime or Runtime,
        opener = dependencies.opener or io.open,
        executor = dependencies.executor or os.execute,
        rename = dependencies.rename or os.rename,
    }, M)
end

function M:staged(stage, os_name)
    local nested = self.runtime.join(os_name, stage, "core")
    if Files.exists(self.runtime.join(os_name, nested, "moon.mod"), self.opener) then
        return nested
    end
    if Files.exists(self.runtime.join(os_name, stage, "moon.mod"), self.opener) then
        return stage
    end
    return nested
end

function M:validate(stage_core, version, os_name)
    local staged_version, version_error =
        Files.moon_mod_version(self.runtime.join(os_name, stage_core, "moon.mod"), self.opener)
    if staged_version ~= version then
        error(
            "MoonBit core version mismatch: expected "
                .. version
                .. ", got "
                .. tostring(staged_version or version_error)
        )
    end
    local builtin = self.runtime.join(os_name, stage_core, "builtin", "moon.pkg")
    if not Files.exists(builtin, self.opener) then
        error("MoonBit core archive is missing required path: builtin/moon.pkg")
    end
end

function M:promote(stage_core, destination, backup, os_name)
    local moon_mod = self.runtime.join(os_name, destination, "moon.mod")
    self.runtime.remove_tree(backup, os_name, self.executor)
    local had_destination = Files.exists(moon_mod, self.opener)
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

function M:commit(transaction)
    self.runtime.remove_tree(transaction.backup, transaction.os_name, self.executor)
end

function M:rollback(transaction)
    self.runtime.remove_tree(transaction.failed, transaction.os_name, self.executor)
    local moved, move_error = self.rename(transaction.destination, transaction.failed)
    local destination_remains = false
    if not moved then
        local moon_mod = self.runtime.join(transaction.os_name, transaction.destination, "moon.mod")
        destination_remains = Files.exists(moon_mod, self.opener)
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

return M
