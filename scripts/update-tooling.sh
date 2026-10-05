#!/usr/bin/env bash
set -euo pipefail

mise lock --bump --platform linux-x64,linux-arm64 conda:gcc conda:lua conda:luarocks
mise lock --bump --platform linux-x64,linux-arm64,macos-arm64,windows-x64 \
  actionlint node pnpm shellcheck stylua vfox zizmor
mise install --locked node pnpm
# Use the refreshed lock's tools even when this task started with older tools.
node_bin="$(dirname "$(mise which node)")"
pnpm_bin="$(dirname "$(mise which pnpm)")"
export PATH="${node_bin}:${pnpm_bin}:$PATH"
pnpm_range="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).devEngines.packageManager.version')"
pnpm self-update --yes "$pnpm_range"
# self-update narrows the package-manager range; retain the declared policy.
PNPM_RANGE="$pnpm_range" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const path = 'package.json';
const document = JSON.parse(readFileSync(path, 'utf8'));
document.devEngines.packageManager.version = process.env.PNPM_RANGE;
delete document.packageManager;
writeFileSync(path, JSON.stringify(document, null, 2) + '\n');
NODE
pnpm update --no-save

# Vite+ ships a specific Vite core and Vitest runner. Update their overrides
# and coverage provider together instead of independently upgrading the runner.
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const tooling = JSON.parse(readFileSync('node_modules/vite-plus/package.json', 'utf8'));
const vitest = tooling.dependencies.vitest;
const vite = tooling.dependencies.vite;
if (!/^5\.\d+\.\d+$/.test(vitest) || !/^npm:@voidzero-dev\/vite-plus-core@1\.\d+\.\d+$/.test(vite)) {
  throw new Error('Vite+ changed its toolchain majors; review compatibility before updating');
}

const packagePath = 'package.json';
const document = JSON.parse(readFileSync(packagePath, 'utf8'));
document.devDependencies['@vitest/coverage-v8'] = vitest;
writeFileSync(packagePath, JSON.stringify(document, null, 2) + '\n');

const workspacePath = 'pnpm-workspace.yaml';
const workspace = readFileSync(workspacePath, 'utf8');
const corePattern = /^  'vite@\*': '[^']+'$/m;
const testPattern = /^  'vitest@\*': '[^']+'$/m;
if (!corePattern.test(workspace) || !testPattern.test(workspace)) {
  throw new Error('Vite/Vitest override declarations are missing');
}
writeFileSync(workspacePath, workspace
  .replace(corePattern, `  'vite@*': '${vite}'`)
  .replace(testPattern, `  'vitest@*': '${vitest}'`));
NODE

pnpm install --no-frozen-lockfile
pnpm vp fmt package.json pnpm-workspace.yaml
node scripts/check_repository.ts
git diff --check
