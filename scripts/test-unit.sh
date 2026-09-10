#!/usr/bin/env bash
set -euo pipefail

lua_version=5.1.5
minor="${lua_version%.*}"
LUA_PATH="./lib/?.lua;./hooks/?.lua;./tests/lua/?.lua;.rocks/${minor}/share/lua/${minor}/?.lua;.rocks/${minor}/share/lua/${minor}/?/init.lua;;" \
  mise exec "conda:lua@${lua_version}" -- ".rocks/${minor}/bin/busted" tests/lua

uv run pytest -q
