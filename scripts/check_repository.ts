#!/usr/bin/env node
/** Validate repository ownership, supply-chain policy, and workflow pinning. */

import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseMetadata } from './package_plugin.ts';
import { validateLocal } from './update_latest.ts';

export const OWNER = 'maya0513';
export const REPOSITORY = 'vfox-moonbit';
export const EXPECTED_REPOSITORY = `${OWNER}/${REPOSITORY}`;
const ACTION_RE = /^\s*(?:-\s+)?uses:\s*([^\s#]+)/gm;
const PINNED_ACTION_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/;
const REMOTE_RE = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/;
const FORBIDDEN_WORKFLOW_TOOL_RE =
  /\b(?:actions\/setup-python|python(?:3(?:\.\d+)?)?|uv|pytest|ruff)\b/i;
const APPROVED_DEV_DEPENDENCIES = {
  '@types/node': '24.13.5',
  '@types/yauzl': '3.4.0',
  '@types/yazl': '3.3.1',
  '@vitest/coverage-v8': '4.1.11',
  tar: '7.5.22',
  'vite-plus': '0.3.2',
  yauzl: '3.4.0',
  yazl: '3.3.1',
} as const;

export class RepositoryError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function filesBelow(
  root: string,
  options: { excluded?: ReadonlySet<string>; include?: (path: string) => boolean } = {},
): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (options.excluded?.has(entry.name) === true) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && (options.include?.(path) ?? true)) result.push(path);
    }
  }
  await visit(root);
  return result.toSorted(compareText);
}

export async function checkOwner(repository: string): Promise<void> {
  const metadata = await parseMetadata(join(repository, 'metadata.lua'));
  const homepage = `https://github.com/${EXPECTED_REPOSITORY}`;
  if (metadata.homepage !== homepage)
    throw new RepositoryError(`metadata homepage must be ${homepage}`);
  if (metadata.license !== 'Apache-2.0') {
    throw new RepositoryError('metadata license must use the Apache-2.0 SPDX identifier');
  }
  if (metadata.manifestUrl !== `${homepage}/releases/download/manifest/manifest.json`) {
    throw new RepositoryError('metadata manifestUrl does not use the canonical repository');
  }

  const config = await readFile(join(repository, 'lib', 'moonbit_config.lua'), 'utf8');
  const required = [
    `owner = "${OWNER}"`,
    `repository = "${REPOSITORY}"`,
    `https://raw.githubusercontent.com/${EXPECTED_REPOSITORY}/main/releases`,
  ];
  if (required.some((value) => !config.includes(value))) {
    throw new RepositoryError(
      'moonbit_config.lua contains an unresolved or inconsistent repository owner',
    );
  }

  const excluded = new Set([
    '.agents',
    '.codex',
    '.direnv',
    '.git',
    '.mise',
    '.pnpm-store',
    '.rocks',
    '.version-fox',
    '.vfox',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'target',
  ]);
  const textSuffixes = new Set([
    '',
    '.json',
    '.lua',
    '.md',
    '.sh',
    '.toml',
    '.ts',
    '.yml',
    '.yaml',
  ]);
  const candidates = await filesBelow(repository, {
    excluded,
    include: (path) => textSuffixes.has(extname(path)),
  });
  const placeholders = [
    ['<', 'owner', '>'].join(''),
    ['YOUR', '_OWNER'].join(''),
    ['your', '-owner'].join(''),
    `username/${REPOSITORY}`,
  ];
  for (const placeholder of placeholders) {
    for (const path of candidates) {
      if ((await readFile(path, 'utf8')).includes(placeholder)) {
        throw new RepositoryError(`unresolved owner placeholder in ${relative(repository, path)}`);
      }
    }
  }
}

export async function checkReleasePolicy(repository: string): Promise<void> {
  const releaseDirectory = join(repository, 'releases');
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  const unexpected = entries
    .filter((entry) => !entry.isFile() || !entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .toSorted(compareText);
  if (unexpected.length > 0) {
    throw new RepositoryError(
      `releases/ may contain JSON manifests only: ${unexpected.join(', ')}`,
    );
  }
  for (const entry of entries) {
    if ((await stat(join(releaseDirectory, entry.name))).size > 1024 * 1024) {
      throw new RepositoryError(`release manifest exceeds 1 MiB: ${entry.name}`);
    }
  }
  await validateLocal(repository);
}

async function matchingFiles(
  repository: string,
  directory: string,
  pattern: RegExp,
): Promise<string[]> {
  return (await readdir(join(repository, directory)))
    .filter((name) => pattern.test(name))
    .toSorted(compareText)
    .map((name) => join(repository, directory, name));
}

export async function checkPluginCode(repository: string): Promise<void> {
  const codePaths = [
    join(repository, 'metadata.lua'),
    ...(await matchingFiles(repository, 'hooks', /\.lua$/)),
    ...(await matchingFiles(repository, 'lib', /^moonbit_.*\.lua$/)),
  ];
  const texts = await Promise.all(codePaths.map((path) => readFile(path, 'utf8')));
  const combined = texts.join('\n');
  if (/\baddition\s*=/.test(combined)) {
    throw new RepositoryError(
      'vfox addition archives are forbidden; core must be installed transactionally',
    );
  }
  const runtimeCode = texts.slice(1).join('\n');
  if (/\bmoonup\b/i.test(runtimeCode)) {
    throw new RepositoryError('plugin runtime must not invoke or depend on moonup');
  }
  if (/moon\s+upgrade/i.test(runtimeCode)) {
    throw new RepositoryError('plugin runtime must not invoke moon upgrade');
  }
}

export async function workflowFiles(repository: string): Promise<string[]> {
  const directory = join(repository, '.github', 'workflows');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => /\.ya?ml$/.test(name))
    .toSorted(compareText)
    .map((name) => join(directory, name));
}

export async function checkActions(repository: string): Promise<void> {
  const workflows = await workflowFiles(repository);
  if (workflows.length === 0) throw new RepositoryError('no GitHub Actions workflows are present');
  for (const path of workflows) {
    const text = await readFile(path, 'utf8');
    for (const match of text.matchAll(ACTION_RE)) {
      const reference = match[1];
      if (reference === undefined) continue;
      if (!reference.startsWith('./') && !PINNED_ACTION_RE.test(reference)) {
        throw new RepositoryError(
          `GitHub Action is not pinned to a full commit SHA in ${path.split('/').at(-1)}: ${reference}`,
        );
      }
    }
  }
}

export async function checkUpdaterWorkflow(repository: string): Promise<void> {
  const path = join(repository, '.github', 'workflows', 'update-latest.yml');
  if (!(await exists(path))) throw new RepositoryError('MoonBit updater workflow is missing');
  const text = await readFile(path, 'utf8');
  if (text.includes('app-id:') || text.includes('MOONBIT_UPDATER_APP_ID')) {
    throw new RepositoryError(
      'MoonBit updater workflow must not use the legacy GitHub App ID input',
    );
  }
  const required = [
    'client-id: ${{ vars.MOONBIT_UPDATER_CLIENT_ID }}',
    'private-key: ${{ secrets.MOONBIT_UPDATER_PRIVATE_KEY }}',
    'APP_SLUG: ${{ steps.app-token.outputs.app-slug }}',
    'BOT_NAME: ${{ steps.app-user.outputs.name }}',
    'BOT_EMAIL: ${{ steps.app-user.outputs.email }}',
  ];
  if (required.some((value) => !text.includes(value))) {
    throw new RepositoryError(
      'MoonBit updater workflow has an incomplete GitHub App identity contract',
    );
  }
  if (text.includes('moonbit-updater[bot]')) {
    throw new RepositoryError(
      'MoonBit updater workflow must not use a static, unattributed bot identity',
    );
  }
}

async function repositoryFiles(repository: string): Promise<string[]> {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repository,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status === 0 && result.stdout !== null) {
    const files = result.stdout.split('\0').filter(Boolean).toSorted(compareText);
    const present = await Promise.all(
      files.map(async (name) => ((await exists(join(repository, name))) ? name : undefined)),
    );
    return present.filter((name): name is string => name !== undefined);
  }
  return (
    await filesBelow(repository, {
      excluded: new Set(['.git', '.pnpm-store', 'coverage', 'dist', 'node_modules']),
    })
  ).map((path) => relative(repository, path).replaceAll('\\', '/'));
}

export async function checkMaintenanceTooling(repository: string): Promise<void> {
  const required = [
    '.gitattributes',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'vite.config.ts',
  ];
  const missing = [];
  for (const name of required) if (!(await exists(join(repository, name)))) missing.push(name);
  if (missing.length > 0)
    throw new RepositoryError(`Node/Vite+ configuration is missing: ${missing.join(', ')}`);

  const packageValue: unknown = JSON.parse(
    await readFile(join(repository, 'package.json'), 'utf8'),
  );
  if (!isRecord(packageValue)) throw new RepositoryError('package.json must contain an object');
  const packageDocument = packageValue;
  const engines = isRecord(packageDocument.engines) ? packageDocument.engines : undefined;
  const devDependencies = isRecord(packageDocument.devDependencies)
    ? packageDocument.devDependencies
    : undefined;
  if (
    packageDocument.private !== true ||
    packageDocument.type !== 'module' ||
    engines?.node !== '24.21.0' ||
    packageDocument.packageManager !== 'pnpm@12.4.2'
  ) {
    throw new RepositoryError(
      'package.json must pin the approved private Node.js and pnpm toolchain',
    );
  }
  if (
    devDependencies === undefined ||
    Object.keys(devDependencies).length !== Object.keys(APPROVED_DEV_DEPENDENCIES).length ||
    Object.entries(APPROVED_DEV_DEPENDENCIES).some(
      ([name, version]) => devDependencies[name] !== version,
    )
  ) {
    throw new RepositoryError('package.json must exactly pin the approved maintenance packages');
  }

  const workspace = await readFile(join(repository, 'pnpm-workspace.yaml'), 'utf8');
  const requiredWorkspaceSettings = [
    "  - '.'",
    'storeDir: .pnpm-store',
    "  'vite@*': 'npm:@voidzero-dev/vite-plus-core@0.3.2'",
    "  'vitest@*': '4.1.11'",
  ];
  if (requiredWorkspaceSettings.some((setting) => !workspace.includes(setting))) {
    throw new RepositoryError(
      'pnpm workspace must pin the approved store and Vite/Vitest overrides',
    );
  }

  const attributes = await readFile(join(repository, '.gitattributes'), 'utf8');
  if (!attributes.split(/\r?\n/).includes('* text=auto eol=lf')) {
    throw new RepositoryError('.gitattributes must keep deterministic package inputs on LF');
  }

  const tsconfigValue: unknown = JSON.parse(
    await readFile(join(repository, 'tsconfig.json'), 'utf8'),
  );
  const compilerOptions =
    isRecord(tsconfigValue) && isRecord(tsconfigValue.compilerOptions)
      ? tsconfigValue.compilerOptions
      : undefined;
  if (
    compilerOptions?.strict !== true ||
    compilerOptions.noEmit !== true ||
    compilerOptions.module !== 'NodeNext' ||
    compilerOptions.moduleResolution !== 'NodeNext' ||
    compilerOptions.erasableSyntaxOnly !== true
  ) {
    throw new RepositoryError('tsconfig.json must enforce the approved strict erasable Node setup');
  }

  const mise = await readFile(join(repository, 'mise.toml'), 'utf8');
  if (!/^node\s*=\s*"24\.21\.0"$/m.test(mise) || !/^pnpm\s*=\s*"12\.4\.2"$/m.test(mise)) {
    throw new RepositoryError('mise.toml must pin the approved Node.js and pnpm versions');
  }
  const files = await repositoryFiles(repository);
  const forbidden = files.filter(
    (name) => name.endsWith('.py') || name === 'pyproject.toml' || name === 'uv.lock',
  );
  if (forbidden.length > 0) {
    throw new RepositoryError(`Python maintenance files are forbidden: ${forbidden.join(', ')}`);
  }
  for (const path of await workflowFiles(repository)) {
    if (FORBIDDEN_WORKFLOW_TOOL_RE.test(await readFile(path, 'utf8'))) {
      throw new RepositoryError(
        `workflow invokes forbidden Python tooling: ${relative(repository, path)}`,
      );
    }
  }
}

export type OriginReader = (repository: string) => { status: number | null; stdout: string };

function readOrigin(repository: string): { status: number | null; stdout: string } {
  return spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd: repository,
    encoding: 'utf8',
    shell: false,
  });
}

export function originSlug(
  repository: string,
  reader: OriginReader = readOrigin,
): string | undefined {
  const result = reader(repository);
  if (result.status !== 0) return undefined;
  const match = REMOTE_RE.exec(result.stdout.trim());
  return match?.[1] ?? '';
}

export async function validate(
  repositoryInput: string,
  options: { requireOrigin?: boolean; originReader?: OriginReader } = {},
): Promise<void> {
  const repository = resolve(repositoryInput);
  await checkOwner(repository);
  await checkReleasePolicy(repository);
  await checkPluginCode(repository);
  await checkActions(repository);
  await checkUpdaterWorkflow(repository);
  await checkMaintenanceTooling(repository);
  const slug = originSlug(repository, options.originReader);
  if (options.requireOrigin === true && slug === undefined) {
    throw new RepositoryError('git remote origin is required for release validation');
  }
  if (slug !== undefined && slug !== EXPECTED_REPOSITORY) {
    throw new RepositoryError(
      `remote origin must be github.com/${EXPECTED_REPOSITORY}, got ${slug === '' ? 'an invalid URL' : slug}`,
    );
  }
}

export interface RepositoryArguments {
  repository: string;
  requireOrigin: boolean;
}

export function parseArguments(argv: readonly string[]): RepositoryArguments {
  let repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
  let requireOrigin = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo') {
      const value = argv[index + 1];
      if (value === undefined) throw new RepositoryError('--repo requires a path');
      repository = resolve(value);
      index += 1;
    } else if (argument === '--require-origin') requireOrigin = true;
    else throw new RepositoryError(`unknown argument: ${argument}`);
  }
  return { repository, requireOrigin };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const argumentsValue = parseArguments(argv);
    await validate(argumentsValue.repository, { requireOrigin: argumentsValue.requireOrigin });
    console.log(`repository policy is valid for ${EXPECTED_REPOSITORY}`);
    return 0;
  } catch (error) {
    console.log(
      `repository check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

/* v8 ignore start -- the process entrypoint is exercised by mise and Actions */
function isMain(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href;
}

if (isMain()) process.exitCode = await main();
/* v8 ignore stop */
