import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  documentedTasks,
  localLinks,
  main,
  miseTasks,
  parseArguments,
  validateDocumentation,
} from '../../scripts/check_documentation.ts';
import * as common from '../../scripts/lib/common.ts';

const VERSION = '0.1.3';
const PROJECT_TOOL_SPEC = "mise use 'vfox:maya0513/vfox-moonbit@latest'";
const PROJECT_CONFIG_SPEC = '"vfox:maya0513/vfox-moonbit" = "latest"';
const RELEASE_URL = `https://github.com/maya0513/vfox-moonbit/releases/download/v${VERSION}/vfox-moonbit-${VERSION}.zip`;
const OVERLAY_REVISION = 'edbca0874797c2ee227d4f9cc2b427747756717c';
let temporary: string;

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

function readme(extra = ''): string {
  return `${PROJECT_TOOL_SPEC}\nmoon version\n${PROJECT_CONFIG_SPEC}\nmise install\nmoon version\n${RELEASE_URL}\nmise 2026.9.2\nvfox 1.0.12\nMOON_TOOLCHAIN_ROOT\nMOON_HOME\n${extra}`;
}

async function fixture(): Promise<void> {
  await mkdir(join(temporary, 'docs'), { recursive: true });
  await Promise.all([
    write(
      join(temporary, 'metadata.lua'),
      [
        'PLUGIN = {}',
        'PLUGIN.name = "moonbit"',
        `PLUGIN.version = "${VERSION}"`,
        'PLUGIN.homepage = "https://github.com/maya0513/vfox-moonbit"',
        'PLUGIN.license = "MIT"',
        'PLUGIN.description = "test"',
        'PLUGIN.minRuntimeVersion = "1.0.12"',
        'PLUGIN.manifestUrl = "https://github.com/maya0513/vfox-moonbit/releases/download/manifest/manifest.json"',
      ].join('\n'),
    ),
    write(
      join(temporary, 'mise.toml'),
      'min_version = "2026.9.2"\nvfox = "1.0.12"\n[tasks.ci]\nrun = "true"\n',
    ),
    write(join(temporary, 'README.md'), readme('[architecture](docs/ARCHITECTURE.md)')),
    write(join(temporary, 'README.ja.md'), readme()),
    write(join(temporary, 'SECURITY.md'), 'Security\n'),
    write(
      join(temporary, 'docs', 'ARCHITECTURE.md'),
      `linux-x86_64 linux-aarch64 darwin-aarch64 windows-x86_64\n${OVERLAY_REVISION}\nLLVM bundle\n`,
    ),
    write(
      join(temporary, 'docs', 'ARCHITECTURE.ja.md'),
      `linux-x86_64 linux-aarch64 darwin-aarch64 windows-x86_64\n${OVERLAY_REVISION}\nLLVM bundle\n`,
    ),
  ]);
}

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'documentation-test-'));
  await fixture();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(temporary, { force: true, recursive: true });
});

describe('documentation checker', () => {
  it('extracts tasks and local links', () => {
    expect([...miseTasks('[tasks.ci]\n[tasks."fmt:check"]\n')]).toEqual(['ci', 'fmt:check']);
    expect([...documentedTasks('mise run ci; mise run fmt:check')]).toEqual(['ci', 'fmt:check']);
    expect(
      localLinks(
        '[local](docs/a.md#anchor) [angle](<docs/with space.md>) [web](https://example.com) [hash](#x)',
      ),
    ).toEqual(['docs/a.md', 'docs/with space.md']);
  });

  it('accepts the configured major vfox series', async () => {
    await write(join(temporary, 'mise.toml'), 'min_version = "2026.9.2"\nvfox = "1"\n');
    for (const name of ['README.md', 'README.ja.md']) {
      await write(join(temporary, name), readme().replace('vfox 1.0.12', 'vfox 1.x'));
    }
    await expect(validateDocumentation(temporary)).resolves.toBeUndefined();
  });

  it('runs the process entrypoint using the default repository', async () => {
    const exitCode = process.exitCode;
    const argv = process.argv;
    try {
      process.argv = [process.execPath, 'check_documentation.ts'];
      vi.doMock('../../scripts/lib/common.ts', () => ({ ...common, isMain: () => true }));
      vi.resetModules();
      await import('../../scripts/check_documentation.ts');
      expect(process.exitCode).toBe(0);
      expect(console.log).toHaveBeenCalledWith('documentation matches implementation facts');
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      vi.doUnmock('../../scripts/lib/common.ts');
      vi.resetModules();
    }
  });

  it('accepts documentation derived from implementation facts', async () => {
    await write(join(temporary, 'README.md'), readme('mise run ci'));
    await expect(validateDocumentation(temporary)).resolves.toBeUndefined();
    expect(parseArguments(['--repo', temporary])).toEqual({ repository: temporary });
    expect(parseArguments([]).repository).toBeTruthy();
    await expect(main(['--repo', temporary])).resolves.toBe(0);
  });

  it.each([
    ['README.md', readme().replace('MOON_HOME', 'USER_HOME'), 'mutable state'],
    ['README.ja.md', readme().replace('MOON_TOOLCHAIN_ROOT', 'USER_ROOT'), 'toolchain environment'],
    ['README.md', readme('mise run missing'), 'unknown mise task'],
    ['README.md', readme('[missing](absent.md)'), 'missing local path'],
    [
      'README.md',
      readme().replace('moon version\n', 'moon version --all --json --no-path\n'),
      'machine-only version probe',
    ],
    [
      'docs/ARCHITECTURE.md',
      'linux-x86_64 linux-aarch64 darwin-aarch64 windows-x86_64\nLLVM bundle\n',
      'comparison revision',
    ],
    [
      'docs/ARCHITECTURE.ja.md',
      `${OVERLAY_REVISION}\nLLVM bundle\n`,
      'docs/ARCHITECTURE.ja.md platform',
    ],
  ])('rejects drift in %s: %s', async (name, content, message) => {
    await write(join(temporary, name), content);
    await expect(validateDocumentation(temporary)).rejects.toThrow(message);
  });

  it('rejects malformed source configuration and arguments', async () => {
    await write(join(temporary, 'mise.toml'), 'vfox = "1.0.12"\n[tasks.ci]\nrun = "true"\n');
    await expect(validateDocumentation(temporary)).rejects.toThrow('mise version');
    expect(() => parseArguments(['--repo'])).toThrow('usage');
    expect(() => parseArguments(['--unknown', temporary])).toThrow('usage');
    await expect(main(['--unknown'])).resolves.toBe(1);
  });
});
