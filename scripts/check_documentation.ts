#!/usr/bin/env node
/** Check machine-verifiable documentation facts against repository sources. */

import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { errorMessage, isMain } from './lib/common.ts';
import { EXPECTED_REPOSITORY } from './lib/project.ts';
import { parseMetadata } from './package_plugin.ts';

export class DocumentationError extends Error {}

function capture(text: string, pattern: RegExp, label: string): string {
  const value = pattern.exec(text)?.[1];
  if (value === undefined) throw new DocumentationError(`cannot read ${label}`);
  return value;
}

export function miseTasks(text: string): Set<string> {
  const tasks = new Set<string>();
  for (const match of text.matchAll(/^\[tasks\.(?:"([^"]+)"|([^\]]+))\]$/gm)) {
    const name = match[1] ?? match[2];
    if (name !== undefined) tasks.add(name);
  }
  return tasks;
}

export function documentedTasks(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/\bmise run ([A-Za-z0-9:.-]+)/g)].flatMap((match) => match[1] ?? []),
  );
}

export function localLinks(text: string): string[] {
  return [...text.matchAll(/\[[^\]]+\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)].flatMap(
    (match) => {
      const target = match[1] ?? match[2];
      if (target === undefined || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
        return [];
      }
      return [target.split('#', 1)[0] ?? target];
    },
  );
}

async function checkLinks(repository: string, documents: readonly string[]): Promise<void> {
  for (const name of documents) {
    const text = await readFile(join(repository, name), 'utf8');
    for (const target of localLinks(text)) {
      try {
        await access(resolve(repository, dirname(name), target));
      } catch {
        throw new DocumentationError(`${name} links to missing local path: ${target}`);
      }
    }
  }
}

function requireText(document: string, text: string, label: string): void {
  if (!document.includes(text)) throw new DocumentationError(`${label} is undocumented`);
}

export async function validateDocumentation(repositoryInput: string): Promise<void> {
  const repository = resolve(repositoryInput);
  const documentNames = [
    'README.md',
    'README.ja.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'docs/ARCHITECTURE.md',
    'docs/REPOSITORY_SETTINGS.md',
  ] as const;
  const [metadata, mise, readme, readmeJa, contributing, architecture] = await Promise.all([
    parseMetadata(join(repository, 'metadata.lua')),
    readFile(join(repository, 'mise.toml'), 'utf8'),
    readFile(join(repository, 'README.md'), 'utf8'),
    readFile(join(repository, 'README.ja.md'), 'utf8'),
    readFile(join(repository, 'CONTRIBUTING.md'), 'utf8'),
    readFile(join(repository, 'docs', 'ARCHITECTURE.md'), 'utf8'),
  ]);
  const pluginVersion = metadata.version;
  if (typeof pluginVersion !== 'string') throw new DocumentationError('plugin version is missing');
  const miseVersion = capture(mise, /^min_version\s*=\s*"([^"]+)"$/m, 'mise version');
  const vfoxVersion = capture(mise, /^vfox\s*=\s*"([^"]+)"$/m, 'vfox version');
  const toolSpec = `"vfox:${EXPECTED_REPOSITORY}" = "latest"`;
  const releaseUrl = `https://github.com/${EXPECTED_REPOSITORY}/releases/download/v${pluginVersion}/vfox-moonbit-${pluginVersion}.zip`;
  for (const [name, document] of [
    ['README.md', readme],
    ['README.ja.md', readmeJa],
  ] as const) {
    requireText(document, toolSpec, `${name} mise tool specification`);
    requireText(document, releaseUrl, `${name} standalone vfox release URL`);
    requireText(document, miseVersion, `${name} tested mise version`);
    requireText(document, vfoxVersion, `${name} tested vfox version`);
    requireText(document, 'MOON_TOOLCHAIN_ROOT', `${name} toolchain environment`);
    requireText(document, 'MOON_HOME', `${name} mutable state environment`);
  }
  for (const platform of ['linux-x86_64', 'linux-aarch64', 'darwin-aarch64', 'windows-x86_64']) {
    requireText(architecture, platform, `architecture platform ${platform}`);
  }
  const availableTasks = miseTasks(mise);
  for (const task of documentedTasks(`${readme}\n${readmeJa}\n${contributing}`)) {
    if (!availableTasks.has(task))
      throw new DocumentationError(`documentation uses unknown mise task: ${task}`);
  }
  await checkLinks(repository, documentNames);
}

export interface DocumentationArguments {
  repository: string;
}

export function parseArguments(argv: readonly string[]): DocumentationArguments {
  let repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (argv.length === 0) return { repository };
  if (argv.length === 2 && argv[0] === '--repo' && argv[1] !== undefined) {
    repository = resolve(argv[1]);
    return { repository };
  }
  throw new DocumentationError('usage: check_documentation.ts [--repo PATH]');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const { repository } = parseArguments(argv);
    await validateDocumentation(repository);
    console.log('documentation matches implementation facts');
    return 0;
  } catch (error) {
    console.error(`documentation check failed: ${errorMessage(error)}`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
