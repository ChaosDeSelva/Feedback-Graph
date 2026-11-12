/** Worker reports across the private runner network; API never joins that network. */
export const RUNNER_READINESS_CURSOR = 'codex-runner-readiness:v1';
/** disabled: the runner's persisted safety flag turned it off on purpose (reason: the flag's reasons), not a failure. */
export type RunnerReadiness = { ok: boolean; reason: string | null; disabled?: true };
export function reportedRunnerReadiness(raw: string | null, now = Date.now()): RunnerReadiness {
  try {
    const report = JSON.parse(raw ?? 'null');
    if (!report || typeof report.at !== 'number' || report.at > now + 5_000 || now - report.at > 60_000 || typeof report.ok !== 'boolean')
      return { ok: false, reason: 'waiting for a fresh runner sandbox check from the worker' };
    return { ok: report.ok, reason: report.ok ? null : typeof report.reason === 'string' ? report.reason : 'runner sandbox unavailable', ...(!report.ok && report.disabled === true && { disabled: true as const }) };
  } catch { return { ok: false, reason: 'waiting for a fresh runner sandbox check from the worker' }; }
}
