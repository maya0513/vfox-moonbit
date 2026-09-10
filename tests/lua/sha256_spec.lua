local Sha256 = require("moonbit_sha256")
local portable = require("moonbit_sha256_portable")
local sha2 = require("sha2")

describe("vendored pure Lua SHA-256", function()
    it("matches NIST-known vectors and streaming input", function()
        assert.equals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", sha2.sha256(""))
        assert.equals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", sha2.sha256("abc"))
        local feed = sha2.sha256()
        feed("a")("b")("c")
        assert.equals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", feed())
        assert.equals(
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
            sha2.sha256(string.rep("a", 1000000))
        )
    end)

    it("uses the vendored module when the runtime can load it", function()
        local calls = {}
        local module = Sha256.default_module(function(name)
            calls[#calls + 1] = name
            return sha2
        end)
        assert.equals(sha2, module)
        assert.same({ "sha2" }, calls)
    end)

    it("falls back when the vendored runtime precision probe fails", function()
        local calls = {}
        local module = Sha256.default_module(function(name)
            calls[#calls + 1] = name
            if name == "sha2" then
                error("non-standard runtime")
            end
            return portable
        end)
        assert.equals(portable, module)
        assert.same({ "sha2", "moonbit_sha256_portable" }, calls)
    end)

    it("hashes files in bounded chunks", function()
        local path = os.tmpname()
        local handle = assert(io.open(path, "wb"))
        handle:write("abc")
        handle:close()
        assert.equals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            Sha256.file(path, sha2, io.open, 1)
        )
        os.remove(path)
    end)

    it("reports open and streaming failures and closes the handle", function()
        assert.has_error(function()
            Sha256.file("missing", sha2, function()
                return nil, "not found"
            end)
        end)
        local closed = false
        local fake = {
            read = function()
                error("corrupt file")
            end,
            close = function()
                closed = true
            end,
        }
        assert.has_error(function()
            Sha256.file("broken", sha2, function()
                return fake
            end)
        end)
        assert.is_true(closed)
    end)
end)

describe("portable SHA-256 fallback", function()
    it("matches known vectors and streaming input", function()
        assert.equals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", portable.sha256(""))
        assert.equals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", portable.sha256("abc"))
        local feed = portable.sha256()
        assert.equals(feed, feed("a"))
        feed("b")
        feed("c")
        assert.equals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", feed())
    end)

    if os.getenv("MOONBIT_COVERAGE") ~= "1" then
        it("matches the million-byte NIST vector outside line-tracing runs", function()
            assert.equals(
                "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
                portable.sha256(string.rep("a", 1000000))
            )
        end)
    end

    it("handles padding boundaries and rejects invalid feed use", function()
        local vectors = {
            [55] = "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318",
            [56] = "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a",
            [64] = "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb",
            [65] = "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0",
        }
        for length, expected in pairs(vectors) do
            assert.equals(expected, portable.sha256(string.rep("a", length)))
        end

        local feed = portable.sha256()
        assert.has_error(function()
            feed(42)
        end)
        feed("done")
        local digest = feed()
        assert.equals(digest, feed())
        assert.has_error(function()
            feed("late")
        end)
    end)
end)
