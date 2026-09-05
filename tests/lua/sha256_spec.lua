local Sha256 = require("moonbit_sha256")
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
