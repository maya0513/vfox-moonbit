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
    // One of the two capture groups always matches a nonempty task name.
    tasks.add(String(match[1] ?? match[2]));
  }
  return tasks;
}

export function viteTasks(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/^ {2}(?:'([^']+)'|"([^"]+)"|([A-Za-z][A-Za-z0-9:.-]*)):\s*\{/gm)].map(
      (match) => String(match[1] ?? match[2] ?? match[3]),
    ),
  );
}

export function documentedTasks(text: string, runner: 'mise' | 'vite'): Set<string> {
  const command = runner === 'mise' ? 'mise' : 'pnpm vp';
  return new Set(
    [...text.matchAll(new RegExp(`\\b${command} run ([A-Za-z0-9:.-]+)`, 'g'))].map((match) =>
      String(match[1]),
    ),
  );
}

export function localLinks(text: string): string[] {
  return [...text.matchAll(/\[[^\]]+\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)].flatMap(
    (match) => {
      const target = String(match[1] ?? match[2]);
      if (target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
        return [];
      }
      return [target.slice(0, target.includes('#') ? target.indexOf('#') : target.length)];
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
    'SECURITY.md',
    'docs/ARCHITECTURE.md',
    'docs/ARCHITECTURE.ja.md',
  ] as const;
  const [metadata, mise, readme, readmeJa, architecture, architectureJa] = await Promise.all([
    parseMetadata(join(repository, 'metadata.lua')),
    readFile(join(repository, 'mise.toml'), 'utf8'),
    readFile(join(repository, 'README.md'), 'utf8'),
    readFile(join(repository, 'README.ja.md'), 'utf8'),
    readFile(join(repository, 'docs', 'ARCHITECTURE.md'), 'utf8'),
    readFile(join(repository, 'docs', 'ARCHITECTURE.ja.md'), 'utf8'),
  ]);
  // parseMetadata requires the version string before returning.
  const pluginVersion = String(metadata.version);
  const miseVersion = capture(mise, /^min_version\s*=\s*"([^"]+)"$/m, 'mise version');
  const vfoxVersion = capture(mise, /^vfox\s*=\s*"([^"]+)"$/m, 'vfox version');
  const vfoxSeries = /^\d+$/.test(vfoxVersion) ? `${vfoxVersion}.x` : vfoxVersion;
  const projectToolSpec = `mise use 'vfox:${EXPECTED_REPOSITORY}@latest'`;
  const projectConfigSpec = `"vfox:${EXPECTED_REPOSITORY}" = "latest"`;
  const releaseUrl = `https://github.com/${EXPECTED_REPOSITORY}/releases/download/v${pluginVersion}/vfox-moonbit-${pluginVersion}.zip`;
  for (const [name, document] of [
    ['README.md', readme],
    ['README.ja.md', readmeJa],
  ] as const) {
    requireText(document, projectToolSpec, `${name} project mise usage`);
    requireText(document, projectConfigSpec, `${name} mise.toml tool specification`);
    requireText(document, releaseUrl, `${name} standalone vfox release URL`);
    requireText(document, miseVersion, `${name} minimum mise version`);
    requireText(document, `vfox ${vfoxSeries}`, `${name} tested vfox series`);
    requireText(document, 'MOON_TOOLCHAIN_ROOT', `${name} toolchain environment`);
    requireText(document, 'MOON_HOME', `${name} mutable state environment`);
    requireText(document, `${projectToolSpec}\nmoon version`, `${name} direct MoonBit quick start`);
    requireText(document, 'mise install\nmoon version', `${name} mise.toml installation`);
    if (document.includes('moon version --all --json --no-path')) {
      throw new DocumentationError(`${name} exposes the machine-only version probe`);
    }
  }
  for (const [name, document] of [
    ['docs/ARCHITECTURE.md', architecture],
    ['docs/ARCHITECTURE.ja.md', architectureJa],
  ] as const) {
    requireText(
      document,
      'edbca0874797c2ee227d4f9cc2b427747756717c',
      `${name} moonbit-overlay comparison revision`,
    );
    requireText(document, 'LLVM bundle', `${name} intentional LLVM bundle difference`);
    for (const platform of ['linux-x86_64', 'linux-aarch64', 'darwin-aarch64', 'windows-x86_64']) {
      requireText(document, platform, `${name} platform ${platform}`);
    }
  }
  const availableTasks = {
    mise: miseTasks(mise),
    vite: viteTasks(await readFile(join(repository, 'vite.tasks.ts'), 'utf8')),
  };
  const documents = [
    readme,
    readmeJa,
    architecture,
    architectureJa,
    await readFile(join(repository, 'SECURITY.md'), 'utf8'),
  ];
  for (const runner of ['mise', 'vite'] as const) {
    for (const task of documentedTasks(documents.join('\n'), runner)) {
      if (!availableTasks[runner].has(task))
        throw new DocumentationError(`documentation uses unknown ${runner} task: ${task}`);
    }
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
