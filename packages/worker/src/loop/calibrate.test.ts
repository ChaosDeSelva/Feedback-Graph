import { expect, test, vi } from 'vitest';
import { betaSummary, type CalibrationBucket, type Decision, type DecisionFilter } from '@fb/core';
import { confidenceOf, foldLabels, labelUntouched, ownerLabel } from './calibrate.ts';
import { readPenalties } from './policy.ts';
import { activity } from './testing/context.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { m, getCursor: async (k: string) => m.get(k) ?? null, setCursor: async (k: string, v: string) => { m.set(k, v); } };
};
const bucket = (band: number, alpha: number, beta: number, n: number): CalibrationBucket =>
  ({ type: 'approve_lesson', band, policyVersion: 1, alpha, beta, n, updatedAt: 't' });

test('confidenceOf: the band\'s posterior, else the type\'s prior with no labels', () => {
  expect(confidenceOf('link_misses', 0.9, [])).toEqual({ ...betaSummary(4, 1), n: 0, band: 4 });
  expect(confidenceOf('approve_lesson', 0.9, [])).toEqual({ ...betaSummary(1, 4), n: 0, band: 4 });
  expect(confidenceOf('approve_lesson', 0.9, [bucket(2, 9, 9, 13), bucket(4, 30, 2, 27)])).toEqual({ ...betaSummary(30, 2), n: 27, band: 4 });
});

const e = (kind: Parameters<typeof activity>[0], details: Record<string, unknown>, actor = 'you') => activity(kind, { actor, details: { decisionId: 'dec:1', ...details } });

test('ownerLabel: approve and keep are kept, reject, roll back and override are not; only yours count', () => {
  expect(ownerLabel(e('decision_applied', { status: 'applied', action: 'approve' }))).toEqual({ decisionId: 'dec:1', kept: true, reason: null });
  expect(ownerLabel(e('decision_made', { status: 'applied', action: 'keep' }))).toEqual({ decisionId: 'dec:1', kept: true, reason: null });
  expect(ownerLabel(e('decision_made', { status: 'rejected', reason: 'not_now' }))).toEqual({ decisionId: 'dec:1', kept: false, reason: 'not_now' });
  expect(ownerLabel(e('decision_made', { status: 'overridden' }))).toEqual({ decisionId: 'dec:1', kept: false, reason: null });
  expect(ownerLabel(e('decision_rolled_back', { status: 'rolled_back', reason: 'wrong_evidence' }))).toEqual({ decisionId: 'dec:1', kept: false, reason: 'wrong_evidence' });
  expect(ownerLabel(e('decision_rolled_back', { reason: 'made-up' }))?.reason).toBeNull();
  // Restore anyway follows the override, which was the label.
  expect(ownerLabel(e('decision_rolled_back', { status: 'overridden', action: 'restore_anyway' }))).toBeNull();
  expect(ownerLabel(e('decision_rolled_back', { status: 'rolled_back', action: 'cascade', cascadeOf: 'dec:0' }))).toBeNull();
  expect(ownerLabel(e('decision_rolled_back', {}, 'operator:ci'))).toBeNull();
  expect(ownerLabel(e('decision_rolled_back', {}, 'loop:1'))).toBeNull();
  expect(ownerLabel(e('decision_made', { status: 'proposed', action: 'proposed' }))).toBeNull();
  expect(ownerLabel(e('decision_noted', {}))).toBeNull();
  expect(ownerLabel(activity('decision_applied', { actor: 'you', details: {} }))).toBeNull();
});

test('foldLabels bumps the decision\'s own bucket from the type\'s prior and penalises a rollback reason', async () => {
  const cursors = memory();
  const dec = { id: 'dec:1', type: 'approve_lesson', confidence: { band: 3 }, policyVersion: 1 } as Decision;
  const decisions = { get: vi.fn(async (id: string) => (id === 'dec:1' ? dec : null)), bumpCalibration: vi.fn(async () => bucket(3, 1, 1, 1)) };
  const n = await foldLabels([
    e('decision_applied', { status: 'applied' }),
    e('decision_rolled_back', { reason: 'too_broad' }),
    e('decision_rolled_back', {}, 'operator:x'),
    activity('decision_applied', { actor: 'you', details: { decisionId: 'dec:gone' } }),
  ], { decisions, cursors });
  expect(n).toBe(2);
  expect(decisions.bumpCalibration.mock.calls).toEqual([
    [{ type: 'approve_lesson', band: 3, policyVersion: 1, prior: { alpha: 1, beta: 4 }, alpha: 1, beta: 0, n: 1 }],
    [{ type: 'approve_lesson', band: 3, policyVersion: 1, prior: { alpha: 1, beta: 4 }, alpha: 0, beta: 1, n: 1 }],
  ]);
  expect(await readPenalties(cursors, 'approve_lesson')).toEqual({ evidence: 0, scope: 1 });
});

test('foldLabels never calibrates the owner\'s own decision: a conflict resolved, then rolled back, is no label', async () => {
  const cursors = memory();
  const dec = { id: 'dec:1', type: 'resolve_conflict', author: 'owner', confidence: { band: 4 }, policyVersion: 1 } as Decision;
  const decisions = { get: vi.fn(async () => dec), bumpCalibration: vi.fn(async () => bucket(4, 1, 1, 1)) };
  expect(await foldLabels([e('decision_rolled_back', { status: 'rolled_back', reason: 'wording' }), e('decision_applied', { status: 'applied' })], { decisions, cursors })).toBe(0);
  expect(decisions.bumpCalibration).not.toHaveBeenCalled();
  expect(await readPenalties(cursors, 'resolve_conflict')).toEqual({ evidence: 0, scope: 0 });
});

test('labelUntouched: an auto-applied decision left alone 14 days while served is kept, once', async () => {
  const now = Date.parse('2026-11-30T00:00:00Z');
  const dec = (id: string, o: Partial<Decision> = {}) => ({
    id, type: 'rank_weight', status: 'applied', mode: 'auto', appliedAt: '2026-11-01T00:00:00.000Z', ratifiedAt: null, decidedBy: 'loop:1',
    targets: [{ kind: 'lesson', id: `lesson:${id}`, role: 'primary' }], after: [{ kind: 'lesson', id: `lesson:${id}`, fields: { status: 'approved' }, fingerprint: 'f' }],
    confidence: { band: 4 }, policyVersion: 1, ...o,
  }) as Decision;
  const all = [
    dec('ok'), dec('young', { appliedAt: '2026-11-20T00:00:00.000Z' }), dec('kept', { ratifiedAt: 't' }),
    dec('unserved'), dec('link', { type: 'link_misses', targets: [{ kind: 'miss', id: 'miss:a', role: 'primary' }] }),
    // Meant to apply on its own, paused, then approved by the owner: the approval is its label, not this.
    dec('approved', { decidedBy: 'you' }),
    // The owner rewrote its lesson since: overridden, a negative label, whether or not it was served.
    dec('edited', { type: 'reword_lesson' }),
  ];
  const labelled = new Set<string>();
  const overridden = new Set<string>();
  const decisions = {
    // The store's filter: applied before, not yet labelled.
    list: vi.fn(async (f: DecisionFilter) => all.filter((x) => x.appliedAt! < f.appliedBefore! && !labelled.has(x.id) && !overridden.has(x.id))),
    bumpCalibration: vi.fn(async (_b: { type: string; alpha: number; beta: number }) => bucket(4, 5, 1, 1)),
    markStatus: vi.fn(async (id: string) => !!overridden.add(id)),
    markLabelled: vi.fn(async (id: string) => !!labelled.add(id)),
  };
  const activity = { record: vi.fn(async () => {}) };
  const changed = async (x: Decision) => (x.id === 'edited' ? 'lesson:edited changed since it was applied' : null);
  const signals = async (id: string) => (id === 'lesson:unserved' ? { lastServed: '2026-10-01T00:00:00.000Z' } : id === 'lesson:ok' ? { lastServed: '2026-11-10T00:00:00.000Z' } : null);
  expect(await labelUntouched({ decisions, activity, signals, changed, now })).toEqual({ kept: 2, overridden: 1 });
  expect(decisions.bumpCalibration.mock.calls.map(([b]) => [b.type, b.alpha, b.beta])).toEqual([['rank_weight', 1, 0], ['link_misses', 1, 0], ['reword_lesson', 0, 1]]);
  expect(decisions.markStatus).toHaveBeenCalledWith('edited', { status: 'overridden', from: ['applied'] });
  expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'decision_made', actor: 'loop:1', details: expect.objectContaining({ decisionId: 'edited', status: 'overridden' }) }));
  // Only those applied 14 days before and not labelled are read; the owner's (kept, approved) are marked as labelled too.
  expect(decisions.list).toHaveBeenCalledWith({ status: ['applied'], mode: 'auto', unlabelled: true, appliedBefore: '2026-11-16T00:00:00.000Z', order: 'applied', limit: 500, offset: 0 });
  expect([...labelled].sort()).toEqual(['approved', 'kept', 'link', 'ok']);
  expect(await labelUntouched({ decisions, activity, signals, changed, now })).toEqual({ kept: 0, overridden: 0 });
  expect(decisions.bumpCalibration).toHaveBeenCalledTimes(3);
});

test('restore anyway after a refused rollback: one owner action, one negative label', async () => {
  const cursors = memory();
  const decisions = { get: vi.fn(async () => ({ id: 'dec:1', type: 'reword_lesson', confidence: { band: 4 }, policyVersion: 1 }) as Decision), bumpCalibration: vi.fn(async () => bucket(4, 1, 2, 1)) };
  // What the API records: the rollback refused (the target changed), then Restore anyway.
  const entries = [e('decision_made', { status: 'overridden', action: 'overridden' }), e('decision_rolled_back', { status: 'overridden', action: 'restore_anyway' })];
  expect(await foldLabels(entries, { decisions, cursors })).toBe(1);
  expect(decisions.bumpCalibration).toHaveBeenCalledTimes(1);
});
