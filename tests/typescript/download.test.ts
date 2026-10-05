import { readFile, stat } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vite-plus/test';

import { Downloader } from '../../scripts/update/download.ts';
import { IncompleteRelease, SupplyChainError, UpdateError } from '../../scripts/update/errors.ts';
import { sha256 } from './fixtures.ts';

const downloaders: Downloader[] = [];
const URL = 'https://example.test/artifact';

function downloader(fetchImplementation: typeof fetch, timeoutMs = 1000): Downloader {
  const value = new Downloader({ fetchImplementation, timeoutMs });
  downloaders.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(downloaders.splice(0).map((value) => value.dispose()));
});

describe('bounded streaming downloads', () => {
  it('hashes every chunk, accepts the exact limit, and uses private distinct files', async () => {
    let headers: Headers | undefined;
    const value = downloader(async (_input, init) => {
      headers = new Headers(init?.headers);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from('pay'));
            controller.enqueue(Buffer.from('load'));
            controller.close();
          },
        }),
        { headers: { 'Content-Length': '7' } },
      );
    });
    const first = await value.fetch(URL, 7);
    const second = await value.fetch(URL, 7);
    expect(first.path).not.toBe(second.path);
    expect(await readFile(first.path, 'utf8')).toBe('payload');
    expect(first).toMatchObject({ size: 7, sha256: sha256(Buffer.from('payload')) });
    expect(headers?.get('user-agent')).toContain('maya0513/');
    expect(headers?.get('accept')).toBe('application/octet-stream');
    await value.dispose();
    for (const file of [first, second]) {
      await expect(stat(file.path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await value.dispose();
    // Disposing a completed batch does not prevent reuse for the next batch.
    expect((await value.fetch(URL, 7)).path).not.toBe(first.path);
  });

  it.skipIf(process.platform === 'win32')(
    'restricts downloaded file permissions to the owner',
    async () => {
      const value = downloader(async () => new Response('private'));
      const file = await value.fetch(URL, 7);
      expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    },
  );

  it('refuses HTTP before making a request', async () => {
    let called = false;
    const value = downloader(async () => {
      called = true;
      return new Response('');
    });
    await expect(value.fetch('http://example.test/artifact', 8)).rejects.toThrow('non-HTTPS');
    expect(called).toBe(false);
  });

  it.each([403, 404, 409])('defers publication when the CDN returns %s', async (status) => {
    const value = downloader(async () => new Response('', { status }));
    await expect(value.fetch(URL, 8)).rejects.toBeInstanceOf(IncompleteRelease);
  });

  it.each([429, 500])('reports HTTP %s as a transport failure', async (status) => {
    const value = downloader(async () => new Response('', { status }));
    await expect(value.fetch(URL, 8)).rejects.toThrow(`HTTP ${status}`);
  });

  it.each(['bad', '-1', '1.5', '9007199254740992'])(
    'rejects invalid Content-Length %s',
    async (length) => {
      const value = downloader(
        async () => new Response('x', { headers: { 'Content-Length': length } }),
      );
      await expect(value.fetch(URL, 8)).rejects.toThrow('invalid Content-Length');
    },
  );

  it('rejects a declared size above the limit', async () => {
    const value = downloader(
      async () => new Response('x', { headers: { 'Content-Length': '99' } }),
    );
    await expect(value.fetch(URL, 8)).rejects.toBeInstanceOf(SupplyChainError);
  });

  it('enforces the limit while reading even when the declared length is smaller', async () => {
    const value = downloader(
      async () => new Response('oversized', { headers: { 'Content-Length': '1' } }),
    );
    await expect(value.fetch(URL, 8)).rejects.toBeInstanceOf(SupplyChainError);
  });

  it('rejects responses without a body', async () => {
    const value = downloader(async () => new Response(null));
    await expect(value.fetch(URL, 8)).rejects.toThrow('no response body');
  });

  it('retains the original stream failure as the cause', async () => {
    const cause = new Error('broken stream');
    const value = downloader(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(cause);
            },
          }),
        ),
    );
    await expect(value.fetch(URL, 8)).rejects.toMatchObject({
      cause,
      message: expect.stringContaining('failed to download'),
    });
  });

  it('retains transport failures as the cause', async () => {
    const cause = new Error('offline');
    const value = downloader(async () => {
      throw cause;
    });
    await expect(value.fetch(URL, 8)).rejects.toMatchObject({ cause });
  });

  it('aborts requests that exceed the deadline', async () => {
    const value = downloader(async (_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) throw new Error('missing abort signal');
      signal.throwIfAborted();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }, 5);
    await expect(value.fetch(URL, 8)).rejects.toBeInstanceOf(UpdateError);
  });
});
