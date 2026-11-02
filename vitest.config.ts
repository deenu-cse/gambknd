import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['src/tests/globalSetup.ts'],
    setupFiles: ['src/tests/setupEnv.ts'],
    // Integration suites share one replset + Redis; run files one at a time for deterministic state.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
