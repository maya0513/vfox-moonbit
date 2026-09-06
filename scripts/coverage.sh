#!/usr/bin/env bash
set -euo pipefail

rm -f luacov.stats.out luacov.report.out .coverage

minor=5.4
MOONBIT_COVERAGE=1 \
  LUA_PATH="./lib/?.lua;./hooks/?.lua;./tests/lua/?.lua;.rocks/${minor}/share/lua/${minor}/?.lua;.rocks/${minor}/share/lua/${minor}/?/init.lua;;" \
  mise exec conda:lua@5.4.8 -- ".rocks/${minor}/bin/busted" --coverage tests/lua
LUA_PATH=".rocks/${minor}/share/lua/${minor}/?.lua;.rocks/${minor}/share/lua/${minor}/?/init.lua;;" \
  mise exec conda:lua@5.4.8 -- ".rocks/${minor}/bin/luacov"
python scripts/check_lua_coverage.py --minimum 95

uv run pytest --cov=scripts --cov-branch --cov-report=term-missing --cov-fail-under=95
