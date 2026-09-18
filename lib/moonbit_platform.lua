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
    for _, name in ipairs({ ... }) do
        local ok, value = pcall(function()
            return object[name]
        end)
        if ok and value ~= nil then
            return value
        end
    end
    return nil
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

M.file_exists = file_exists

return M
