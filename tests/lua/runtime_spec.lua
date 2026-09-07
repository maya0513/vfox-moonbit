local Runtime = require("moonbit_runtime")

describe("MoonBit runtime adapter", function()
    it("reads optional fields from strict runtime userdata adapters", function()
        local strict = setmetatable({ osType = "Linux", archType = "amd64" }, {
            __index = function(_, name)
                error("unknown field: " .. name)
            end,
        })
        assert.equals("linux-x86_64", Runtime.platform(strict, { alpine = false }))
        assert.equals("Linux", Runtime.get(strict, "missing", "osType"))
        assert.is_nil(Runtime.get(strict, "missing"))
        assert.is_nil(Runtime.get(nil, "missing"))

        local context = setmetatable({ rootPath = "/strict", version = "0.1.0+a" }, {
            __index = function(_, name)
                error("unknown field: " .. name)
            end,
        })
        assert.same({ "/strict", "0.1.0+a" }, { Runtime.context(context) })
    end)

    it("normalizes supported platform aliases", function()
        assert.equals("linux-x86_64", Runtime.platform({ osType = "Linux", archType = "amd64" }, { alpine = false }))
        assert.equals("linux-aarch64", Runtime.platform({ os = "linux", arch = "arm64" }, { alpine = false }))
        assert.equals("darwin-aarch64", Runtime.platform({ platform = "macos", arch = "aarch64" }))
        assert.equals("windows-x86_64", Runtime.platform({ osType = "win32", archType = "x64" }))
        assert.equals("linux-x86_64", Runtime.platform({ osType = "Linux", archType = "x86_64" }))
    end)

    it("rejects unsupported OS, CPU, libc, and emulation", function()
        local cases = {
            { { osType = "FreeBSD", archType = "amd64" }, {} },
            { { osType = "Linux", archType = "386" }, { alpine = false } },
            { { osType = "Darwin", archType = "amd64" }, {} },
            { { osType = "Windows", archType = "arm64" }, {} },
            { { osType = "Linux", archType = "amd64", libc = "musl" }, { alpine = false } },
            { { osType = "Linux", archType = "amd64" }, { alpine = true } },
        }
        for _, case in ipairs(cases) do
            assert.has_error(function()
                Runtime.platform(case[1], case[2])
            end)
        end
    end)

    it("normalizes Lua 5.1 and 5.4 os.execute results", function()
        assert.is_true(Runtime.execute_succeeded(0))
        assert.is_false(Runtime.execute_succeeded(256))
        assert.is_true(Runtime.execute_succeeded(true, "exit", 0))
        assert.is_false(Runtime.execute_succeeded(false, "exit", 1))
        assert.is_false(Runtime.execute_succeeded(nil, "signal", 9))
    end)

    it("quotes Unix and Windows arguments", function()
        assert.equals("'hello world'", Runtime.quote_unix("hello world"))
        assert.equals("'a'\\''b'", Runtime.quote_unix("a'b"))
        assert.equals('"a ""quote"""', Runtime.quote_windows('a "quote"'))
        assert.equals("'a''b'", Runtime.quote_powershell("a'b"))
        assert.has_error(function()
            Runtime.quote_windows("bad\nargument")
        end)
        assert.has_error(function()
            Runtime.quote_windows("%TEMP%")
        end)
        assert.has_error(function()
            Runtime.quote_windows("bang!")
        end)
        assert.has_error(function()
            Runtime.quote_unix("bad\0argument")
        end)
        assert.has_error(function()
            Runtime.quote_powershell("bad\nargument")
        end)
    end)

    it("builds quote-free PowerShell encoded commands for Windows", function()
        assert.equals("", Runtime.base64_encode(""))
        assert.equals("Zg==", Runtime.base64_encode("f"))
        assert.equals("Zm8=", Runtime.base64_encode("fo"))
        assert.equals("Zm9v", Runtime.base64_encode("foo"))
        assert.equals(
            string.char(0x41, 0, 0xe9, 0, 0x08, 0x67, 0x3d, 0xd8, 0, 0xde),
            Runtime.utf8_to_utf16le("Aé月😀")
        )
        assert.equals(
            "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand QQA=",
            Runtime.powershell_command("A")
        )
        assert.equals(
            Runtime.powershell_command("$ErrorActionPreference = 'Stop'; A"),
            Runtime.checked_powershell_command("A")
        )
        for _, invalid in ipairs({
            string.char(0xc0, 0x80),
            string.char(0xe2, 0x82),
            string.char(0xe0, 0x80, 0x80),
            string.char(0xed, 0xa0, 0x80),
            string.char(0xf4, 0x90, 0x80, 0x80),
        }) do
            assert.has_error(function()
                Runtime.utf8_to_utf16le(invalid)
            end)
        end
    end)

    it("joins paths with the host separator", function()
        assert.equals("/root/bin/moon", Runtime.join("Linux", "/root/", "/bin", "moon"))
        assert.equals("C:\\root\\bin\\moon.exe", Runtime.join("Windows", "C:\\root\\", "\\bin", "moon.exe"))
        assert.equals("/root", Runtime.join("Linux", "/root"))
    end)

    it("probes regular files without leaking a handle", function()
        local path = os.tmpname()
        local handle = assert(io.open(path, "wb"))
        handle:write("present")
        handle:close()
        assert.is_true(Runtime.file_exists(path))
        os.remove(path)
        assert.is_false(Runtime.file_exists(path))
    end)

    it("extracts context across vfox and mise shapes", function()
        assert.same({ "/root", "0.1.0+a" }, { Runtime.context({ rootPath = "/root", version = "0.1.0+a" }) })
        assert.same({ "/sdk", "0.2.0+b" }, {
            Runtime.context({
                rootPath = "/version-container",
                sdkInfo = { moonbit = { path = "/sdk", version = "0.2.0+b" } },
            }),
        })
        assert.same({ "/main", "0.3.0+c" }, { Runtime.context({ main = { path = "/main", version = "0.3.0+c" } }) })
        assert.has_error(function()
            Runtime.context({ version = "0.1.0+a" })
        end)
        assert.has_error(function()
            Runtime.context({ rootPath = "/root" })
        end)
    end)

    it("loads archive adapters and errors when absent", function()
        local custom = {}
        assert.equals(custom, Runtime.archiver(custom))
        package.loaded["vfox.archiver"] = nil
        package.loaded.archiver = nil
        package.preload["vfox.archiver"] = function()
            return { name = "vfox" }
        end
        assert.equals("vfox", Runtime.archiver().name)
        package.loaded["vfox.archiver"] = nil
        package.preload["vfox.archiver"] = function()
            error("missing")
        end
        package.preload.archiver = function()
            return { name = "legacy" }
        end
        assert.equals("legacy", Runtime.archiver().name)
        package.loaded.archiver = nil
        package.preload.archiver = function()
            error("missing")
        end
        assert.has_error(function()
            Runtime.archiver()
        end)
        package.preload["vfox.archiver"] = nil
        package.preload.archiver = nil
    end)

    it("runs commands and detects programs", function()
        Runtime.run("ok", function(command)
            assert.equals("ok", command)
            return true, "exit", 0
        end)
        assert.has_error(function()
            Runtime.run("bad", function()
                return false, "exit", 2
            end)
        end)
        assert.is_true(Runtime.command_exists("git", "Linux", function(command)
            assert.matches("git %-%-version >/dev/null 2>&1", command)
            return 0
        end))
        assert.is_true(Runtime.command_exists("git", "Windows", function(command)
            assert.matches(">NUL 2>&1", command)
            return true, "exit", 0
        end))
    end)

    it("guards cleanup paths and builds host commands", function()
        local commands = {}
        local execute = function(command)
            commands[#commands + 1] = command
            return 0
        end
        Runtime.remove_tree("/tmp/root/.vfox-moonbit-stage", "Linux", execute)
        Runtime.remove_tree("C:\\root\\.vfox-moonbit-stage", "Windows", execute)
        Runtime.make_dir("/tmp/a b", "Linux", execute)
        Runtime.make_dir("C:\\a b", "Windows", execute)
        assert.equals(4, #commands)
        assert.matches("rm %-rf", commands[1])
        assert.matches("powershell%.exe", commands[2])
        assert.matches("mkdir %-p", commands[3])
        assert.matches("powershell%.exe", commands[4])
        assert.is_nil(commands[2]:find('"', 1, true))
        assert.is_nil(commands[4]:find('"', 1, true))
        for _, unsafe in ipairs({ "", "/", "/tmp/core", ".vfox-moonbit-stage" }) do
            assert.has_error(function()
                Runtime.remove_tree(unsafe, "Linux", execute)
            end)
        end
    end)
end)
