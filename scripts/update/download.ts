import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { errorMessage } from '../lib/common.ts';
import { IncompleteRelease, SupplyChainError, UpdateError } from './errors.ts';

export interface DownloadedFile {
  path: string;
  size: number;
  sha256: string;
}

export interface DownloaderLike {
  fetch(url: string, maxBytes: number): Promise<DownloadedFile>;
}

export class Downloader implements DownloaderLike {
  readonly timeoutMs: number;
  readonly fetchImplementation: typeof fetch;
  #temporaryDirectory: string | undefined;

  constructor(options: { timeoutMs?: number; fetchImplementation?: typeof fetch } = {}) {
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async fetch(url: string, maxBytes: number): Promise<DownloadedFile> {
    if (!url.startsWith('https://')) throw new UpdateError(`refusing non-HTTPS download: ${url}`);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        headers: {
          Accept: 'application/octet-stream',
          'User-Agent': 'maya0513/vfox-moonbit updater',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new UpdateError(`failed to download ${url}: ${errorMessage(error)}`, { cause: error });
    }
    if (!response.ok) {
      if ([403, 404, 409].includes(response.status)) {
        throw new IncompleteRelease(`artifact is not published yet (${response.status}): ${url}`);
      }
      throw new UpdateError(`HTTP ${response.status} while downloading ${url}`);
    }
    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader !== null) {
      const length = Number(lengthHeader);
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new UpdateError(`invalid Content-Length while downloading ${url}`);
      }
      if (length > maxBytes) throw new SupplyChainError(`download exceeds size limit: ${url}`);
    }
    if (response.body === null) throw new UpdateError(`download returned no response body: ${url}`);

    const directory = await this.#directory();
    const destination = join(directory, `${randomUUID()}.part`);
    const handle = await open(destination, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const value of response.body) {
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > maxBytes) throw new SupplyChainError(`download exceeds size limit: ${url}`);
        hash.update(chunk);
        await handle.writeFile(chunk);
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(destination, { force: true });
      if (error instanceof UpdateError) throw error;
      throw new UpdateError(`failed to download ${url}: ${errorMessage(error)}`, { cause: error });
    }
    await handle.close();
    return { path: destination, size, sha256: hash.digest('hex') };
  }

  async dispose(): Promise<void> {
    if (this.#temporaryDirectory !== undefined) {
      const directory = this.#temporaryDirectory;
      this.#temporaryDirectory = undefined;
      await rm(directory, { force: true, recursive: true });
    }
  }

  async #directory(): Promise<string> {
    this.#temporaryDirectory ??= await mkdtemp(join(tmpdir(), 'vfox-moonbit-updater-'));
    return this.#temporaryDirectory;
  }
}
