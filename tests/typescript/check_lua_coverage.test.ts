import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  checkCoverage,
  EXPECTED,
  main,
  parseArguments,
  parseReport,
} from '../../scripts/check_lua_coverage.ts';

let temporary: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'lua-coverage-test-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(temporary, { force: true, recursive: true });
});

function completeReport(coverage = 100): string {
  return [...EXPECTED]
    .toSorted()
    .map((name) => `${name} 10 0 ${coverage.toFixed(2)}%`)
    .join('\n');
}

describe('LuaCov coverage checker', () => {
  it('parses first-party rows only', () => {
    expect(
      Object.fromEntries(
        parseReport(`
File                         Hits Missed Coverage
hooks/available.lua             4      0  100.00%
lib/moonbit_runtime.lua        95      5   95.00%
tests/lua/example.lua          10      0  100.00%
Total                         109      5   95.61%
`),
      ),
    ).toEqual({ 'hooks/available.lua': 100, 'lib/moonbit_runtime.lua': 95 });
  });

  it('accepts complete reports and rejects missing or low files', async () => {
    const report = join(temporary, 'report.out');
    await writeFile(report, completeReport());
    await expect(checkCoverage({ minimum: 95, report })).resolves.toContain('Lua line coverage');
    await writeFile(report, 'hooks/available.lua 10 0 100.00%\n');
    await expect(checkCoverage({ minimum: 95, report })).rejects.toThrow('missing first-party');
    await writeFile(report, completeReport(94));
    await expect(checkCoverage({ minimum: 95, report })).rejects.toThrow('below 95.00%');
  });

  it('parses strict CLI arguments', () => {
    expect(parseArguments(['--report', 'custom.out', '--minimum', '96'])).toMatchObject({
      minimum: 96,
    });
    expect(() => parseArguments(['--minimum'])).toThrow('requires a value');
    expect(() => parseArguments(['--minimum', 'bad'])).toThrow('invalid coverage minimum');
    expect(() => parseArguments(['--minimum', '101'])).toThrow('invalid coverage minimum');
    expect(() => parseArguments(['--report'])).toThrow('requires a value');
    expect(() => parseArguments(['--unknown'])).toThrow('unknown argument');
  });

  it('returns CLI-compatible success and failure codes', async () => {
    const report = join(temporary, 'report.out');
    await writeFile(report, completeReport());
    await expect(main(['--report', report])).resolves.toBe(0);
    await expect(main(['--report', join(temporary, 'missing')])).resolves.toBe(1);
  });
});
