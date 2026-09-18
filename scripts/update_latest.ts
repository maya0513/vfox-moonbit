#!/usr/bin/env node
/** Safely promote a complete MoonBit stable release into immutable manifests. */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 as calculateCrc32 } from 'node:zlib';

import { list as listTar } from 'tar';
import * as yauzl from 'yauzl';

import { canonicalJson, errorMessage, isMain, isRecord } from './lib/common.ts';
import { EXACT_VERSION_RE, SHA256_RE } from './lib/project.ts';
import { Downloader, type DownloadedFile, type DownloaderLike } from './update/download.ts';
import {
  IncompleteRelease,
  ManualReviewRequired,
  SupplyChainError,
  UpdateError,
} from './update/errors.ts';

export { Downloader, IncompleteRelease, ManualReviewRequired, SupplyChainError, UpdateError };
export type { DownloadedFile, DownloaderLike };

export const SCHEMA = 1;
export const RECIPE = 1;
export const CDN = 'https://cli.moonbitlang.com';
export { canonicalJson, EXACT_VERSION_RE, SHA256_RE };
const DRIVE_RE = /^[A-Za-z]:/;

export interface Limits {
  installerBytes: number;
  checksumBytes: number;
  coreBytes: number;
  toolchainBytes: number;
  members: number;
  uncompressedBytes: number;
  metadataBytes: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = {
  installerBytes: 1024 * 1024,
  checksumBytes: 4096,
  coreBytes: 128 * 1024 * 1024,
  toolchainBytes: 768 * 1024 * 1024,
  members: 100_000,
  uncompressedBytes: 4 * 1024 * 1024 * 1024,
  metadataBytes: 1024 * 1024,
};

export interface Platform {
  key: string;
  filename: string;
  format: ArchiveFormat;
  required: readonly string[];
}

export type ArchiveFormat = 'tar.gz' | 'zip';

export const UNIX_REQUIRED = [
  'bin/moon',
  'bin/moonc',
  'bin/moonfmt',
  'bin/mooninfo',
  'bin/moonrun',
  'bin/moon-lsp',
  'bin/moon-ide',
  'bin/internal/tcc',
] as const;
export const WINDOWS_REQUIRED = UNIX_REQUIRED.filter((item) => item !== 'bin/internal/tcc').map(
  (item) => `${item}.exe`,
);
export const CORE_REQUIRED = ['core/moon.mod', 'core/builtin/moon.pkg'] as const;
export const PLATFORMS: readonly Platform[] = [
  {
    key: 'darwin-aarch64',
    filename: 'moonbit-darwin-aarch64.tar.gz',
    format: 'tar.gz',
    required: UNIX_REQUIRED,
  },
  {
    key: 'linux-aarch64',
    filename: 'moonbit-linux-aarch64.tar.gz',
    format: 'tar.gz',
    required: UNIX_REQUIRED,
  },
  {
    key: 'linux-x86_64',
    filename: 'moonbit-linux-x86_64.tar.gz',
    format: 'tar.gz',
    required: UNIX_REQUIRED,
  },
  {
    key: 'windows-x86_64',
    filename: 'moonbit-windows-x86_64.zip',
    format: 'zip',
    required: WINDOWS_REQUIRED,
  },
];

const INSTALLER_MARKERS: Readonly<Record<string, readonly string[]>> = {
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

interface ArchiveInspection {
  names: Set<string>;
  moonMod?: Buffer;
}

interface ExactArtifact {
  format: ArchiveFormat;
  sha256: string;
  url: string;
}

interface PlatformRecord {
  core: ExactArtifact;
  toolchain: ExactArtifact;
}

export interface ExactManifest {
  schema: number;
  recipe: number;
  version: string;
  platforms: Record<string, PlatformRecord>;
}

export interface LatestPointer {
  schema: number;
  recipe: number;
  version: string;
  manifest: string;
}

export function encodeVersion(version: string): string {
  if (!EXACT_VERSION_RE.test(version)) {
    throw new ManualReviewRequired(
      `unsupported MoonBit version schema: ${JSON.stringify(version)}`,
    );
  }
  return version.replace('+', '%2B');
}

export function safeName(rawName: string): string {
  if (rawName.includes('\0')) {
    throw new SupplyChainError('archive member contains NUL');
  }
  const name = rawName.replaceAll('\\', '/');
  if (name.startsWith('/') || DRIVE_RE.test(name)) {
    throw new SupplyChainError(`archive contains absolute path: ${JSON.stringify(rawName)}`);
  }
  const parts = name.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 && ['', '.', './'].includes(name.replace(/\/+$/, ''))) {
    return '';
  }
  if (parts.length === 0 || parts.includes('..')) {
    throw new SupplyChainError(`archive path escapes its root: ${JSON.stringify(rawName)}`);
  }
  return parts.join('/');
}

export function safeLink(memberName: string, rawTarget: string): void {
  if (rawTarget.includes('\0')) {
    throw new SupplyChainError('archive link target contains NUL');
  }
  const target = rawTarget.replaceAll('\\', '/');
  if (target.startsWith('/') || DRIVE_RE.test(target)) {
    throw new SupplyChainError(`archive link has absolute target: ${JSON.stringify(rawTarget)}`);
  }
  const resolvedTarget = posix.normalize(posix.join(posix.dirname(memberName), target));
  if (resolvedTarget === '..' || resolvedTarget.startsWith('../')) {
    throw new SupplyChainError(
      `archive link escapes its root: ${JSON.stringify(memberName)} -> ${JSON.stringify(rawTarget)}`,
    );
  }
}

function checkLayout(names: Set<string>, required: readonly string[], label: string): Set<string> {
  const missing = required.filter((name) => !names.has(name)).toSorted();
  if (missing.length > 0) {
    throw new ManualReviewRequired(
      `${label} archive layout changed; missing required paths: ${missing.join(', ')}`,
    );
  }
  return names;
}

function addArchiveName(
  name: string,
  names: Set<string>,
  folded: Set<string>,
  label: string,
): void {
  const key = name.toLowerCase();
  if (folded.has(key)) {
    throw new SupplyChainError(`${label} archive has duplicate/case-colliding path: ${name}`);
  }
  folded.add(key);
  names.add(name);
}

export async function inspectTar(
  archivePath: string,
  options: { required: readonly string[]; label: string; limits?: Readonly<Limits> },
): Promise<ArchiveInspection> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const names = new Set<string>();
  const folded = new Set<string>();
  let members = 0;
  let totalSize = 0;
  let moonMod: Buffer | undefined;
  let validationError: unknown;
  const pending: Promise<void>[] = [];
  try {
    const handle = await open(archivePath, 'r');
    const signature = Buffer.alloc(2);
    try {
      const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
      if (bytesRead !== 2 || signature[0] !== 0x1f || signature[1] !== 0x8b) {
        throw new SupplyChainError(`invalid ${options.label} tar.gz archive: not gzip data`);
      }
    } finally {
      await handle.close();
    }
    await listTar({
      file: archivePath,
      gzip: true,
      onentry(entry) {
        if (validationError !== undefined) {
          entry.resume();
          return;
        }
        try {
          members += 1;
          if (members > limits.members) {
            entry.resume();
            throw new SupplyChainError(`${options.label} archive has too many members`);
          }
          const name = safeName(entry.path);
          if (name === '') {
            entry.resume();
            return;
          }
          addArchiveName(name, names, folded, options.label);
          const allowed = new Set([
            'File',
            'OldFile',
            'ContiguousFile',
            'Directory',
            'SymbolicLink',
            'Link',
          ]);
          if (!allowed.has(entry.type)) {
            entry.resume();
            throw new SupplyChainError(
              `${options.label} archive contains unsupported special file: ${name}`,
            );
          }
          if (entry.type === 'SymbolicLink') {
            if (entry.linkpath === undefined)
              throw new SupplyChainError(`${options.label} symlink has no target: ${name}`);
            safeLink(name, entry.linkpath);
          } else if (entry.type === 'Link') {
            if (entry.linkpath === undefined)
              throw new SupplyChainError(`${options.label} hardlink has no target: ${name}`);
            safeName(entry.linkpath);
          }
          const regular = ['File', 'OldFile', 'ContiguousFile'].includes(entry.type);
          if (regular) {
            totalSize += entry.size;
            if (totalSize > limits.uncompressedBytes) {
              entry.resume();
              throw new SupplyChainError(`${options.label} archive expands beyond the size limit`);
            }
          }
          if (name === 'core/moon.mod' && regular) {
            if (entry.size > limits.metadataBytes) {
              entry.resume();
              throw new SupplyChainError('core/moon.mod exceeds its size limit');
            }
            pending.push(
              new Promise((resolveEntry, rejectEntry) => {
                const chunks: Buffer[] = [];
                entry.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
                entry.once('error', rejectEntry);
                entry.once('end', () => {
                  moonMod = Buffer.concat(chunks);
                  resolveEntry();
                });
              }),
            );
          } else entry.resume();
        } catch (error) {
          validationError = error;
          entry.resume();
        }
      },
    });
    await Promise.all(pending);
    if (validationError !== undefined) throw validationError;
  } catch (error) {
    if (error instanceof UpdateError) {
      throw error;
    }
    throw new SupplyChainError(`invalid ${options.label} tar.gz archive: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  checkLayout(names, options.required, options.label);
  return moonMod === undefined ? { names } : { names, moonMod };
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolveZip, rejectZip) => {
    yauzl.open(
      path,
      { autoClose: false, lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error !== null) {
          rejectZip(error);
        } else if (zip === undefined) {
          rejectZip(new Error('ZIP reader returned no archive'));
        } else {
          resolveZip(zip);
        }
      },
    );
  });
}

function readZipEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  options: { capture: boolean; maximumBytes?: number },
): Promise<Buffer | undefined> {
  return new Promise((resolveEntry, rejectEntry) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        rejectEntry(error);
        return;
      }
      if (stream === undefined) {
        rejectEntry(new Error(`ZIP reader returned no stream for ${entry.fileName}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let checksum = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        checksum = calculateCrc32(chunk, checksum);
        if (
          options.capture &&
          (options.maximumBytes === undefined || size <= options.maximumBytes)
        ) {
          chunks.push(Buffer.from(chunk));
        }
      });
      stream.once('error', rejectEntry);
      stream.once('end', () => {
        if (checksum >>> 0 !== entry.crc32) {
          rejectEntry(new SupplyChainError(`ZIP CRC-32 mismatch for ${entry.fileName}`));
        } else if (options.maximumBytes !== undefined && size > options.maximumBytes) {
          rejectEntry(new SupplyChainError('core/moon.mod exceeds its size limit'));
        } else {
          resolveEntry(options.capture ? Buffer.concat(chunks) : undefined);
        }
      });
    });
  });
}

export async function inspectZip(
  archivePath: string,
  options: { required: readonly string[]; label: string; limits?: Readonly<Limits> },
): Promise<ArchiveInspection> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const names = new Set<string>();
  const folded = new Set<string>();
  let members = 0;
  let totalSize = 0;
  let moonMod: Buffer | undefined;
  let zip: yauzl.ZipFile | undefined;
  try {
    zip = await openZip(archivePath);
    const archive = zip;
    await new Promise<void>((resolveArchive, rejectArchive) => {
      const fail = (error: unknown): void => rejectArchive(error);
      archive.once('error', fail);
      archive.once('end', resolveArchive);
      archive.on('entry', (entry) => {
        void (async () => {
          members += 1;
          if (members > limits.members) {
            throw new SupplyChainError(`${options.label} archive has too many members`);
          }
          const name = safeName(entry.fileName);
          if (name === '') {
            archive.readEntry();
            return;
          }
          addArchiveName(name, names, folded, options.label);
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
            throw new SupplyChainError(
              `${options.label} archive contains encrypted member: ${name}`,
            );
          }
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const kind = mode & 0o170000;
          if ([0o010000, 0o020000, 0o060000, 0o140000].includes(kind)) {
            throw new SupplyChainError(
              `${options.label} archive contains unsupported special file: ${name}`,
            );
          }
          totalSize += entry.uncompressedSize;
          if (totalSize > limits.uncompressedBytes) {
            throw new SupplyChainError(`${options.label} archive expands beyond the size limit`);
          }
          const isDirectory = entry.fileName.endsWith('/');
          if (isDirectory) {
            if (entry.uncompressedSize !== 0 || entry.crc32 !== 0) {
              throw new SupplyChainError(
                `${options.label} archive has malformed directory: ${name}`,
              );
            }
          } else {
            const capture = kind === 0o120000 || name === 'core/moon.mod';
            const content = await readZipEntry(archive, entry, {
              capture,
              ...(name === 'core/moon.mod' ? { maximumBytes: limits.metadataBytes } : {}),
            });
            if (kind === 0o120000) {
              safeLink(name, new TextDecoder('utf-8', { fatal: true }).decode(content));
            }
            if (name === 'core/moon.mod') {
              moonMod = content;
            }
          }
          archive.readEntry();
        })().catch(fail);
      });
      archive.readEntry();
    });
  } catch (error) {
    if (error instanceof UpdateError) {
      throw error;
    }
    throw new SupplyChainError(`invalid ${options.label} zip archive: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    zip?.close();
  }
  checkLayout(names, options.required, options.label);
  return moonMod === undefined ? { names } : { names, moonMod };
}

export async function inspectArchive(
  archivePath: string,
  format: string,
  options: { required: readonly string[]; label: string; limits?: Readonly<Limits> },
): Promise<ArchiveInspection> {
  if (format === 'tar.gz') {
    return inspectTar(archivePath, options);
  }
  if (format === 'zip') {
    return inspectZip(archivePath, options);
  }
  throw new SupplyChainError(`unsupported archive format: ${format}`);
}

export function coreVersion(content: Buffer | undefined): string {
  if (content === undefined) {
    throw new SupplyChainError('core archive has no regular core/moon.mod');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch (error) {
    throw new SupplyChainError('core/moon.mod is not UTF-8', { cause: error });
  }
  const match = /^\s*version\s*=\s*"([^"]+)"\s*$/m.exec(text);
  if (match?.[1] === undefined) {
    throw new SupplyChainError('core/moon.mod has no top-level version');
  }
  return match[1];
}

export function parseChecksum(data: Buffer, expectedFilename: string): string {
  if (data.some((byte) => byte > 0x7f)) {
    throw new SupplyChainError('official checksum is not ASCII');
  }
  const text = data.toString('ascii').trim();
  const match = /^([0-9a-fA-F]{64})\s+\*?([^\s]+)$/.exec(text);
  if (match?.[1] === undefined || match[2] !== expectedFilename) {
    throw new SupplyChainError(`malformed official checksum for ${expectedFilename}`);
  }
  return match[1].toLowerCase();
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function mapValue<Key, Value>(map: ReadonlyMap<Key, Value>, key: Key): Value {
  const value = map.get(key);
  if (value === undefined)
    throw new SupplyChainError('internal updater artifact map is incomplete');
  return value;
}

export async function loadJson(path: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new SupplyChainError(`cannot read JSON ${path}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new SupplyChainError(`JSON root must be an object: ${path}`);
  }
  return value;
}

async function artifactBytes(downloaded: DownloadedFile): Promise<Buffer> {
  return readFile(downloaded.path);
}

export async function checkInstallers(
  repository: string,
  downloader: DownloaderLike,
  limits: Readonly<Limits> = DEFAULT_LIMITS,
): Promise<void> {
  const lock = await loadJson(join(repository, 'upstream', 'installers.json'));
  const files = lock.files;
  if (lock.schema !== SCHEMA || lock.recipe !== RECIPE || !isRecord(files)) {
    throw new SupplyChainError('invalid installer lock schema');
  }
  for (const [name, markers] of Object.entries(INSTALLER_MARKERS)) {
    const record = files[name];
    if (!isRecord(record) || typeof record.sha256 !== 'string' || !SHA256_RE.test(record.sha256)) {
      throw new SupplyChainError(`invalid installer lock record: ${name}`);
    }
    if (typeof record.url !== 'string' || !record.url.startsWith(`${CDN}/install/`)) {
      throw new SupplyChainError(`installer does not use the official CDN: ${name}`);
    }
    const downloadedInstaller = await downloader.fetch(record.url, limits.installerBytes);
    if (downloadedInstaller.sha256 !== record.sha256) {
      throw new ManualReviewRequired(
        `official ${name} installer changed; review the installation recipe`,
      );
    }
    const text = (await artifactBytes(downloadedInstaller)).toString('utf8');
    if (markers.some((marker) => !text.includes(marker))) {
      throw new ManualReviewRequired(
        `official ${name} installer no longer matches recipe ${RECIPE}`,
      );
    }
    console.error(`verified official ${name} installer`);
  }
}

export function coreUrl(version: string, extension: 'tar.gz' | 'zip'): string {
  return `${CDN}/cores/core-${encodeVersion(version)}.${extension}`;
}

function makeArtifact(url: string, digest: string, format: ArchiveFormat): ExactArtifact {
  return { format, sha256: digest, url };
}

export async function filesEqual(left: DownloadedFile, right: DownloadedFile): Promise<boolean> {
  if (left.size !== right.size || left.sha256 !== right.sha256) {
    return false;
  }
  const leftHandle = await open(left.path, 'r');
  const rightHandle = await open(right.path, 'r');
  try {
    const chunkSize = 1024 * 1024;
    const leftBuffer = Buffer.allocUnsafe(chunkSize);
    const rightBuffer = Buffer.allocUnsafe(chunkSize);
    let position = 0;
    while (position < left.size) {
      const length = Math.min(chunkSize, left.size - position);
      const [leftRead, rightRead] = await Promise.all([
        leftHandle.read(leftBuffer, 0, length, position),
        rightHandle.read(rightBuffer, 0, length, position),
      ]);
      if (
        leftRead.bytesRead !== rightRead.bytesRead ||
        leftRead.bytesRead === 0 ||
        !leftBuffer
          .subarray(0, leftRead.bytesRead)
          .equals(rightBuffer.subarray(0, rightRead.bytesRead))
      ) {
        return false;
      }
      position += leftRead.bytesRead;
    }
    return true;
  } finally {
    await Promise.all([leftHandle.close(), rightHandle.close()]);
  }
}

export async function discover(
  repository: string,
  downloader: DownloaderLike,
  limits: Readonly<Limits> = DEFAULT_LIMITS,
): Promise<ExactManifest> {
  await checkInstallers(repository, downloader, limits);

  const latestUrls: Record<ArchiveFormat, string> = {
    'tar.gz': `${CDN}/cores/core-latest.tar.gz`,
    zip: `${CDN}/cores/core-latest.zip`,
  };
  const latestCore = new Map<ArchiveFormat, DownloadedFile>();
  const versions = new Set<string>();
  for (const format of ['tar.gz', 'zip'] as const) {
    const downloaded = await downloader.fetch(latestUrls[format], limits.coreBytes);
    latestCore.set(format, downloaded);
    const inspection = await inspectArchive(downloaded.path, format, {
      label: `latest core ${format}`,
      limits,
      required: CORE_REQUIRED,
    });
    versions.add(coreVersion(inspection.moonMod));
    console.error(`verified latest core ${format}`);
  }
  if (versions.size !== 1) {
    throw new IncompleteRelease('latest core tar.gz and zip point to different MoonBit versions');
  }
  const version = [...versions][0];
  if (version === undefined) {
    throw new SupplyChainError('latest core did not expose a version');
  }
  encodeVersion(version);

  const exactCore = new Map<ArchiveFormat, DownloadedFile>();
  for (const format of ['tar.gz', 'zip'] as const) {
    const latest = mapValue(latestCore, format);
    const downloaded = await downloader.fetch(coreUrl(version, format), limits.coreBytes);
    if (!(await filesEqual(downloaded, latest))) {
      throw new SupplyChainError(`latest and exact MoonBit core differ for ${format}`);
    }
    exactCore.set(format, downloaded);
    console.error(`verified exact core ${format}`);
  }

  const encoded = encodeVersion(version);
  const platforms: Record<string, PlatformRecord> = {};
  for (const platform of PLATFORMS) {
    const url = `${CDN}/binaries/${encoded}/${platform.filename}`;
    const checksum = await downloader.fetch(`${url}.sha256`, limits.checksumBytes);
    const expected = parseChecksum(await artifactBytes(checksum), platform.filename);
    const toolchain = await downloader.fetch(url, limits.toolchainBytes);
    if (toolchain.sha256 !== expected) {
      throw new SupplyChainError(
        `official checksum mismatch for ${platform.filename}: expected ${expected}, got ${toolchain.sha256}`,
      );
    }
    await inspectArchive(toolchain.path, platform.format, {
      label: platform.key,
      limits,
      required: platform.required,
    });
    console.error(`verified ${platform.key} toolchain`);
    const coreFormat = platform.format === 'zip' ? 'zip' : 'tar.gz';
    const core = mapValue(exactCore, coreFormat);
    platforms[platform.key] = {
      core: makeArtifact(coreUrl(version, coreFormat), core.sha256, coreFormat),
      toolchain: makeArtifact(url, toolchain.sha256, platform.format),
    };
  }

  for (const format of ['tar.gz', 'zip'] as const) {
    const after = await downloader.fetch(latestUrls[format], limits.coreBytes);
    if (!(await filesEqual(after, mapValue(latestCore, format)))) {
      throw new IncompleteRelease(
        `MoonBit latest ${format} changed during discovery; deferring promotion`,
      );
    }
  }
  return { platforms, recipe: RECIPE, schema: SCHEMA, version };
}

export function latestPointer(version: string): LatestPointer {
  return { manifest: `${version}.json`, recipe: RECIPE, schema: SCHEMA, version };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).toSorted();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].toSorted()[index])
  );
}

export function validateExact(
  document: unknown,
  expectedVersion?: string,
): asserts document is ExactManifest {
  if (!isRecord(document)) throw new SupplyChainError('release manifest root must be an object');
  if (!exactKeys(document, ['platforms', 'recipe', 'schema', 'version'])) {
    throw new SupplyChainError('release manifest has unexpected fields');
  }
  if (document.schema !== SCHEMA || document.recipe !== RECIPE) {
    throw new SupplyChainError('unsupported release manifest schema or recipe');
  }
  const version = document.version;
  if (typeof version !== 'string' || !EXACT_VERSION_RE.test(version)) {
    throw new SupplyChainError('release manifest has invalid version');
  }
  if (expectedVersion !== undefined && version !== expectedVersion) {
    throw new SupplyChainError('release manifest version does not match its filename');
  }
  if (!isRecord(document.platforms)) {
    throw new SupplyChainError('release manifest platform set is incomplete or unexpected');
  }
  const expectedPlatforms = PLATFORMS.map((platform) => platform.key).toSorted();
  if (!exactKeys(document.platforms, expectedPlatforms)) {
    throw new SupplyChainError('release manifest platform set is incomplete or unexpected');
  }
  const encoded = encodeVersion(version);
  for (const platform of PLATFORMS) {
    const record = document.platforms[platform.key];
    if (!isRecord(record) || !exactKeys(record, ['core', 'toolchain'])) {
      throw new SupplyChainError(`invalid component set for ${platform.key}`);
    }
    for (const component of ['core', 'toolchain'] as const) {
      const item = record[component];
      if (!isRecord(item) || !exactKeys(item, ['format', 'sha256', 'url'])) {
        throw new SupplyChainError(`invalid ${component} record for ${platform.key}`);
      }
      if (item.format !== platform.format) {
        throw new SupplyChainError(`invalid format for ${platform.key} ${component}`);
      }
      if (typeof item.sha256 !== 'string' || !SHA256_RE.test(item.sha256)) {
        throw new SupplyChainError(`invalid digest for ${platform.key} ${component}`);
      }
      const expectedUrl =
        component === 'core'
          ? coreUrl(version, platform.format === 'zip' ? 'zip' : 'tar.gz')
          : `${CDN}/binaries/${encoded}/${platform.filename}`;
      if (item.url !== expectedUrl) {
        throw new SupplyChainError(`non-canonical URL for ${platform.key} ${component}`);
      }
    }
  }
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function validateLocal(repository: string): Promise<void> {
  const releaseDirectory = join(repository, 'releases');
  const pointerPath = join(releaseDirectory, 'latest.json');
  const pointer = await loadJson(pointerPath);
  if (!exactKeys(pointer, ['manifest', 'recipe', 'schema', 'version'])) {
    throw new SupplyChainError('latest pointer has unexpected fields');
  }
  if (pointer.schema !== SCHEMA || pointer.recipe !== RECIPE) {
    throw new SupplyChainError('latest pointer has unsupported schema or recipe');
  }
  if (typeof pointer.version !== 'string' || !EXACT_VERSION_RE.test(pointer.version)) {
    throw new SupplyChainError('latest pointer has invalid version');
  }
  if (pointer.manifest !== `${pointer.version}.json`) {
    throw new SupplyChainError('latest pointer filename is inconsistent');
  }

  const exactNames = (await readdir(releaseDirectory))
    .filter((name) => name.endsWith('.json') && name !== 'latest.json')
    .toSorted();
  if (exactNames.length === 0) {
    throw new SupplyChainError('no exact MoonBit manifests are present');
  }
  for (const name of exactNames) {
    const path = join(releaseDirectory, name);
    const version = name.slice(0, -'.json'.length);
    const document = await loadJson(path);
    validateExact(document, version);
    if ((await readFile(path, 'utf8')) !== canonicalJson(document)) {
      throw new SupplyChainError(`manifest is not canonical JSON: ${path}`);
    }
  }
  try {
    await stat(join(releaseDirectory, pointer.manifest));
  } catch (error) {
    throw new SupplyChainError('latest pointer targets a missing exact manifest', { cause: error });
  }
  if ((await readFile(pointerPath, 'utf8')) !== canonicalJson(pointer)) {
    throw new SupplyChainError('latest pointer is not canonical JSON');
  }

  const vendor = await loadJson(join(repository, 'vendor-lock.json'));
  const record = vendor.pure_lua_SHA;
  if (vendor.schema !== 1 || !isRecord(record) || typeof record.file !== 'string') {
    throw new SupplyChainError('invalid vendor lock');
  }
  let digest: string;
  try {
    digest = await digestFile(join(repository, record.file));
  } catch (error) {
    throw new SupplyChainError(`cannot read vendored SHA module: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (digest !== record.sha256) {
    throw new SupplyChainError('vendored pure_lua_SHA digest does not match vendor-lock.json');
  }
}

export async function promote(
  repository: string,
  exact: unknown,
  options: { dryRun?: boolean } = {},
): Promise<boolean> {
  validateExact(exact);
  const version = exact.version;
  const exactPath = join(repository, 'releases', `${version}.json`);
  const pointerPath = join(repository, 'releases', 'latest.json');
  const exactText = canonicalJson(exact);
  const pointerText = canonicalJson(latestPointer(version));

  let existingExact: string | undefined;
  let existingPointer: string | undefined;
  try {
    existingExact = await readFile(exactPath, 'utf8');
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  try {
    existingPointer = await readFile(pointerPath, 'utf8');
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  if (existingExact !== undefined && existingExact !== exactText) {
    throw new SupplyChainError(
      `immutable manifest changed for already-recorded MoonBit ${version}`,
    );
  }
  const changed = existingExact === undefined || existingPointer !== pointerText;
  if (options.dryRun === true || !changed) {
    return changed;
  }
  await mkdir(dirname(exactPath), { recursive: true });
  if (existingExact === undefined) {
    await writeFile(exactPath, exactText, { encoding: 'utf8', flag: 'wx' });
  }
  const temporary = `${pointerPath}.part`;
  await writeFile(temporary, pointerText, 'utf8');
  await rename(temporary, pointerPath);
  return true;
}

export interface UpdateArguments {
  repository: string;
  check: boolean;
  dryRun: boolean;
}

export function parseArguments(argv: readonly string[]): UpdateArguments {
  let repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
  let check = false;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo') {
      const value = argv[index + 1];
      if (value === undefined) throw new UpdateError('--repo requires a path');
      repository = resolve(value);
      index += 1;
    } else if (argument === '--check') {
      check = true;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else {
      throw new UpdateError(`unknown argument: ${argument}`);
    }
  }
  if (check && dryRun) {
    throw new UpdateError('--check and --dry-run are mutually exclusive');
  }
  return { check, dryRun, repository };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  injected?: DownloaderLike,
): Promise<number> {
  let argumentsValue: UpdateArguments;
  try {
    argumentsValue = parseArguments(argv);
  } catch (error) {
    console.error(`update failed: ${errorMessage(error)}`);
    return 1;
  }
  let ownedDownloader: Downloader | undefined;
  let downloader: DownloaderLike;
  if (injected === undefined) {
    ownedDownloader = new Downloader();
    downloader = ownedDownloader;
  } else downloader = injected;
  try {
    await validateLocal(argumentsValue.repository);
    if (argumentsValue.check) {
      console.log('checked-in MoonBit manifests and vendor lock are valid');
      return 0;
    }
    const exact = await discover(argumentsValue.repository, downloader);
    const changed = await promote(argumentsValue.repository, exact, {
      dryRun: argumentsValue.dryRun,
    });
    const state =
      argumentsValue.dryRun && changed ? 'would update' : changed ? 'updated' : 'already current';
    console.log(`MoonBit ${exact.version}: ${state}`);
    return 0;
  } catch (error) {
    if (error instanceof IncompleteRelease) {
      console.error(`release incomplete; deferred: ${error.message}`);
      return 0;
    }
    if (error instanceof ManualReviewRequired) {
      console.error(`manual review required: ${error.message}`);
      return 2;
    }
    console.error(`update failed: ${errorMessage(error)}`);
    return 1;
  } finally {
    await ownedDownloader?.dispose();
  }
}

/* v8 ignore start -- the process entrypoint is exercised by mise and Actions */
if (isMain(import.meta.url)) {
  process.exitCode = await main();
}
/* v8 ignore stop */
