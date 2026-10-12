import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { checkDependencies, checkInstalledVersions } from '../../scripts/lib/dependencies.ts';
import { isRecord } from '../../scripts/lib/common.ts';
import { REPOSITORY } from './fixtures.ts';

const project: unknown = JSON.parse(await readFile(join(REPOSITORY, 'package.json'), 'utf8'));
assert(
  isRecord(project) &&
    isRecord(project.engines) &&
    typeof project.engines.node === 'string' &&
    typeof project.packageManager === 'string',
);
const NODE = project.engines.node;
const PNPM = project.packageManager.slice('pnpm@'.length);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dependency-policy-'));
  for (const name of [
    'mise.toml',
    'mise.lock',
    'package.json',
    'pnpm-workspace.yaml',
    'renovate.json',
    '.github',
  ]) {
    await cp(join(REPOSITORY, name), join(root, name), { recursive: true });
  }
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function change(name: string, before: string, after: string): Promise<void> {
  const path = join(root, name);
  const text = await readFile(path, 'utf8');
  expect(text).toContain(before);
  await writeFile(path, text.replace(before, after));
}

describe('dependency automation contract', () => {
  it('accepts exact tools, synchronized declarations and identical generation groups', async () => {
    await expect(checkDependencies(root)).resolves.toEqual({ node: NODE, pnpm: PNPM });
  });

  it.each([
    ['mise.toml', `node = "${NODE}"`, 'node = "24"', 'exact'],
    ['mise.toml', `node = "${NODE}"`, 'node = true', 'exact'],
    ['mise.toml', `node = "${NODE}"`, 'node = { version = "24" }', 'exact'],
    ['mise.toml', `node = "${NODE}"`, 'node = "99.0.0"', 'locked version'],
    ['mise.lock', '[[tools.node]]', '[[tools.missing]]', 'locked version'],
    ['package.json', `"node": "${NODE}"`, '"node": "24.x"', 'Node declaration'],
    [
      'package.json',
      `"packageManager": "pnpm@${PNPM}"`,
      '"packageManager": "pnpm@99.0.0"',
      'pnpm declaration',
    ],
    ['pnpm-workspace.yaml', 'pmOnFail: ignore', 'pmOnFail: download', 'mise-managed'],
    [
      'mise.toml',
      'lockfile_platforms = ["linux-x64", "linux-arm64"]',
      'lockfile_platforms = ["windows-x64"]',
      'Linux',
    ],
    ['mise.toml', 'os = ["linux"]', 'os = ["windows"]', 'Linux-only'],
    [
      'renovate.json',
      'local>maya0513/renovate-config//presets/vite-plus',
      'local>maya0513/renovate-config//presets/other',
      'presets',
    ],
    [
      'renovate.json',
      'https://api.anaconda.org/package/conda-forge/',
      'https://example.com/',
      'Conda',
    ],
    ['renovate.json', '>=5.1.0 <5.2.0', '>=5.0.0 <6.0.0', 'Lua 5.1'],
    ['renovate.json', '>=24.0.0 <25.0.0', '>=25.0.0 <26.0.0', 'Node types'],
    [
      'renovate.json',
      '"skipArtifactsUpdate": true',
      '"skipArtifactsUpdate": false',
      'mise artifacts',
    ],
    ['renovate.json', '"enabled": false', '"enabled": true', 'mise lock maintenance'],
    [
      '.github/workflows/update-dependencies.yml',
      'sync-vite-plus: true',
      'sync-vite-plus: false',
      'synchronization',
    ],
    [
      '.github/workflows/ci.yml',
      'sync-declarations: true',
      'sync-declarations: false',
      'synchronization',
    ],
    ['.github/workflows/ci.yml', '"verify":"locked"', '"verify":"regenerate"', 'groups'],
    [
      '.github/workflows/ci.yml',
      '"conda:gcc","conda:lua","conda:luarocks"',
      '"conda:gcc","conda:lua","conda:lua","conda:luarocks"',
      'groups',
    ],
    [
      '.github/workflows/ci.yml',
      '"conda:gcc","conda:lua","conda:luarocks"',
      '"conda:gcc","conda:lua"',
      'groups',
    ],
    ['.github/workflows/ci.yml', '"macos-arm64","windows-x64"', '"macos-arm64"', 'groups'],
    ['.github/workflows/ci.yml', 'verify-only: true', 'verify-only: false', 'read-only'],
  ])('rejects policy drift in %s: %s', async (name, before, after, message) => {
    await change(name, before, after);
    await expect(checkDependencies(root)).rejects.toThrow(message);
  });

  it('checks executable versions, not only declarations', () => {
    expect(() => checkInstalledVersions('24.21.0', '12.9.1', 'v24.21.0', '12.9.1\n')).not.toThrow();
    expect(() => checkInstalledVersions('24.21.0', '12.9.1', 'v24.22.0', '12.9.1')).toThrow(
      'Node executable',
    );
    expect(() => checkInstalledVersions('24.21.0', '12.9.1', 'v24.21.0', '12.10.1')).toThrow(
      'pnpm executable',
    );
  });
});
