#!/usr/bin/env node
/** Run real-download integration tests through mise and/or standalone vfox. */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer, Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, releaseFiles } from './package_plugin.ts';
import { compareText, errorMessage, isMain, isRecord } from './lib/common.ts';
import { EXACT_VERSION_RE } from './lib/project.ts';
import {
  containsAdjacentPathEntries,
  E2EError,
  environmentValue,
  normalizedPath,
  pathsReferToSameEntry,
  run,
  type RunOptions,
  type RunResult,
} from './e2e/process.ts';

export { EXACT_VERSION_RE };
export {
  containsAdjacentPathEntries,
  E2EError,
  environmentValue,
  normalizedPath,
  pathsReferToSameEntry,
  run,
};
export type { RunOptions, RunResult };
export const REQUIRED_EXECUTABLES = [
  'moon',
  'moonc',
  'moonfmt',
  'mooninfo',
  'moonrun',
  'moon-lsp',
  'moon-ide',
] as const;
export const HELPER_EXECUTABLES = ['moon-lsp', 'moon-ide'] as const;

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export type Fingerprint =
  | readonly (readonly [string, number, number, number, string])[]
  | undefined;

export async function treeFingerprint(root: string): Promise<Fingerprint> {
  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  const paths = [root];
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).toSorted((left, right) =>
      compareText(left.name, right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      paths.push(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path);
    }
  }
  if (rootStats.isDirectory() && !rootStats.isSymbolicLink()) await visit(root);
  const result: [string, number, number, number, string][] = [];
  for (const path of paths) {
    const metadata = await lstat(path);
    const name = path === root ? '.' : relative(root, path).replaceAll('\\', '/');
    const detail = metadata.isSymbolicLink()
      ? await readlink(path)
      : metadata.isFile()
        ? await sha256File(path)
        : '';
    result.push([name, metadata.mode & 0o170000, metadata.mode & 0o7777, metadata.size, detail]);
  }
  return result;
}

export async function exactVersion(repository: string): Promise<string> {
  const document: unknown = JSON.parse(
    await readFile(join(repository, 'releases', 'latest.json'), 'utf8'),
  );
  if (
    !isRecord(document) ||
    typeof document.version !== 'string' ||
    !EXACT_VERSION_RE.test(document.version)
  ) {
    throw new E2EError('latest.json does not contain a supported exact version');
  }
  return document.version;
}

async function serveRepository(repository: string): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405).end();
          return;
        }
        const rawPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        const requested = resolve(repository, `.${decodeURIComponent(rawPath)}`);
        const rel = relative(repository, requested);
        if (rel.startsWith('..') || isAbsolute(rel) || !(await stat(requested)).isFile()) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, {
          'Content-Type': requested.endsWith('.json')
            ? 'application/json'
            : 'application/octet-stream',
        });
        if (request.method === 'HEAD') response.end();
        else createReadStream(requested).pipe(response);
      } catch {
        if (!response.headersSent) response.writeHead(404);
        response.end();
      }
    })();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new E2EError('manifest server has no TCP port');
  return { baseUrl: `http://127.0.0.1:${address.port}/releases`, server };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

export async function withManifestServer<T>(
  repository: string,
  callback: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const { baseUrl, server } = await serveRepository(repository);
  try {
    return await callback(baseUrl);
  } finally {
    await closeServer(server);
  }
}

export async function preparePlugin(
  repository: string,
  destination: string,
  manifestBase: string,
): Promise<string> {
  const plugin = join(destination, 'plugin source with spaces + symbols');
  for (const source of await releaseFiles(repository)) {
    const target = join(plugin, relative(repository, source));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  const config = join(plugin, 'lib', 'moonbit_config.lua');
  const text = await readFile(config, 'utf8');
  let count = 0;
  const replaced = text.replace(/manifest_base\s*=\s*"[^"]+"/, () => {
    count += 1;
    return `manifest_base = "${manifestBase}"`;
  });
  if (count !== 1) throw new E2EError('could not redirect the plugin manifest endpoint');
  await writeFile(config, replaced, 'utf8');
  return plugin;
}

async function filesBelow(directory: string, filename: string): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesBelow(path, filename)));
    else if (entry.isFile() && entry.name === filename) result.push(path);
  }
  return result;
}

export async function findVfoxRoot(
  alias: string,
  version: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<string> {
  const formatted = await run(['vfox', 'info', '--format', '{{.Path}}', `${alias}@${version}`], {
    ...options,
    check: false,
  });
  const output = formatted.stdout.trim();
  const executable = process.platform === 'win32' ? 'moon.exe' : 'moon';
  const searchRoots: string[] = [];
  if (formatted.returnCode === 0 && output !== '') {
    try {
      if ((await stat(output)).isDirectory()) searchRoots.push(output);
    } catch {
      // Fall through to vfox state directories.
    }
  }
  const homes = [
    options.env.VFOX_HOME,
    join(homedir(), '.version-fox'),
    join(homedir(), '.vfox'),
  ].filter((value): value is string => value !== undefined);
  for (const home of homes) {
    for (const category of ['cache', 'sdks']) {
      const path = join(home, category, alias);
      if (!searchRoots.includes(path)) searchRoots.push(path);
    }
  }
  const matches: string[] = [];
  for (const root of searchRoots) {
    for (const path of await filesBelow(root, executable)) {
      if (basename(dirname(path)) === 'bin') matches.push(dirname(dirname(path)));
    }
  }
  const matchingVersions = matches.filter((path) => path.replaceAll('\\', '/').includes(version));
  const candidates = matchingVersions.length > 0 ? matchingVersions : matches;
  const unique = [...new Set(await Promise.all(candidates.map((path) => realpath(path))))].toSorted(
    compareText,
  );
  if (unique.length !== 1) {
    throw new E2EError(
      `cannot identify one vfox install root for ${alias}@${version}: ${unique.join(', ')}`,
    );
  }
  const root = unique[0];
  if (root === undefined)
    throw new E2EError(`cannot identify one vfox install root for ${alias}@${version}`);
  return root;
}

export async function assertWithin(root: string, path: string): Promise<void> {
  try {
    const [resolvedRoot, resolvedPath] = await Promise.all([realpath(root), realpath(path)]);
    const rel = relative(resolvedRoot, resolvedPath);
    if (
      rel === '..' ||
      rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(rel)
    ) {
      throw new Error('outside root');
    }
  } catch (error) {
    throw new E2EError(`installed component escapes its root: ${path}`, { cause: error });
  }
}

export function executableName(name: string, platform = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

export async function validateInstall(root: string, version: string): Promise<void> {
  for (const name of REQUIRED_EXECUTABLES) {
    const path = join(root, 'bin', executableName(name));
    try {
      if (!(await stat(path)).isFile()) throw new Error('not a file');
    } catch {
      throw new E2EError(`required MoonBit executable is missing: ${path}`);
    }
    await assertWithin(root, path);
  }
  if (process.platform !== 'win32') {
    const tcc = join(root, 'bin', 'internal', 'tcc');
    try {
      if (!(await stat(tcc)).isFile()) throw new Error('not a file');
    } catch {
      throw new E2EError(`required MoonBit executable is missing: ${tcc}`);
    }
    await assertWithin(root, tcc);
  }
  const moonx = join(root, 'bin', executableName('moonx'));
  try {
    if (!(await stat(moonx)).isFile()) throw new Error('not a file');
  } catch {
    throw new E2EError(`moonx is missing: ${moonx}`);
  }
  await assertWithin(root, moonx);
  if (process.platform !== 'win32') {
    const metadata = await lstat(moonx);
    if (!metadata.isSymbolicLink() || (await readlink(moonx)) !== 'moon') {
      throw new E2EError('moonx must be a relative symlink to moon on Unix');
    }
  }
  const shimSuffix = process.platform === 'win32' ? '.cmd' : '';
  for (const helper of HELPER_EXECUTABLES) {
    const shim = join(root, 'shims', `${helper}${shimSuffix}`);
    try {
      if (!(await stat(shim)).isFile()) throw new Error('not a file');
    } catch {
      throw new E2EError(`MoonBit helper shim is missing: ${shim}`);
    }
    await assertWithin(root, shim);
  }
  const moonMod = join(root, 'lib', 'core', 'moon.mod');
  let moonModText: string;
  try {
    moonModText = await readFile(moonMod, 'utf8');
  } catch {
    throw new E2EError('installed core has no moon.mod');
  }
  await assertWithin(root, moonMod);
  const match = /^\s*version\s*=\s*"([^"]+)"\s*$/m.exec(moonModText);
  if (match?.[1] !== version)
    throw new E2EError(`installed core version does not match ${version}`);
  const builtin = join(root, 'lib', 'core', 'builtin', 'moon.pkg');
  try {
    if (!(await stat(builtin)).isFile()) throw new Error('not a file');
  } catch {
    throw new E2EError(`installed core is missing its builtin package: ${builtin}`);
  }
  await assertWithin(root, builtin);
}

async function managedRun(
  prefix: readonly string[],
  command: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return run([...prefix, ...command], options);
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function validateCommands(
  prefix: readonly string[],
  root: string,
  version: string,
  options: { workspace: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  const moon = executableName('moon');
  const moonx = executableName('moonx');
  const expectedHome = resolve(options.env.MOON_HOME ?? '');
  const probe = await managedRun(
    prefix,
    [
      process.execPath,
      '-e',
      'console.log(JSON.stringify({home:process.env.MOON_HOME,root:process.env.MOON_TOOLCHAIN_ROOT,path:process.env.PATH}))',
    ],
    { cwd: options.workspace, env: options.env },
  );
  const lines = probe.stdout.trim().split(/\r?\n/);
  const parsedValues: unknown = JSON.parse(lines.at(-1) ?? '{}');
  if (!isRecord(parsedValues))
    throw new E2EError('manager environment probe did not return an object');
  const values = parsedValues;
  if (
    typeof values.home !== 'string' ||
    normalizedPath(values.home) !== normalizedPath(expectedHome)
  ) {
    throw new E2EError("manager overwrote the caller's mutable MOON_HOME");
  }
  if (typeof values.root !== 'string' || !(await pathsReferToSameEntry(values.root, root))) {
    throw new E2EError('manager did not export the exact install root as MOON_TOOLCHAIN_ROOT');
  }
  if (typeof values.path !== 'string') throw new E2EError('manager did not export PATH');
  const pathEntries = values.path
    .split(delimiter)
    .filter((path) => path !== '')
    .map((path) => resolve(path));
  const expectedPaths = [resolve(root, 'shims'), resolve(root, 'bin')];
  if (!(await containsAdjacentPathEntries(pathEntries, expectedPaths))) {
    throw new E2EError(
      'manager did not expose the helper shims and install bin directories in order',
    );
  }

  const installBefore = await treeFingerprint(root);
  const versionResult = await managedRun(
    prefix,
    [moon, 'version', '--all', '--json', '--no-path'],
    {
      cwd: options.workspace,
      env: options.env,
    },
  );
  let versionJson: unknown;
  try {
    versionJson = JSON.parse(versionResult.stdout);
  } catch (error) {
    throw new E2EError('moon version did not return JSON', { cause: error });
  }
  if (!JSON.stringify(versionJson).includes(version)) {
    throw new E2EError(`moon version output does not contain resolved version ${version}`);
  }

  const project = join(options.workspace, 'fixture project');
  await managedRun(prefix, [moon, 'new', '--user', 'vfox-e2e', '--name', 'smoke', project], {
    cwd: options.workspace,
    env: options.env,
  });
  for (const command of [
    [moon, 'check'],
    [moon, 'test'],
    [moon, 'run', 'cmd/main'],
  ]) {
    await managedRun(prefix, command, { cwd: project, env: options.env });
  }
  const moonxHelp = await managedRun(prefix, [moonx, '--help'], { cwd: project, env: options.env });
  if (!`${moonxHelp.stdout}${moonxHelp.stderr}`.toLowerCase().includes('package')) {
    throw new E2EError('moonx did not identify itself as the package runner');
  }
  await managedRun(prefix, [moon, 'lsp', '--version'], { cwd: project, env: options.env });
  await managedRun(prefix, [moon, 'ide', '--help'], { cwd: project, env: options.env });
  if (!sameFingerprint(await treeFingerprint(root), installBefore)) {
    throw new E2EError('MoonBit commands modified the managed installation root');
  }
}

async function commandAvailable(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const extensions =
    process.platform === 'win32'
      ? (environmentValue(env, 'PATHEXT') ?? '.EXE;.CMD;.BAT').split(';')
      : [''];
  for (const directory of (environmentValue(env, 'PATH') ?? '').split(delimiter)) {
    for (const extension of extensions) {
      try {
        if ((await stat(join(directory, `${name}${extension}`))).isFile()) return true;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return false;
}

export async function runMise(
  plugin: string,
  version: string,
  options: { workspace: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  if (!(await commandAvailable('mise', options.env)))
    throw new E2EError('mise is not available on PATH');
  await run(['mise', '--no-config', '--yes', 'plugins', 'link', '--force', 'moonbit', plugin], {
    cwd: options.workspace,
    env: options.env,
  });
  await run(['mise', '--no-config', '--yes', 'install', 'moonbit@latest'], {
    cwd: options.workspace,
    env: options.env,
  });
  const latest = (
    await run(['mise', '--no-config', 'latest', 'moonbit'], {
      cwd: options.workspace,
      env: options.env,
    })
  ).stdout.trim();
  if (latest !== version)
    throw new E2EError(
      `mise latest resolved to ${JSON.stringify(latest)}, expected ${JSON.stringify(version)}`,
    );
  const root = (
    await run(['mise', '--no-config', 'where', `moonbit@${version}`], {
      cwd: options.workspace,
      env: options.env,
    })
  ).stdout.trim();
  await validateInstall(root, version);
  await validateCommands(
    ['mise', '--no-config', 'exec', `moonbit@${version}`, '--'],
    root,
    version,
    options,
  );
}

export async function runVfox(
  plugin: string,
  version: string,
  options: { workspace: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  if (!(await commandAvailable('vfox', options.env)))
    throw new E2EError('vfox is not available on PATH');
  const distribution = join(options.workspace, 'plugin distribution');
  const { archive } = await build(plugin, distribution);
  const alias = `moonbit-e2e-${process.pid}`;
  const vfoxHome = options.env.VFOX_HOME;
  if (vfoxHome === undefined) throw new E2EError('VFOX_HOME is not configured');
  await mkdir(join(vfoxHome, 'plugin'), { recursive: true });
  await run(['vfox', '--version'], { cwd: options.workspace, env: options.env });
  let added = false;
  const removePlugin = async (): Promise<void> => {
    await run(['vfox', 'remove', '--yes', alias], {
      cwd: options.workspace,
      env: options.env,
      timeoutSeconds: 30,
    });
  };
  try {
    await run(['vfox', 'add', '--source', archive, alias], {
      cwd: options.workspace,
      env: options.env,
    });
    added = true;
    await run(['vfox', 'install', '--yes', `${alias}@latest`], {
      cwd: options.workspace,
      env: options.env,
      timeoutSeconds: 300,
    });
    const root = await findVfoxRoot(alias, version, { cwd: options.workspace, env: options.env });
    await validateInstall(root, version);
    await validateCommands(['vfox', 'exec', `${alias}@${version}`, '--'], root, version, options);
  } catch (error) {
    if (added) {
      try {
        await removePlugin();
      } catch (cleanupError) {
        console.error(
          `warning: vfox cleanup failed after the primary E2E failure: ${errorMessage(cleanupError)}`,
        );
      }
    }
    throw error;
  }
  if (added) await removePlugin();
}

export type Backend = 'mise' | 'vfox' | 'all';
export interface E2EArguments {
  repository: string;
  backend: Backend;
  allowVfoxUserState: boolean;
}

export function parseArguments(argv: readonly string[]): E2EArguments {
  let repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
  let backend: Backend = 'mise';
  let allowVfoxUserState = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo') {
      const value = argv[index + 1];
      if (value === undefined) throw new E2EError('--repo requires a path');
      repository = resolve(value);
      index += 1;
    } else if (argument === '--backend') {
      const value = argv[index + 1];
      if (value !== 'mise' && value !== 'vfox' && value !== 'all') {
        throw new E2EError('--backend must be mise, vfox, or all');
      }
      backend = value;
      index += 1;
    } else if (argument === '--allow-vfox-user-state') allowVfoxUserState = true;
    else throw new E2EError(`unknown argument: ${argument}`);
  }
  return { allowVfoxUserState, backend, repository };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let argumentsValue: E2EArguments;
  try {
    argumentsValue = parseArguments(argv);
  } catch (error) {
    console.error(`E2E failed: ${errorMessage(error)}`);
    return 1;
  }
  if (
    (argumentsValue.backend === 'vfox' || argumentsValue.backend === 'all') &&
    !argumentsValue.allowVfoxUserState &&
    process.env.CI !== 'true'
  ) {
    console.error(
      'standalone vfox E2E is disabled locally; pass --allow-vfox-user-state to opt in',
    );
    return 2;
  }

  const repository = resolve(argumentsValue.repository);
  const moonHome = join(homedir(), '.moon');
  const before = await treeFingerprint(moonHome);
  let failure: string | undefined;
  const temporary = await mkdtemp(join(tmpdir(), 'vfox-moonbit-e2e-'));
  try {
    const version = await exactVersion(repository);
    await withManifestServer(repository, async (baseUrl) => {
      const workspace = join(temporary, 'workspace with spaces + symbols');
      await mkdir(workspace);
      const plugin = await preparePlugin(repository, temporary, baseUrl);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MISE_DATA_DIR: join(temporary, 'mise data + symbols'),
        MISE_CACHE_DIR: join(temporary, 'mise cache + symbols'),
        MISE_STATE_DIR: join(temporary, 'mise state + symbols'),
        MISE_NO_UPDATE_CHECK: '1',
        VFOX_HOME: join(temporary, 'vfox home + symbols'),
        MOON_HOME: join(temporary, 'moon user state + symbols'),
      };
      if (argumentsValue.backend === 'mise' || argumentsValue.backend === 'all') {
        await runMise(plugin, version, { workspace, env: { ...env } });
      }
      if (argumentsValue.backend === 'vfox' || argumentsValue.backend === 'all') {
        await runVfox(plugin, version, { workspace, env: { ...env } });
      }
      console.log(`MoonBit ${version} E2E passed through ${argumentsValue.backend}`);
    });
  } catch (error) {
    failure = errorMessage(error);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
  if (!sameFingerprint(await treeFingerprint(moonHome), before))
    failure = '~/.moon was created or modified';
  if (failure !== undefined) {
    console.error(`E2E failed: ${failure}`);
    return 1;
  }
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await main();
