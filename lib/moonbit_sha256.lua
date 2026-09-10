local M = {}

function M.default_module(loader)
    loader = loader or require
    local loaded = { pcall(loader, "sha2") }
    if loaded[1] then
        return loaded[2]
    end
    return loader("moonbit_sha256_portable")
end

function M.file(path, sha_module, opener, chunk_size)
    sha_module = sha_module or M.default_module()
    opener = opener or io.open
    chunk_size = chunk_size or 1024 * 1024

    local handle, open_error = opener(path, "rb")
    if not handle then
        error("cannot open file for SHA-256: " .. tostring(open_error or path))
    end

    local feed = sha_module.sha256()
    local ok, result = pcall(function()
        while true do
            local chunk = handle:read(chunk_size)
            if not chunk then
                break
            end
            feed(chunk)
        end
        return feed()
    end)
    handle:close()
    if not ok then
        error("failed to calculate SHA-256 for " .. path .. ": " .. tostring(result))
    end
    return result
end

return M
