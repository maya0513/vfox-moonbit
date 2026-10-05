#!/usr/bin/env bash
set -euo pipefail

rm -f luacov.stats.out luacov.report.out

minor=5.1
MOONBIT_COVERAGE=1 \
  LUA_PATH="./lib/?.lua;./hooks/?.lua;./tests/lua/?.lua;.rocks/${minor}/share/lua/${minor}/?.lua;.rocks/${minor}/share/lua/${minor}/?/init.lua;;" \
  ".rocks/${minor}/bin/busted" --coverage tests/lua
LUA_PATH=".rocks/${minor}/share/lua/${minor}/?.lua;.rocks/${minor}/share/lua/${minor}/?/init.lua;;" \
  ".rocks/${minor}/bin/luacov"
node scripts/check_lua_coverage.ts --minimum 100

pnpm vp test run --coverage
