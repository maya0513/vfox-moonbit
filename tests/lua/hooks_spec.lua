local function load_hook(path)
    _G.PLUGIN = {}
    assert(loadfile(path))()
    return _G.PLUGIN
end

describe("vfox hooks", function()
    after_each(function()
        package.loaded.moonbit_manifest = nil
        package.loaded.moonbit_runtime = nil
        package.loaded.moonbit_installer = nil
        _G.PLUGIN = nil
        _G.RUNTIME = nil
    end)

    it("lists exactly one latest stable version", function()
        package.loaded.moonbit_manifest = {
            new = function()
                return {
                    latest = function()
                        return { version = "0.1.0+a" }
                    end,
                }
            end,
        }
        local result = load_hook("hooks/available.lua"):Available({})
        assert.equals(1, #result)
        assert.equals("0.1.0+a", result[1].version)
        assert.equals("latest stable", result[1].note)
    end)

    it("returns only the verified main toolchain from PreInstall", function()
        package.loaded.moonbit_manifest = {
            new = function()
                return {
                    resolve = function(_, requested)
                        assert.equals("latest", requested)
                        return "0.1.0+a"
                    end,
                    exact = function()
                        return {
                            platforms = {
                                ["linux-x86_64"] = {
                                    toolchain = { url = "https://cdn/tool.tar.gz", sha256 = string.rep("a", 64) },
                                },
                            },
                        }
                    end,
                }
            end,
        }
        package.loaded.moonbit_runtime = {
            platform = function()
                return "linux-x86_64"
            end,
        }
        _G.RUNTIME = { osType = "Linux", archType = "amd64" }
        local result = load_hook("hooks/pre_install.lua"):PreInstall({ version = "latest" })
        assert.equals("0.1.0+a", result.version)
        assert.equals("https://cdn/tool.tar.gz", result.url)
        assert.is_nil(result.addition)
    end)

    it("exports helper shims, binaries, and the immutable toolchain root", function()
        package.loaded.moonbit_runtime = {
            get = function(ctx, name)
                return ctx[name]
            end,
            join = function(_, root, leaf)
                return root .. "/" .. leaf
            end,
            context = function()
                return "/fallback", "0.1.0+a"
            end,
        }
        _G.RUNTIME = { osType = "Linux" }
        local plugin = load_hook("hooks/env_keys.lua")
        local direct = plugin:EnvKeys({ path = "/root" })
        assert.same({
            { key = "PATH", value = "/root/shims" },
            { key = "PATH", value = "/root/bin" },
            { key = "MOON_TOOLCHAIN_ROOT", value = "/root" },
        }, direct)
        assert.is_nil(direct.MOON_HOME)
        local fallback = plugin:EnvKeys({})
        assert.equals("/fallback", fallback[3].value)
    end)

    it("delegates PostInstall to the installer", function()
        local received
        package.loaded.moonbit_installer = {
            new = function()
                return {
                    install = function(_, ctx, runtime)
                        received = { ctx, runtime }
                    end,
                }
            end,
        }
        _G.RUNTIME = { osType = "Linux" }
        local context = { rootPath = "/root" }
        load_hook("hooks/post_install.lua"):PostInstall(context)
        assert.equals(context, received[1])
        assert.equals(_G.RUNTIME, received[2])
    end)
end)
