#!/usr/bin/env node
/** Validate repository ownership, supply-chain policy, and tool compatibility. */

import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMetadata } from './package_plugin.ts';
import { miseTasks, viteTasks as taskNames } from './check_documentation.ts';
import { validateLocal } from './update_latest.ts';
import { compareText, isMain, isRecord } from './lib/common.ts';
import { EXPECTED_REPOSITORY, OWNER, REPOSITORY } from './lib/project.ts';

export { EXPECTED_REPOSITORY, OWNER, REPOSITORY };
const ACTION_RE = /^\s*(?:-\s+)?uses:\s*([^\s#]+)/gm;
const APPROVED_ACTION_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/;
const PINNED_ACTION_LINE_RE =
  /^\s*(?:-\s+)?uses:\s*[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}\s+#\s+v[1-9][0-9]*\s*$/gm;
const REMOTE_RE = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/;
const FORBIDDEN_WORKFLOW_TOOL_RE =
  /\b(?:actions\/setup-python|python(?:3(?:\.\d+)?)?|uv|pytest|ruff)\b/i;
const APPROVED_DEV_DEPENDENCIES = {
  '@types/node': 24,
  '@types/yauzl': 3,
  '@types/yazl': 3,
  '@vitest/coverage-v8': 5,
  tar: 7,
  'vite-plus': 1,
  yauzl: 3,
  yazl: 3,
} as const;

export class RepositoryError extends Error {}

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
  if (metadata.license !== 'MIT') {
    throw new RepositoryError('metadata license must use the MIT SPDX identifier');
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
    let remoteCount = 0;
    for (const match of text.matchAll(ACTION_RE)) {
      const reference = String(match[1]);
      if (reference.startsWith('./')) continue;
      remoteCount += 1;
      if (!APPROVED_ACTION_RE.test(reference)) {
        throw new RepositoryError(
          `GitHub Action must use a full commit SHA in ${path.split('/').at(-1)}: ${reference}`,
        );
      }
    }
    if ([...text.matchAll(PINNED_ACTION_LINE_RE)].length !== remoteCount) {
      throw new RepositoryError(
        `GitHub Action pins need trailing major tag comments in ${path.split('/').at(-1)}`,
      );
    }
    let miseCount = 0;
    for (const step of text.split(/(?=^ {6}- )/m)) {
      if (!/^ {8}uses:\s*jdx\/mise-action@/m.test(step)) continue;
      miseCount += 1;
      if (
        !/^ {10}minimum_release_age: "0s"(?:\s+#.*)?$/m.test(step) ||
        !/^ {10}cache: false$/m.test(step) ||
        /^ {10}version:/m.test(step)
      ) {
        throw new RepositoryError('mise-action must explicitly select the latest stable mise');
      }
    }
    if ([...text.matchAll(/^ {8}run: mise --version$/gm)].length !== miseCount) {
      throw new RepositoryError('workflows using mise must record the actual mise version');
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
    'vite.tasks.ts',
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
    packageDocument.version !== undefined ||
    packageDocument.type !== 'module' ||
    engines?.node !== '24.x' ||
    engines.pnpm !== '12.x' ||
    packageDocument.packageManager !== undefined ||
    packageDocument.devEngines !== undefined
  ) {
    throw new RepositoryError(
      'package.json must declare the approved Node.js and pnpm engine ranges, use mise-managed pnpm, and remain private and unversioned',
    );
  }
  if (
    /\bpackageManagerDependencies:/.test(await readFile(join(repository, 'pnpm-lock.yaml'), 'utf8'))
  ) {
    throw new RepositoryError('pnpm itself must be locked only in mise.lock');
  }
  const coverageVersion = devDependencies?.['@vitest/coverage-v8'];
  if (
    devDependencies === undefined ||
    typeof coverageVersion !== 'string' ||
    Object.keys(devDependencies).length !== Object.keys(APPROVED_DEV_DEPENDENCIES).length ||
    Object.entries(APPROVED_DEV_DEPENDENCIES).some(([name, major]) => {
      const version = devDependencies[name];
      const prefix = name === '@vitest/coverage-v8' ? '' : '\\^';
      return (
        typeof version !== 'string' ||
        !new RegExp(`^${prefix}${major}\\.\\d+\\.\\d+$`).test(version)
      );
    })
  ) {
    throw new RepositoryError(
      'package.json must use compatible ranges for the approved maintenance packages',
    );
  }

  const workspace = await readFile(join(repository, 'pnpm-workspace.yaml'), 'utf8');
  const requiredWorkspaceSettings = [
    "  - '.'",
    'storeDir: .pnpm-store',
    `  'vitest@*': '${coverageVersion}'`,
    "    vite: '1'",
  ];
  if (
    requiredWorkspaceSettings.some((setting) => !workspace.includes(setting)) ||
    !/^  'vite@\*': 'npm:@voidzero-dev\/vite-plus-core@1\.\d+\.\d+'$/m.test(workspace)
  ) {
    throw new RepositoryError(
      'pnpm workspace must configure the approved store, aligned Vite/Vitest overrides, and peer policy',
    );
  }

  const rockLock = await readFile(join(repository, 'lua-rocks.lock'), 'utf8');
  const lockedRocks = new Map<string, string>();
  for (const line of rockLock.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+) (\S+) ([0-9a-f]{64}) ([0-9a-f]{64})$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new RepositoryError('lua-rocks.lock must pin version, rockspec hash, and source hash');
    }
    if (lockedRocks.has(match[1])) throw new RepositoryError(`duplicate Lua rock: ${match[1]}`);
    lockedRocks.set(match[1], match[2]);
  }
  for (const [name, pattern] of [
    ['busted', /^2\./],
    ['luacov', /^0\.16\./],
    ['luacheck', /^1\./],
  ] as const) {
    if (!pattern.test(lockedRocks.get(name) ?? '')) {
      throw new RepositoryError(`lua-rocks.lock violates the approved ${name} series`);
    }
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
  if (!/^node\s*=\s*"24"$/m.test(mise) || !/^pnpm\s*=\s*"12"$/m.test(mise)) {
    throw new RepositoryError('mise.toml must select the approved Node.js and pnpm major versions');
  }
  const selectedMiseTasks = miseTasks(mise);
  if (
    selectedMiseTasks.size !== 2 ||
    !selectedMiseTasks.has('bootstrap') ||
    !selectedMiseTasks.has('update:tooling') ||
    !mise.includes('run = "bash scripts/bootstrap.sh"') ||
    !mise.includes('run = "bash scripts/update-tooling.sh"')
  ) {
    throw new RepositoryError('mise must define only bootstrap and update:tooling shell tasks');
  }

  const viteConfig = await readFile(join(repository, 'vite.config.ts'), 'utf8');
  const viteTasks = await readFile(join(repository, 'vite.tasks.ts'), 'utf8');
  if (
    !viteConfig.includes("import { tasks } from './vite.tasks.ts'") ||
    !viteConfig.includes('tasks: true') ||
    !viteConfig.includes('tasks,')
  ) {
    throw new RepositoryError('Vite+ configuration must enable and import the cached task graph');
  }
  const selectedViteTasks = taskNames(viteTasks);
  for (const task of [
    'fmt:check',
    'lint',
    'test:unit',
    'coverage',
    'docs:check',
    'e2e',
    'e2e:vfox',
    'package',
    'update:check',
    'update:discover',
    'check',
    'ci',
  ]) {
    if (!selectedViteTasks.has(task)) {
      throw new RepositoryError(`Vite Task must define maintenance task: ${task}`);
    }
  }
  if (selectedViteTasks.has('bootstrap') || selectedViteTasks.has('update:tooling')) {
    throw new RepositoryError('bootstrap and update:tooling belong only in mise');
  }
  if ((viteTasks.match(/cache: false/g) ?? []).length !== 4) {
    throw new RepositoryError(
      'only E2E, upstream discovery, and Git-state checks may disable caching',
    );
  }

  const ciWorkflow = await readFile(join(repository, '.github', 'workflows', 'ci.yml'), 'utf8');
  if (
    !ciWorkflow.includes('node_modules/.vite/task-cache') ||
    !ciWorkflow.includes('actions/cache/restore@') ||
    !ciWorkflow.includes('actions/cache/save@') ||
    !ciWorkflow.includes('actions/dependency-review-action@') ||
    !ciWorkflow.includes('fail-on-severity: moderate')
  ) {
    throw new RepositoryError('CI must enforce dependency review and the isolated Vite Task cache');
  }
  const toolingWorkflow = await readFile(
    join(repository, '.github', 'workflows', 'update-tooling.yml'),
    'utf8',
  );
  for (const contract of [
    'permission-workflows: write',
    'mise run update:tooling',
    '.github/workflows/*.yml|lua-rocks.lock|mise.lock',
  ]) {
    if (!toolingWorkflow.includes(contract)) {
      throw new RepositoryError(`tooling updater is missing contract: ${contract}`);
    }
  }

  const toolingUpdater = await readFile(join(repository, 'scripts', 'update-tooling.sh'), 'utf8');
  if (
    !toolingUpdater.includes('mise install --locked node pnpm conda:gcc conda:lua conda:luarocks')
  ) {
    throw new RepositoryError('tooling updater must install every Lua lock-generation tool');
  }
  if (/\bpnpm\s+(?:self-update|env)\b/.test(toolingUpdater)) {
    throw new RepositoryError('tooling updater must update pnpm only through mise');
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
if (isMain(import.meta.url)) process.exitCode = await main();
/* v8 ignore stop */
