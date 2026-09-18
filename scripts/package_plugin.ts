#!/usr/bin/env node
/** Build a deterministic vfox plugin archive, checksum, and manifest. */

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ZipFile } from 'yazl';

export const OWNER = 'maya0513';
export const REPOSITORY = 'vfox-moonbit';
export const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const STRING_FIELD_RE = /^PLUGIN\.([A-Za-z][A-Za-z0-9]*)\s*=\s*"([^"\r\n]*)"\s*$/;
const LIST_FIELD_RE = /^PLUGIN\.(depends|notes|legacyFilenames)\s*=\s*\{(.*?)\}/gms;
const LIST_VALUE_RE = /"([^"\r\n]*)"/g;
const REQUIRED_METADATA = new Set([
  'name',
  'version',
  'homepage',
  'license',
  'description',
  'minRuntimeVersion',
  'manifestUrl',
]);
const ROOT_FILES = [
  'LICENSE',
  'README.md',
  'README.ja.md',
  'THIRD_PARTY_NOTICES',
  'metadata.lua',
  'vendor-lock.json',
] as const;
const ZIP_TIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

export type Metadata = Record<string, string | string[]>;

export class PackageError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

export function canonicalJson(document: unknown): string {
  return `${JSON.stringify(sortJson(document), null, 2)}\n`;
}

export async function parseMetadata(path: string): Promise<Metadata> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new PackageError(`cannot read plugin metadata: ${errorMessage(error)}`, { cause: error });
  }

  const result: Metadata = {};
  for (const line of text.split(/\r?\n/)) {
    const match = STRING_FIELD_RE.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) result[match[1]] = match[2];
  }
  for (const match of text.matchAll(LIST_FIELD_RE)) {
    const name = match[1];
    const body = match[2];
    if (name !== undefined && body !== undefined) {
      result[name] = [...body.matchAll(LIST_VALUE_RE)].flatMap((value) =>
        value[1] === undefined ? [] : [value[1]],
      );
    }
  }

  const missing = [...REQUIRED_METADATA].filter((name) => !(name in result)).toSorted(compareText);
  if (missing.length > 0)
    throw new PackageError(`metadata.lua is missing fields: ${missing.join(', ')}`);
  if (result.name !== 'moonbit')
    throw new PackageError("metadata.lua must name the plugin 'moonbit'");
  return result;
}

async function luaFiles(repository: string, directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(repository, directory));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.lua'))
    .toSorted(compareText)
    .map((name) => join(repository, directory, name));
}

export async function releaseFiles(repository: string): Promise<string[]> {
  const paths = [
    ...ROOT_FILES.map((name) => join(repository, name)),
    ...(await luaFiles(repository, 'hooks')),
    ...(await luaFiles(repository, 'lib')),
  ];
  const records = await Promise.all(
    paths.map(async (path) => {
      try {
        return { path, stats: await lstat(path) };
      } catch {
        return { path, stats: undefined };
      }
    }),
  );
  const symlink = records.find((record) => record.stats?.isSymbolicLink() === true);
  if (symlink !== undefined) {
    throw new PackageError(
      `release input must not be a symlink: ${relative(repository, symlink.path)}`,
    );
  }
  const missing = records
    .filter((record) => record.stats?.isFile() !== true)
    .map((record) => relative(repository, record.path));
  if (missing.length > 0) throw new PackageError(`release input is missing: ${missing.join(', ')}`);

  const available = join(repository, 'hooks', 'available.lua');
  const sha = join(repository, 'lib', 'sha2.lua');
  const pathSet = new Set(paths);
  if (!pathSet.has(available) || !pathSet.has(sha)) {
    throw new PackageError(
      'release input does not contain the required hook and vendored SHA module',
    );
  }
  return [...new Set(paths)].toSorted((left, right) =>
    compareText(
      relative(repository, left).replaceAll('\\', '/'),
      relative(repository, right).replaceAll('\\', '/'),
    ),
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function writeArchive(
  repository: string,
  archive: string,
  paths: readonly string[],
): Promise<void> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const completed = (async () => {
    for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  })();
  for (const path of paths) {
    const name = relative(repository, path).replaceAll('\\', '/');
    zip.addBuffer(await readFile(path), name, {
      compress: true,
      compressionLevel: 9,
      mode: 0o100644,
      mtime: ZIP_TIME,
    });
  }
  zip.end();
  await completed;
  await writeFile(archive, Buffer.concat(chunks), { mode: 0o600 });
}

export interface PackageResult {
  archive: string;
  checksum: string;
  manifest: string;
}

export async function build(
  repositoryInput: string,
  outputInput: string,
  requestedVersion?: string,
): Promise<PackageResult> {
  const repository = resolve(repositoryInput);
  const output = resolve(outputInput);
  const metadata = await parseMetadata(join(repository, 'metadata.lua'));
  const metadataVersion = String(metadata.version);
  const version = requestedVersion ?? metadataVersion;
  if (!SEMVER_RE.test(version))
    throw new PackageError(`plugin version is not SemVer: ${JSON.stringify(version)}`);
  if (version !== metadataVersion) {
    throw new PackageError(
      `tag version ${version} does not match metadata.lua version ${metadataVersion}`,
    );
  }
  if (metadata.homepage !== `https://github.com/${OWNER}/${REPOSITORY}`) {
    throw new PackageError('metadata.lua homepage does not match the release repository');
  }

  await mkdir(output, { recursive: true });
  const archive = join(output, `${REPOSITORY}-${version}.zip`);
  await writeArchive(repository, archive, await releaseFiles(repository));
  const digest = await sha256File(archive);
  const checksum = `${archive}.sha256`;
  await writeFile(checksum, `${digest}  ${REPOSITORY}-${version}.zip\n`, 'ascii');

  const manifest = join(output, 'manifest.json');
  await writeFile(
    manifest,
    canonicalJson({
      ...metadata,
      downloadUrl: `https://github.com/${OWNER}/${REPOSITORY}/releases/download/v${version}/${REPOSITORY}-${version}.zip`,
    }),
    'utf8',
  );
  return { archive, checksum, manifest };
}

export interface PackageArguments {
  repository: string;
  output: string;
  version?: string;
}

export function parseArguments(argv: readonly string[]): PackageArguments {
  let repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
  let output = resolve('dist');
  let version: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo' || argument === '--output' || argument === '--version') {
      const value = argv[index + 1];
      if (value === undefined) throw new PackageError(`${argument} requires a value`);
      if (argument === '--repo') repository = resolve(value);
      if (argument === '--output') output = resolve(value);
      if (argument === '--version') version = value;
      index += 1;
    } else {
      throw new PackageError(`unknown argument: ${argument}`);
    }
  }
  return { output, repository, ...(version === undefined ? {} : { version }) };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const argumentsValue = parseArguments(argv);
    const result = await build(
      argumentsValue.repository,
      argumentsValue.output,
      argumentsValue.version,
    );
    console.log(result.archive);
    console.log(result.checksum);
    console.log(result.manifest);
    return 0;
  } catch (error) {
    console.log(`package failed: ${errorMessage(error)}`);
    return 1;
  }
}

/* v8 ignore start -- the process entrypoint is exercised by mise and Actions */
function isMain(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href;
}

if (isMain()) process.exitCode = await main();
/* v8 ignore stop */
