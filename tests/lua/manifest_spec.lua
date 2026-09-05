local Manifest = require("moonbit_manifest")

local VERSION = "0.10.11+abc123"
local ENCODED = "0.10.11%2Babc123"

local function copy(value)
    if type(value) ~= "table" then
        return value
    end
    local result = {}
    for key, item in pairs(value) do
        result[key] = copy(item)
    end
    return result
end

local function artifact(format, kind, platform)
    local toolchain_filenames = {
        ["linux-x86_64"] = "moonbit-linux-x86_64.tar.gz",
        ["linux-aarch64"] = "moonbit-linux-aarch64.tar.gz",
        ["darwin-aarch64"] = "moonbit-darwin-aarch64.tar.gz",
        ["windows-x86_64"] = "moonbit-windows-x86_64.zip",
    }
    local extension = format == "zip" and "zip" or "tar.gz"
    local url
    if kind == "toolchain" then
        url = "https://cli.moonbitlang.com/binaries/" .. ENCODED .. "/" .. toolchain_filenames[platform]
    else
        url = "https://cli.moonbitlang.com/cores/core-" .. ENCODED .. "." .. extension
    end
    return {
        format = format,
        sha256 = string.rep("A", 64),
        url = url,
    }
end

local function exact_document()
    return {
        schema = 1,
        recipe = 1,
        version = VERSION,
        platforms = {
            ["linux-x86_64"] = {
                toolchain = artifact("tar.gz", "toolchain", "linux-x86_64"),
                core = artifact("tar.gz", "core", "linux-x86_64"),
            },
            ["linux-aarch64"] = {
                toolchain = artifact("tar.gz", "toolchain", "linux-aarch64"),
                core = artifact("tar.gz", "core", "linux-aarch64"),
            },
            ["darwin-aarch64"] = {
                toolchain = artifact("tar.gz", "toolchain", "darwin-aarch64"),
                core = artifact("tar.gz", "core", "darwin-aarch64"),
            },
            ["windows-x86_64"] = {
                toolchain = artifact("zip", "toolchain", "windows-x86_64"),
                core = artifact("zip", "core", "windows-x86_64"),
            },
        },
    }
end

local function latest_document()
    return {
        schema = 1,
        recipe = 1,
        version = VERSION,
        manifest = VERSION .. ".json",
    }
end

local function client(documents, overrides)
    overrides = overrides or {}
    local http = overrides.http
        or {
            get = function(options)
                if options.url:match("latest%.json$") then
                    return { status_code = 200, body = "latest" }, nil
                end
                return { status_code = 200, body = "exact" }, nil
            end,
        }
    local json = overrides.json
        or {
            decode = function(body)
                if body == "latest" then
                    return documents.latest
                end
                return documents.exact
            end,
        }
    return Manifest.new({ http = http, json = json, base_url = "https://metadata.test/releases" })
end

describe("MoonBit release manifest", function()
    it("accepts only strict pre-1.0 exact versions", function()
        assert.is_true(Manifest.is_exact_version("0.0.0+a"))
        assert.is_true(Manifest.is_exact_version("0.10.11+abc.DEF-1_2"))
        assert.is_false(Manifest.is_exact_version(nil))
        for _, invalid in ipairs({
            "latest",
            "1.0.0+a",
            "0.01.0+a",
            "0.1.01+a",
            "0.1",
            "0.1.0",
            "0.1.0+",
            "0.1.0+a/b",
        }) do
            assert.is_false(Manifest.is_exact_version(invalid))
        end
    end)

    it("encodes plus only after validating the version", function()
        assert.equals(ENCODED, Manifest.encode_version(VERSION))
        assert.has_error(function()
            Manifest.encode_version("latest")
        end)
    end)

    it("loads latest and a complete exact record", function()
        local documents = { latest = latest_document(), exact = exact_document() }
        local manifest = client(documents)
        assert.equals(VERSION, manifest:latest().version)
        local exact = manifest:exact(VERSION)
        assert.equals(string.rep("a", 64), exact.platforms["linux-x86_64"].toolchain.sha256)
        assert.equals(VERSION, manifest:resolve("latest"))
        assert.equals(VERSION, manifest:resolve(VERSION))
    end)

    it("rejects unsupported requests", function()
        local manifest = client({ latest = latest_document(), exact = exact_document() })
        for _, requested in ipairs({ "0.10", "0.10.11", "^0.10", "nightly", "dev" }) do
            assert.has_error(function()
                manifest:resolve(requested)
            end)
            assert.has_error(function()
                manifest:exact(requested)
            end)
        end
    end)

    it("reports transport, status, and JSON failures", function()
        local docs = { latest = latest_document(), exact = exact_document() }
        local request_error = client(docs, {
            http = {
                get = function()
                    return nil, "offline"
                end,
            },
        })
        assert.has_error(function()
            request_error:latest()
        end)

        local bad_status = client(docs, {
            http = {
                get = function()
                    return { status_code = 404, body = "" }, nil
                end,
            },
        })
        assert.has_error(function()
            bad_status:latest()
        end)

        local bad_json = client(docs, {
            json = {
                decode = function()
                    error("bad JSON")
                end,
            },
        })
        assert.has_error(function()
            bad_json:latest()
        end)
    end)

    it("validates common and pointer fields", function()
        local mutations = {
            function(document)
                document.schema = 2
            end,
            function(document)
                document.recipe = 2
            end,
            function(document)
                document.version = "1.0.0+a"
            end,
            function(document)
                document.manifest = "other.json"
            end,
        }
        for _, mutate in ipairs(mutations) do
            local latest = latest_document()
            mutate(latest)
            assert.has_error(function()
                client({ latest = latest, exact = exact_document() }):latest()
            end)
        end
    end)

    it("rejects an exact version mismatch and absent platform table", function()
        local mismatch = exact_document()
        mismatch.version = "0.10.12+different"
        assert.has_error(function()
            client({ latest = latest_document(), exact = mismatch }):exact(VERSION)
        end)
        local absent = exact_document()
        absent.platforms = nil
        assert.has_error(function()
            client({ latest = latest_document(), exact = absent }):exact(VERSION)
        end)
    end)

    it("validates every platform and artifact field", function()
        local mutations = {
            function(document)
                document.platforms["linux-x86_64"] = nil
            end,
            function(document)
                document.platforms["linux-x86_64"].core = nil
            end,
            function(document)
                document.platforms["linux-x86_64"].core.format = "7z"
            end,
            function(document)
                document.platforms["linux-x86_64"].core.sha256 = "bad"
            end,
            function(document)
                document.platforms["linux-x86_64"].core.url = "https://evil.test/core.tar.gz"
            end,
            function(document)
                document.platforms["linux-x86_64"].core.url = "https://cli.moonbitlang.com/cores/other/core.tar.gz"
            end,
            function(document)
                document.platforms["windows-x86_64"].core.format = "tar.gz"
            end,
            function(document)
                document.platforms["darwin-aarch64"].toolchain.format = "zip"
            end,
        }
        for _, mutate in ipairs(mutations) do
            local exact = copy(exact_document())
            mutate(exact)
            assert.has_error(function()
                client({ latest = latest_document(), exact = exact }):exact(VERSION)
            end)
        end
    end)
end)
