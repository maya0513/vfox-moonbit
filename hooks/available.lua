function PLUGIN:Available(_)
    local manifest = require("moonbit_manifest").new()
    local latest = manifest:latest()
    return {
        {
            version = latest.version,
            note = "latest stable",
        },
    }
end
