local Runtime = require("moonbit_runtime")
local Toolchain = require("moonbit_toolchain")

local VERSION = "0.10.11+abc123"
local roots = {}

local function write(path, content)
    local handle = assert(io.open(path, "wb"))
    assert(handle:write(content))
    assert(handle:close())
end

local function read(path)
    local handle = assert(io.open(path, "rb"))
    local content = assert(handle:read("*a"))
    assert(handle:close())
    return content
end

local function temp_root()
    local root = os.tmpname() .. " vfox-moonbit-toolchain-'test"
    os.remove(root)
    assert(Runtime.execute_succeeded(os.execute("mkdir -p -- " .. Runtime.quote_unix(root))))
    roots[#roots + 1] = root
    return root
end

local function mkdir(path)
    assert(Runtime.execute_succeeded(os.execute("mkdir -p -- " .. Runtime.quote_unix(path))))
end

local function unix_path_runtime()
    local runtime = {}
    for key, value in pairs(Runtime) do
        runtime[key] = value
    end
    runtime.join = function(_, ...)
        return Runtime.join("linux", ...)
    end
    return runtime
end

describe("MoonBit toolchain preparation", function()
    after_each(function()
        for _, root in ipairs(roots) do
            os.execute("rm -rf -- " .. Runtime.quote_unix(root))
        end
        roots = {}
    end)

    it("creates Windows helper shims without changing permissions", function()
        local root = temp_root()
        mkdir(root .. "/bin")
        for _, executable in ipairs(Toolchain.REQUIRED_EXECUTABLES) do
            write(root .. "/bin/" .. executable .. ".exe", executable)
        end

        local commands = {}
        local runtime = unix_path_runtime()
        runtime.make_dir = function(path)
            mkdir(path)
        end
        runtime.run = function(command)
            commands[#commands + 1] = command
        end
        local toolchain = Toolchain.new({ runtime = runtime })

        toolchain:validate_toolchain(root, "windows")
        toolchain:repair_permissions(root, "windows")
        toolchain:make_helper_shims(root, "windows")

        assert.equals(0, #commands)
        for _, helper in ipairs(Toolchain.HELPER_EXECUTABLES) do
            local shim = read(root .. "/shims/" .. helper .. ".cmd")
            assert.is_truthy(shim:find('set "MOON_TOOLCHAIN_ROOT=' .. root .. '"', 1, true))
            assert.is_truthy(shim:find('set "MOON_HOME=' .. root .. '"', 1, true))
            assert.is_truthy(shim:find(root .. "/bin/" .. helper .. '.exe" %*', 1, true))
            assert.is_nil(io.open(root .. "/shims/" .. helper .. ".cmd.part", "rb"))
        end
    end)

    it("reports helper-shim write and atomic-rename failures", function()
        local runtime = {
            join = function(_, ...)
                return (table.concat({ ... }, "/"):gsub("//+", "/"))
            end,
            make_dir = function() end,
            quote_unix = Runtime.quote_unix,
            run = function() end,
        }
        local write_removals = {}
        local cannot_write = Toolchain.new({
            runtime = runtime,
            opener = function()
                return nil, "read-only filesystem"
            end,
            remove = function(path)
                write_removals[#write_removals + 1] = path
            end,
        })
        assert.has_error(function()
            cannot_write:make_helper_shims("root", "linux")
        end)
        assert.same({ "root/shims/moon-lsp.part", "root/shims/moon-lsp.part" }, write_removals)

        local removed = {}
        local cannot_rename = Toolchain.new({
            runtime = runtime,
            opener = function()
                return {
                    write = function()
                        return true
                    end,
                    close = function()
                        return true
                    end,
                }
            end,
            remove = function(path)
                removed[#removed + 1] = path
            end,
            rename = function()
                return nil, "rename denied"
            end,
        })
        assert.has_error(function()
            cannot_rename:make_helper_shims("root", "linux")
        end)
        assert.equals(3, #removed)
        assert.equals(removed[1], removed[3])
    end)

    it("reports every helper-shim file IO failure", function()
        local value, reason = Toolchain.write_all("ignored", "content", function()
            return nil, "open denied"
        end)
        assert.is_nil(value)
        assert.equals("open denied", reason)

        value, reason = Toolchain.write_all("ignored", "content", function()
            return {
                write = function()
                    return nil, "disk full"
                end,
                close = function()
                    return true
                end,
            }
        end)
        assert.is_nil(value)
        assert.equals("disk full", reason)

        value, reason = Toolchain.write_all("ignored", "content", function()
            return {
                write = function()
                    return true
                end,
                close = function()
                    return nil, "close failed"
                end,
            }
        end)
        assert.is_nil(value)
        assert.equals("close failed", reason)
    end)

    it("cleans the temporary home when bundling or cleanup fails", function()
        local function runtime_with_cleanup(remove_tree)
            return {
                join = Runtime.join,
                quote_unix = Runtime.quote_unix,
                make_dir = function() end,
                remove_tree = remove_tree,
                run = function()
                    error("bundle command failed")
                end,
            }
        end

        local removals = 0
        local runtime = runtime_with_cleanup(function()
            removals = removals + 1
        end)
        local toolchain = Toolchain.new({
            runtime = runtime,
            getenv = function()
                return nil
            end,
        })
        assert.has_error(function()
            toolchain:bundle("/root", "linux")
        end)
        assert.equals(2, removals)

        removals = 0
        runtime = runtime_with_cleanup(function()
            removals = removals + 1
            if removals == 2 then
                error("cleanup failed")
            end
        end)
        runtime.run = function() end
        toolchain = Toolchain.new({ runtime = runtime })
        assert.has_error(function()
            toolchain:bundle("/root", "linux")
        end)
        assert.equals(2, removals)
    end)

    it("restores the previous core when preparation fails", function()
        local root = temp_root()
        local stage = root .. "/.vfox-moonbit-core-stage/core"
        local destination = root .. "/lib/core"
        local backup = root .. "/.vfox-moonbit-core-backup"
        mkdir(stage .. "/builtin")
        mkdir(destination)
        write(stage .. "/moon.mod", 'version = "' .. VERSION .. '"\n')
        write(stage .. "/builtin/moon.pkg", "builtin")
        write(destination .. "/moon.mod", 'version = "0.9.0+old"\n')

        local toolchain = Toolchain.new()
        toolchain.repair_permissions = function()
            error("prepare failed")
        end
        assert.has_error(function()
            toolchain:install_core_and_prepare(stage, destination, backup, root, VERSION, "linux")
        end)

        assert.is_truthy(read(destination .. "/moon.mod"):find("0.9.0+old", 1, true))
        assert.is_nil(io.open(backup .. "/moon.mod", "rb"))
        assert.is_nil(io.open(backup .. "-failed/moon.mod", "rb"))
    end)

    it("reports quarantine, restore, and compound rollback failures", function()
        local files = { ["/destination/moon.mod"] = true }
        local runtime = {
            join = function(_, ...)
                return (table.concat({ ... }, "/"):gsub("//+", "/"))
            end,
            remove_tree = function() end,
        }
        local opener = function(path)
            if not files[path] then
                return nil
            end
            return {
                close = function() end,
            }
        end
        local toolchain = Toolchain.new({
            runtime = runtime,
            opener = opener,
            rename = function()
                return nil, "quarantine denied"
            end,
        })
        assert.has_error(function()
            toolchain:rollback_core({
                backup = "/backup",
                destination = "/destination",
                failed = "/failed",
                had_destination = false,
                os_name = "linux",
            })
        end)

        local renames = 0
        toolchain = Toolchain.new({
            runtime = runtime,
            opener = opener,
            rename = function()
                renames = renames + 1
                if renames == 1 then
                    return true
                end
                return nil, "restore denied"
            end,
        })
        assert.has_error(function()
            toolchain:rollback_core({
                backup = "/backup",
                destination = "/destination",
                failed = "/failed",
                had_destination = true,
                os_name = "linux",
            })
        end)

        toolchain = Toolchain.new()
        toolchain.validate_core = function() end
        toolchain.promote_core = function()
            return {}
        end
        toolchain.repair_permissions = function()
            error("prepare failed")
        end
        toolchain.rollback_core = function()
            error("rollback failed")
        end
        local ok, message = pcall(function()
            toolchain:install_core_and_prepare("stage", "destination", "backup", "root", VERSION, "linux")
        end)
        assert.is_false(ok)
        assert.is_truthy(tostring(message):find("prepare failed", 1, true))
        assert.is_truthy(tostring(message):find("rollback failed", 1, true))
    end)
end)
