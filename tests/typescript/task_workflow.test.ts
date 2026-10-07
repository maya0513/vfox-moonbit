import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { tasks } from '../../vite.tasks.ts';
import { REPOSITORY } from './fixtures.ts';

const execute = promisify(execFile);
let temporary: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'vfox-task workflow-'));
});

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

describe('verification task graph', () => {
  it('checks formatting, lint, and all tests once, then adds release checks in CI', () => {
    expect(tasks.check.dependsOn).toEqual(['fmt:check', 'lint', 'coverage']);
    expect(tasks.ci.dependsOn).toEqual(['check', 'docs:check', 'update:check', 'package']);
    expect(tasks.lint.command).toContain('vp lint');
    expect(tasks.lint.command.some((command) => command.startsWith('vp check'))).toBe(false);
    expect(tasks.lint.command).not.toContain('node scripts/check_repository.ts');
    expect(tasks.ci.command).toEqual(['node scripts/check_repository.ts', 'git diff --check']);
    expect(
      tasks['fmt:check'].command.filter((command) => command === 'vp fmt --check'),
    ).toHaveLength(1);
  });

  it('fingerprints repository fixtures as well as test sources', () => {
    for (const task of [tasks['test:unit'], tasks.coverage]) {
      expect(task.cache.input).toEqual(
        expect.arrayContaining([
          'lib/sha2.lua',
          'vendor-lock.json',
          'releases/**/*.json',
          'upstream/**/*.json',
          'docs/**/*.md',
          '.github/**/*',
          'README.md',
          'LICENSE',
          '.gitignore',
          '.gitattributes',
        ]),
      );
    }
  });

  it('fingerprints the files that control formatter discovery', () => {
    expect(tasks['fmt:check'].cache.input).toEqual(
      expect.arrayContaining(['.gitignore', '.gitattributes']),
    );
  });

  it('never caches a Git-state-dependent diff check', async () => {
    expect(tasks.ci.cache).toBe(false);
    const git = async (args: string[]) =>
      execute('git', args, {
        cwd: temporary,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
    await git(['init']);
    const commit = () =>
      git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-am',
        'fixture',
      ]);
    await writeFile(join(temporary, 'sample.txt'), 'clean\n');
    await git(['add', 'sample.txt']);
    await commit();
    const { stdout: cleanBlob } = await git(['rev-parse', 'HEAD:sample.txt']);
    await writeFile(join(temporary, 'sample.txt'), 'trailing space \n');
    await commit();
    await writeFile(
      join(temporary, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );
    await writeFile(
      join(temporary, 'vite.config.mjs'),
      `export default ${JSON.stringify({
        run: { tasks: { ci: { command: tasks.ci.command.at(-1), cache: tasks.ci.cache } } },
      })};\n`,
    );
    const run = () =>
      execute(join(REPOSITORY, 'node_modules/.bin/vp'), ['run', 'ci'], { cwd: temporary });
    await expect(run()).resolves.toBeDefined();
    // Change only the index: source bytes and task configuration stay identical.
    await git(['update-index', '--cacheinfo', `100644,${cleanBlob.trim()},sample.txt`]);
    await expect(run()).rejects.toMatchObject({ code: 2 });
  });
});

async function runnerFixture(): Promise<NodeJS.ProcessEnv> {
  await mkdir(join(temporary, 'scripts'));
  await mkdir(join(temporary, '.rocks/5.1/bin'), { recursive: true });
  await mkdir(join(temporary, 'bin'));
  for (const name of ['test-lua.sh', 'test-unit.sh', 'coverage.sh']) {
    await copyFile(join(REPOSITORY, 'scripts', name), join(temporary, 'scripts', name));
  }
  for (const [path, name] of [
    ['.rocks/5.1/bin/busted', 'busted'],
    ['.rocks/5.1/bin/luacov', 'luacov'],
    ['bin/node', 'node'],
    ['bin/pnpm', 'pnpm'],
  ] as const) {
    await writeFile(
      join(temporary, path),
      `#!/usr/bin/env bash
printf '%s|%s|%s\\n' '${name}' "$*" "$LUA_PATH" >> "$FIXTURE_LOG"
if [[ '${name}' == "$FIXTURE_FAIL" ]]; then exit 23; fi
`,
      { mode: 0o755 },
    );
  }
  return {
    ...process.env,
    PATH: `${join(temporary, 'bin')}:${process.env.PATH}`,
    FIXTURE_LOG: join(temporary, 'commands'),
    FIXTURE_FAIL: '',
    LUA_PATH: '',
  };
}

async function commands(): Promise<string[][]> {
  return (await readFile(join(temporary, 'commands'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => line.split('|'));
}

describe('shared Lua test runner', () => {
  it('runs the complete Lua and TypeScript suites without instrumentation for test:unit', async () => {
    const env = await runnerFixture();
    await execute('bash', ['scripts/test-unit.sh'], { cwd: temporary, env });
    const calls = await commands();
    expect(calls.map(([name, args]) => [name, args])).toEqual([
      ['busted', 'tests/lua'],
      ['pnpm', 'vp test run'],
    ]);
    expect(calls[0]?.[2]).toContain('.rocks/5.1/share/lua/5.1/?/init.lua');
    expect(calls[0]?.[2]).toContain('./tests/lua/?.lua');
  });

  it('covers regular tests once and runs only large SHA vectors without tracing', async () => {
    const env = await runnerFixture();
    for (const name of ['luacov.stats.out', 'luacov.report.out']) {
      await writeFile(join(temporary, name), 'stale');
    }
    await execute('bash', ['scripts/coverage.sh'], { cwd: temporary, env });
    const calls = await commands();
    expect(calls.map(([name, args]) => [name, args])).toEqual([
      ['busted', '--coverage --exclude-tags=large tests/lua'],
      ['luacov', ''],
      ['node', 'scripts/check_lua_coverage.ts --minimum 100'],
      ['busted', '--tags=large tests/lua'],
      ['pnpm', 'vp test run --coverage'],
    ]);
    expect(calls[0]?.[2]).toBe(calls[3]?.[2]);
    for (const name of ['luacov.stats.out', 'luacov.report.out']) {
      await expect(readFile(join(temporary, name))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.each(['busted', 'luacov', 'node'])('stops coverage when %s fails', async (tool) => {
    const env = { ...(await runnerFixture()), FIXTURE_FAIL: tool };
    await expect(
      execute('bash', ['scripts/coverage.sh'], { cwd: temporary, env }),
    ).rejects.toMatchObject({ code: 23 });
    expect((await commands()).at(-1)?.[0]).toBe(tool);
  });

  it.each([{ args: [] }, { args: ['unknown'] }, { args: ['unit', 'extra'] }])(
    'rejects invalid runner arguments $args',
    async ({ args }) => {
      const env = await runnerFixture();
      await expect(
        execute('bash', ['scripts/test-lua.sh', ...args], { cwd: temporary, env }),
      ).rejects.toMatchObject({ code: 2 });
    },
  );
});
