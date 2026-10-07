#!/usr/bin/env bash
set -euo pipefail

bash scripts/test-lua.sh coverage
pnpm vp test run --coverage
