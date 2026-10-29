/** Test-only compatibility; production Compose defaults are untouched. */
export function runnerTestSystemPaths(value: string | undefined): string[] {
  if (!value || value === '0') return [];
  if (value === '1') return ['--security-opt', 'systempaths=unconfined'];
  throw new Error('FG_TEST_RUNNER_UNMASK_SYSTEM_PATHS must be 0 or 1');
}
