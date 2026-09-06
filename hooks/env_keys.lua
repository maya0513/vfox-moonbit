function PLUGIN:EnvKeys(ctx)
    local Runtime = require("moonbit_runtime")
    local root = Runtime.get(ctx, "path")
    if type(root) ~= "string" or root == "" then
        root = Runtime.context(ctx)
    end
    local runtime = rawget(_G, "RUNTIME") or {}
    local os_name = Runtime.get(runtime, "osType", "os") or ""
    return {
        {
            key = "PATH",
            value = Runtime.join(os_name, root, "shims"),
        },
        {
            key = "PATH",
            value = Runtime.join(os_name, root, "bin"),
        },
        {
            key = "MOON_TOOLCHAIN_ROOT",
            value = root,
        },
    }
end
