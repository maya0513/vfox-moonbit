#!/usr/bin/env node
/** Pin every remote GitHub Action to the commit behind its documented major tag. */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { errorMessage, isMain, isRecord } from './lib/common.ts';

const ACTION_LINE_RE =
  /^([ \t]*(?:-[ \t]+)?uses:[ \t]*)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)@([^\s#]+)(?:[ \t]+#[ \t]*(.*))?[ \t]*$/gm;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const MAJOR_TAG_RE = /^v[1-9][0-9]*$/;

export class ActionUpdateError extends Error {}

export interface ActionPin {
  action: string;
  majorTag: string;
  repository: string;
}

export type FetchJson = (url: string) => Promise<unknown>;
export type ResolveAction = (repository: string, majorTag: string) => Promise<string>;

function actionPin(action: string, reference: string, marker: string | undefined): ActionPin {
  const parts = action.split('/');
  const repository = parts.slice(0, 2).join('/');
  const majorTag = MAJOR_TAG_RE.test(reference) ? reference : marker;
  if (majorTag === undefined || !MAJOR_TAG_RE.test(majorTag)) {
    throw new ActionUpdateError(`${action}@${reference} needs a trailing major tag comment`);
  }
  if (marker !== undefined && marker !== majorTag) {
    throw new ActionUpdateError(`${action}@${reference} has mismatched major tag ${marker}`);
  }
  if (!MAJOR_TAG_RE.test(reference) && !COMMIT_RE.test(reference)) {
    throw new ActionUpdateError(`${action}@${reference} is not a major tag or commit SHA`);
  }
  return { action, majorTag, repository };
}

function majorMarker(comment: string | undefined): string | undefined {
  return comment === undefined ? undefined : /^(v[1-9][0-9]*)(?:\s|$)/.exec(comment)?.[1];
}

export function actionPins(text: string): ActionPin[] {
  const pins: ActionPin[] = [];
  for (const match of text.matchAll(ACTION_LINE_RE)) {
    const action = String(match[2]);
    pins.push(actionPin(action, String(match[3]), majorMarker(match[4])));
  }
  return pins;
}

export async function resolveActionSha(
  repository: string,
  majorTag: string,
  fetchJson: FetchJson,
): Promise<string> {
  const major = Number(majorTag.slice(1));
  const endpoint = `https://api.github.com/repos/${repository}/tags?per_page=100`;
  const value = await fetchJson(endpoint);
  if (!Array.isArray(value))
    throw new ActionUpdateError(`GitHub returned invalid tags for ${repository}`);
  const candidates: Array<{ name: string; minor: number; patch: number; sha: string }> = [];
  let moving: string | undefined;
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !isRecord(entry.commit)) continue;
    const sha = entry.commit.sha;
    if (typeof sha !== 'string') continue;
    if (entry.name === majorTag) moving = sha;
    const match = /^v([1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(entry.name);
    if (match?.[1] !== undefined && Number(match[1]) === major) {
      candidates.push({
        name: entry.name,
        minor: Number(match[2]),
        patch: Number(match[3]),
        sha,
      });
    }
  }
  candidates.sort((left, right) => right.minor - left.minor || right.patch - left.patch);
  const selected = candidates[0];
  const sha = selected?.sha ?? moving;
  if (sha === undefined)
    throw new ActionUpdateError(`${repository} has no stable ${majorTag} release tag`);
  if (!COMMIT_RE.test(sha))
    throw new ActionUpdateError(
      `${repository}@${selected?.name ?? majorTag} has an invalid commit SHA`,
    );
  return sha;
}

export async function pinWorkflow(text: string, resolveAction: ResolveAction): Promise<string> {
  const replacements = new Map<string, string>();
  let output = '';
  let offset = 0;
  for (const match of text.matchAll(ACTION_LINE_RE)) {
    const action = String(match[2]);
    const pin = actionPin(action, String(match[3]), majorMarker(match[4]));
    const key = `${pin.repository}@${pin.majorTag}`;
    let sha = replacements.get(key);
    if (sha === undefined) {
      sha = await resolveAction(pin.repository, pin.majorTag);
      replacements.set(key, sha);
    }
    output += text.slice(offset, match.index);
    output += `${String(match[1])}${action}@${sha} # ${pin.majorTag}`;
    offset = match.index + match[0].length;
  }
  return output + text.slice(offset);
}

export async function fetchGitHubJson(
  url: string,
  token = process.env.GITHUB_TOKEN,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'vfox-moonbit-maintenance',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token !== undefined && token !== '') headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok)
    throw new ActionUpdateError(`GitHub API returned HTTP ${response.status}: ${url}`);
  return response.json();
}

export async function updateActions(
  repositoryInput: string,
  fetchJson = fetchGitHubJson,
): Promise<number> {
  const repository = resolve(repositoryInput);
  const directory = join(repository, '.github', 'workflows');
  const names = (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name)).toSorted();
  const cache = new Map<string, Promise<string>>();
  const resolver: ResolveAction = (actionRepository, majorTag) => {
    const key = `${actionRepository}@${majorTag}`;
    const existing = cache.get(key);
    if (existing !== undefined) return existing;
    const pending = resolveActionSha(actionRepository, majorTag, fetchJson);
    cache.set(key, pending);
    return pending;
  };
  let changed = 0;
  for (const name of names) {
    const path = join(directory, name);
    const before = await readFile(path, 'utf8');
    const after = await pinWorkflow(before, resolver);
    if (after !== before) {
      await writeFile(path, after);
      changed += 1;
    }
  }
  return changed;
}

export interface ActionArguments {
  repository: string;
}

export function parseArguments(argv: readonly string[]): ActionArguments {
  let repository = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (argv.length === 0) return { repository };
  if (argv.length === 2 && argv[0] === '--repo' && argv[1] !== undefined) {
    repository = resolve(argv[1]);
    return { repository };
  }
  throw new ActionUpdateError('usage: update_actions.ts [--repo PATH]');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const { repository } = parseArguments(argv);
    const changed = await updateActions(repository);
    console.log(`pinned GitHub Actions in ${changed} workflow file(s)`);
    return 0;
  } catch (error) {
    console.error(`GitHub Action update failed: ${errorMessage(error)}`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
