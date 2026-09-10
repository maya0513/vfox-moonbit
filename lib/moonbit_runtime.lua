local M = {}

local function lower(value)
    if type(value) ~= "string" then
        return ""
    end
    return string.lower(value)
end

local function file_exists(path)
    local handle = io.open(path, "rb")
    if handle then
        handle:close()
        return true
    end
    return false
end

function M.get(object, ...)
    if object == nil then
        return nil
    end
    local names = { ... }
    for _, name in ipairs(names) do
        local ok, value = pcall(function()
            return object[name]
        end)
        if ok and value ~= nil then
            return value
        end
    end
    return nil
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

local function concat_in_chunks(parts)
    if #parts == 0 then
        return ""
    end
    local chunks = {}
    for first = 1, #parts, 128 do
        chunks[#chunks + 1] = table.concat(parts, "", first, math.min(first + 127, #parts))
    end
    if #chunks == 1 then
        return chunks[1]
    end
    return concat_in_chunks(chunks)
end

local function utf8_to_utf16le(value)
    local result = {}
    local index = 1
    while index <= #value do
        local first = string.byte(value, index)
        local codepoint
        local width
        if first < 0x80 then
            codepoint = first
            width = 1
        elseif first >= 0xc2 and first <= 0xdf then
            codepoint = first - 0xc0
            width = 2
        elseif first >= 0xe0 and first <= 0xef then
            codepoint = first - 0xe0
            width = 3
        elseif first >= 0xf0 and first <= 0xf4 then
            codepoint = first - 0xf0
            width = 4
        else
            error("cannot encode invalid UTF-8 for PowerShell", 2)
        end

        for offset = 2, width do
            local continuation = string.byte(value, index + offset - 1)
            if not continuation or continuation < 0x80 or continuation > 0xbf then
                error("cannot encode invalid UTF-8 for PowerShell", 2)
            end
            codepoint = codepoint * 64 + continuation - 0x80
        end
        if
            (width == 3 and codepoint < 0x800)
            or (width == 4 and codepoint < 0x10000)
            or (codepoint >= 0xd800 and codepoint <= 0xdfff)
            or codepoint > 0x10ffff
        then
            error("cannot encode invalid UTF-8 for PowerShell", 2)
        end

        if codepoint < 0x10000 then
            result[#result + 1] = string.char(codepoint % 256, math.floor(codepoint / 256))
        else
            local supplementary = codepoint - 0x10000
            local high = 0xd800 + math.floor(supplementary / 1024)
            local low = 0xdc00 + supplementary % 1024
            result[#result + 1] = string.char(high % 256, math.floor(high / 256), low % 256, math.floor(low / 256))
        end
        index = index + width
    end
    return concat_in_chunks(result)
end

local BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

local function base64_encode(value)
    local result = {}
    for index = 1, #value, 3 do
        local first = string.byte(value, index)
        local second = string.byte(value, index + 1)
        local third = string.byte(value, index + 2)
        local combined = first * 65536 + (second or 0) * 256 + (third or 0)
        result[#result + 1] =
            BASE64_ALPHABET:sub(math.floor(combined / 262144) % 64 + 1, math.floor(combined / 262144) % 64 + 1)
        result[#result + 1] =
            BASE64_ALPHABET:sub(math.floor(combined / 4096) % 64 + 1, math.floor(combined / 4096) % 64 + 1)
        result[#result + 1] = second
                and BASE64_ALPHABET:sub(math.floor(combined / 64) % 64 + 1, math.floor(combined / 64) % 64 + 1)
            or "="
        result[#result + 1] = third and BASE64_ALPHABET:sub(combined % 64 + 1, combined % 64 + 1) or "="
    end
    return concat_in_chunks(result)
end

function M.powershell_command(script)
    local encoded = base64_encode(utf8_to_utf16le(script))
    local prefix = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    return prefix .. encoded .. " <NUL"
end

function M.checked_powershell_command(script)
    return M.powershell_command("$ErrorActionPreference = 'Stop'; " .. script)
end

function M.separator(os_name)
    return lower(os_name) == "windows" and "\\" or "/"
end

function M.join(os_name, ...)
    local separator = M.separator(os_name)
    local parts = { ... }
    local result = tostring(parts[1] or "")
    for index = 2, #parts do
        local part = tostring(parts[index])
        result = result:gsub("[\\/]$", "")
        part = part:gsub("^[\\/]", "")
        result = result .. separator .. part
    end
    return result
end

function M.platform(runtime, probes)
    runtime = runtime or rawget(_G, "RUNTIME") or {}
    probes = probes or {}

    local os_name = lower(M.get(runtime, "osType", "os", "platform"))
    local arch = lower(M.get(runtime, "archType", "arch"))
    local normalized_os = ({
        linux = "linux",
        darwin = "darwin",
        macos = "darwin",
        windows = "windows",
        win32 = "windows",
    })[os_name]
    local normalized_arch = ({
        amd64 = "x86_64",
        x86_64 = "x86_64",
        x64 = "x86_64",
        arm64 = "aarch64",
        aarch64 = "aarch64",
    })[arch]

    if not normalized_os then
        error(
            "MoonBit is unsupported on operating system '"
                .. tostring(M.get(runtime, "osType", "os") or "unknown")
                .. "'"
        )
    end
    if not normalized_arch then
        error(
            "MoonBit is unsupported on architecture '"
                .. tostring(M.get(runtime, "archType", "arch") or "unknown")
                .. "'"
        )
    end

    if normalized_os == "darwin" and normalized_arch ~= "aarch64" then
        error("macOS Intel is not supported; this plugin supports Apple Silicon only")
    end
    if normalized_os == "windows" and normalized_arch ~= "x86_64" then
        error("Windows ARM64 emulation is intentionally unsupported; use Windows x86_64")
    end
    if normalized_os == "linux" then
        local libc = lower(M.get(runtime, "libcType", "libc"))
        local alpine = probes.alpine
        if alpine == nil then
            alpine = file_exists("/etc/alpine-release")
        end
        if alpine or libc == "musl" then
            error("musl/Alpine Linux is unsupported; MoonBit's official Linux archives require glibc")
        end
    end

    return normalized_os .. "-" .. normalized_arch, normalized_os
end

function M.context(ctx)
    ctx = ctx or {}
    local sdk_info = M.get(ctx, "sdkInfo") or {}
    local sdk = M.get(sdk_info, "moonbit") or M.get(ctx, "main") or {}
    -- standalone vfox passes rootPath as the version container and the actual
    -- main SDK root as sdkInfo.moonbit.path. mise currently uses the
    -- same path for both, so the more precise SDK path is safe to prefer.
    local root = M.get(sdk, "path") or M.get(ctx, "rootPath", "path", "install_path")
    local version = M.get(sdk, "version") or M.get(ctx, "version")
    if type(root) ~= "string" or root == "" then
        error("vfox did not provide the MoonBit installation root")
    end
    if type(version) ~= "string" or version == "" then
        error("vfox did not provide the resolved MoonBit version")
    end
    return root, version
end

function M.archiver(custom)
    if custom then
        return custom
    end
    local ok, module = pcall(require, "vfox.archiver")
    if ok then
        return module
    end
    ok, module = pcall(require, "archiver")
    if ok then
        return module
    end
    error("this vfox runtime does not provide an archive extraction module")
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
        command = M.checked_powershell_command(
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
        command = M.checked_powershell_command(
            "[System.IO.Directory]::CreateDirectory(" .. M.quote_powershell(path) .. ") | Out-Null"
        )
    else
        command = "mkdir -p -- " .. M.quote_unix(path)
    end
    M.run(command, executor)
end

M.file_exists = file_exists
M.base64_encode = base64_encode
M.utf8_to_utf16le = utf8_to_utf16le

return M
