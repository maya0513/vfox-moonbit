import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function compareText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

export function canonicalJson(document: unknown): string {
  return `${JSON.stringify(sortJson(document), null, 2)}\n`;
}

/* v8 ignore start -- process entrypoints are exercised by mise and Actions */
export function isMain(moduleUrl: string, argv = process.argv): boolean {
  const entrypoint = argv[1];
  return entrypoint !== undefined && moduleUrl === pathToFileURL(resolve(entrypoint)).href;
}
/* v8 ignore stop */
