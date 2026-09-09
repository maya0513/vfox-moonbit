local Installer = require("moonbit_installer")
local Runtime = require("moonbit_runtime")
local Toolchain = require("moonbit_toolchain")
local sha2 = require("sha2")

local VERSION = "0.10.11+abc123"
local roots = {}

local function write(path, content)
    local handle = assert(io.open(path, "wb"))
    assert(handle:write(content))
    handle:close()
end

local function read(path)
    local handle = assert(io.open(path, "rb"))
    local content = handle:read("*a")
    handle:close()
    return content
end

local function temp_root()
    local root = os.tmpname() .. " vfox-moonbit-'test"
    os.remove(root)
    assert(Runtime.execute_succeeded(os.execute("mkdir -p -- " .. Runtime.quote_unix(root))))
    roots[#roots + 1] = root
    return root
end

local function make_toolchain(root, suffix)
    suffix = suffix or ""
    assert(Runtime.execute_succeeded(os.execute("mkdir -p -- " .. Runtime.quote_unix(root .. "/bin/internal"))))
    assert(Runtime.execute_succeeded(os.execute("mkdir -p -- " .. Runtime.quote_unix(root .. "/lib"))))
    for _, executable in ipairs({ "moon", "moonc", "moonfmt", "mooninfo", "moonrun", "moon-lsp", "moon-ide" }) do
        write(root .. "/bin/" .. executable .. suffix, executable)
    end
    write(root .. "/bin/internal/tcc", "tcc")
end

local function normal_executor(commands)
    return function(command)
        commands[#commands + 1] = command
        if command:match("^rm ") or command:match("^mkdir ") then
            return os.execute(command)
        end
        return 0
    end
end

local function dependencies(_root, overrides)
    overrides = overrides or {}
    local commands = overrides.commands or {}
    local archive_bytes = overrides.archive_bytes or "core archive"
    local core_version = overrides.core_version or VERSION
    local artifact = {
        format = overrides.format or "tar.gz",
        sha256 = overrides.sha256 or sha2.sha256(archive_bytes),
        url = "https://cli.moonbitlang.com/cores/core-" .. VERSION .. ".tar.gz",
    }
    local deps = {
        runtime = overrides.runtime or Runtime,
        manifest = overrides.manifest or {
            exact = function(_, requested)
                assert.equals(VERSION, requested)
                return { platforms = { ["linux-x86_64"] = { core = artifact } } }
            end,
        },
        http = overrides.http or {
            download_file = function(options, path)
                assert.equals(artifact.url, options.url)
                write(path, archive_bytes)
                return nil
            end,
        },
        archiver = overrides.archiver
            or {
                decompress = function(_, stage)
                    assert(
                        Runtime.execute_succeeded(
                            os.execute("mkdir -p -- " .. Runtime.quote_unix(stage .. "/core/builtin"))
                        )
                    )
                    write(stage .. "/core/moon.mod", 'name = "moonbitlang/core"\nversion = "' .. core_version .. '"\n')
                    write(stage .. "/core/builtin/moon.pkg", "builtin")
                    return nil
                end,
            },
        sha_module = overrides.sha_module or sha2,
        opener = overrides.opener or io.open,
        executor = overrides.executor or normal_executor(commands),
        rename = overrides.rename or os.rename,
        remove = overrides.remove or os.remove,
        getenv = overrides.getenv or function()
            return "/usr/bin:/bin"
        end,
    }
    return deps, commands, artifact
end

describe("MoonBit post-install", function()
    after_each(function()
        for _, root in ipairs(roots) do
            os.execute("rm -rf -- " .. Runtime.quote_unix(root))
        end
        roots = {}
    end)

    it("downloads, verifies, stages, validates, links, and bundles matching core", function()
        local root = temp_root()
        make_toolchain(root)
        local deps, commands = dependencies(root)
        Installer.new(deps):install({ rootPath = root, version = VERSION }, { osType = "Linux", archType = "amd64" })
        assert.is_truthy(read(root .. "/lib/core/moon.mod"):find('version = "' .. VERSION .. '"', 1, true))
        assert.is_nil(io.open(root .. "/.vfox-moonbit-core.part.tar.gz", "rb"))
        local joined = table.concat(commands, "\n")
        assert.matches("git %-%-version", joined)
        assert.matches("ln %-sfn moon", joined)
        assert.matches("bundle.-%-%-all", joined)
        assert.matches("%-%-target.-wasm%-gc.-%-%-quiet", joined)
        assert.matches("MOON_TOOLCHAIN_ROOT=", joined)
        assert.matches("MOON_HOME=.*%.vfox%-moonbit%-bundle%-home", joined)
        assert.matches("PATH=", joined)
        assert.is_truthy(read(root .. "/shims/moon-lsp"):find("MOON_HOME=", 1, true))
        assert.is_truthy(read(root .. "/shims/moon-ide"):find("MOON_TOOLCHAIN_ROOT=", 1, true))
        assert.is_nil(io.open(root .. "/.vfox-moonbit-bundle-home", "rb"))
        assert.is_nil(joined:match("chmod [^\n]* %-%- "))
    end)

    it("is idempotent when the same core already exists", function()
        local root = temp_root()
        make_toolchain(root)
        assert(Runtime.execute_succeeded(os.execute("mkdir -p -- " .. Runtime.quote_unix(root .. "/lib/core"))))
        write(root .. "/lib/core/moon.mod", 'version = "' .. VERSION .. '"\n')
        local deps = dependencies(root)
        Installer.new(deps):install({ rootPath = root, version = VERSION }, { osType = "Linux", archType = "amd64" })
        assert.equals(VERSION, Toolchain.moon_mod_version(root .. "/lib/core/moon.mod", io.open))
    end)

    it("replaces a mismatched existing core only after staging a verified one", function()
        local root = temp_root()
        make_toolchain(root)
        assert(Runtime.execute_succeeded(os.execute("mkdir -p -- " .. Runtime.quote_unix(root .. "/lib/core"))))
        write(root .. "/lib/core/moon.mod", 'version = "0.9.0+old"\n')
        local deps = dependencies(root)
        Installer.new(deps):install({ rootPath = root, version = VERSION }, { osType = "Linux", archType = "amd64" })
        assert.equals(VERSION, Toolchain.moon_mod_version(root .. "/lib/core/moon.mod", io.open))
        assert.is_nil(io.open(root .. "/.vfox-moonbit-core-backup/moon.mod", "rb"))
    end)

    it("allows the vfox HTTP client to yield under Lua 5.1", function()
        local root = temp_root()
        make_toolchain(root)
        local deps = dependencies(root, {
            http = {
                download_file = function(_, path)
                    coroutine.yield("downloading")
                    write(path, "core archive")
                end,
            },
        })
        local thread = coroutine.create(function()
            Installer.new(deps)
                :install({ rootPath = root, version = VERSION }, { osType = "Linux", archType = "amd64" })
        end)
        local resumed, value = coroutine.resume(thread)
        assert.is_true(resumed)
        assert.equals("downloading", value)
        resumed, value = coroutine.resume(thread)
        assert.is_true(resumed)
        assert.is_nil(value)
        assert.equals("dead", coroutine.status(thread))
    end)

    it("normalizes the root-stripping archiver used by standalone vfox", function()
        local root = temp_root()
        make_toolchain(root)
        local deps = dependencies(root, {
            archiver = {
                decompress = function(_, stage)
                    assert(
                        Runtime.execute_succeeded(os.execute("mkdir -p -- " .. Runtime.quote_unix(stage .. "/builtin")))
                    )
                    write(stage .. "/moon.mod", 'name = "moonbitlang/core"\nversion = "' .. VERSION .. '"\n')
                    write(stage .. "/builtin/moon.pkg", "builtin")
                end,
            },
        })
        Installer.new(deps):install({ rootPath = root, version = VERSION }, { osType = "Linux", archType = "amd64" })
        assert.equals(VERSION, Toolchain.moon_mod_version(root .. "/lib/core/moon.mod", io.open))
    end)

    it("rejects unresolved versions, missing Git, and incomplete toolchains", function()
        local root = temp_root()
        make_toolchain(root)
        local deps = dependencies(root)
        assert.has_error(function()
            Installer.new(deps)
                :install({ rootPath = root, version = "latest" }, { osType = "Linux", archType = "amd64" })
        end)

        deps = dependencies(root, {
            executor = function()
                return 1
            end,
        })
        assert.has_error(function()
            Installer.new(deps)
                :install({ rootPath = root, version = VERSION }, { osType = "Linux", archType = "amd64" })
        end)

        os.remove(root .. "/bin/moonc")
        deps = dependencies(root)
        assert.has_error(function()
            Installer.new(deps)
                :install({ rootPath = root, version = VERSION }, { osType = "Linux", archType = "amd64" })
        end)

        write(root .. "/bin/moonc", "moonc")
        os.remove(root .. "/bin/moon-ide")
        deps = dependencies(root)
        assert.has_error(function()
            Installer.new(deps)
                :install({ rootPath = root, version = VERSION }, { osType = "Linux", archType = "amd64" })
        end)

        write(root .. "/bin/moon-ide", "moon-ide")
        os.remove(root .. "/bin/internal/tcc")
        deps = dependencies(root)
        assert.has_error(function()
            Installer.new(deps)
                :install({ rootPath = root, version = VERSION }, { osType = "Linux", archType = "amd64" })
        end)
    end)

    it("rejects download, digest, extraction, and core-version failures with cleanup", function()
        local scenarios = {
            {
                http = {
                    download_file = function()
                        return "offline"
                    end,
                },
            },
            {
                sha_module = {
                    sha256 = function()
                        error("hash backend failed")
                    end,
                },
            },
            { sha256 = string.rep("0", 64) },
            {
                archiver = {
                    decompress = function()
                        return "corrupt"
                    end,
                },
            },
            { core_version = "0.10.12+wrong" },
            { core_version = false },
            { core_layout_missing = true },
            { core_missing = true },
        }
        for _, scenario in ipairs(scenarios) do
            local root = temp_root()
            make_toolchain(root)
            if scenario.core_version == false then
                scenario.archiver = {
                    decompress = function(_, stage)
                        assert(
                            Runtime.execute_succeeded(
                                os.execute("mkdir -p -- " .. Runtime.quote_unix(stage .. "/core"))
                            )
                        )
                        write(stage .. "/core/moon.mod", 'name = "moonbitlang/core"\n')
                    end,
                }
            elseif scenario.core_layout_missing then
                scenario.archiver = {
                    decompress = function(_, stage)
                        assert(
                            Runtime.execute_succeeded(
                                os.execute("mkdir -p -- " .. Runtime.quote_unix(stage .. "/core"))
                            )
                        )
                        write(stage .. "/core/moon.mod", 'version = "' .. VERSION .. '"\n')
                    end,
                }
            elseif scenario.core_missing then
                scenario.archiver = {
                    decompress = function()
                        return nil
                    end,
                }
            end
            local deps = dependencies(root, scenario)
            assert.has_error(function()
                Installer.new(deps)
                    :install({ rootPath = root, version = VERSION }, { osType = "Linux", archType = "amd64" })
            end)
            assert.is_nil(io.open(root .. "/.vfox-moonbit-core.part.tar.gz", "rb"))
        end
    end)

    it("rejects a checksum mismatch before invoking the archiver", function()
        local root = temp_root()
        make_toolchain(root)
        local extracted = false
        local deps = dependencies(root, {
            sha256 = string.rep("0", 64),
            archiver = {
                decompress = function()
                    extracted = true
                end,
            },
        })
        assert.has_error(function()
            Installer.new(deps)
                :install({ rootPath = root, version = VERSION }, { osType = "Linux", archType = "amd64" })
        end)
        assert.is_false(extracted)
    end)

    it("copies moonx.exe when a Windows hardlink is unavailable", function()
        local root = temp_root()
        make_toolchain(root, ".exe")
        local commands = {}
        local powershell_scripts = {}
        local windows_runtime = {}
        for key, value in pairs(Runtime) do
            windows_runtime[key] = value
        end
        windows_runtime.join = function(_, ...)
            return Runtime.join("Linux", ...)
        end
        windows_runtime.checked_powershell_command = function(script)
            powershell_scripts[#powershell_scripts + 1] = script
            return script
        end
        local deps = dependencies(root, {
            runtime = windows_runtime,
            commands = commands,
            getenv = function(name)
                assert.equals("PATH", name)
                return string.rep("long-parent-path;", 1000)
            end,
            executor = function(command)
                commands[#commands + 1] = command
                if command:match("^New%-Item") then
                    return false, "exit", 1
                end
                return 0
            end,
        })
        local installer = Installer.new(deps)
        installer.toolchain:make_moonx(root, "windows")
        assert.equals(read(root .. "/bin/moon.exe"), read(root .. "/bin/moonx.exe"))
        installer.toolchain:bundle(root, "windows")
        local joined = table.concat(commands, "\n")
        assert.matches("New%-Item %-ItemType HardLink", joined)
        assert.matches("%$env:MOON_TOOLCHAIN_ROOT =", joined)
        assert.matches("%$env:MOON_HOME =.*%.vfox%-moonbit%-bundle%-home", joined)
        assert.matches("%+ %$env:PATH", joined)
        local bundled = 0
        for _, script in ipairs(powershell_scripts) do
            if script:find("$env:MOON_TOOLCHAIN_ROOT", 1, true) then
                bundled = bundled + 1
                assert.is_true(#Runtime.checked_powershell_command(script) < 8191)
            end
        end
        assert.equals(2, bundled)
        assert.matches("wasm%-gc", joined)
    end)

    it("verifies the Windows hardlink result", function()
        local root = temp_root()
        make_toolchain(root, ".exe")
        local windows_runtime = {}
        for key, value in pairs(Runtime) do
            windows_runtime[key] = value
        end
        windows_runtime.join = function(_, ...)
            return Runtime.join("Linux", ...)
        end
        windows_runtime.checked_powershell_command = function(script)
            return script
        end
        local deps = dependencies(root, {
            runtime = windows_runtime,
            executor = function(command)
                if command:match("^New%-Item") then
                    write(root .. "/bin/moonx.exe", "tampered")
                end
                return 0
            end,
        })
        assert.has_error(function()
            Installer.new(deps).toolchain:make_moonx(root, "windows")
        end)
    end)

    it("handles copy-file IO failures", function()
        assert.is_nil(Toolchain.copy_file("a", "b", function()
            return nil, "source missing"
        end))

        local input_closed = false
        local input = {
            close = function()
                input_closed = true
            end,
        }
        local calls = 0
        assert.is_nil(Toolchain.copy_file("a", "b", function()
            calls = calls + 1
            if calls == 1 then
                return input
            end
            return nil, "destination denied"
        end))
        assert.is_true(input_closed)

        local closed = 0
        local source = {
            read = function(self)
                if self.done then
                    return nil
                end
                self.done = true
                return "chunk"
            end,
            close = function()
                closed = closed + 1
            end,
        }
        local output = {
            write = function()
                return nil, "disk full"
            end,
            close = function()
                closed = closed + 1
            end,
        }
        calls = 0
        assert.is_nil(Toolchain.copy_file("a", "b", function()
            calls = calls + 1
            return calls == 1 and source or output
        end))
        assert.equals(2, closed)
    end)

    it("parses moon.mod strictly and reports unreadable input", function()
        local root = temp_root()
        write(root .. "/moon.mod", 'name = "x"\n  version = "0.1.0+a"  \n')
        assert.equals("0.1.0+a", Toolchain.moon_mod_version(root .. "/moon.mod", io.open))
        write(root .. "/moon.mod", 'name = "x"\n')
        local version, reason = Toolchain.moon_mod_version(root .. "/moon.mod", io.open)
        assert.is_nil(version)
        assert.matches("top%-level", reason)
        assert.is_nil(Toolchain.moon_mod_version(root .. "/missing", io.open))
    end)

    it("restores an old core when the final rename fails", function()
        local files = { ["/dest/moon.mod"] = 'version = "old"' }
        local rename_calls = {}
        local fake_runtime = {
            join = function(_, ...)
                return (table.concat({ ... }, "/"):gsub("//+", "/"))
            end,
            remove_tree = function() end,
        }
        local opener = function(path)
            if not files[path] then
                return nil, "missing"
            end
            return {
                read = function()
                    return files[path]
                end,
                close = function() end,
            }
        end
        local installer = Installer.new({
            runtime = fake_runtime,
            manifest = {},
            http = {},
            opener = opener,
            rename = function(source, destination)
                rename_calls[#rename_calls + 1] = { source, destination }
                if source == "/dest" then
                    files["/dest/moon.mod"] = nil
                    files["/backup/moon.mod"] = 'version = "old"'
                    return true
                end
                if source == "/stage" then
                    return nil, "rename denied"
                end
                return true
            end,
        })
        assert.has_error(function()
            installer.toolchain:promote_core("/stage", "/dest", "/backup", "linux")
        end)
        assert.equals(3, #rename_calls)
    end)

    it("refuses to overwrite an existing core that cannot be staged", function()
        local fake_runtime = {
            join = function(_, ...)
                return (table.concat({ ... }, "/"):gsub("//+", "/"))
            end,
            remove_tree = function() end,
        }
        local opener = function(path)
            if path ~= "/dest/moon.mod" then
                return nil, "missing"
            end
            return {
                read = function()
                    return 'version = "old"'
                end,
                close = function() end,
            }
        end
        local installer = Installer.new({
            runtime = fake_runtime,
            manifest = {},
            http = {},
            opener = opener,
            rename = function()
                return nil, "permission denied"
            end,
        })
        assert.has_error(function()
            installer.toolchain:promote_core("/stage", "/dest", "/backup", "linux")
        end)
    end)

    it("reports a Windows moonx fallback-copy failure", function()
        local fake_runtime = {}
        for key, value in pairs(Runtime) do
            fake_runtime[key] = value
        end
        fake_runtime.join = function(_, ...)
            return (table.concat({ ... }, "/"):gsub("//+", "/"))
        end
        local installer = Installer.new({
            runtime = fake_runtime,
            manifest = {},
            http = {},
            opener = function()
                return nil, "missing moon.exe"
            end,
            executor = function()
                return false, "exit", 1
            end,
            remove = function() end,
        })
        assert.has_error(function()
            installer.toolchain:make_moonx("/root", "windows")
        end)
    end)
end)
