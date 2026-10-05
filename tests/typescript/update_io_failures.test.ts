import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { main as checkRepository } from '../../scripts/check_repository.ts';
import { Downloader, inspectTar, inspectZip } from '../../scripts/update_latest.ts';
import { tarBytes } from './fixtures.ts';

interface TarEntryDouble extends Readable {
  path: string;
  type: string;
  size: number;
}
interface ZipDouble extends EventEmitter {
  readEntry(): void;
  openReadStream(entry: unknown, callback: (error: Error | null) => void): void;
  close(): void;
}
const readers = vi.hoisted(() => ({
  list: vi.fn<(options: { onentry?: (entry: TarEntryDouble) => void }) => Promise<void>>(),
  open: vi.fn<
    (
      path: string,
      options: unknown,
      callback: (error: Error | null, archive?: ZipDouble) => void,
    ) => void
  >(),
}));
// Fault injection is confined to I/O boundaries; archive validation remains real.
vi.mock('tar', () => ({ list: readers.list }));
vi.mock('yauzl', () => ({ open: readers.open }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    open: vi.fn<typeof fs.open>(actual.open),
    readFile: vi.fn<typeof fs.readFile>(actual.readFile),
  };
});

let temporary: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(join(tmpdir(), 'updater-io-failure-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await fs.rm(temporary, { recursive: true, force: true });
});

describe('archive reader failures', () => {
  it.each(['SymbolicLink', 'Link'] as const)(
    'rejects %s entries without a target',
    async (type) => {
      const path = join(temporary, 'archive.tar.gz');
      await fs.writeFile(path, tarBytes([]));
      const entry = Object.assign(Readable.from([]), { path: 'link', type, size: 0 });
      const resume = vi.spyOn(entry, 'resume');
      readers.list.mockImplementation(async (options) => {
        options.onentry?.(entry);
      });
      await expect(inspectTar(path, { label: 'tool', required: [] })).rejects.toThrow(
        'has no target',
      );
      expect(resume).toHaveBeenCalled();
    },
  );

  it('rejects a ZIP reader that returns neither an error nor an archive', async () => {
    readers.open.mockImplementation((_path, _options, callback) => callback(null));
    await expect(inspectZip('unused', { label: 'tool', required: [] })).rejects.toThrow(
      'ZIP reader returned no archive',
    );
  });

  it.each([
    [new Error('reader refused stream'), 'reader refused stream'],
    [null, 'ZIP reader returned no stream'],
  ])('closes the archive after a stream-open failure: %s', async (error, message) => {
    const archive = Object.assign(new EventEmitter(), {
      readEntry() {
        queueMicrotask(() =>
          archive.emit('entry', {
            fileName: 'payload',
            generalPurposeBitFlag: 0,
            externalFileAttributes: 0,
            uncompressedSize: 0,
            crc32: 0,
          }),
        );
      },
      openReadStream(_entry: unknown, callback: (error: Error | null) => void) {
        callback(error);
      },
      close: vi.fn<() => void>(),
    });
    readers.open.mockImplementation((_path, _options, callback) => {
      callback(null, archive);
    });
    await expect(inspectZip('unused', { label: 'tool', required: [] })).rejects.toThrow(message);
    expect(archive.close).toHaveBeenCalledExactlyOnceWith();
  });
});

describe('download cleanup and CLI failures', () => {
  it('removes the partial download even when closing the file fails', async () => {
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    let destination = '';
    vi.mocked(fs.open).mockImplementationOnce(async (path, flags, mode) => {
      destination = String(path);
      const handle = await actual.open(path, flags, mode);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        await close();
        throw new Error('close failed');
      });
      return handle;
    });
    const downloader = new Downloader({ fetchImplementation: async () => new Response('large') });
    try {
      await expect(downloader.fetch('https://example.test/artifact', 1)).rejects.toThrow(
        'size limit',
      );
      expect(destination).not.toBe('');
      await expect(fs.stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await downloader.dispose();
    }
  });

  it('reports a non-Error rejection without losing its message', async () => {
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.readFile)
      .mockImplementationOnce(actual.readFile)
      .mockRejectedValueOnce('storage unavailable');
    await expect(checkRepository([])).resolves.toBe(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('storage unavailable'));
  });
});
