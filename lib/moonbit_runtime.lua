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
    -- standalone vfox 0.4 passes rootPath as the version container and the
    -- actual main SDK root as sdkInfo.moonbit.path. mise currently uses the
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
        command = "if exist " .. M.quote_windows(path) .. " rmdir /S /Q " .. M.quote_windows(path)
    else
        command = "rm -rf -- " .. M.quote_unix(path)
    end
    M.run(command, executor)
end

function M.make_dir(path, os_name, executor)
    local command
    if lower(os_name) == "windows" then
        command = "if not exist " .. M.quote_windows(path) .. " mkdir " .. M.quote_windows(path)
    else
        command = "mkdir -p -- " .. M.quote_unix(path)
    end
    M.run(command, executor)
end

M.file_exists = file_exists

return M
