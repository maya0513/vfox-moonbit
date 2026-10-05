#!/usr/bin/env bash
set -euo pipefail

minor=5.1
LUA_PATH="./lib/?.lua;./hooks/?.lua;./tests/lua/?.lua;.rocks/${minor}/share/lua/${minor}/?.lua;.rocks/${minor}/share/lua/${minor}/?/init.lua;;" \
  mise exec conda:lua -- ".rocks/${minor}/bin/busted" tests/lua

pnpm exec vp test run
