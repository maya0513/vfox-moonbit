#!/usr/bin/env bash
set -euo pipefail

bash scripts/test-lua.sh unit
pnpm vp test run
