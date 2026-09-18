local Encoding = require("moonbit_encoding")
local Platform = require("moonbit_platform")
local Process = require("moonbit_process")

local M = {}

for _, module in ipairs({ Encoding, Platform, Process }) do
    for name, value in pairs(module) do
        M[name] = value
    end
end

return M
