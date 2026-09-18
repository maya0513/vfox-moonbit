#!/usr/bin/env node
/** Enforce the aggregate and per-file LuaCov line-coverage threshold. */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareText, errorMessage, isMain } from './lib/common.ts';

const ROW = /^((?:hooks|lib)\/\S+\.lua|metadata\.lua)\s+(\d+)\s+(\d+)\s+([\d.]+)%$/;
const DEFAULT_REPOSITORY = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function expectedFiles(repository: string): Promise<Set<string>> {
  const [hooks, libraries] = await Promise.all([
    readdir(join(repository, 'hooks')),
    readdir(join(repository, 'lib')),
  ]);
  return new Set([
    ...hooks.filter((name) => name.endsWith('.lua')).map((name) => `hooks/${name}`),
    ...libraries.filter((name) => /^moonbit_.*\.lua$/.test(name)).map((name) => `lib/${name}`),
  ]);
}

export function parseReport(report: string): Map<string, number> {
  const results = new Map<string, number>();
  for (const line of report.split(/\r?\n/)) {
    const match = ROW.exec(line.trim());
    if (match?.[1] !== undefined && match[4] !== undefined) results.set(match[1], Number(match[4]));
  }
  return results;
}

export interface CoverageArguments {
  minimum: number;
  report: string;
  repository: string;
}

export function parseArguments(argv: readonly string[]): CoverageArguments {
  let minimum = 95;
  let report = resolve('luacov.report.out');
  let repository = DEFAULT_REPOSITORY;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--minimum') {
      if (value === undefined) throw new Error('--minimum requires a value');
      minimum = Number(value);
      index += 1;
    } else if (argument === '--report') {
      if (value === undefined) throw new Error('--report requires a value');
      report = resolve(value);
      index += 1;
    } else if (argument === '--repo') {
      if (value === undefined) throw new Error('--repo requires a value');
      repository = resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
    throw new Error(`invalid coverage minimum: ${minimum}`);
  }
  return { minimum, report, repository };
}

export async function checkCoverage(argumentsValue: CoverageArguments): Promise<string> {
  const rows = parseReport(await readFile(argumentsValue.report, 'utf8'));
  const expected = await expectedFiles(argumentsValue.repository);
  const missing = [...expected].filter((name) => !rows.has(name)).toSorted(compareText);
  if (missing.length > 0) {
    throw new Error(`LuaCov report is missing first-party files: ${missing.join(', ')}`);
  }
  const failures = [...rows]
    .filter(([, value]) => value < argumentsValue.minimum)
    .toSorted(([left], [right]) => compareText(left, right));
  if (failures.length > 0) {
    const details = failures.map(([name, value]) => `${name}=${value.toFixed(2)}%`).join(', ');
    throw new Error(`Lua line coverage is below ${argumentsValue.minimum.toFixed(2)}%: ${details}`);
  }
  return `Lua line coverage: ${[...rows]
    .toSorted(([left], [right]) => compareText(left, right))
    .map(([name, value]) => `${name}=${value.toFixed(2)}%`)
    .join(', ')}`;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    console.log(await checkCoverage(parseArguments(argv)));
    return 0;
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }
}

/* v8 ignore start -- the process entrypoint is exercised by mise and Actions */
if (isMain(import.meta.url)) process.exitCode = await main();
/* v8 ignore stop */
