#!/usr/bin/env bash
set -euo pipefail

pnpm install --frozen-lockfile
bash scripts/lua-rocks.sh install
