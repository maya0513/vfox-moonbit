import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { REPOSITORY } from './fixtures.ts';

const execute = promisify(execFile);
let temporary: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'vfox-tooling-workflow-'));
});

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  for (const name of [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ]) {
    delete env[name];
  }
  return env;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execute('git', args, { cwd, env: environment() });
  return result.stdout.trim();
}

async function commit(cwd: string, message: string): Promise<void> {
  await git(cwd, ['add', '.']);
  await git(cwd, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    message,
  ]);
}

describe('weekly maintenance workflow', () => {
  it('uses only the mise-locked pnpm after refreshing tools, without self-updating it', async () => {
    const repository = join(temporary, 'repository');
    const oldBin = join(temporary, 'old bin');
    const freshBin = join(temporary, 'fresh bin');
    const log = join(temporary, 'commands');
    await mkdir(join(repository, 'scripts'), { recursive: true });
    await mkdir(join(repository, 'node_modules/vite-plus'), { recursive: true });
    await mkdir(oldBin);
    await mkdir(freshBin);
    for (const name of ['package.json', 'pnpm-workspace.yaml', 'scripts/update-tooling.sh']) {
      await copyFile(join(REPOSITORY, name), join(repository, name));
    }
    await writeFile(
      join(repository, 'node_modules/vite-plus/package.json'),
      JSON.stringify({
        dependencies: { vitest: '5.0.1', vite: 'npm:@voidzero-dev/vite-plus-core@1.0.0' },
      }),
    );
    for (const name of ['update_actions.ts', 'check_repository.ts']) {
      await writeFile(join(repository, 'scripts', name), 'export {};\n');
    }
    await writeFile(join(repository, 'scripts/lua-rocks.sh'), 'exit 0\n');
    await writeFile(
      join(oldBin, 'mise'),
      `#!/usr/bin/env bash
printf 'mise %s\\n' "$*" >> "$FIXTURE_LOG"
case "$*" in
  'which node') printf '%s/node\\n' "$FIXTURE_FRESH_BIN" ;;
  'which pnpm') printf '%s/pnpm\\n' "$FIXTURE_FRESH_BIN" ;;
  'lock --bump '*|'install --locked '*) ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    for (const name of ['pnpm', 'node']) {
      await writeFile(join(oldBin, name), '#!/usr/bin/env bash\nexit 98\n', { mode: 0o755 });
    }
    await symlink(process.execPath, join(freshBin, 'node'));
    await writeFile(
      join(freshBin, 'pnpm'),
      `#!/usr/bin/env bash
printf 'pnpm %s\\n' "$*" >> "$FIXTURE_LOG"
case "$*" in
  'update --no-save'|'install --no-frozen-lockfile'|'vp fmt package.json pnpm-workspace.yaml') ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    await git(repository, ['init']);
    await execute('bash', ['scripts/update-tooling.sh'], {
      cwd: repository,
      env: {
        ...process.env,
        PATH: `${oldBin}:${process.env.PATH}`,
        FIXTURE_FRESH_BIN: freshBin,
        FIXTURE_LOG: log,
      },
    });
    const commands = (await readFile(log, 'utf8')).trim().split('\n');
    expect(commands).toContain(
      'mise install --locked node pnpm conda:gcc conda:lua conda:luarocks',
    );
    expect(commands.filter((command) => command.startsWith('pnpm '))).toEqual([
      'pnpm update --no-save',
      'pnpm install --no-frozen-lockfile',
      'pnpm vp fmt package.json pnpm-workspace.yaml',
    ]);
    const document = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
    expect(document.engines.pnpm).toBe('12.x');
    expect(document).not.toHaveProperty('devEngines');
    expect(document).not.toHaveProperty('packageManager');
  });

  it('creates and reuses the automation branch on a runner without a Git identity', async () => {
    const workflow = await readFile(
      join(REPOSITORY, '.github/workflows/update-tooling.yml'),
      'utf8',
    );
    const block =
      /- name: Prepare the single automation branch\n        shell: bash\n        run: \|\n([\s\S]*?)\n      - name:/.exec(
        workflow,
      )?.[1];
    expect(block).toBeDefined();
    const script = String(block).replace(/^          /gm, '');
    const remote = join(temporary, 'remote.git');
    const main = join(temporary, 'main');
    const worker = join(temporary, 'worker');
    await git(temporary, ['init', '--bare', '--initial-branch=main', remote]);
    await git(temporary, ['clone', remote, main]);
    await writeFile(join(main, 'base.txt'), 'base');
    await commit(main, 'initial');
    await git(main, ['push', 'origin', 'main']);
    await git(temporary, ['clone', remote, worker]);
    await execute('bash', ['-euo', 'pipefail', '-c', script], { cwd: worker, env: environment() });
    expect(await git(worker, ['branch', '--show-current'])).toBe('automation/maintenance-tooling');
    await writeFile(join(worker, 'lock.txt'), 'weekly update');
    await commit(worker, 'automation update');
    await git(worker, ['push', 'origin', 'HEAD']);
    await writeFile(join(main, 'new-feature.txt'), 'main changed');
    await commit(main, 'main update');
    await git(main, ['push', 'origin', 'main']);
    const nextWorker = join(temporary, 'next-worker');
    await git(temporary, ['clone', remote, nextWorker]);
    await execute('bash', ['-euo', 'pipefail', '-c', script], {
      cwd: nextWorker,
      env: environment(),
    });
    expect(await readFile(join(nextWorker, 'lock.txt'), 'utf8')).toBe('weekly update');
    expect(await readFile(join(nextWorker, 'new-feature.txt'), 'utf8')).toBe('main changed');
    expect(await git(nextWorker, ['log', '-1', '--format=%an'])).toBe('github-actions[bot]');
    expect(
      (await git(nextWorker, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' '),
    ).toHaveLength(3);
  });

  it('rejects a changed rockspec before LuaRocks can unpack or evaluate it', async () => {
    const repository = join(temporary, 'repository');
    const bin = join(temporary, 'bin');
    const gcc = join(temporary, 'gcc');
    await mkdir(join(repository, 'scripts'), { recursive: true });
    await mkdir(bin);
    await mkdir(join(gcc, 'x86_64-conda-linux-gnu/sysroot/lib64'), { recursive: true });
    await writeFile(join(gcc, 'x86_64-conda-linux-gnu/sysroot/lib64/librt.a'), '');
    await copyFile(
      join(REPOSITORY, 'scripts/lua-rocks.sh'),
      join(repository, 'scripts/lua-rocks.sh'),
    );
    await writeFile(
      join(repository, 'lua-rocks.lock'),
      `fixture 1.0-1 ${'a'.repeat(64)} ${'b'.repeat(64)}\n`,
    );
    await writeFile(join(bin, 'mise'), '#!/usr/bin/env bash\nprintf "%s\\n" "$FIXTURE_GCC"\n', {
      mode: 0o755,
    });
    await writeFile(
      join(bin, 'luarocks'),
      `#!/usr/bin/env bash
case "$*" in
  *download*) printf 'error("changed rockspec")\\n' > fixture-1.0-1.rockspec ;;
  *) touch "$FIXTURE_UNPACKED"; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const unpacked = join(temporary, 'unpacked');
    await expect(
      execute('bash', ['scripts/lua-rocks.sh', 'install'], {
        cwd: repository,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FIXTURE_GCC: gcc,
          FIXTURE_UNPACKED: unpacked,
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('verification failed before unpacking'),
    });
    await expect(readFile(unpacked)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('selects the unpacked source root instead of a nested same-name rockspec', async () => {
    const repository = join(temporary, 'repository');
    const bin = join(temporary, 'bin');
    const gcc = join(temporary, 'gcc');
    await mkdir(join(repository, 'scripts'), { recursive: true });
    await mkdir(bin);
    await mkdir(join(gcc, 'x86_64-conda-linux-gnu/sysroot/lib64'), { recursive: true });
    await writeFile(join(gcc, 'x86_64-conda-linux-gnu/sysroot/lib64/librt.a'), '');
    await copyFile(
      join(REPOSITORY, 'scripts/lua-rocks.sh'),
      join(repository, 'scripts/lua-rocks.sh'),
    );
    const recipe = 'package = "fixture"\n';
    const recipeHash = createHash('sha256').update(recipe).digest('hex');
    const sourceHash = createHash('sha256');
    for (const [name, contents] of [
      ['fixture-1.0-1.rockspec', recipe],
      ['payload.lua', 'return true\n'],
      ['rockspecs/fixture-1.0-1.rockspec', recipe],
    ]) {
      sourceHash.update(`file\0${name}\0`).update(String(contents)).update('\0');
    }
    await writeFile(
      join(repository, 'lua-rocks.lock'),
      `fixture 1.0-1 ${recipeHash} ${sourceHash.digest('hex')}\n`,
    );
    await writeFile(join(bin, 'mise'), '#!/usr/bin/env bash\nprintf "%s\\n" "$FIXTURE_GCC"\n', {
      mode: 0o755,
    });
    await writeFile(
      join(bin, 'luarocks'),
      `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *download*) printf 'package = "fixture"\\n' > fixture-1.0-1.rockspec ;;
  *unpack*)
    # Create the nested entry first, as on the failing clean CI runner.
    mkdir -p fixture-1.0-1/source/rockspecs
    cp fixture-1.0-1.rockspec fixture-1.0-1/source/rockspecs/
    cp fixture-1.0-1.rockspec fixture-1.0-1/source/
    printf 'return true\\n' > fixture-1.0-1/source/payload.lua
    ;;
  *make*)
    test -f payload.lua
    pwd > "$FIXTURE_BUILT"
    ;;
  *) exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    const built = join(temporary, 'built');
    const find = (await execute('sh', ['-c', 'command -v find'])).stdout.trim();
    await writeFile(
      join(bin, 'find'),
      `#!/usr/bin/env bash
set -euo pipefail
# Model a filesystem walk that visits the nested rockspec first.
arguments=()
for argument in "$@"; do
  if [[ "$argument" != '-quit' ]]; then arguments+=("$argument"); fi
done
"$FIXTURE_FIND" "\${arguments[@]}" | sort -r | head -n 1
`,
      { mode: 0o755 },
    );
    await execute('bash', ['scripts/lua-rocks.sh', 'install'], {
      cwd: repository,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FIXTURE_GCC: gcc,
        FIXTURE_BUILT: built,
        FIXTURE_FIND: find,
      },
    });
    expect((await readFile(built, 'utf8')).trim()).toMatch(/\/fixture-1\.0-1\/source$/);
  });
});
