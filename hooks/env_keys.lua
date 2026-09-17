function PLUGIN:EnvKeys(ctx)
    local Runtime = require("moonbit_runtime")
    local root = Runtime.get(ctx, "path")
    if type(root) ~= "string" or root == "" then
        root = Runtime.context(ctx)
    end
    local runtime = rawget(_G, "RUNTIME") or {}
    local os_name = Runtime.get(runtime, "osType", "os") or ""
    local shims = Runtime.join(os_name, root, "shims")
    local bin = Runtime.join(os_name, root, "bin")
    local result = {
        {
            key = "PATH",
            value = shims,
        },
        {
            key = "PATH",
            value = bin,
        },
        {
            key = "MOON_TOOLCHAIN_ROOT",
            value = root,
        },
    }

    if string.lower(os_name) == "windows" then
        result[#result + 1] = {
            key = "VFOX_MOONBIT_RUNTIME_DEBUG",
            value = table.concat({
                type(runtime),
                tostring(Runtime.get(runtime, "version")),
                os_name,
                tostring(Runtime.is_mise_vfox_runtime(runtime)),
            }, "|"),
        }
    end

    -- mise 2026.9.2's Windows vfox adapter does not surface the traditional
    -- PATH entries in its child environment. MISE_ADD_PATH is consumed by mise
    -- before spawning the child and is not returned by standalone vfox.
    if string.lower(os_name) == "windows" and Runtime.is_mise_vfox_runtime(runtime) then
        result[#result + 1] = {
            key = "MISE_ADD_PATH",
            value = shims .. ";" .. bin,
        }
    end

    return result
end
