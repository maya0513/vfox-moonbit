import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
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

import * as yauzl from 'yauzl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  build,
  canonicalJson,
  main,
  PackageError,
  parseArguments,
  parseMetadata,
  releaseFiles,
} from '../../scripts/package_plugin.ts';

const REPOSITORY = resolve(fileURLToPath(new URL('../..', import.meta.url)));
let temporary: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'vfox-package-test-'));
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

interface ZipMetadata {
  names: string[];
  modes: number[];
  dates: Date[];
}

function zipMetadata(path: string): Promise<ZipMetadata> {
  return new Promise((resolveZip, rejectZip) => {
    yauzl.open(path, { lazyEntries: true }, (error, archive) => {
      if (error !== null || archive === undefined) {
        rejectZip(error ?? new Error('no ZIP archive'));
        return;
      }
      const names: string[] = [];
      const modes: number[] = [];
      const dates: Date[] = [];
      archive.on('entry', (entry) => {
        names.push(entry.fileName);
        modes.push((entry.externalFileAttributes >>> 16) & 0o777);
        dates.push(entry.getLastModDate());
        archive.readEntry();
      });
      archive.once('error', rejectZip);
      archive.once('end', () => resolveZip({ dates, modes, names }));
      archive.readEntry();
    });
  });
}

describe('plugin metadata and release inputs', () => {
  it('parses required strings and lists', async () => {
    const metadata = await parseMetadata(join(REPOSITORY, 'metadata.lua'));
    expect(metadata.name).toBe('moonbit');
    expect(metadata.version).toBe('0.1.0');
    expect(metadata.depends).toEqual(['git']);
    expect(metadata.legacyFilenames).toEqual([]);
    expect(metadata.notes).toHaveLength(2);
  });

  it('rejects missing metadata and the wrong plugin name', async () => {
    await expect(parseMetadata(join(temporary, 'missing.lua'))).rejects.toThrow('cannot read');
    const metadata = join(temporary, 'metadata.lua');
    await writeFile(metadata, 'PLUGIN.name = "moonbit"\n');
    await expect(parseMetadata(metadata)).rejects.toThrow('missing fields');
    await writeFile(
      metadata,
      (await readFile(join(REPOSITORY, 'metadata.lua'), 'utf8')).replace(
        'PLUGIN.name = "moonbit"',
        'PLUGIN.name = "wrong"',
      ),
    );
    await expect(parseMetadata(metadata)).rejects.toThrow('must name');
  });

  it('rejects missing required inputs and symlinks', async () => {
    await expect(releaseFiles(join(temporary, 'absent'))).rejects.toThrow('missing');
    const missingRoot = await copyReleaseSource(join(temporary, 'missing'));
    await unlink(join(missingRoot, 'LICENSE'));
    await expect(releaseFiles(missingRoot)).rejects.toThrow('missing');

    const missingHook = await copyReleaseSource(join(temporary, 'hook'));
    await unlink(join(missingHook, 'hooks', 'available.lua'));
    await expect(releaseFiles(missingHook)).rejects.toThrow('required hook');

    const missingVendor = await copyReleaseSource(join(temporary, 'vendor'));
    await unlink(join(missingVendor, 'lib', 'sha2.lua'));
    await expect(releaseFiles(missingVendor)).rejects.toThrow('vendored SHA');

    const linked = await copyReleaseSource(join(temporary, 'linked'));
    await unlink(join(linked, 'README.md'));
    await symlink('README.ja.md', join(linked, 'README.md'));
    await expect(releaseFiles(linked)).rejects.toThrow('symlink');
  });
});

describe('deterministic package output', () => {
  it('builds byte-identical complete ZIP files, checksums, and manifests', async () => {
    const first = await build(REPOSITORY, join(temporary, 'first'));
    const second = await build(REPOSITORY, join(temporary, 'second'), '0.1.0');
    const firstBytes = await readFile(first.archive);
    expect(firstBytes.equals(await readFile(second.archive))).toBe(true);
    await writeFile(first.archive, 'stale output');
    const rebuilt = await build(REPOSITORY, join(temporary, 'first'));
    expect(firstBytes.equals(await readFile(rebuilt.archive))).toBe(true);

    const digest = createHash('sha256').update(firstBytes).digest('hex');
    expect(await readFile(first.checksum, 'ascii')).toBe(`${digest}  vfox-moonbit-0.1.0.zip\n`);
    const manifest: unknown = JSON.parse(await readFile(first.manifest, 'utf8'));
    expect(manifest).toMatchObject({
      downloadUrl:
        'https://github.com/maya0513/vfox-moonbit/releases/download/v0.1.0/vfox-moonbit-0.1.0.zip',
      minRuntimeVersion: '1.0.12',
    });

    const metadata = await zipMetadata(first.archive);
    expect(metadata.names).toEqual(metadata.names.toSorted());
    expect(metadata.names).toContain('metadata.lua');
    expect(metadata.names).toContain('hooks/post_install.lua');
    expect(metadata.names).toContain('lib/sha2.lua');
    expect(metadata.names).not.toContain('releases/latest.json');
    expect(new Set(metadata.modes)).toEqual(new Set([0o644]));
    expect(new Set(metadata.dates.map((date) => date.toISOString()))).toEqual(
      new Set(['1980-01-01T00:00:00.000Z']),
    );
  });

  it.each(['v1.2.3', '1.2', '01.2.3', '1.2.3-beta'])(
    'rejects non-SemVer version %s',
    async (version) => {
      await expect(
        build(REPOSITORY, join(temporary, version.replaceAll('/', '_')), version),
      ).rejects.toBeInstanceOf(PackageError);
    },
  );

  it('rejects tag mismatch and wrong homepage', async () => {
    await expect(build(REPOSITORY, join(temporary, 'mismatch'), '1.2.3')).rejects.toThrow(
      'does not match',
    );
    const source = await copyReleaseSource(join(temporary, 'source'));
    const metadata = join(source, 'metadata.lua');
    await writeFile(
      metadata,
      (await readFile(metadata, 'utf8')).replace(
        'https://github.com/maya0513/vfox-moonbit',
        'https://example.test/wrong',
      ),
    );
    await expect(build(source, join(temporary, 'wrong-homepage'))).rejects.toThrow('homepage');
  });

  it('sorts canonical JSON and parses CLI options', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
    expect(
      parseArguments(['--repo', REPOSITORY, '--output', temporary, '--version', '0.1.0']),
    ).toEqual({
      output: temporary,
      repository: REPOSITORY,
      version: '0.1.0',
    });
    expect(() => parseArguments(['--repo'])).toThrow('requires');
    expect(() => parseArguments(['--unknown'])).toThrow('unknown');
  });

  it('reports CLI success and validation failures', async () => {
    await expect(main(['--repo', REPOSITORY, '--output', join(temporary, 'dist')])).resolves.toBe(
      0,
    );
    await expect(
      main(['--repo', REPOSITORY, '--output', join(temporary, 'bad'), '--version', 'bad']),
    ).resolves.toBe(1);
    expect(console.log).toHaveBeenCalled();
  });

  it('only packages regular source files', async () => {
    for (const path of await releaseFiles(REPOSITORY))
      expect((await lstat(path)).isFile()).toBe(true);
  });
});
