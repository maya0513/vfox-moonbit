#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ( "${1:-}" != unit && "${1:-}" != coverage ) ]]; then
  echo "usage: bash scripts/test-lua.sh unit|coverage" >&2
  exit 2
fi

lua_version=5.1
rocks_root=".rocks/${lua_version}"
export LUA_PATH="./lib/?.lua;./hooks/?.lua;./tests/lua/?.lua;${rocks_root}/share/lua/${lua_version}/?.lua;${rocks_root}/share/lua/${lua_version}/?/init.lua;;"

if [[ "$1" == unit ]]; then
  "${rocks_root}/bin/busted" tests/lua
else
  rm -f luacov.stats.out luacov.report.out
  "${rocks_root}/bin/busted" --coverage --exclude-tags=large tests/lua
  "${rocks_root}/bin/luacov"
  node scripts/check_lua_coverage.ts --minimum 100
  "${rocks_root}/bin/busted" --tags=large tests/lua
fi
