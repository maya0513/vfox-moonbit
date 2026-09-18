import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  checkActions,
  checkMaintenanceTooling,
  checkOwner,
  checkPluginCode,
  checkReleasePolicy,
  checkUpdaterWorkflow,
  EXPECTED_REPOSITORY,
  main,
  originSlug,
  parseArguments,
  RepositoryError,
  validate,
  workflowFiles,
} from '../../scripts/check_repository.ts';
import { releaseFiles } from '../../scripts/package_plugin.ts';
import {
  canonicalJson,
  coreUrl,
  encodeVersion,
  PLATFORMS,
  promote,
} from '../../scripts/update_latest.ts';
import { sha256 } from './fixtures.ts';

const REPOSITORY = resolve(fileURLToPath(new URL('../..', import.meta.url)));
let temporary: string;

function originResult(status: number, stdout: string): () => { status: number; stdout: string } {
  return () => ({ status, stdout });
}

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'repository-check-test-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
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

function validExact(version = '0.1.2+abc'): Record<string, unknown> {
  const encoded = encodeVersion(version);
  const platforms: Record<string, unknown> = {};
  for (const platform of PLATFORMS) {
    const coreFormat = platform.format === 'zip' ? 'zip' : 'tar.gz';
    platforms[platform.key] = {
      core: { format: platform.format, sha256: 'b'.repeat(64), url: coreUrl(version, coreFormat) },
      toolchain: {
        format: platform.format,
        sha256: 'a'.repeat(64),
        url: `https://cli.moonbitlang.com/binaries/${encoded}/${platform.filename}`,
      },
    };
  }
  return { platforms, recipe: 1, schema: 1, version };
}

async function makeReleaseRepository(root: string): Promise<void> {
  await mkdir(join(root, 'releases'), { recursive: true });
  await promote(root, validExact());
  const vendorBytes = Buffer.from('vendored');
  await writeFile(join(root, 'sha.lua'), vendorBytes);
  await writeFile(
    join(root, 'vendor-lock.json'),
    canonicalJson({ pure_lua_SHA: { file: 'sha.lua', sha256: sha256(vendorBytes) }, schema: 1 }),
  );
}

async function makeWorkflow(root: string, name: string, text: string): Promise<string> {
  const path = join(root, '.github', 'workflows', name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

async function makeMaintenanceConfiguration(root: string): Promise<void> {
  for (const name of [
    '.gitattributes',
    'mise.toml',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'vite.config.ts',
    'vite.tasks.ts',
  ]) {
    await copyFile(join(REPOSITORY, name), join(root, name));
  }
}

describe('ownership and runtime policy', () => {
  it('accepts the current owner and rejects metadata/config drift and placeholders', async () => {
    const root = await copyReleaseSource(join(temporary, 'owner'));
    await checkOwner(root);
    const metadata = join(root, 'metadata.lua');
    const original = await readFile(metadata, 'utf8');
    await writeFile(metadata, original.replace('maya0513/vfox-moonbit', 'other/vfox-moonbit'));
    await expect(checkOwner(root)).rejects.toThrow('homepage');
    await writeFile(
      metadata,
      original.replace('PLUGIN.license = "Apache-2.0"', 'PLUGIN.license = "custom"'),
    );
    await expect(checkOwner(root)).rejects.toThrow('SPDX');
    await writeFile(metadata, original.replace('releases/download/manifest', 'wrong/manifest'));
    await expect(checkOwner(root)).rejects.toThrow('manifestUrl');
    await writeFile(metadata, original);

    const config = join(root, 'lib', 'moonbit_config.lua');
    const originalConfig = await readFile(config, 'utf8');
    await writeFile(config, originalConfig.replace('owner = "maya0513"', 'owner = "wrong"'));
    await expect(checkOwner(root)).rejects.toThrow('repository owner');
    await writeFile(config, originalConfig);
    await writeFile(
      join(root, 'placeholder.md'),
      `publish at ${['<', 'owner', '>'].join('')}/vfox-moonbit`,
    );
    await expect(checkOwner(root)).rejects.toThrow('placeholder');
  });

  it.each([
    ['return { addition = {} }', 'addition archives'],
    ["os.execute('moonup install')", 'moonup'],
    ["os.execute('moon upgrade')", 'moon upgrade'],
  ])('rejects overlapping manager behavior', async (runtime, message) => {
    await mkdir(join(temporary, 'hooks'));
    await mkdir(join(temporary, 'lib'));
    await writeFile(join(temporary, 'metadata.lua'), 'PLUGIN = {}');
    await writeFile(join(temporary, 'hooks', 'available.lua'), runtime);
    await writeFile(join(temporary, 'lib', 'moonbit_runtime.lua'), 'return {}');
    await expect(checkPluginCode(temporary)).rejects.toThrow(message);
  });

  it('allows documentation warnings in metadata', async () => {
    await mkdir(join(temporary, 'hooks'));
    await mkdir(join(temporary, 'lib'));
    await writeFile(
      join(temporary, 'metadata.lua'),
      '-- Do not run moon upgrade; moonup is not used.',
    );
    await writeFile(join(temporary, 'hooks', 'available.lua'), 'return {}');
    await writeFile(join(temporary, 'lib', 'moonbit_runtime.lua'), 'return {}');
    await expect(checkPluginCode(temporary)).resolves.toBeUndefined();
  });
});

describe('release and Actions policy', () => {
  it('rejects non-JSON and oversized release files', async () => {
    await makeReleaseRepository(temporary);
    await writeFile(join(temporary, 'releases', 'binary.zip'), 'x');
    await expect(checkReleasePolicy(temporary)).rejects.toThrow('JSON manifests only');
    await rm(join(temporary, 'releases', 'binary.zip'));
    await writeFile(join(temporary, 'releases', 'large.json'), Buffer.alloc(1024 * 1024 + 1));
    await expect(checkReleasePolicy(temporary)).rejects.toThrow('exceeds');
  });

  it('requires workflows and full action commit pins', async () => {
    await expect(workflowFiles(temporary)).resolves.toEqual([]);
    await mkdir(join(temporary, '.github', 'workflows'), { recursive: true });
    await expect(checkActions(temporary)).rejects.toThrow('no GitHub Actions');
    const workflow = await makeWorkflow(
      temporary,
      'ci.yml',
      'steps:\n  - uses: ./local\n  - uses: actions/checkout@v6\n',
    );
    await expect(checkActions(temporary)).rejects.toThrow('not pinned');
    await writeFile(
      workflow,
      `steps:\n  - uses: ./local\n  - uses: actions/checkout@${'a'.repeat(40)}\n`,
    );
    await expect(checkActions(temporary)).resolves.toBeUndefined();
  });

  it('enforces the GitHub App updater identity contract', async () => {
    await expect(checkUpdaterWorkflow(temporary)).rejects.toThrow('workflow is missing');
    const original = await readFile(
      join(REPOSITORY, '.github', 'workflows', 'update-latest.yml'),
      'utf8',
    );
    const workflow = await makeWorkflow(temporary, 'update-latest.yml', original);
    await expect(checkUpdaterWorkflow(temporary)).resolves.toBeUndefined();
    await writeFile(
      workflow,
      original.replace(
        'client-id: ${{ vars.MOONBIT_UPDATER_CLIENT_ID }}',
        'app-id: ${{ secrets.MOONBIT_UPDATER_APP_ID }}',
      ),
    );
    await expect(checkUpdaterWorkflow(temporary)).rejects.toThrow('legacy GitHub App ID');
    await writeFile(workflow, original.replace('${APP_SLUG}[bot]', 'moonbit-updater[bot]'));
    await expect(checkUpdaterWorkflow(temporary)).rejects.toThrow('static, unattributed');
    await writeFile(
      workflow,
      original.replaceAll('BOT_EMAIL: ${{ steps.app-user.outputs.email }}', ''),
    );
    await expect(checkUpdaterWorkflow(temporary)).rejects.toThrow('incomplete GitHub App');
  });
});

describe('Node maintenance tooling policy', () => {
  it('accepts pinned Node/Vite+ configuration and rejects Python remnants', async () => {
    await makeMaintenanceConfiguration(temporary);
    await makeWorkflow(
      temporary,
      'ci.yml',
      `steps:\n  - uses: actions/cache/restore@${'a'.repeat(40)}\n    with:\n      path: node_modules/.vite/task-cache\n  - uses: actions/cache/save@${'b'.repeat(40)}\n`,
    );
    await expect(checkMaintenanceTooling(temporary)).resolves.toBeUndefined();
    await writeFile(join(temporary, 'tool.py'), 'print(1)');
    await expect(checkMaintenanceTooling(temporary)).rejects.toThrow('Python maintenance files');
    await rm(join(temporary, 'tool.py'));
    await writeFile(
      join(temporary, '.github', 'workflows', 'ci.yml'),
      'uses: actions/cache/restore@ref\nuses: actions/cache/save@ref\npath: node_modules/.vite/task-cache\nrun: python tool.py\n',
    );
    await expect(checkMaintenanceTooling(temporary)).rejects.toThrow('forbidden Python tooling');
  });

  it('rejects missing or unpinned package configuration', async () => {
    await expect(checkMaintenanceTooling(temporary)).rejects.toThrow('configuration is missing');
    await makeMaintenanceConfiguration(temporary);
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: false }));
    await expect(checkMaintenanceTooling(temporary)).rejects.toThrow('must pin');
    await writeFile(join(temporary, 'package.json'), '[]');
    await expect(checkMaintenanceTooling(temporary)).rejects.toThrow('contain an object');
  });

  it('rejects dependency, workspace, TypeScript, and mise drift', async () => {
    await makeMaintenanceConfiguration(temporary);
    const packagePath = join(temporary, 'package.json');
    const packageText = await readFile(packagePath, 'utf8');
    await writeFile(packagePath, packageText.replace('"tar": "7.5.22"', '"tar": "7.5.21"'));
    await expect(checkMaintenanceTooling(temporary)).rejects.toThrow('maintenance packages');
    await writeFile(packagePath, packageText);

    const workspacePath = join(temporary, 'pnpm-workspace.yaml');
    const workspaceText = await readFile(workspacePath, 'utf8');
    await writeFile(workspacePath, workspaceText.replace('vitest@*', 'vitest'));
    await expect(checkMaintenanceTooling(temporary)).rejects.toThrow('Vite/Vitest overrides');
    await writeFile(workspacePath, workspaceText);

    await writeFile(join(temporary, '.gitattributes'), '* text=auto\n');
    await expect(checkMaintenanceTooling(temporary)).rejects.toThrow('package inputs on LF');
    await copyFile(join(REPOSITORY, '.gitattributes'), join(temporary, '.gitattributes'));

    const tsconfigPath = join(temporary, 'tsconfig.json');
    const tsconfigText = await readFile(tsconfigPath, 'utf8');
    await writeFile(tsconfigPath, tsconfigText.replace('"strict": true', '"strict": false'));
    await expect(checkMaintenanceTooling(temporary)).rejects.toThrow('strict erasable Node');
    await writeFile(tsconfigPath, tsconfigText);

    const misePath = join(temporary, 'mise.toml');
    const miseText = await readFile(misePath, 'utf8');
    await writeFile(misePath, miseText.replace('node = "24.21.0"', 'node = "24.20.0"'));
    await expect(checkMaintenanceTooling(temporary)).rejects.toThrow('Node.js and pnpm');
  });
});

describe('origin and CLI behavior', () => {
  it.each([
    ['https://github.com/maya0513/vfox-moonbit.git\n', 0, 'maya0513/vfox-moonbit'],
    ['git@github.com:maya0513/vfox-moonbit.git\n', 0, 'maya0513/vfox-moonbit'],
    ['https://example.test/repo\n', 0, ''],
    ['', 1, undefined],
  ])('parses origin %s', (stdout, status, expected) => {
    expect(originSlug(temporary, () => ({ status, stdout }))).toBe(expected);
  });

  it('parses CLI arguments and reports a repository failure', async () => {
    expect(parseArguments(['--repo', REPOSITORY, '--require-origin'])).toEqual({
      repository: REPOSITORY,
      requireOrigin: true,
    });
    expect(() => parseArguments(['--repo'])).toThrow('requires');
    expect(() => parseArguments(['--bad'])).toThrow('unknown');
    await expect(main(['--repo', temporary])).resolves.toBe(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('repository check failed'));
  });

  it('validates the completed repository policy', async () => {
    await expect(validate(REPOSITORY, { requireOrigin: true })).resolves.toBeUndefined();
    expect(EXPECTED_REPOSITORY).toBe('maya0513/vfox-moonbit');
    await expect(main(['--repo', REPOSITORY, '--require-origin'])).resolves.toBe(0);
  });

  it('rejects missing, malformed, and wrong origin remotes', async () => {
    await expect(
      validate(REPOSITORY, { originReader: originResult(1, ''), requireOrigin: true }),
    ).rejects.toThrow('required');
    await expect(
      validate(REPOSITORY, { originReader: originResult(0, 'https://example.test/repository\n') }),
    ).rejects.toThrow('invalid URL');
    await expect(
      validate(REPOSITORY, {
        originReader: originResult(0, 'https://github.com/other/repository.git\n'),
      }),
    ).rejects.toThrow('other/repository');
  });

  it('exposes the repository error type', () => {
    expect(new RepositoryError('broken')).toBeInstanceOf(Error);
  });
});
