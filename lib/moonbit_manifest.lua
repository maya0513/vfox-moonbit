local config = require("moonbit_config")

local M = {}
M.__index = M

local required_platforms = {
    "linux-x86_64",
    "linux-aarch64",
    "darwin-aarch64",
    "windows-x86_64",
}

local toolchain_filenames = {
    ["linux-x86_64"] = "moonbit-linux-x86_64.tar.gz",
    ["linux-aarch64"] = "moonbit-linux-aarch64.tar.gz",
    ["darwin-aarch64"] = "moonbit-darwin-aarch64.tar.gz",
    ["windows-x86_64"] = "moonbit-windows-x86_64.zip",
}

local function is_uint(value)
    return value == "0" or (value and value:match("^[1-9]%d*$") ~= nil)
end

function M.is_exact_version(version)
    if type(version) ~= "string" then
        return false
    end
    local major, minor, patch, build = version:match("^(%d+)%.(%d+)%.(%d+)%+([%w][%w._%-]*)$")
    return major == "0" and is_uint(minor) and is_uint(patch) and build ~= nil
end

function M.encode_version(version)
    if not M.is_exact_version(version) then
        error("invalid MoonBit exact version: " .. tostring(version))
    end
    return (version:gsub("%%", "%%25"):gsub("%+", "%%2B"))
end

function M.new(dependencies)
    dependencies = dependencies or {}
    local instance = {
        http = dependencies.http or require("http"),
        json = dependencies.json or require("json"),
        base_url = dependencies.base_url or config.manifest_base,
    }
    return setmetatable(instance, M)
end

function M:_fetch(url)
    local response, request_error = self.http.get({
        url = url,
        headers = { Accept = "application/json" },
    })
    if request_error ~= nil then
        error("failed to fetch MoonBit release metadata from " .. url .. ": " .. tostring(request_error))
    end
    if not response or tonumber(response.status_code) ~= 200 then
        local status = response and response.status_code or "no response"
        error("MoonBit release metadata request returned " .. tostring(status) .. " for " .. url)
    end
    local ok, decoded = pcall(self.json.decode, response.body)
    if not ok or type(decoded) ~= "table" then
        error("invalid JSON in MoonBit release metadata from " .. url)
    end
    return decoded
end

local function validate_common(document)
    if document.schema ~= config.schema then
        error("unsupported MoonBit manifest schema: " .. tostring(document.schema))
    end
    if document.recipe ~= config.recipe then
        error("unsupported MoonBit installation recipe: " .. tostring(document.recipe))
    end
    if not M.is_exact_version(document.version) then
        error("manifest contains an invalid or non-pre-1.0 MoonBit version")
    end
end

local function validate_artifact(artifact, expected_url, label)
    if type(artifact) ~= "table" then
        error(label .. " artifact is missing")
    end
    if artifact.format ~= "tar.gz" and artifact.format ~= "zip" then
        error(label .. " has unsupported archive format")
    end
    if type(artifact.sha256) ~= "string" or not artifact.sha256:match("^[0-9a-fA-F]+$") or #artifact.sha256 ~= 64 then
        error(label .. " has an invalid SHA-256 digest")
    end
    if artifact.url ~= expected_url then
        error(label .. " does not use its canonical exact MoonBit CDN URL")
    end
    artifact.sha256 = string.lower(artifact.sha256)
end

function M:latest()
    local document = self:_fetch(self.base_url .. "/latest.json")
    validate_common(document)
    local expected = document.version .. ".json"
    if document.manifest ~= expected then
        error("latest manifest pointer is inconsistent with its version")
    end
    return document
end

function M:exact(version)
    if not M.is_exact_version(version) then
        error("MoonBit accepts only 'latest' or an exact 0.x.y+build-id version")
    end
    local document = self:_fetch(self.base_url .. "/" .. M.encode_version(version) .. ".json")
    validate_common(document)
    if document.version ~= version then
        error("exact MoonBit manifest version mismatch")
    end
    if type(document.platforms) ~= "table" then
        error("MoonBit manifest has no platform records")
    end
    for _, platform in ipairs(required_platforms) do
        local record = document.platforms[platform]
        if type(record) ~= "table" then
            error("MoonBit manifest is incomplete for " .. platform)
        end
        local encoded = M.encode_version(version)
        local toolchain_url = config.cdn_origin .. "binaries/" .. encoded .. "/" .. toolchain_filenames[platform]
        local core_extension = platform == "windows-x86_64" and "zip" or "tar.gz"
        local core_url = config.cdn_origin .. "cores/core-" .. encoded .. "." .. core_extension
        validate_artifact(record.toolchain, toolchain_url, platform .. " toolchain")
        validate_artifact(record.core, core_url, platform .. " core")
        if platform == "windows-x86_64" then
            if record.toolchain.format ~= "zip" or record.core.format ~= "zip" then
                error("Windows MoonBit artifacts must use zip")
            end
        elseif record.toolchain.format ~= "tar.gz" or record.core.format ~= "tar.gz" then
            error("Unix MoonBit artifacts must use tar.gz")
        end
    end
    return document
end

function M:resolve(requested)
    if requested == "latest" then
        return self:latest().version
    end
    if not M.is_exact_version(requested) then
        error(
            "MoonBit accepts only 'latest' or an exact 0.x.y+build-id version; "
                .. "ranges and partial versions are unsupported"
        )
    end
    return requested
end

return M
