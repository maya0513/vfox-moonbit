PLUGIN = {}

PLUGIN.name = "moonbit"
PLUGIN.version = "0.1.0"
PLUGIN.homepage = "https://github.com/maya0513/vfox-moonbit"
PLUGIN.license = "Apache-2.0"
PLUGIN.description = "Install the latest stable MoonBit toolchain with its matching core library."
PLUGIN.minRuntimeVersion = "1.0.12"
PLUGIN.manifestUrl = "https://github.com/maya0513/vfox-moonbit/releases/download/manifest/manifest.json"

-- MoonBit invokes Git for package and project operations. mise uses this
-- declaration to order a configured Git dependency; standalone vfox users are
-- also given an actionable error by PostInstall when Git is absent.
PLUGIN.depends = { "git" }
PLUGIN.systemDependencies = {
    { bin = "git" },
}

PLUGIN.notes = {
    "Only the latest stable pre-1.0 MoonBit release is listed.",
    "Use mise/vfox to upgrade; do not run `moon upgrade` inside this managed installation.",
}
PLUGIN.legacyFilenames = {}
