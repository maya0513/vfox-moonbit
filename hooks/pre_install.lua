function PLUGIN:PreInstall(ctx)
    local Manifest = require("moonbit_manifest")
    local Runtime = require("moonbit_runtime")
    local manifest = Manifest.new()
    local version = manifest:resolve(ctx.version)
    local document = manifest:exact(version)
    local platform = Runtime.platform(rawget(_G, "RUNTIME"))
    local artifact = document.platforms[platform].toolchain

    return {
        version = version,
        url = artifact.url,
        sha256 = artifact.sha256,
        note = "MoonBit " .. version .. " (official toolchain)",
    }
end
