local M = {}

local FILE_CHUNK_SIZE = 1024 * 1024

function M.read_all(path, opener)
    local handle, open_error = opener(path, "rb")
    if not handle then
        return nil, open_error
    end
    local content = handle:read("*a")
    handle:close()
    return content
end

function M.write_all(path, content, opener)
    local handle, open_error = opener(path, "wb")
    if not handle then
        return nil, open_error
    end
    local ok, write_error = handle:write(content)
    local close_ok, close_error = handle:close()
    if not ok then
        return nil, write_error
    end
    if close_ok == nil then
        return nil, close_error
    end
    return true
end

function M.exists(path, opener)
    local handle = opener(path, "rb")
    if handle then
        handle:close()
        return true
    end
    return false
end

function M.moon_mod_version(path, opener)
    local content, read_error = M.read_all(path, opener)
    if not content then
        return nil, read_error
    end
    for line in content:gmatch("[^\r\n]+") do
        local version = line:match('^%s*version%s*=%s*"([^"]+)"%s*$')
        if version then
            return version
        end
    end
    return nil, "moon.mod does not contain a top-level version"
end

function M.copy(source, destination, opener)
    local input, input_error = opener(source, "rb")
    if not input then
        return nil, input_error
    end
    local output, output_error = opener(destination, "wb")
    if not output then
        input:close()
        return nil, output_error
    end
    while true do
        local chunk = input:read(FILE_CHUNK_SIZE)
        if not chunk then
            break
        end
        local ok, write_error = output:write(chunk)
        if not ok then
            input:close()
            output:close()
            return nil, write_error
        end
    end
    input:close()
    output:close()
    return true
end

function M.equal(source, destination, opener)
    local source_handle, source_error = opener(source, "rb")
    if not source_handle then
        return nil, source_error
    end
    local destination_handle, destination_error = opener(destination, "rb")
    if not destination_handle then
        source_handle:close()
        return nil, destination_error
    end
    while true do
        local source_chunk, source_read_error = source_handle:read(FILE_CHUNK_SIZE)
        local destination_chunk, destination_read_error = destination_handle:read(FILE_CHUNK_SIZE)
        if source_read_error or destination_read_error then
            source_handle:close()
            destination_handle:close()
            return nil, source_read_error or destination_read_error
        end
        if source_chunk ~= destination_chunk then
            source_handle:close()
            destination_handle:close()
            return false
        end
        if source_chunk == nil then
            source_handle:close()
            destination_handle:close()
            return true
        end
    end
end

return M
