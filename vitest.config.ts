import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/{core,worker,api,store-postgres}/src/**/*.test.ts', 'plugin/hooks/**/*.test.mjs'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/**/src/**/*.int.test.ts'],
          // Contract suites run once per backend in TEST_STORES (default neo4j); this registers the Postgres one.
          setupFiles: ['./packages/store-postgres/src/testing/register.ts'],
          testTimeout: 30000,
          // Cold disposable database startup and batched cleanup can exceed the default ten-second hook budget.
          hookTimeout: 60000,
          fileParallelism: false,
        },
      },
      './packages/ui/vite.config.ts',
    ],
  },
});
