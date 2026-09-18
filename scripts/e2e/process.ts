import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

export class E2EError extends Error {}

export function normalizedPath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function pathsReferToSameEntry(left: string, right: string): Promise<boolean> {
  try {
    const [resolvedLeft, resolvedRight] = await Promise.all([realpath(left), realpath(right)]);
    return normalizedPath(resolvedLeft) === normalizedPath(resolvedRight);
  } catch {
    return normalizedPath(left) === normalizedPath(right);
  }
}

export function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

export async function containsAdjacentPathEntries(
  entries: readonly string[],
  expected: readonly string[],
): Promise<boolean> {
  if (expected.length === 0) return true;
  const indexes: number[] = [];
  for (const expectedPath of expected) {
    const matches = await Promise.all(
      entries.map((entry) => pathsReferToSameEntry(entry, expectedPath)),
    );
    indexes.push(matches.indexOf(true));
  }
  const first = indexes[0] ?? -1;
  return first >= 0 && indexes.every((index, offset) => index === first + offset);
}

function printCaptured(text: string, error = false): void {
  if (text === '') return;
  const output = text.endsWith('\n') ? text : `${text}\n`;
  if (error) process.stderr.write(output);
  else process.stdout.write(output);
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSeconds?: number;
  check?: boolean;
  input?: string;
}

export interface RunResult {
  returnCode: number;
  stdout: string;
  stderr: string;
}

export async function run(command: readonly string[], options: RunOptions): Promise<RunResult> {
  const executable = command[0];
  if (executable === undefined) throw new E2EError('command must not be empty');
  const display = command.join(' ');
  console.log(`$ ${display}`);
  const timeoutSeconds = options.timeoutSeconds ?? 600;
  const result = await new Promise<RunResult>((resolveRun, rejectRun) => {
    const child = spawn(executable, command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: 'pipe',
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSeconds * 1000);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRun(new E2EError(`cannot run command ${display}: ${error.message}`, { cause: error }));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const captured = {
        returnCode: code ?? -1,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      };
      printCaptured(captured.stdout);
      printCaptured(captured.stderr, true);
      if (timedOut)
        rejectRun(new E2EError(`command timed out after ${timeoutSeconds} seconds: ${display}`));
      else resolveRun(captured);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
  if ((options.check ?? true) && result.returnCode !== 0) {
    throw new E2EError(`command exited ${result.returnCode}: ${display}`);
  }
  return result;
}
