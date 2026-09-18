local Files = require("moonbit_files")
local Runtime = require("moonbit_runtime")

local M = {}
M.__index = M

local REQUIRED_EXECUTABLES = { "moon", "moonc", "moonfmt", "mooninfo", "moonrun", "moon-lsp", "moon-ide" }
local HELPER_EXECUTABLES = { "moon-lsp", "moon-ide" }

function M.new(dependencies)
    dependencies = dependencies or {}
    return setmetatable({
        runtime = dependencies.runtime or Runtime,
        opener = dependencies.opener or io.open,
        executor = dependencies.executor or os.execute,
        rename = dependencies.rename or os.rename,
        remove = dependencies.remove or os.remove,
        getenv = dependencies.getenv or os.getenv,
    }, M)
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
        local first, second, third = self.executor(self.runtime.checked_powershell_command(script))
        if not self.runtime.execute_succeeded(first, second, third) then
            local copied, copy_error = Files.copy(moon, moonx, self.opener)
            if not copied then
                error("cannot create moonx.exe: " .. tostring(copy_error))
            end
        end
        local matching, compare_error = Files.equal(moon, moonx, self.opener)
        if not matching then
            local detail = compare_error and ": " .. tostring(compare_error) or ""
            error("moonx.exe does not match moon.exe after link/copy" .. detail)
        end
    else
        self.runtime.run("ln -sfn moon " .. self.runtime.quote_unix(moonx), self.executor)
    end
end

function M:unix_helper(root, helper, os_name)
    local target = self.runtime.join(os_name, root, "bin", helper)
    local variables = table.concat({
        "MOON_TOOLCHAIN_ROOT=" .. self.runtime.quote_unix(root),
        "MOON_HOME=" .. self.runtime.quote_unix(root),
        "exec " .. self.runtime.quote_unix(target) .. ' "$@"',
    }, " ")
    return table.concat({ "#!/bin/sh", variables, "" }, "\n")
end

function M:windows_helper(helper)
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
        local content = os_name == "windows" and self:windows_helper(helper) or self:unix_helper(root, helper, os_name)
        local written, write_error = Files.write_all(temporary, content, self.opener)
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
                local command_parts =
                    { "&", self.runtime.quote_powershell(moon), "-C", self.runtime.quote_powershell(core) }
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
                local pieces = {
                    "MOON_TOOLCHAIN_ROOT=" .. self.runtime.quote_unix(root),
                    "MOON_HOME=" .. self.runtime.quote_unix(bundle_home),
                    "PATH=" .. self.runtime.quote_unix(bin .. ":" .. (self.getenv("PATH") or "")),
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

M.REQUIRED_EXECUTABLES = REQUIRED_EXECUTABLES
M.HELPER_EXECUTABLES = HELPER_EXECUTABLES

return M
