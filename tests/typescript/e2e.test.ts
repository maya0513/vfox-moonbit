import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  assertWithin,
  containsAdjacentPathEntries,
  environmentValue,
  E2EError,
  exactVersion,
  executableName,
  HELPER_EXECUTABLES,
  main,
  parseArguments,
  pathsReferToSameEntry,
  preparePlugin,
  REQUIRED_EXECUTABLES,
  run,
  treeFingerprint,
  validateInstall,
  withManifestServer,
} from '../../scripts/e2e.ts';
import { releaseFiles } from '../../scripts/package_plugin.ts';

const REPOSITORY = resolve(fileURLToPath(new URL('../..', import.meta.url)));
let temporary: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'e2e-helper-test-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(temporary, { force: true, recursive: true });
});

async function copyReleaseSource(destination: string): Promise<string> {
  for (const source of await releaseFiles(REPOSITORY)) {
    const target = join(destination, relative(REPOSITORY, source));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return destination;
}

describe('E2E helper invariants', () => {
  it('reads only supported exact versions', async () => {
    expect(await exactVersion(REPOSITORY)).toMatch(/^0\./);
    await mkdir(join(temporary, 'releases'));
    await writeFile(
      join(temporary, 'releases', 'latest.json'),
      JSON.stringify({ version: 'latest' }),
    );
    await expect(exactVersion(temporary)).rejects.toThrow('supported exact');
  });

  it('selects executable suffixes', () => {
    expect(executableName('moon', 'linux')).toBe('moon');
    expect(executableName('moon', 'win32')).toBe('moon.exe');
  });

  it('fingerprints files and links without following them', async () => {
    expect(await treeFingerprint(join(temporary, 'missing'))).toBeUndefined();
    const root = join(temporary, 'tree');
    await mkdir(root);
    await writeFile(join(root, 'file'), 'one');
    if (process.platform !== 'win32') await symlink('file', join(root, 'link'));
    const before = await treeFingerprint(root);
    await writeFile(join(root, 'file'), 'two');
    expect(await treeFingerprint(root)).not.toEqual(before);
  });

  it('serves manifests and prepares a redirected plugin in a symbolic path', async (context) => {
    try {
      await withManifestServer(REPOSITORY, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/latest.json`);
        expect(response.ok).toBe(true);
        expect(await response.json()).toMatchObject({ schema: 1 });
        const plugin = await preparePlugin(REPOSITORY, temporary, baseUrl);
        expect(await readFile(join(plugin, 'lib', 'moonbit_config.lua'), 'utf8')).toContain(
          baseUrl,
        );
        expect(await readFile(join(plugin, 'lib', 'sha2.lua'), 'utf8')).toContain('sha256');
      });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EPERM') context.skip();
      else throw error;
    }
  });

  it('requires the manifest endpoint setting', async () => {
    const source = await copyReleaseSource(join(temporary, 'source'));
    await writeFile(join(source, 'lib', 'moonbit_config.lua'), 'return {}');
    await expect(preparePlugin(source, join(temporary, 'out'), 'http://127.0.0.1')).rejects.toThrow(
      'redirect',
    );
  });

  it('checks root containment', async () => {
    const root = join(temporary, 'root');
    await mkdir(root);
    const child = join(root, 'child');
    await writeFile(child, 'ok');
    await expect(assertWithin(root, child)).resolves.toBeUndefined();
    await expect(assertWithin(root, join(temporary, 'missing'))).rejects.toThrow('escapes');
  });

  it('normalizes environment key casing and filesystem aliases', async () => {
    expect(environmentValue({ Path: 'tool path' }, 'PATH')).toBe('tool path');
    const root = join(temporary, 'real root');
    await mkdir(join(root, 'shims'), { recursive: true });
    await mkdir(join(root, 'bin'));
    const alias = join(temporary, 'root alias');
    if (process.platform !== 'win32') await symlink(root, alias, 'dir');
    const candidate = process.platform === 'win32' ? root : alias;
    await expect(pathsReferToSameEntry(root, candidate)).resolves.toBe(true);
    await expect(
      containsAdjacentPathEntries(
        [temporary, join(candidate, 'shims'), join(candidate, 'bin')],
        [join(root, 'shims'), join(root, 'bin')],
      ),
    ).resolves.toBe(true);
    await expect(
      containsAdjacentPathEntries(
        [join(candidate, 'bin'), join(candidate, 'shims')],
        [join(root, 'shims'), join(root, 'bin')],
      ),
    ).resolves.toBe(false);
  });

  it('validates executable, shim, moonx, and core layout', async () => {
    const version = '0.1.2+abc';
    const root = join(temporary, 'install root');
    await mkdir(join(root, 'bin', 'internal'), { recursive: true });
    for (const name of REQUIRED_EXECUTABLES) {
      await writeFile(join(root, 'bin', executableName(name)), name);
    }
    await mkdir(join(root, 'shims'));
    for (const name of HELPER_EXECUTABLES) {
      await writeFile(
        join(root, 'shims', `${name}${process.platform === 'win32' ? '.cmd' : ''}`),
        name,
      );
    }
    if (process.platform === 'win32') await writeFile(join(root, 'bin', 'moonx.exe'), 'moonx');
    else {
      await writeFile(join(root, 'bin', 'internal', 'tcc'), 'tcc');
      await symlink('moon', join(root, 'bin', 'moonx'));
    }
    await mkdir(join(root, 'lib', 'core', 'builtin'), { recursive: true });
    await writeFile(join(root, 'lib', 'core', 'moon.mod'), `version = "${version}"\n`);
    const builtin = join(root, 'lib', 'core', 'builtin', 'moon.pkg');
    await writeFile(builtin, 'builtin');
    await expect(validateInstall(root, version)).resolves.toBeUndefined();
    await unlink(builtin);
    await expect(validateInstall(root, version)).rejects.toThrow('builtin package');
  });

  it('runs fixed commands, accepts input, and reports nonzero exits', async () => {
    const env = { ...process.env };
    const echoCommand = process.platform === 'win32' ? ['cmd', '/d', '/s', '/c', 'more'] : ['cat'];
    const success = await run(echoCommand, {
      cwd: temporary,
      env,
      input: 'ok\n',
    });
    expect(success.stdout).toContain('ok');
    await expect(run(['node', '-e', 'process.exit(3)'], { cwd: temporary, env })).rejects.toThrow(
      'exited 3',
    );
    await expect(run([], { cwd: temporary, env })).rejects.toBeInstanceOf(E2EError);
  });

  it('parses CLI options and protects standalone vfox user state', async () => {
    expect(
      parseArguments(['--repo', REPOSITORY, '--backend', 'all', '--allow-vfox-user-state']),
    ).toEqual({
      allowVfoxUserState: true,
      backend: 'all',
      repository: REPOSITORY,
    });
    expect(() => parseArguments(['--backend', 'bad'])).toThrow('must be mise');
    expect(() => parseArguments(['--unknown'])).toThrow('unknown');
    const previousCi = process.env.CI;
    delete process.env.CI;
    await expect(main(['--repo', REPOSITORY, '--backend', 'vfox'])).resolves.toBe(2);
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
  });
});
