#!/usr/bin/env bash
set -euo pipefail

for lua_version in 5.1.5 5.4.8; do
  minor="${lua_version%.*}"
  LUA_PATH="./lib/?.lua;./hooks/?.lua;./tests/lua/?.lua;.rocks/${minor}/share/lua/${minor}/?.lua;.rocks/${minor}/share/lua/${minor}/?/init.lua;;" \
    mise exec "conda:lua@${lua_version}" -- ".rocks/${minor}/bin/busted" tests/lua
done

uv run pytest -q
