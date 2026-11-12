import { expect, test } from 'vitest';
import type { CodeMapMeta } from './api.ts';
import { codeMapState, rebuildFailureStep } from './codeMapState.ts';

const now = Date.parse('2026-11-10T12:00:00Z');
const meta = (o: Partial<CodeMapMeta> = {}) => ({ builtAt: '2026-11-10T09:00:00Z', fingerprint: 'abc', lastFailureAt: null, lastFailure: null, writingAt: null, ...o }) as CodeMapMeta;

test('a failed rebuild says when and why, and names the fix its error points to', () => {
  const s = codeMapState(meta({ lastFailureAt: '2026-11-10T11:00:00Z', lastFailure: 'Neo.TransientError.General.MemoryPoolOutOfMemoryError' }), null, now);
  expect(s?.tone).toBe('bad');
  expect(s?.line).toBe('The last rebuild failed 1h ago: Neo.TransientError.General.MemoryPoolOutOfMemoryError. The map built 3h ago stays in use until a rebuild succeeds.');
  expect(s?.next).toMatch(/raise NEO4J_TRANSACTION_MAX/);
});

test('each kind of rebuild failure gets its own next step', () => {
  expect(rebuildFailureStep('connect ECONNREFUSED 10.0.0.2:7687')).toMatch(/unreachable: run \.\/scripts\/doctor\.sh/);
  expect(rebuildFailureStep('Neo.TransientError.Transaction.DeadlockDetected')).toBe('A temporary store error: Rebuild map to retry now.');
  expect(rebuildFailureStep('statement timed out')).toBe('A temporary store error: Rebuild map to retry now.');
  expect(rebuildFailureStep(null)).toMatch(/^Rebuild map to retry now; if it fails again/);
});

test('a running rebuild wins over an old failure; an interrupted one says it will be redone; a current map says nothing', () => {
  expect(codeMapState(meta({ lastFailureAt: '2026-11-10T11:00:00Z' }), { rebuilding: true } as never, now)?.tone).toBe('info');
  expect(codeMapState(meta({ fingerprint: null }), null, now)?.next).toBe('Rebuild map retries it now.');
  expect(codeMapState(meta(), null, now)).toBeNull();
});

test('a failure recorded without a reason points to Activity and gives the general next step', () => {
  const s = codeMapState(meta({ lastFailureAt: '2026-11-10T11:00:00Z' }), null, now);
  expect(s?.line).toBe('The last rebuild failed 1h ago: see Activity for details. The map built 3h ago stays in use until a rebuild succeeds.');
  expect(s?.next).toBe(rebuildFailureStep(null));
});

test('a map with no build time (its first build never finished) is not said to have been built, and no time reads "NaNy ago"', () => {
  const unbuilt = meta({ builtAt: null, fingerprint: null });
  expect(codeMapState(unbuilt, { rebuilding: true } as never, now)?.line).toBe('Building the first map now.');
  expect(codeMapState(unbuilt, { interrupted: true } as never, now)?.line).toBe('The last build stopped part way (the worker stopped while writing it). The worker rebuilds it from scratch at its next pass.');
  expect(codeMapState(meta({ builtAt: 'not a time', lastFailureAt: 'nor this' }), null, now)?.line).not.toMatch(/NaN/);
});
