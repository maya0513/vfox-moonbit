import { defineConfig } from 'vite-plus';

import { tasks } from './vite.tasks.ts';

export default defineConfig({
  run: {
    cache: {
      scripts: false,
      tasks: true,
    },
    tasks,
  },
  lint: {
    ignorePatterns: ['coverage/**', 'dist/**', 'lib/sha2.lua'],
    options: {
      denyWarnings: true,
      reportUnusedDisableDirectives: 'error',
      typeAware: true,
      typeCheck: true,
    },
    categories: {
      correctness: 'error',
      perf: 'error',
      suspicious: 'error',
    },
    rules: {
      'no-await-in-loop': 'off',
    },
    overrides: [
      {
        files: ['scripts/**/*.ts', 'tests/typescript/**/*.ts', 'vite.config.ts', 'vite.tasks.ts'],
        env: { node: true },
      },
      {
        files: ['tests/typescript/**/*.ts'],
        plugins: ['vitest'],
      },
    ],
  },
  fmt: {
    ignorePatterns: [
      '**/*.md',
      '.github/**',
      'lib/sha2.lua',
      'mise.lock',
      'releases/**',
      'upstream/**',
      'vendor-lock.json',
    ],
    semi: true,
    singleQuote: true,
    sortPackageJson: true,
  },
  test: {
    environment: 'node',
    include: ['tests/typescript/**/*.test.ts'],
    coverage: {
      exclude: ['scripts/e2e.ts', 'scripts/e2e/**'],
      include: ['scripts/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 95,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
  },
});
