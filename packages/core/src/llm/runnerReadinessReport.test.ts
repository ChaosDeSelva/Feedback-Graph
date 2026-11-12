import { expect, test } from 'vitest';
import { reportedRunnerReadiness } from './runnerReadinessReport.ts';
test('API trusts only a fresh typed worker readiness report', () => {
  const now = 100_000;
  expect(reportedRunnerReadiness(JSON.stringify({ at: now, ok: true }), now)).toEqual({ ok: true, reason: null });
  expect(reportedRunnerReadiness(JSON.stringify({ at: now, ok: false, reason: 'cannot mount proc' }), now)).toEqual({ ok: false, reason: 'cannot mount proc' });
  for (const raw of [null, '{}', 'broken', JSON.stringify({ at: 1, ok: true }), JSON.stringify({ at: now + 60_000, ok: true }), JSON.stringify({ at: now, ok: 'yes' })])
    expect(reportedRunnerReadiness(raw, now).ok).toBe(false);
});

test('a failed worker report without a reason still says the sandbox is unavailable', () => {
  expect(reportedRunnerReadiness(JSON.stringify({ at: 5, ok: false }), 5)).toEqual({ ok: false, reason: 'runner sandbox unavailable' });
  expect(reportedRunnerReadiness(JSON.stringify({ at: 5, ok: false, reason: 42 }), 5)).toEqual({ ok: false, reason: 'runner sandbox unavailable' });
});
