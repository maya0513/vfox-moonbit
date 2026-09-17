import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ZipFile } from 'yazl';

import {
  canonicalJson,
  CDN,
  coreUrl,
  encodeVersion,
  IncompleteRelease,
  type DownloadedFile,
  type DownloaderLike,
  PLATFORMS,
  SupplyChainError,
} from '../../scripts/update_latest.ts';

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  buffer.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'ascii');
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value
    .toString(8)
    .padStart(length - 1, '0')
    .slice(-(length - 1));
  writeString(buffer, offset, length, `${encoded}\0`);
}

export interface TarEntry {
  name: string;
  content?: Buffer;
  type?: 'file' | 'symlink' | 'hardlink' | 'fifo';
  link?: string;
}

export function tarBytes(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0);
    const type = entry.type ?? 'file';
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, entry.name);
    writeOctal(header, 100, 8, entry.name.startsWith('bin/') ? 0o755 : 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, type === 'file' ? content.length : 0);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = { file: 0x30, fifo: 0x36, hardlink: 0x31, symlink: 0x32 }[type];
    if (entry.link !== undefined) writeString(header, 157, 100, entry.link);
    writeString(header, 257, 6, 'ustar\0');
    writeString(header, 263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    blocks.push(header);
    if (type === 'file') {
      blocks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

export interface ZipEntry {
  name: string;
  content?: Buffer;
  mode?: number;
  directory?: boolean;
}

export async function zipBytes(entries: readonly ZipEntry[]): Promise<Buffer> {
  const archive = new ZipFile();
  const chunks: Buffer[] = [];
  const output = new Promise<Buffer>((resolveOutput, rejectOutput) => {
    archive.outputStream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    archive.outputStream.once('error', rejectOutput);
    archive.outputStream.once('end', () => resolveOutput(Buffer.concat(chunks)));
  });
  for (const entry of entries) {
    if (entry.directory === true) {
      archive.addEmptyDirectory(entry.name, {
        mode: entry.mode ?? 0o40755,
        mtime: new Date(Date.UTC(1980, 0, 1)),
      });
    } else {
      archive.addBuffer(entry.content ?? Buffer.alloc(0), entry.name, {
        compress: true,
        compressionLevel: 9,
        mode: entry.mode ?? 0o100644,
        mtime: new Date(Date.UTC(1980, 0, 1)),
      });
    }
  }
  archive.end();
  return output;
}

export function setZipEncrypted(data: Buffer): Buffer {
  const result = Buffer.from(data);
  for (let offset = 0; offset + 10 < result.length; offset += 1) {
    const signature = result.readUInt32LE(offset);
    if (signature === 0x04034b50)
      result.writeUInt16LE(result.readUInt16LE(offset + 6) | 1, offset + 6);
    if (signature === 0x02014b50)
      result.writeUInt16LE(result.readUInt16LE(offset + 8) | 1, offset + 8);
  }
  return result;
}

export function setZipCrc(data: Buffer, checksum: number): Buffer {
  const result = Buffer.from(data);
  const centralHeader = result.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (centralHeader === -1) throw new Error('ZIP fixture has no central directory entry');
  result.writeUInt32LE(checksum >>> 0, centralHeader + 16);
  return result;
}

export function replaceZipName(data: Buffer, from: string, to: string): Buffer {
  const source = Buffer.from(from, 'utf8');
  const target = Buffer.from(to, 'utf8');
  if (source.length !== target.length)
    throw new Error('ZIP fixture names must have equal byte length');
  const result = Buffer.from(data);
  let offset = 0;
  let replacements = 0;
  while ((offset = result.indexOf(source, offset)) !== -1) {
    target.copy(result, offset);
    offset += target.length;
    replacements += 1;
  }
  if (replacements < 2)
    throw new Error(`ZIP fixture did not contain both filename records for ${from}`);
  return result;
}

export function corruptZipPayload(data: Buffer): Buffer {
  const result = Buffer.from(data);
  const header = result.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (header === -1) throw new Error('ZIP fixture has no local header');
  const compressedSize = result.readUInt32LE(header + 18);
  const nameLength = result.readUInt16LE(header + 26);
  const extraLength = result.readUInt16LE(header + 28);
  if (compressedSize === 0) throw new Error('ZIP fixture has no compressed payload');
  const payload = header + 30 + nameLength + extraLength;
  const target = payload + Math.floor(compressedSize / 2);
  result[target] = (result[target] ?? 0) ^ 0xff;
  return result;
}

export function installerBytes(name: 'unix' | 'powershell'): Buffer {
  const markers = {
    unix: [
      'bundle --warn-list -a --all',
      'bundle --warn-list -a --target wasm-gc --quiet',
      'chmod +x ./internal/tcc',
      'ln -sfn moon',
    ],
    powershell: [
      'bundle --warn-list -a --all',
      'bundle --warn-list -a --target wasm-gc --quiet',
      'New-Item -ItemType HardLink',
    ],
  };
  return Buffer.from(`${markers[name].join('\n')}\n`);
}

export type DownloadValue = Buffer | Error | ((call: number) => Buffer | Error);

export class FakeDownloader implements DownloaderLike {
  readonly calls: { url: string; maxBytes: number }[] = [];
  readonly directory: string;
  readonly mapping: Map<string, DownloadValue>;
  readonly #counts = new Map<string, number>();

  constructor(directory: string, mapping: Map<string, DownloadValue>) {
    this.directory = directory;
    this.mapping = mapping;
  }

  async fetch(url: string, maxBytes: number): Promise<DownloadedFile> {
    this.calls.push({ maxBytes, url });
    const call = (this.#counts.get(url) ?? 0) + 1;
    this.#counts.set(url, call);
    const configured = this.mapping.get(url);
    if (configured === undefined) throw new Error(`missing fake download: ${url}`);
    const result = typeof configured === 'function' ? configured(call) : configured;
    if (result instanceof Error) throw result;
    if (result.length > maxBytes) throw new SupplyChainError('fixture exceeds limit');
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${randomUUID()}.download`);
    await writeFile(path, result);
    return { path, sha256: sha256(result), size: result.length };
  }
}

function toolchainEntries(required: readonly string[]): TarEntry[] {
  return required.map((name) => ({ content: Buffer.from(`executable:${name}`), name }));
}

export interface ReleaseFixture {
  repository: string;
  version: string;
  mapping: Map<string, DownloadValue>;
  archives: Map<string, Buffer>;
}

export async function createReleaseFixture(root: string): Promise<ReleaseFixture> {
  const version = '0.9.9+abc123';
  const encoded = encodeVersion(version);
  const unixInstaller = installerBytes('unix');
  const powershellInstaller = installerBytes('powershell');
  const records = {
    powershell: {
      sha256: sha256(powershellInstaller),
      url: `${CDN}/install/powershell.ps1`,
    },
    unix: { sha256: sha256(unixInstaller), url: `${CDN}/install/unix.sh` },
  };
  await mkdir(join(root, 'upstream'), { recursive: true });
  await mkdir(join(root, 'releases'), { recursive: true });
  await writeFile(
    join(root, 'upstream', 'installers.json'),
    canonicalJson({ files: records, recipe: 1, schema: 1 }),
  );

  const moonMod = Buffer.from(`name = "moonbitlang/core"\nversion = "${version}"\n`);
  const coreEntries = [
    { content: moonMod, name: './core/moon.mod' },
    { content: Buffer.from('core'), name: './core/builtin/moon.pkg' },
  ];
  const coreTar = tarBytes(coreEntries);
  const coreZip = await zipBytes(
    coreEntries.map((entry) => ({ content: entry.content, name: entry.name.slice(2) })),
  );
  const mapping = new Map<string, DownloadValue>([
    [records.unix.url, unixInstaller],
    [records.powershell.url, powershellInstaller],
    [`${CDN}/cores/core-latest.tar.gz`, coreTar],
    [`${CDN}/cores/core-latest.zip`, coreZip],
    [coreUrl(version, 'tar.gz'), coreTar],
    [coreUrl(version, 'zip'), coreZip],
  ]);
  const archives = new Map<string, Buffer>();
  for (const platform of PLATFORMS) {
    const entries = toolchainEntries(platform.required);
    const data =
      platform.format === 'tar.gz'
        ? tarBytes(entries)
        : await zipBytes(
            entries.map((entry) => ({
              content: entry.content ?? Buffer.alloc(0),
              name: entry.name,
            })),
          );
    const url = `${CDN}/binaries/${encoded}/${platform.filename}`;
    mapping.set(url, data);
    mapping.set(`${url}.sha256`, Buffer.from(`${sha256(data)}  ${platform.filename}\n`));
    archives.set(platform.key, data);
  }
  return { archives, mapping, repository: root, version };
}

export async function fileBytes(path: string): Promise<Buffer> {
  return readFile(path);
}

export function incomplete(message = 'not ready'): IncompleteRelease {
  return new IncompleteRelease(message);
}
