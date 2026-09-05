function PLUGIN:PostInstall(ctx)
    local Installer = require("moonbit_installer")
    Installer.new():install(ctx, rawget(_G, "RUNTIME"))
end
