-- Portable SHA-256 fallback for Lua runtimes without standard multiple-assignment semantics.
--
-- The arithmetic bit-operation implementation is derived from pure_lua_SHA by
-- Egor Skriptunoff and is distributed under the MIT license reproduced in
-- THIRD_PARTY_NOTICES. The SHA-256 constants and algorithm are defined by FIPS 180-4.

local floor = math.floor
local byte = string.byte
local char = string.char
local format = string.format
local rep = string.rep
local sub = string.sub

local MODULO = 4294967296
local MAX_WORD = 4294967295

local ROUND_CONSTANTS = {
    0x428a2f98,
    0x71374491,
    0xb5c0fbcf,
    0xe9b5dba5,
    0x3956c25b,
    0x59f111f1,
    0x923f82a4,
    0xab1c5ed5,
    0xd807aa98,
    0x12835b01,
    0x243185be,
    0x550c7dc3,
    0x72be5d74,
    0x80deb1fe,
    0x9bdc06a7,
    0xc19bf174,
    0xe49b69c1,
    0xefbe4786,
    0x0fc19dc6,
    0x240ca1cc,
    0x2de92c6f,
    0x4a7484aa,
    0x5cb0a9dc,
    0x76f988da,
    0x983e5152,
    0xa831c66d,
    0xb00327c8,
    0xbf597fc7,
    0xc6e00bf3,
    0xd5a79147,
    0x06ca6351,
    0x14292967,
    0x27b70a85,
    0x2e1b2138,
    0x4d2c6dfc,
    0x53380d13,
    0x650a7354,
    0x766a0abb,
    0x81c2c92e,
    0x92722c85,
    0xa2bfe8a1,
    0xa81a664b,
    0xc24b8b70,
    0xc76c51a3,
    0xd192e819,
    0xd6990624,
    0xf40e3585,
    0x106aa070,
    0x19a4c116,
    0x1e376c08,
    0x2748774c,
    0x34b0bcb5,
    0x391c0cb3,
    0x4ed8aa4a,
    0x5b9cca4f,
    0x682e6ff3,
    0x748f82ee,
    0x78a5636f,
    0x84c87814,
    0x8cc70208,
    0x90befffa,
    0xa4506ceb,
    0xbef9a3f7,
    0xc67178f2,
}

local INITIAL_HASH = {
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
}

-- Lookup-table AND keeps the implementation compatible with Lua 5.1 and with
-- GopherLua, neither of which guarantees a native 32-bit bitwise library.
local AND_BYTES = { [0] = 0 }
local table_index = 0
for high = 0, 127 * 256, 256 do
    for source = high, high + 127 do
        local doubled = AND_BYTES[source] * 2
        AND_BYTES[table_index] = doubled
        AND_BYTES[table_index + 1] = doubled
        AND_BYTES[table_index + 256] = doubled
        AND_BYTES[table_index + 257] = doubled + 1
        table_index = table_index + 2
    end
    table_index = table_index + 256
end

local function band(left, right)
    local left_word = left % MODULO
    local right_word = right % MODULO
    local left_byte = left_word % 256
    local right_byte = right_word % 256
    local result = AND_BYTES[left_byte + right_byte * 256]

    left_word = left_word - left_byte
    right_word = (right_word - right_byte) / 256
    left_byte = left_word % 65536
    right_byte = right_word % 256
    result = result + AND_BYTES[left_byte + right_byte] * 256

    left_word = (left_word - left_byte) / 256
    right_word = (right_word - right_byte) / 256
    local combined = left_word % 65536 + right_word % 256
    result = result + AND_BYTES[combined] * 65536
    result = result + AND_BYTES[(left_word + right_word - combined) / 256] * 16777216
    return result
end

local function bxor(left, right)
    local left_word = left % MODULO
    local right_word = right % MODULO
    return left_word + right_word - 2 * band(left_word, right_word)
end

local function bxor3(first, second, third)
    return bxor(bxor(first, second), third)
end

local function rotate_right(word, count)
    local divisor = 2 ^ count
    local quotient = floor((word % MODULO) / divisor)
    local remainder = word % divisor
    return quotient + remainder * 2 ^ (32 - count)
end

local function shift_right(word, count)
    return floor((word % MODULO) / 2 ^ count)
end

local function compress(hash, block, offset)
    local words = {}
    local position = offset
    for index = 0, 15 do
        local first = byte(block, position)
        local second = byte(block, position + 1)
        local third = byte(block, position + 2)
        local fourth = byte(block, position + 3)
        words[index] = ((first * 256 + second) * 256 + third) * 256 + fourth
        position = position + 4
    end

    for index = 16, 63 do
        local older = words[index - 15]
        local newer = words[index - 2]
        local sigma_zero = bxor3(rotate_right(older, 7), rotate_right(older, 18), shift_right(older, 3))
        local sigma_one = bxor3(rotate_right(newer, 17), rotate_right(newer, 19), shift_right(newer, 10))
        words[index] = (words[index - 16] + sigma_zero + words[index - 7] + sigma_one) % MODULO
    end

    local a = hash[1]
    local b = hash[2]
    local c = hash[3]
    local d = hash[4]
    local e = hash[5]
    local f = hash[6]
    local g = hash[7]
    local h = hash[8]

    for index = 0, 63 do
        local upper_e = bxor3(rotate_right(e, 6), rotate_right(e, 11), rotate_right(e, 25))
        local choice = bxor(band(e, f), band(MAX_WORD - e, g))
        local temporary_one = (h + upper_e + choice + ROUND_CONSTANTS[index + 1] + words[index]) % MODULO
        local upper_a = bxor3(rotate_right(a, 2), rotate_right(a, 13), rotate_right(a, 22))
        local majority = bxor3(band(a, b), band(a, c), band(b, c))
        local temporary_two = (upper_a + majority) % MODULO

        h = g
        g = f
        f = e
        e = (d + temporary_one) % MODULO
        d = c
        c = b
        b = a
        a = (temporary_one + temporary_two) % MODULO
    end

    hash[1] = (hash[1] + a) % MODULO
    hash[2] = (hash[2] + b) % MODULO
    hash[3] = (hash[3] + c) % MODULO
    hash[4] = (hash[4] + d) % MODULO
    hash[5] = (hash[5] + e) % MODULO
    hash[6] = (hash[6] + f) % MODULO
    hash[7] = (hash[7] + g) % MODULO
    hash[8] = (hash[8] + h) % MODULO
end

local function compress_blocks(hash, data)
    for offset = 1, #data, 64 do
        compress(hash, data, offset)
    end
end

local function word_bytes(word)
    local first = floor(word / 16777216) % 256
    local second = floor(word / 65536) % 256
    local third = floor(word / 256) % 256
    local fourth = word % 256
    return char(first, second, third, fourth)
end

local HEX_BYTES = {}
for value = 0, 255 do
    HEX_BYTES[value] = format("%02x", value)
end

local function word_hex(word)
    local first = floor(word / 16777216) % 256
    local second = floor(word / 65536) % 256
    local third = floor(word / 256) % 256
    local fourth = word % 256
    return HEX_BYTES[first] .. HEX_BYTES[second] .. HEX_BYTES[third] .. HEX_BYTES[fourth]
end

local function new_feed()
    local hash = {}
    for index = 1, 8 do
        hash[index] = INITIAL_HASH[index]
    end

    local byte_length = 0
    local tail = ""
    local digest = nil

    local function feed(chunk)
        if chunk ~= nil then
            if digest then
                error("adding chunks after finalizing SHA-256 is not allowed", 2)
            end
            if type(chunk) ~= "string" then
                error("SHA-256 chunks must be strings", 2)
            end

            byte_length = byte_length + #chunk
            local pending = tail .. chunk
            local complete_length = #pending - (#pending % 64)
            if complete_length > 0 then
                compress_blocks(hash, sub(pending, 1, complete_length))
            end
            tail = sub(pending, complete_length + 1)
            return feed
        end

        if not digest then
            local zero_count = (56 - ((#tail + 1) % 64)) % 64
            local high_length = floor(byte_length / 536870912) % MODULO
            local low_length = (byte_length * 8) % MODULO
            local final_blocks = tail .. "\128"
            final_blocks = final_blocks .. rep("\0", zero_count)
            final_blocks = final_blocks .. word_bytes(high_length)
            final_blocks = final_blocks .. word_bytes(low_length)
            compress_blocks(hash, final_blocks)
            local parts = {}
            for index = 1, 8 do
                parts[index] = word_hex(hash[index])
            end
            digest = table.concat(parts)
            tail = nil
        end
        return digest
    end

    return feed
end

local M = {}

function M.sha256(message)
    local feed = new_feed()
    if message ~= nil then
        return feed(message)()
    end
    return feed
end

return M
