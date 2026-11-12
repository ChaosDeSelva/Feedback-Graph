import { expect, test } from 'vitest';
import { ABSENT, changedError, DecisionStateError, refuse, TargetChangedError, UnsupportedTargetError } from './record.ts';
import { absentSnapshot, drift, snapshotOf } from './snapshot.ts';
import { rollbackDecision } from './rollback.ts';
import type { Decision } from '../types.ts';

const snap = (id: string, fingerprint: string) => ({ kind: 'lesson' as const, id, fields: {}, fingerprint });

test('a target a snapshot list leaves out reads as absent, so drift sees it appear or go', () => {
  expect(snapshotOf([], { kind: 'fact', id: 'fact:1' })).toEqual(absentSnapshot({ kind: 'fact', id: 'fact:1' }));
  expect(snapshotOf([snap('a', 'x')], { kind: 'fact', id: 'a' }).fingerprint).toBe(ABSENT); // same id, other kind
  expect(drift([snap('a', 'x')], [snap('a', 'x')])).toBeNull();
  expect(drift([snap('a', 'x'), snap('b', 'y')], [snap('a', 'x')])).toEqual({ target: snap('b', 'y'), expected: ABSENT });
});

test('refusals say which decision, what it is, and what the call takes', () => {
  expect(refuse('dec:1', null, 'applied')).toMatchObject({ name: 'DecisionStateError', status: null, message: 'no decision dec:1' });
  const e = refuse('dec:1', { status: 'expired' } as never, 'applied');
  expect(e).toBeInstanceOf(DecisionStateError);
  expect(e).toMatchObject({ decisionId: 'dec:1', status: 'expired', message: 'decision dec:1 is expired, not applied' });
  expect(changedError('l', 'e', snap('l', ABSENT))).toMatchObject({ actual: null, expected: 'e' });
  expect(changedError('l', 'e', snap('l', 'now'))).toEqual(new TargetChangedError('l', 'e', 'now'));
  expect(new UnsupportedTargetError({ kind: 'project', id: 'p' }, 'write')).toMatchObject({ name: 'UnsupportedTargetError', message: 'cannot write project p' });
});

test('restore anyway on an overridden decision that was never applied says it was never applied', async () => {
  const d = { id: 'dec:1', status: 'overridden', appliedAt: null } as Decision;
  const s = { decisions: { get: async () => d } } as never;
  await expect(rollbackDecision(s, d, { by: 'you', cascade: 'apply', restoreAnyway: true }))
    .rejects.toThrow('decision dec:1 is overridden, and it was never applied, so there is nothing to restore');
});
