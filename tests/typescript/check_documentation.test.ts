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

const VERSION = '0.1.3';
const TOOL_SPEC = '"vfox:maya0513/vfox-moonbit" = "latest"';
const RELEASE_URL = `https://github.com/maya0513/vfox-moonbit/releases/download/v${VERSION}/vfox-moonbit-${VERSION}.zip`;
let temporary: string;

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

function readme(extra = ''): string {
  return `${TOOL_SPEC}\n${RELEASE_URL}\nmise 2026.9.2\nvfox 1.0.12\nMOON_TOOLCHAIN_ROOT\nMOON_HOME\n${extra}`;
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
        'PLUGIN.license = "Apache-2.0"',
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
    write(join(temporary, 'CONTRIBUTING.md'), 'Run `mise run ci`.\n'),
    write(join(temporary, 'SECURITY.md'), 'Security\n'),
    write(
      join(temporary, 'docs', 'ARCHITECTURE.md'),
      'linux-x86_64 linux-aarch64 darwin-aarch64 windows-x86_64\n',
    ),
    write(join(temporary, 'docs', 'REPOSITORY_SETTINGS.md'), 'Settings\n'),
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
        '[local](docs/a.md) [angle](<docs/with space.md>) [web](https://example.com) [hash](#x)',
      ),
    ).toEqual(['docs/a.md', 'docs/with space.md']);
  });

  it('accepts documentation derived from implementation facts', async () => {
    await expect(validateDocumentation(temporary)).resolves.toBeUndefined();
    expect(parseArguments(['--repo', temporary])).toEqual({ repository: temporary });
    expect(parseArguments([]).repository).toBeTruthy();
    await expect(main(['--repo', temporary])).resolves.toBe(0);
  });

  it('rejects missing facts, unknown tasks, and broken links', async () => {
    await write(join(temporary, 'README.md'), readme().replace('MOON_HOME', 'USER_HOME'));
    await expect(validateDocumentation(temporary)).rejects.toThrow('mutable state');

    await fixture();
    await write(join(temporary, 'CONTRIBUTING.md'), 'mise run missing\n');
    await expect(validateDocumentation(temporary)).rejects.toThrow('unknown mise task');

    await fixture();
    await write(join(temporary, 'README.md'), readme('[missing](absent.md)'));
    await expect(validateDocumentation(temporary)).rejects.toThrow('missing local path');
  });

  it('rejects malformed source configuration and arguments', async () => {
    await write(join(temporary, 'mise.toml'), 'vfox = "1.0.12"\n[tasks.ci]\nrun = "true"\n');
    await expect(validateDocumentation(temporary)).rejects.toThrow('mise version');
    expect(() => parseArguments(['--repo'])).toThrow('usage');
    expect(() => parseArguments(['--unknown', temporary])).toThrow('usage');
    await expect(main(['--unknown'])).resolves.toBe(1);
  });
});
