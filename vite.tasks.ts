const luaSources = [
  'metadata.lua',
  'hooks/**/*.lua',
  'lib/moonbit_*.lua',
  'tests/lua/**/*.lua',
  '.luacov',
  '.luacheckrc',
  'stylua.toml',
  'lua-rocks.lock',
  'mise.toml',
  'mise.lock',
];

const typescriptSources = [
  'scripts/**/*.ts',
  'scripts/**/*.sh',
  'tests/typescript/**/*.ts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vite.config.ts',
  'vite.tasks.ts',
];

const repositoryPolicyInputs = [
  ...luaSources,
  ...typescriptSources,
  '.gitattributes',
  '.gitignore',
  '.github/**/*',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'README.ja.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES',
  'docs/**/*.md',
  'lib/sha2.lua',
  'releases/**/*.json',
  'upstream/**/*.json',
  'vendor-lock.json',
];

export const tasks = {
  'fmt:check': {
    command: [
      "bash -c 'stylua --check metadata.lua hooks lib/moonbit_*.lua tests/lua'",
      'vp fmt --check',
    ],
    input: [...luaSources, ...typescriptSources],
    output: [],
  },
  lint: {
    command: [
      "bash -c '.rocks/5.1/bin/luacheck metadata.lua hooks lib/moonbit_*.lua tests/lua'",
      'vp check',
      "bash -c 'actionlint .github/workflows/*.yml'",
      'zizmor --pedantic .github/workflows',
      'node scripts/check_repository.ts',
    ],
    input: repositoryPolicyInputs,
    output: [],
  },
  'test:unit': {
    command: 'bash scripts/test-unit.sh',
    input: [...luaSources, ...typescriptSources, 'scripts/test-unit.sh'],
    output: [],
  },
  coverage: {
    command: 'bash scripts/coverage.sh',
    input: [...luaSources, ...typescriptSources, 'scripts/coverage.sh'],
    output: ['coverage/**', 'luacov.report.out', 'luacov.stats.out'],
  },
  'docs:check': {
    command: 'node scripts/check_documentation.ts',
    input: repositoryPolicyInputs,
    output: [],
  },
  package: {
    command: 'node scripts/package_plugin.ts',
    input: repositoryPolicyInputs,
    output: ['dist/**'],
  },
  'update:check': {
    command: 'node scripts/update_latest.ts --check',
    input: repositoryPolicyInputs,
    output: [],
  },
  e2e: {
    command: 'node scripts/e2e.ts --backend mise',
    cache: false,
  },
  'e2e:vfox': {
    command: 'node scripts/e2e.ts --backend vfox --allow-vfox-user-state',
    cache: false,
  },
  'update:discover': {
    command: 'node scripts/update_latest.ts',
    cache: false,
  },
  ci: {
    command: 'git diff --check',
    dependsOn: [
      'fmt:check',
      'lint',
      'test:unit',
      'coverage',
      'docs:check',
      'update:check',
      'package',
    ],
    input: repositoryPolicyInputs,
    output: [],
  },
};
