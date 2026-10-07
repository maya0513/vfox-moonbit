import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  actionPins,
  ActionUpdateError,
  fetchGitHubJson,
  main,
  parseArguments,
  pinWorkflow,
  resolveActionSha,
  updateActions,
} from '../../scripts/update_actions.ts';
import type { FetchJson, ResolveAction } from '../../scripts/update_actions.ts';
import * as common from '../../scripts/lib/common.ts';

const SHA = 'a'.repeat(40);
let temporary: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'action-update-test-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(temporary, { force: true, recursive: true });
});

describe('GitHub Action updater', () => {
  it('pins major tags, refreshes commit pins, preserves local actions, and caches resolutions', async () => {
    const input = [
      'steps:',
      '  - uses: actions/checkout@v7 # old explanation',
      `  - uses: actions/checkout@${'b'.repeat(40)} # v7`,
      '  - uses: actions/cache/restore@v6',
      '  - uses: ./local',
      '',
    ].join('\n');
    expect(actionPins(input)).toEqual([
      { action: 'actions/checkout', majorTag: 'v7', repository: 'actions/checkout' },
      { action: 'actions/checkout', majorTag: 'v7', repository: 'actions/checkout' },
      { action: 'actions/cache/restore', majorTag: 'v6', repository: 'actions/cache' },
    ]);
    const resolver = vi.fn<ResolveAction>(async () => SHA);
    const result = await pinWorkflow(input, resolver);
    expect(result).toContain(`uses: actions/checkout@${SHA} # v7`);
    expect(result).toContain(`uses: actions/cache/restore@${SHA} # v6`);
    expect(result).toContain('uses: ./local');
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['actions/checkout@main', 'trailing major tag'],
    [`actions/checkout@${SHA}`, 'trailing major tag'],
    ['actions/checkout@v7 # v6', 'mismatched'],
    ['actions/checkout@release # v7', 'not a major tag or commit'],
  ])('rejects an unsafe reference: %s', async (reference, message) => {
    await expect(pinWorkflow(`steps:\n  - uses: ${reference}\n`, async () => SHA)).rejects.toThrow(
      message,
    );
  });

  it('resolves the newest stable release within the documented major', async () => {
    await expect(
      resolveActionSha('actions/checkout', 'v7', async () => [
        null,
        { commit: null, name: 'v7.9.9' },
        { commit: {}, name: 7 },
        { commit: { sha: 7 }, name: 'v7.9.9' },
        { commit: { sha: 'b'.repeat(40) }, name: 'v7.2.1' },
        { commit: { sha: 'c'.repeat(40) }, name: 'v7.2.2' },
        { commit: { sha: SHA }, name: 'v7.2.0' },
        { commit: { sha: 'd'.repeat(40) }, name: 'v6.9.0' },
        { commit: { sha: 'd'.repeat(40) }, name: 'v7.2.0-beta.1' },
      ]),
    ).resolves.toBe('c'.repeat(40));
    await expect(
      resolveActionSha('actions/checkout', 'v7', async () => [
        { commit: { sha: SHA }, name: 'v7' },
      ]),
    ).resolves.toBe(SHA);
  });

  it.each([
    [undefined, 'invalid'],
    [[], 'no stable'],
    [[{ commit: { sha: SHA }, name: 'v6.1.0' }], 'no stable'],
    [[{ commit: { sha: 'bad' }, name: 'v7.1.0' }], 'invalid commit'],
    [[{ commit: { sha: 'bad' }, name: 'v7' }], 'invalid commit'],
  ])('rejects malformed GitHub metadata %#', async (value, message) => {
    await expect(resolveActionSha('actions/checkout', 'v7', async () => value)).rejects.toThrow(
      message,
    );
  });

  it('updates every workflow once and leaves an already current tree unchanged', async () => {
    const directory = join(temporary, '.github', 'workflows');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'a.yml'), 'steps:\n  - uses: actions/checkout@v7\n');
    await writeFile(join(directory, 'b.yaml'), 'steps:\n  - uses: actions/checkout@v7\n');
    await writeFile(join(directory, 'ignored.txt'), 'uses: actions/checkout@v7\n');
    const fetchJson = vi.fn<FetchJson>(async () => [{ commit: { sha: SHA }, name: 'v7.1.0' }]);
    await expect(updateActions(temporary, fetchJson)).resolves.toBe(2);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(await readFile(join(directory, 'a.yml'), 'utf8')).toContain(`${SHA} # v7`);
    await expect(updateActions(temporary, fetchJson)).resolves.toBe(0);
  });

  it('fetches GitHub JSON with optional authentication and reports HTTP errors', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchGitHubJson('https://api.github.test/ref', '')).resolves.toEqual({ ok: true });
    await fetchGitHubJson('https://api.github.test/ref', 'token');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBeNull();
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
      'Bearer token',
    );
    fetchMock.mockResolvedValueOnce(new Response(undefined, { status: 403 }));
    await expect(fetchGitHubJson('https://api.github.test/ref')).rejects.toThrow('HTTP 403');
  });

  it('parses arguments and reports entrypoint failures', async () => {
    expect(parseArguments([]).repository).toBeTruthy();
    expect(parseArguments(['--repo', temporary])).toEqual({ repository: temporary });
    expect(() => parseArguments(['--repo'])).toThrow('usage');
    expect(new ActionUpdateError('broken')).toBeInstanceOf(Error);
    await mkdir(join(temporary, '.github', 'workflows'), { recursive: true });
    await expect(main(['--repo', temporary])).resolves.toBe(0);
    expect(console.log).toHaveBeenCalledWith('pinned GitHub Actions in 0 workflow file(s)');
    await rm(join(temporary, '.github'), { recursive: true });
    await expect(main(['--repo', temporary])).resolves.toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('update failed'));
  });

  it('runs the process entrypoint against the default repository', async () => {
    const exitCode = process.exitCode;
    const argv = process.argv;
    try {
      const actionVersions = new Map<string, Array<{ commit: { sha: string }; name: string }>>();
      const workflowDirectory = join(process.cwd(), '.github', 'workflows');
      for (const name of await readdir(workflowDirectory)) {
        const workflow = await readFile(join(workflowDirectory, name), 'utf8');
        for (const match of workflow.matchAll(
          /uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_.-]+)*@([0-9a-f]{40})\s+#\s+(v[1-9][0-9]*)/g,
        )) {
          const repository = String(match[1]);
          const values = actionVersions.get(repository) ?? [];
          if (!values.some((value) => value.name === match[3])) {
            values.push({ commit: { sha: String(match[2]) }, name: String(match[3]) });
          }
          actionVersions.set(repository, values);
        }
      }
      process.argv = [process.execPath, 'update_actions.ts'];
      vi.doMock('../../scripts/lib/common.ts', () => ({ ...common, isMain: () => true }));
      vi.resetModules();
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (input) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const repository = /\/repos\/([^/]+\/[^/]+)\/tags/.exec(url)?.[1];
          return new Response(JSON.stringify(actionVersions.get(String(repository)) ?? []));
        }),
      );
      await import('../../scripts/update_actions.ts');
      expect(process.exitCode).toBe(0);
      expect(console.log).toHaveBeenCalledWith('pinned GitHub Actions in 0 workflow file(s)');
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      vi.doUnmock('../../scripts/lib/common.ts');
      vi.resetModules();
    }
  });
});
