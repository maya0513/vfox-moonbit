/** Keep declarations, generated artifacts, and automation ownership consistent. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml, parseAllDocuments } from 'yaml';

import { isRecord } from './common.ts';

function object(value: unknown): Record<string, unknown> {
  assert(isRecord(value), 'Expected a configuration object');
  return value;
}

function array(value: unknown): unknown[] {
  assert(Array.isArray(value), 'Expected a configuration array');
  return value;
}

export function checkInstalledVersions(
  node: string,
  pnpm: string,
  actualNode: string,
  actualPnpm: string,
): void {
  assert.equal(actualNode.replace(/^v/, ''), node, 'Node executable must match the declaration');
  assert.equal(actualPnpm.trim(), pnpm, 'pnpm executable must match the declaration');
}

export async function checkDependencies(
  repository: string,
): Promise<{ node: string; pnpm: string }> {
  const read = (name: string) => readFile(join(repository, name), 'utf8');
  const mise = object(parseToml(await read('mise.toml')));
  const locks = object(object(parseToml(await read('mise.lock'))).tools);
  const project = object(JSON.parse(await read('package.json')));
  const workspace = object(parseYaml(await read('pnpm-workspace.yaml')));
  const renovate = object(JSON.parse(await read('renovate.json')));
  const tools = object(mise.tools);
  const versions: Record<string, string> = {};
  for (const [name, declaration] of Object.entries(tools)) {
    assert(
      typeof declaration === 'string' || isRecord(declaration),
      'Tools must use exact versions',
    );
    const version = typeof declaration === 'string' ? declaration : declaration.version;
    assert(
      typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version),
      'Tools must use exact versions',
    );
    versions[name] = version;
    assert(Array.isArray(locks[name]), `${name} needs a locked version`);
    const records = array(locks[name]);
    assert.equal(records.length, 1, `${name} must have one locked version`);
    assert.equal(
      object(records[0]).version,
      version,
      `${name} declaration differs from its locked version`,
    );
    if (name.startsWith('conda:')) {
      assert.deepEqual(object(declaration).os, ['linux'], 'Conda tools must remain Linux-only');
    }
  }
  const node = versions.node;
  const pnpm = versions.pnpm;
  assert(typeof node === 'string' && typeof pnpm === 'string', 'Declare Node and pnpm');
  assert.equal(object(project.engines).node, node, 'Node declaration must match mise');
  assert.equal(project.packageManager, `pnpm@${pnpm}`, 'pnpm declaration must match mise');
  assert.equal(workspace.pmOnFail, 'error', 'Fail on a mismatch in mise-managed pnpm');
  const documents = parseAllDocuments(await read('pnpm-lock.yaml'));
  assert(
    documents.every((document) => document.errors.length === 0),
    'Invalid pnpm lockfile',
  );
  for (const field of ['specifier', 'version']) {
    assert.equal(
      documents[0]?.getIn(['importers', '.', 'packageManagerDependencies', 'pnpm', field]),
      pnpm,
      'Package-manager lock must follow the mise-managed pnpm declaration',
    );
  }
  const linux = ['linux-x64', 'linux-arm64'];
  assert.deepEqual(
    object(mise.settings).lockfile_platforms,
    linux,
    'Default lock platforms must be Linux',
  );
  assert.deepEqual(
    renovate.extends,
    [
      'local>maya0513/renovate-config',
      'local>maya0513/renovate-config//presets/mise-pnpm',
      'local>maya0513/renovate-config//presets/viteplus',
    ],
    'Use the shared default, mise-pnpm and Vite+ presets',
  );
  assert.equal(renovate.mise, undefined, 'Delegate mise policy to the shared preset');
  const rules = array(renovate.packageRules).map(object);
  assert.equal(rules.length, 3, 'Keep only repository-specific Renovate rules');
  const rule = (field: string, value: unknown, label: string) => {
    const found = rules.find((entry) => JSON.stringify(entry[field]) === JSON.stringify(value));
    assert(found !== undefined, `Missing Renovate rule: ${label}`);
    return found;
  };
  const conda = rule('matchDatasources', ['conda'], 'Conda');
  assert.deepEqual(
    conda.registryUrls,
    ['https://api.anaconda.org/package/conda-forge/'],
    'Use the Conda forge registry',
  );
  assert.equal(
    rule('matchDepNames', ['conda:lua'], 'Lua 5.1').allowedVersions,
    '>=5.1.0 <5.2.0',
    'Keep Lua 5.1',
  );
  const nodeMajor = Number(node.split('.')[0]);
  assert.equal(
    rule('matchPackageNames', ['@types/node'], 'Node types').allowedVersions,
    `>=${nodeMajor}.0.0 <${nodeMajor + 1}.0.0`,
    'Node types must follow the runtime major',
  );
  const ci = object(parseYaml(await read('.github/workflows/ci.yml')));
  const update = object(parseYaml(await read('.github/workflows/update-dependencies.yml')));
  const ciJobs = object(ci.jobs);
  const checkJob = object(ciJobs.dependency_artifacts);
  const updateJobs = object(update.jobs);
  const updateJob = object(updateJobs.prepare);
  const publishJob = object(updateJobs.publish);
  const prefix = 'maya0513/renovate-config/.github/';
  const names = ['mise-pnpm', 'pnpm-viteplus', 'pnpm-outputs'];
  const ids = ['mise', 'viteplus', 'outputs'];
  const components = (job: Record<string, unknown>) =>
    array(job.steps)
      .map(object)
      .filter((step) => String(step.uses).startsWith(prefix));
  const checkSteps = components(checkJob);
  const updateSteps = components(updateJob);
  const revision = String(object(checkSteps[0]).uses).split('@')[1];
  assert.match(String(revision), /^[a-f0-9]{40}$/, 'Pin shared components to a full SHA');
  for (const [job, steps, mode] of [
    [checkJob, checkSteps, 'true'],
    [updateJob, updateSteps, 'false'],
  ] as const) {
    assert.deepEqual(
      steps.map((step) => step.id),
      ids,
      'Connect shared components in order',
    );
    steps.forEach((step, index) => {
      assert.equal(
        step.uses,
        `${prefix}actions/${names[index]}@${revision}`,
        'Use the same shared component revision',
      );
    });
    assert.equal(job.secrets, undefined, 'Preparation must not receive secrets');
    assert.doesNotMatch(JSON.stringify(job), /secrets\./, 'Preparation must not reference secrets');
    assert.equal(
      object(steps[0]!.with)['verify-only'],
      mode,
      'CI must be read-only and updates must generate artifacts',
    );
    assert.deepEqual(
      steps[1]!.with,
      {
        'preparation-state': '${{ steps.mise.outputs.state }}',
      },
      'Connect Vite+ preparation state and inherit verification mode',
    );
    assert.deepEqual(
      steps[2]!.with,
      {
        'mise-state': '${{ steps.mise.outputs.state }}',
        'viteplus-state': '${{ steps.viteplus.outputs.state }}',
      },
      'Connect final validation states',
    );
  }
  assert.deepEqual(ci.permissions, { contents: 'read' }, 'CI permissions must be read-only');
  assert.deepEqual(
    update.permissions,
    { contents: 'read' },
    'Update permissions must be read-only',
  );
  assert.equal(
    updateJob.if,
    "github.event_name == 'push' && github.event.sender.id == 29139614 && startsWith(github.ref, 'refs/heads/renovate/')",
    'Only Mend Renovate branch pushes may generate updates',
  );
  assert.deepEqual(
    updateJob.outputs,
    {
      base: '${{ steps.outputs.outputs.base }}',
      changed: '${{ steps.outputs.outputs.changed }}',
      'artifact-id': '${{ steps.outputs.outputs.artifact-id }}',
    },
    'Export validated publishing outputs',
  );
  assert.equal(publishJob.needs, 'prepare', 'Publish after preparation');
  assert.equal(
    publishJob.uses,
    `${prefix}workflows/publish-pnpm-artifacts.yml@${revision}`,
    'Use the same shared publishing revision',
  );
  assert.deepEqual(
    publishJob.with,
    {
      base: '${{ needs.prepare.outputs.base }}',
      changed: '${{ needs.prepare.outputs.changed }}',
      'artifact-id': '${{ needs.prepare.outputs.artifact-id }}',
      mise: true,
      viteplus: true,
      'app-client-id': '${{ vars.MOONBIT_UPDATER_CLIENT_ID }}',
    },
    'Connect publishing outputs and authorize selected components',
  );
  assert.deepEqual(
    publishJob.secrets,
    {
      'app-private-key': '${{ secrets.MOONBIT_UPDATER_PRIVATE_KEY }}',
    },
    'Pass App credentials only to publishing',
  );
  const platforms = [...linux, 'macos-arm64', 'windows-x64'];
  const groups = [
    {
      lockfile: 'mise.lock',
      tools: Object.keys(tools)
        .filter((name) => name.startsWith('conda:'))
        .toSorted(),
      platforms: linux,
      verify: 'locked',
    },
    {
      lockfile: 'mise.lock',
      tools: Object.keys(tools)
        .filter((name) => !name.startsWith('conda:'))
        .toSorted(),
      platforms,
      verify: 'regenerate',
    },
  ];
  for (const inputs of [object(checkSteps[0]!.with), object(updateSteps[0]!.with)]) {
    assert.deepEqual(
      JSON.parse(String(inputs['lock-groups'])),
      groups,
      'Lock groups must cover tools, platforms and validation modes identically',
    );
  }
  assert(
    array(object(ciJobs.required).needs).includes('dependency_artifacts'),
    'Require dependency artifact validation',
  );
  const runners = ['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15', 'windows-2025'];
  for (const name of ['mise_e2e', 'vfox_e2e']) {
    assert.deepEqual(
      object(object(object(ciJobs[name]).strategy).matrix).os,
      runners,
      'Validate all supported runners',
    );
  }
  return { node, pnpm };
}
