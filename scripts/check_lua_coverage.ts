#!/usr/bin/env node
/** Enforce the aggregate and per-file LuaCov line-coverage threshold. */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROW = /^((?:hooks|lib)\/\S+\.lua|metadata\.lua)\s+(\d+)\s+(\d+)\s+([\d.]+)%$/;
export const EXPECTED = new Set([
  'hooks/available.lua',
  'hooks/env_keys.lua',
  'hooks/post_install.lua',
  'hooks/pre_install.lua',
  'lib/moonbit_config.lua',
  'lib/moonbit_installer.lua',
  'lib/moonbit_manifest.lua',
  'lib/moonbit_runtime.lua',
  'lib/moonbit_sha256.lua',
  'lib/moonbit_sha256_portable.lua',
  'lib/moonbit_toolchain.lua',
]);

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
}

export function parseArguments(argv: readonly string[]): CoverageArguments {
  let minimum = 95;
  let report = resolve('luacov.report.out');
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
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
    throw new Error(`invalid coverage minimum: ${minimum}`);
  }
  return { minimum, report };
}

function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export async function checkCoverage(argumentsValue: CoverageArguments): Promise<string> {
  const rows = parseReport(await readFile(argumentsValue.report, 'utf8'));
  const missing = [...EXPECTED].filter((name) => !rows.has(name)).toSorted(compareText);
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
    console.error(error instanceof Error ? error.message : String(error));
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
