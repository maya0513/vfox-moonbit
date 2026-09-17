import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  canonicalJson,
  checkInstallers,
  CDN,
  coreUrl,
  coreVersion,
  DEFAULT_LIMITS,
  discover,
  Downloader,
  encodeVersion,
  filesEqual,
  IncompleteRelease,
  inspectArchive,
  inspectTar,
  inspectZip,
  latestPointer,
  loadJson,
  main,
  ManualReviewRequired,
  parseArguments,
  parseChecksum,
  PLATFORMS,
  promote,
  safeLink,
  safeName,
  SupplyChainError,
  UpdateError,
  validateExact,
  validateLocal,
} from '../../scripts/update_latest.ts';
import {
  corruptZipPayload,
  createReleaseFixture,
  FakeDownloader,
  installerBytes,
  replaceZipName,
  setZipCrc,
  setZipEncrypted,
  sha256,
  tarBytes,
  type ReleaseFixture,
  zipBytes,
} from './fixtures.ts';

let temporary: string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'vfox-moonbit-test-'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(temporary, { force: true, recursive: true });
});

async function archiveFile(name: string, data: Buffer): Promise<string> {
  const path = join(temporary, name);
  await writeFile(path, data);
  return path;
}

function validExact(version = '0.1.2+abc'): Record<string, unknown> {
  const encoded = encodeVersion(version);
  const platforms: Record<string, unknown> = {};
  for (const platform of PLATFORMS) {
    const coreFormat = platform.format === 'zip' ? 'zip' : 'tar.gz';
    platforms[platform.key] = {
      core: {
        format: platform.format,
        sha256: 'b'.repeat(64),
        url: coreUrl(version, coreFormat),
      },
      toolchain: {
        format: platform.format,
        sha256: 'a'.repeat(64),
        url: `${CDN}/binaries/${encoded}/${platform.filename}`,
      },
    };
  }
  return { platforms, recipe: 1, schema: 1, version };
}

async function writeVendorLock(repository: string): Promise<void> {
  const vendor = join(repository, 'sha.lua');
  const content = Buffer.from('vendored');
  await writeFile(vendor, content);
  await writeFile(
    join(repository, 'vendor-lock.json'),
    canonicalJson({ pure_lua_SHA: { file: 'sha.lua', sha256: sha256(content) }, schema: 1 }),
  );
}

async function makeLocalRepository(repository: string): Promise<Record<string, unknown>> {
  await mkdir(join(repository, 'releases'), { recursive: true });
  const exact = validExact();
  await promote(repository, exact);
  await writeVendorLock(repository);
  return exact;
}

describe('version and JSON helpers', () => {
  it('encodes exact pre-1.0 versions and creates canonical pointers', () => {
    expect(encodeVersion('0.10.2+abc-def.1')).toBe('0.10.2%2Babc-def.1');
    expect(latestPointer('0.1.0+a')).toEqual({
      manifest: '0.1.0+a.json',
      recipe: 1,
      schema: 1,
      version: '0.1.0+a',
    });
    expect(canonicalJson({ z: 1, a: { d: 2, c: 1 } })).toBe(
      '{\n  "a": {\n    "c": 1,\n    "d": 2\n  },\n  "z": 1\n}\n',
    );
    expect(canonicalJson([{ z: 1 }, 'value'])).toBe('[\n  {\n    "z": 1\n  },\n  "value"\n]\n');
  });

  it.each([
    'latest',
    '1.0.0+abc',
    '0.01.0+abc',
    '0.1.01+abc',
    '0.1',
    '0.1.0',
    '0.1.0+',
    '0.1.0+a/b',
  ])('rejects unsupported version %s', (version) =>
    expect(() => encodeVersion(version)).toThrow(ManualReviewRequired),
  );

  it('parses strict checksum files', () => {
    const digest = 'a'.repeat(64);
    expect(parseChecksum(Buffer.from(`${digest}  moon.zip\n`), 'moon.zip')).toBe(digest);
    expect(parseChecksum(Buffer.from(`${digest.toUpperCase()} *moon.zip`), 'moon.zip')).toBe(
      digest,
    );
    for (const malformed of [
      Buffer.from('no'),
      Buffer.from(`${digest} wrong.zip`),
      Buffer.from([0xff]),
    ]) {
      expect(() => parseChecksum(malformed, 'moon.zip')).toThrow(SupplyChainError);
    }
  });
});

describe('streaming downloader', () => {
  it('downloads to a private temporary file and cleans it up', async () => {
    let requestHeaders: Headers | undefined;
    const fakeFetch: typeof fetch = async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(Buffer.from('payload'), { headers: { 'Content-Length': '7' } });
    };
    const downloader = new Downloader({ fetchImplementation: fakeFetch, timeoutMs: 1000 });
    const downloaded = await downloader.fetch('https://example.test/a', 8);
    expect(await readFile(downloaded.path, 'utf8')).toBe('payload');
    expect(downloaded.sha256).toBe(createHash('sha256').update('payload').digest('hex'));
    expect(requestHeaders?.get('user-agent')).toContain('maya0513/');
    await downloader.dispose();
    await expect(stat(downloaded.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await downloader.dispose();
  });

  it('rejects invalid schemes, statuses, lengths, streams, and transport failures', async () => {
    const downloader = new Downloader();
    await expect(downloader.fetch('http://example.test/a', 8)).rejects.toThrow('non-HTTPS');

    for (const [status, error] of [
      [403, IncompleteRelease],
      [404, IncompleteRelease],
      [409, IncompleteRelease],
      [500, UpdateError],
    ] as const) {
      const failing = new Downloader({
        fetchImplementation: async () => new Response('', { status }),
      });
      await expect(failing.fetch('https://example.test/a', 8)).rejects.toBeInstanceOf(error);
    }

    const tooLargeHeader = new Downloader({
      fetchImplementation: async () => new Response('x', { headers: { 'Content-Length': '99' } }),
    });
    await expect(tooLargeHeader.fetch('https://example.test/a', 2)).rejects.toThrow('size limit');
    const invalidHeader = new Downloader({
      fetchImplementation: async () => new Response('x', { headers: { 'Content-Length': 'bad' } }),
    });
    await expect(invalidHeader.fetch('https://example.test/a', 2)).rejects.toThrow(
      'invalid Content-Length',
    );
    const streamed = new Downloader({ fetchImplementation: async () => new Response('abc') });
    await expect(streamed.fetch('https://example.test/a', 2)).rejects.toThrow('size limit');
    const empty = new Downloader({ fetchImplementation: async () => new Response(null) });
    await expect(empty.fetch('https://example.test/a', 2)).rejects.toThrow('no response body');
    const brokenStream = new Downloader({
      fetchImplementation: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('broken stream'));
            },
          }),
        ),
    });
    await expect(brokenStream.fetch('https://example.test/a', 20)).rejects.toThrow(
      'failed to download',
    );
    const offline = new Downloader({
      fetchImplementation: async () => {
        throw new Error('offline');
      },
    });
    await expect(offline.fetch('https://example.test/a', 2)).rejects.toThrow('failed to download');
  });
});

describe('archive path validation', () => {
  it.each(['/etc/passwd', 'C:/escape', '../escape', 'a/../../escape', 'a\\..\\..\\escape', 'a\0b'])(
    'rejects unsafe member %s',
    (name) => expect(() => safeName(name)).toThrow(SupplyChainError),
  );

  it('normalizes roots and checks relative link targets', () => {
    expect(safeName('./core/moon.mod')).toBe('core/moon.mod');
    expect(safeName('.')).toBe('');
    safeLink('core/docs/readme', '../README.md');
    expect(() => safeLink('core/readme', '../../outside')).toThrow('escapes');
    expect(() => safeLink('core/readme', '/outside')).toThrow('absolute');
    expect(() => safeLink('core/readme', 'bad\0target')).toThrow('NUL');
  });

  it('inspects valid tar and ZIP layouts without extraction', async () => {
    const tar = tarBytes([
      { content: Buffer.from('moon'), name: './bin/moon' },
      { content: Buffer.from('ok'), name: './readme' },
      { link: '../readme', name: './docs/link', type: 'symlink' },
    ]);
    const zip = await zipBytes([
      { content: Buffer.from('moon'), name: 'bin/moon.exe' },
      { content: Buffer.from('../bin/moon.exe'), mode: 0o120777, name: 'docs/link' },
    ]);
    expect(
      (
        await inspectTar(await archiveFile('tool.tar.gz', tar), {
          label: 'tool',
          required: ['bin/moon'],
        })
      ).names,
    ).toContain('bin/moon');
    expect(
      (
        await inspectZip(await archiveFile('tool.zip', zip), {
          label: 'tool',
          required: ['bin/moon.exe'],
        })
      ).names,
    ).toContain('bin/moon.exe');
    await expect(inspectArchive('missing', '7z', { label: 'tool', required: [] })).rejects.toThrow(
      'unsupported archive format',
    );
  });

  it('applies tar hardlink root semantics and rejects unsafe special entries', async () => {
    const valid = tarBytes([
      { content: Buffer.from('ok'), name: 'core/target' },
      { link: 'core/target', name: 'core/link', type: 'hardlink' },
    ]);
    await inspectTar(await archiveFile('hardlink.tar.gz', valid), {
      label: 'core',
      required: ['core/link'],
    });
    const invalidCases = [
      tarBytes([{ content: Buffer.from('x'), name: '../escape' }]),
      tarBytes([
        { content: Buffer.from('x'), name: 'ok' },
        { link: '../outside', name: 'link', type: 'symlink' },
      ]),
      tarBytes([{ name: 'pipe', type: 'fifo' }]),
      tarBytes([{ link: '../outside', name: 'core/link', type: 'hardlink' }]),
    ];
    for (const [index, data] of invalidCases.entries()) {
      await expect(
        inspectTar(await archiveFile(`unsafe-${index}.tar.gz`, data), {
          label: 'unsafe',
          required: [],
        }),
      ).rejects.toBeInstanceOf(SupplyChainError);
    }
  });

  it('accepts archive root entries and rejects oversized tar metadata and missing input', async () => {
    const rootTar = await archiveFile(
      'root.tar.gz',
      tarBytes([{ content: Buffer.alloc(0), name: '.' }]),
    );
    await expect(inspectTar(rootTar, { label: 'root', required: [] })).resolves.toMatchObject({
      names: new Set(),
    });
    const metadataTar = await archiveFile(
      'metadata.tar.gz',
      tarBytes([{ content: Buffer.alloc(10), name: 'core/moon.mod' }]),
    );
    await expect(
      inspectTar(metadataTar, {
        label: 'core',
        limits: { ...DEFAULT_LIMITS, metadataBytes: 2 },
        required: [],
      }),
    ).rejects.toThrow('size limit');
    await expect(
      inspectTar(join(temporary, 'absent.tar.gz'), { label: 'missing', required: [] }),
    ).rejects.toThrow('invalid missing tar.gz');
  });

  it('rejects ZIP traversal, escaping links, special files, and encryption', async () => {
    const cases = [
      replaceZipName(
        await zipBytes([{ content: Buffer.from('x'), name: 'ok/escape' }]),
        'ok/escape',
        '../escape',
      ),
      await zipBytes([{ content: Buffer.from('../outside'), mode: 0o120777, name: 'link' }]),
      await zipBytes([{ mode: 0o010644, name: 'pipe' }]),
      setZipEncrypted(await zipBytes([{ content: Buffer.from('secret'), name: 'secret' }])),
    ];
    for (const [index, data] of cases.entries()) {
      await expect(
        inspectZip(await archiveFile(`unsafe-${index}.zip`, data), {
          label: 'unsafe',
          required: [],
        }),
      ).rejects.toBeInstanceOf(SupplyChainError);
    }
  });

  it('drains directory/root ZIP entries and rejects corrupt compressed data', async () => {
    const directories = await archiveFile(
      'directories.zip',
      await zipBytes([
        { content: Buffer.alloc(0), name: '.' },
        { directory: true, name: 'folder/' },
      ]),
    );
    await expect(
      inspectZip(directories, { label: 'directories', required: ['folder'] }),
    ).resolves.toBeDefined();
    const corrupt = corruptZipPayload(
      await zipBytes([{ content: Buffer.alloc(4096, 0x61), name: 'payload' }]),
    );
    await expect(
      inspectZip(await archiveFile('corrupt.zip', corrupt), { label: 'corrupt', required: [] }),
    ).rejects.toBeInstanceOf(SupplyChainError);
    const wrongCrc = setZipCrc(
      await zipBytes([{ content: Buffer.from('valid payload'), name: 'payload' }]),
      0,
    );
    await expect(
      inspectZip(await archiveFile('crc.zip', wrongCrc), { label: 'crc', required: [] }),
    ).rejects.toThrow('CRC-32 mismatch');
  });

  it('rejects malformed, missing, colliding, oversized, and overpopulated archives', async () => {
    await expect(
      inspectTar(await archiveFile('bad.tar.gz', Buffer.from('not tar')), {
        label: 'tool',
        required: [],
      }),
    ).rejects.toThrow('invalid');
    await expect(
      inspectZip(await archiveFile('bad.zip', Buffer.from('not zip')), {
        label: 'tool',
        required: [],
      }),
    ).rejects.toThrow('invalid');
    const missing = tarBytes([{ content: Buffer.from('x'), name: 'other' }]);
    await expect(
      inspectTar(await archiveFile('missing.tar.gz', missing), {
        label: 'tool',
        required: ['bin/moon'],
      }),
    ).rejects.toThrow('missing required');
    const collisionTar = tarBytes([
      { content: Buffer.from('x'), name: 'Same' },
      { content: Buffer.from('x'), name: 'same' },
    ]);
    const collisionZip = await zipBytes([
      { content: Buffer.from('x'), name: 'Same' },
      { content: Buffer.from('x'), name: 'same' },
    ]);
    await expect(
      inspectTar(await archiveFile('collision.tar.gz', collisionTar), {
        label: 'tool',
        required: [],
      }),
    ).rejects.toThrow('colliding');
    await expect(
      inspectZip(await archiveFile('collision.zip', collisionZip), { label: 'tool', required: [] }),
    ).rejects.toThrow('colliding');

    const oneTar = await archiveFile(
      'one.tar.gz',
      tarBytes([{ content: Buffer.from('1'), name: 'one' }]),
    );
    const oneZip = await archiveFile(
      'one.zip',
      await zipBytes([{ content: Buffer.from('1'), name: 'one' }]),
    );
    const noMembers = { ...DEFAULT_LIMITS, members: 0 };
    const noBytes = { ...DEFAULT_LIMITS, uncompressedBytes: 0 };
    await expect(
      inspectTar(oneTar, { label: 'tool', limits: noMembers, required: [] }),
    ).rejects.toThrow('too many');
    await expect(
      inspectZip(oneZip, { label: 'tool', limits: noMembers, required: [] }),
    ).rejects.toThrow('too many');
    await expect(
      inspectTar(oneTar, { label: 'tool', limits: noBytes, required: [] }),
    ).rejects.toThrow('size limit');
    await expect(
      inspectZip(oneZip, { label: 'tool', limits: noBytes, required: [] }),
    ).rejects.toThrow('size limit');
  });

  it('extracts and validates core metadata from either archive format', async () => {
    const mod = Buffer.from('name = "moonbitlang/core"\nversion = "0.2.3+abc"\n');
    const tar = await inspectTar(
      await archiveFile('core.tar.gz', tarBytes([{ content: mod, name: './core/moon.mod' }])),
      { label: 'core', required: ['core/moon.mod'] },
    );
    const zip = await inspectZip(
      await archiveFile('core.zip', await zipBytes([{ content: mod, name: 'core/moon.mod' }])),
      { label: 'core', required: ['core/moon.mod'] },
    );
    expect(coreVersion(tar.moonMod)).toBe('0.2.3+abc');
    expect(coreVersion(zip.moonMod)).toBe('0.2.3+abc');
    expect(() => coreVersion(undefined)).toThrow('no regular');
    expect(() => coreVersion(Buffer.from('name = 1'))).toThrow('no top-level version');
    expect(() => coreVersion(Buffer.from([0xff]))).toThrow('not UTF-8');
    const large = await archiveFile(
      'large-core.zip',
      await zipBytes([{ content: Buffer.alloc(10), name: 'core/moon.mod' }]),
    );
    await expect(
      inspectZip(large, {
        label: 'core',
        limits: { ...DEFAULT_LIMITS, metadataBytes: 2 },
        required: [],
      }),
    ).rejects.toThrow('size limit');
  });
});

describe('installer and release discovery', () => {
  let fixture: ReleaseFixture;
  beforeEach(async () => {
    fixture = await createReleaseFixture(join(temporary, 'repository'));
  });

  it('checks installer digests and recipe markers', async () => {
    await checkInstallers(
      fixture.repository,
      new FakeDownloader(join(temporary, 'downloads'), fixture.mapping),
    );
    const changed = new Map(fixture.mapping);
    changed.set(`${CDN}/install/unix.sh`, Buffer.from('changed'));
    await expect(
      checkInstallers(fixture.repository, new FakeDownloader(join(temporary, 'changed'), changed)),
    ).rejects.toThrow('installer changed');

    const lockPath = join(fixture.repository, 'upstream', 'installers.json');
    const lock = await loadJson(lockPath);
    const files = lock.files;
    expect(files).toBeTypeOf('object');
    if (!isRecord(files)) throw new Error('fixture lock');
    const unix = files.unix;
    if (!isRecord(unix)) throw new Error('fixture unix');
    unix.sha256 = 'bad';
    await writeFile(lockPath, canonicalJson(lock));
    await expect(
      checkInstallers(
        fixture.repository,
        new FakeDownloader(join(temporary, 'invalid-lock'), fixture.mapping),
      ),
    ).rejects.toThrow('lock record');
  });

  it('rejects installer schema, origin, and recipe drift', async () => {
    const lockPath = join(fixture.repository, 'upstream', 'installers.json');
    const lock = await loadJson(lockPath);
    lock.schema = 2;
    await writeFile(lockPath, canonicalJson(lock));
    await expect(
      checkInstallers(
        fixture.repository,
        new FakeDownloader(join(temporary, 'schema'), fixture.mapping),
      ),
    ).rejects.toThrow('lock schema');

    lock.schema = 1;
    const files = lock.files;
    if (!isRecord(files)) throw new Error('fixture lock');
    const unix = files.unix;
    if (!isRecord(unix)) throw new Error('fixture unix');
    unix.url = 'https://evil.test/unix.sh';
    await writeFile(lockPath, canonicalJson(lock));
    await expect(
      checkInstallers(
        fixture.repository,
        new FakeDownloader(join(temporary, 'origin'), fixture.mapping),
      ),
    ).rejects.toThrow('official CDN');

    const changed = installerBytes('unix').toString().replace('ln -sfn moon', 'different recipe');
    unix.url = `${CDN}/install/unix.sh`;
    unix.sha256 = sha256(Buffer.from(changed));
    await writeFile(lockPath, canonicalJson(lock));
    const mapping = new Map(fixture.mapping);
    mapping.set(`${CDN}/install/unix.sh`, Buffer.from(changed));
    await expect(
      checkInstallers(fixture.repository, new FakeDownloader(join(temporary, 'recipe'), mapping)),
    ).rejects.toThrow('no longer matches');
  });

  it('discovers a complete coherent release', async () => {
    const exact = await discover(
      fixture.repository,
      new FakeDownloader(join(temporary, 'complete'), fixture.mapping),
    );
    expect(exact.version).toBe(fixture.version);
    expect(Object.keys(exact.platforms).toSorted()).toEqual(
      PLATFORMS.map((item) => item.key).toSorted(),
    );
    for (const platform of PLATFORMS) {
      expect(exact.platforms[platform.key]?.toolchain.sha256).toBe(
        sha256(fixture.archives.get(platform.key) ?? Buffer.alloc(0)),
      );
      expect(exact.platforms[platform.key]?.toolchain.url).toContain('%2B');
    }
  });

  it('defers partial publication and cross-format version skew', async () => {
    const partial = new Map(fixture.mapping);
    const platform = PLATFORMS[0];
    if (platform === undefined) throw new Error('platform fixture');
    partial.set(
      `${CDN}/binaries/${encodeVersion(fixture.version)}/${platform.filename}`,
      new IncompleteRelease('not ready'),
    );
    await expect(
      discover(fixture.repository, new FakeDownloader(join(temporary, 'partial'), partial)),
    ).rejects.toBeInstanceOf(IncompleteRelease);

    const skew = new Map(fixture.mapping);
    skew.set(
      `${CDN}/cores/core-latest.zip`,
      await zipBytes([
        { content: Buffer.from('version = "0.9.10+different"\n'), name: 'core/moon.mod' },
        { content: Buffer.from('core'), name: 'core/builtin/moon.pkg' },
      ]),
    );
    await expect(
      discover(fixture.repository, new FakeDownloader(join(temporary, 'skew'), skew)),
    ).rejects.toThrow('different MoonBit versions');
  });

  it('rejects core, checksum, and latest-race tampering', async () => {
    const coreChanged = new Map(fixture.mapping);
    coreChanged.set(
      coreUrl(fixture.version, 'zip'),
      await zipBytes([
        { content: Buffer.from(`version = "${fixture.version}"\n`), name: 'core/moon.mod' },
        { content: Buffer.from('core'), name: 'core/builtin/moon.pkg' },
        { content: Buffer.from('new'), name: 'extra' },
      ]),
    );
    await expect(
      discover(fixture.repository, new FakeDownloader(join(temporary, 'core-change'), coreChanged)),
    ).rejects.toThrow('latest and exact');

    const checksumChanged = new Map(fixture.mapping);
    const platform = PLATFORMS[0];
    if (platform === undefined) throw new Error('platform fixture');
    checksumChanged.set(
      `${CDN}/binaries/${encodeVersion(fixture.version)}/${platform.filename}.sha256`,
      Buffer.from(`${'0'.repeat(64)}  ${platform.filename}\n`),
    );
    await expect(
      discover(
        fixture.repository,
        new FakeDownloader(join(temporary, 'checksum-change'), checksumChanged),
      ),
    ).rejects.toThrow('checksum mismatch');

    for (const format of ['tar.gz', 'zip'] as const) {
      const racing = new Map(fixture.mapping);
      const initial = fixture.mapping.get(`${CDN}/cores/core-latest.${format}`);
      if (!Buffer.isBuffer(initial)) throw new Error('latest fixture');
      racing.set(`${CDN}/cores/core-latest.${format}`, (call) =>
        call === 1 ? initial : Buffer.from('new latest'),
      );
      await expect(
        discover(fixture.repository, new FakeDownloader(join(temporary, `race-${format}`), racing)),
      ).rejects.toThrow('changed during discovery');
    }
  });
});

describe('manifest validation and promotion', () => {
  it('accepts a complete manifest and rejects schema mutations', () => {
    validateExact(validExact(), '0.1.2+abc');
    const mutations: ((value: Record<string, unknown>) => void)[] = [
      (value) => {
        value.schema = 2;
      },
      (value) => {
        value.version = 'latest';
      },
      (value) => {
        value.platforms = {};
      },
      (value) => {
        value.platforms = null;
      },
      (value) => {
        value.extra = true;
      },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(validExact());
      mutate(value);
      expect(() => validateExact(value)).toThrow(SupplyChainError);
    }
    expect(() => validateExact([], '0.1.2+abc')).toThrow('root');
    expect(() => validateExact(validExact(), '0.1.3+wrong')).toThrow('filename');
  });

  it('rejects component format, digest, URL, and field mutations', () => {
    for (const mutation of ['format', 'digest', 'url', 'extra'] as const) {
      const value = structuredClone(validExact());
      const platforms = value.platforms;
      if (!isRecord(platforms)) throw new Error('fixture');
      const linux = platforms['linux-x86_64'];
      if (!isRecord(linux)) throw new Error('fixture');
      const core = linux.core;
      if (!isRecord(core)) throw new Error('fixture');
      if (mutation === 'format') core.format = 'zip';
      if (mutation === 'digest') core.sha256 = 'bad';
      if (mutation === 'url') core.url = 'https://evil.test/core';
      if (mutation === 'extra') core.extra = true;
      expect(() => validateExact(value)).toThrow(SupplyChainError);
    }
    const invalidPlatform = structuredClone(validExact());
    const platforms = invalidPlatform.platforms;
    if (!isRecord(platforms)) throw new Error('fixture');
    platforms['linux-x86_64'] = null;
    expect(() => validateExact(invalidPlatform)).toThrow('component set');

    const invalidComponent = structuredClone(validExact());
    const componentPlatforms = invalidComponent.platforms;
    if (!isRecord(componentPlatforms)) throw new Error('fixture');
    const linux = componentPlatforms['linux-x86_64'];
    if (!isRecord(linux)) throw new Error('fixture');
    linux.core = null;
    expect(() => validateExact(invalidComponent)).toThrow('invalid core record');
  });

  it('promotes deterministically, updates pointers, and enforces immutability', async () => {
    await mkdir(join(temporary, 'releases'));
    const exact = validExact();
    expect(await promote(temporary, exact)).toBe(true);
    expect(await promote(temporary, exact)).toBe(false);
    expect(
      JSON.parse(await readFile(join(temporary, 'releases', 'latest.json'), 'utf8')).version,
    ).toBe(exact.version);
    const changed = structuredClone(exact);
    const platforms = changed.platforms;
    if (!isRecord(platforms)) throw new Error('fixture');
    const linux = platforms['linux-x86_64'];
    if (!isRecord(linux)) throw new Error('fixture');
    const core = linux.core;
    if (!isRecord(core)) throw new Error('fixture');
    core.sha256 = 'c'.repeat(64);
    await expect(promote(temporary, changed)).rejects.toThrow('immutable');
  });

  it('supports dry runs and repoints an existing exact manifest', async () => {
    await mkdir(join(temporary, 'releases'));
    const old = validExact('0.1.1+old');
    const current = validExact('0.1.2+new');
    expect(await promote(temporary, current, { dryRun: true })).toBe(true);
    expect(await stat(join(temporary, 'releases'))).toBeDefined();
    await promote(temporary, old);
    await promote(temporary, current);
    await writeFile(
      join(temporary, 'releases', 'latest.json'),
      canonicalJson(latestPointer('0.1.1+old')),
    );
    expect(await promote(temporary, current)).toBe(true);
  });

  it('validates canonical local manifests and vendor hashes', async () => {
    const exact = await makeLocalRepository(temporary);
    await validateLocal(temporary);
    const pointer = join(temporary, 'releases', 'latest.json');
    const original = await readFile(pointer, 'utf8');
    await writeFile(pointer, original.trimEnd());
    await expect(validateLocal(temporary)).rejects.toThrow('canonical');
    await writeFile(pointer, original);

    const vendor = await loadJson(join(temporary, 'vendor-lock.json'));
    const record = vendor.pure_lua_SHA;
    if (!isRecord(record)) throw new Error('fixture');
    record.sha256 = '0'.repeat(64);
    await writeFile(join(temporary, 'vendor-lock.json'), canonicalJson(vendor));
    await expect(validateLocal(temporary)).rejects.toThrow('vendored');

    await writeVendorLock(temporary);
    const exactPath = join(temporary, 'releases', `${String(exact.version)}.json`);
    await rename(exactPath, join(temporary, 'releases', '0.2.0+wrong.json'));
    await expect(validateLocal(temporary)).rejects.toThrow('filename');
  });

  it.each([
    ['{}', 'unexpected fields'],
    [canonicalJson({ ...latestPointer('0.1.2+abc'), schema: 2 }), 'unsupported schema'],
    [canonicalJson({ ...latestPointer('0.1.2+abc'), version: 'latest' }), 'invalid version'],
    [canonicalJson({ ...latestPointer('0.1.2+abc'), manifest: 'other.json' }), 'inconsistent'],
  ])('rejects defensive pointer mutation', async (content, message) => {
    await makeLocalRepository(temporary);
    await writeFile(join(temporary, 'releases', 'latest.json'), content);
    await expect(validateLocal(temporary)).rejects.toThrow(message);
  });

  it('rejects malformed JSON roots and missing JSON', async () => {
    const path = join(temporary, 'value.json');
    await writeFile(path, '[]');
    await expect(loadJson(path)).rejects.toThrow('root');
    await writeFile(path, '{');
    await expect(loadJson(path)).rejects.toThrow('cannot read');
    await expect(loadJson(join(temporary, 'missing'))).rejects.toThrow('cannot read');
  });

  it('rejects missing exact manifests, missing targets, invalid locks, and absent vendor files', async () => {
    const exact = await makeLocalRepository(temporary);
    await rm(join(temporary, 'releases', `${String(exact.version)}.json`));
    await expect(validateLocal(temporary)).rejects.toThrow('no exact');

    await promote(temporary, exact);
    await writeFile(
      join(temporary, 'releases', 'latest.json'),
      canonicalJson(latestPointer('0.2.0+missing')),
    );
    await writeFile(
      join(temporary, 'releases', '0.2.0+missing.json'),
      canonicalJson(validExact('0.2.0+missing')),
    );
    await rm(join(temporary, 'releases', '0.2.0+missing.json'));
    await expect(validateLocal(temporary)).rejects.toThrow('missing exact manifest');

    await writeFile(
      join(temporary, 'releases', 'latest.json'),
      canonicalJson(latestPointer(String(exact.version))),
    );
    await writeFile(join(temporary, 'vendor-lock.json'), '{}');
    await expect(validateLocal(temporary)).rejects.toThrow('invalid vendor lock');
    await writeVendorLock(temporary);
    await rm(join(temporary, 'sha.lua'));
    await expect(validateLocal(temporary)).rejects.toThrow('cannot read vendored');
  });

  it('rejects noncanonical exact manifests and unexpected filesystem read errors', async () => {
    const exact = await makeLocalRepository(temporary);
    const exactPath = join(temporary, 'releases', `${String(exact.version)}.json`);
    const exactText = await readFile(exactPath, 'utf8');
    await writeFile(exactPath, exactText.trimEnd());
    await expect(validateLocal(temporary)).rejects.toThrow('not canonical');

    const another = join(temporary, 'read-error');
    await mkdir(join(another, 'releases'), { recursive: true });
    await mkdir(join(another, 'releases', '0.1.2+abc.json'));
    await expect(promote(another, validExact())).rejects.toBeInstanceOf(Error);
  });
});

describe('file comparison and CLI contracts', () => {
  it('uses hashes and block comparison for identity', async () => {
    const leftPath = join(temporary, 'left');
    const rightPath = join(temporary, 'right');
    await writeFile(leftPath, 'same');
    await writeFile(rightPath, 'same');
    const common = { sha256: sha256(Buffer.from('same')), size: 4 };
    expect(await filesEqual({ ...common, path: leftPath }, { ...common, path: rightPath })).toBe(
      true,
    );
    await writeFile(rightPath, 'diff');
    expect(await filesEqual({ ...common, path: leftPath }, { ...common, path: rightPath })).toBe(
      false,
    );
    expect(
      await filesEqual(
        { ...common, path: leftPath },
        { path: rightPath, sha256: '0'.repeat(64), size: 4 },
      ),
    ).toBe(false);
  });

  it('parses CLI modes and validates check mode', async () => {
    await makeLocalRepository(temporary);
    expect(parseArguments(['--repo', temporary, '--check'])).toMatchObject({
      check: true,
      repository: temporary,
    });
    expect(() => parseArguments(['--check', '--dry-run'])).toThrow('mutually exclusive');
    expect(() => parseArguments(['--repo'])).toThrow('requires');
    expect(() => parseArguments(['--unknown'])).toThrow('unknown');
    await expect(main(['--repo', temporary, '--check'])).resolves.toBe(0);
  });

  it('preserves updater exit codes for incomplete, manual-review, and ordinary failures', async () => {
    const fixture = await createReleaseFixture(join(temporary, 'repository'));
    await makeLocalRepository(fixture.repository);

    const incompleteMapping = new Map(fixture.mapping);
    incompleteMapping.set(`${CDN}/install/unix.sh`, new IncompleteRelease('partial'));
    await expect(
      main(
        ['--repo', fixture.repository],
        new FakeDownloader(join(temporary, 'incomplete'), incompleteMapping),
      ),
    ).resolves.toBe(0);

    const driftMapping = new Map(fixture.mapping);
    driftMapping.set(`${CDN}/install/unix.sh`, Buffer.from('changed'));
    await expect(
      main(
        ['--repo', fixture.repository],
        new FakeDownloader(join(temporary, 'drift'), driftMapping),
      ),
    ).resolves.toBe(2);

    const brokenMapping = new Map(fixture.mapping);
    brokenMapping.set(`${CDN}/install/unix.sh`, new SupplyChainError('broken'));
    await expect(
      main(
        ['--repo', fixture.repository],
        new FakeDownloader(join(temporary, 'broken'), brokenMapping),
      ),
    ).resolves.toBe(1);
    const nonErrorMapping = new Map(fixture.mapping);
    nonErrorMapping.set(`${CDN}/install/unix.sh`, () => {
      throw 'string failure';
    });
    await expect(
      main(
        ['--repo', fixture.repository],
        new FakeDownloader(join(temporary, 'non-error'), nonErrorMapping),
      ),
    ).resolves.toBe(1);
    await expect(main(['--unknown'])).resolves.toBe(1);
  });

  it('reports dry-run, update, and already-current discovery states', async () => {
    const fixture = await createReleaseFixture(join(temporary, 'repository'));
    await makeLocalRepository(fixture.repository);
    await expect(
      main(
        ['--repo', fixture.repository, '--dry-run'],
        new FakeDownloader(join(temporary, 'dry-run'), fixture.mapping),
      ),
    ).resolves.toBe(0);
    await expect(
      main(
        ['--repo', fixture.repository],
        new FakeDownloader(join(temporary, 'update'), fixture.mapping),
      ),
    ).resolves.toBe(0);
    await expect(
      main(
        ['--repo', fixture.repository],
        new FakeDownloader(join(temporary, 'current'), fixture.mapping),
      ),
    ).resolves.toBe(0);
  });
});
