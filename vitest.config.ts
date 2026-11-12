import { defineConfig } from 'vitest/config';

/**
 * The coverage floor for unit + ui + integration on both backends (`pnpm test:coverage:all`, run in CI). Set to the
 * achieved numbers rounded down so coverage cannot regress: raise them here when coverage rises. They apply only to
 * the merged report (FG_COVERAGE_GATE), not to `pnpm test:coverage` or the partial runs that feed the merge.
 */
const coverageFloor = {
  lines: 94,
  branches: 89,
  functions: 96,
  statements: 94,
};

export default defineConfig({
  test: {
    // A hang guard, not a speed check: timing assertions use fake timers or CPU time, and on a heavily loaded host a
    // test that takes a second when idle can take several times vitest's 5 s default.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}', 'plugin/hooks/**/*.mjs', 'scripts/**/*.mjs'],
      exclude: ['**/*.test.{ts,tsx,mjs}', '**/*.int.test.ts', '**/testing/**', '**/*.d.ts', '**/*.corpus.ts'],
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      thresholds: process.env.FG_COVERAGE_GATE === '1' ? coverageFloor : undefined,
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/{core,worker,api,store-postgres}/src/**/*.test.ts', 'plugin/hooks/**/*.test.mjs'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          setupFiles: ['./packages/core/src/testing/cleanEnvSetup.ts', './packages/core/src/testing/yieldBetweenTests.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['packages/**/src/**/*.int.test.ts'],
          // Contract suites run once per backend in TEST_STORES (default neo4j); this registers the Postgres one.
          setupFiles: ['./packages/core/src/testing/cleanEnvSetup.ts', './packages/store-postgres/src/testing/register.ts'],
          // A hang guard: on a Docker VM short of memory the test database swaps, and a query that takes a second idle has
          // taken over 30.
          testTimeout: 120_000,
          // Cold disposable database startup and batched cleanup can exceed the default ten-second hook budget.
          hookTimeout: 60000,
          fileParallelism: false,
        },
      },
      './packages/ui/vite.config.ts',
    ],
  },
});
