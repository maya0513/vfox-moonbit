local Encoding = require("moonbit_encoding")

local M = {}

local function lower(value)
    return type(value) == "string" and string.lower(value) or ""
end

function M.execute_succeeded(first, _, third)
    if type(first) == "number" then
        return first == 0
    end
    if first == true then
        return third == nil or third == 0
    end
    return false
end

function M.quote_unix(value)
    value = tostring(value)
    if value:find("\0", 1, true) then
        error("a Unix command argument contains a forbidden NUL")
    end
    return "'" .. value:gsub("'", "'\\''") .. "'"
end

function M.quote_windows(value)
    value = tostring(value)
    if
        value:find("\r", 1, true)
        or value:find("\n", 1, true)
        or value:find("\0", 1, true)
        or value:find("%%")
        or value:find("!", 1, true)
    then
        error("a Windows command argument contains a forbidden control or cmd.exe expansion character")
    end
    return '"' .. value:gsub('"', '""') .. '"'
end

function M.quote_powershell(value)
    value = tostring(value)
    if value:find("\r", 1, true) or value:find("\n", 1, true) or value:find("\0", 1, true) then
        error("a PowerShell argument contains a forbidden control character")
    end
    return "'" .. value:gsub("'", "''") .. "'"
end

function M.run(command, executor)
    executor = executor or os.execute
    local first, second, third = executor(command)
    if not M.execute_succeeded(first, second, third) then
        error("command failed: " .. command)
    end
end

function M.command_exists(command, os_name, executor)
    local suffix = lower(os_name) == "windows" and " >NUL 2>&1" or " >/dev/null 2>&1"
    executor = executor or os.execute
    return M.execute_succeeded(executor(command .. " --version" .. suffix))
end

function M.remove_tree(path, os_name, executor)
    local normalized = tostring(path):gsub("\\", "/"):gsub("/+$", "")
    if normalized == "" or normalized == "/" or not normalized:match("/%.vfox%-moonbit%-") then
        error("refusing to remove an unsafe path: " .. tostring(path))
    end
    local command
    if lower(os_name) == "windows" then
        local literal = M.quote_powershell(path)
        command = Encoding.checked_powershell_command(
            "if (Test-Path -LiteralPath "
                .. literal
                .. ") { Remove-Item -LiteralPath "
                .. literal
                .. " -Recurse -Force }"
        )
    else
        command = "rm -rf -- " .. M.quote_unix(path)
    end
    M.run(command, executor)
end

function M.make_dir(path, os_name, executor)
    local command
    if lower(os_name) == "windows" then
        command = Encoding.checked_powershell_command(
            "[System.IO.Directory]::CreateDirectory(" .. M.quote_powershell(path) .. ") | Out-Null"
        )
    else
        command = "mkdir -p -- " .. M.quote_unix(path)
    end
    M.run(command, executor)
end

M.powershell_command = Encoding.powershell_command
M.checked_powershell_command = Encoding.checked_powershell_command

return M
