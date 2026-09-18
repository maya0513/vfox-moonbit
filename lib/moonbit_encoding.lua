local M = {}

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

function M.utf8_to_utf16le(value)
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

function M.base64_encode(value)
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
    local encoded = M.base64_encode(M.utf8_to_utf16le(script))
    local prefix = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "
    return prefix .. encoded .. " <NUL"
end

function M.checked_powershell_command(script)
    return M.powershell_command("$ErrorActionPreference = 'Stop'; " .. script)
end

return M
