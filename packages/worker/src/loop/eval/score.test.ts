import { expect, test } from 'vitest';
import type { Activity, Decision, DecisionTarget, DecisionType } from '@fb/core';
import {
  freezeSplit, formatReplayReport, isHeldOut, NO_SPLIT, ownerActions, replayReport, scoreCut, verdictOf, type OwnerAction,
} from './score.ts';

let n = 0;
const entry = (o: Partial<Activity>): Activity => ({
  id: `act:${++n}`, ts: '2026-11-01T00:00:00.000Z', kind: 'lesson_decided', actor: 'you', projectKey: 'p', subject: 'approved lesson "x"', why: '', details: {}, targets: ['lesson:a'], ...o,
});
const decision = (type: DecisionType, targets: DecisionTarget[], o: Partial<Decision> = {}): Decision => ({
  id: `dec:${++n}`, type, projectKey: 'p', targets, before: [], after: [], evidence: [], features: {}, score: 0.5, confidence: { p: 0.5, lower: 0.4, n: 0, band: 2 },
  tier: 'H', mode: 'observe', rationale: '', model: 'deterministic', policyVersion: 1, status: 'observed', dependsOn: [], createdAt: '2026-11-01T00:00:00.000Z',
  appliedAt: null, decidedAt: null, decidedBy: null, supersededBy: null, rollback: null, ratifiedAt: null, ratifiedBy: null, syncHoldUntil: null, ...o,
});
const lessonT = (id: string, role: DecisionTarget['role'] = 'primary'): DecisionTarget => ({ kind: 'lesson', id, role });
const act = (kind: OwnerAction['kind'], target: string, o: Partial<OwnerAction> = {}): OwnerAction => ({ kind, target, ts: '2026-11-02T00:00:00.000Z', projectKey: 'p', ...o });

test('ownerActions reads only the owner\'s entries, oldest first, as the actions they are', () => {
  const as = ownerActions([
    entry({ ts: '2026-11-05T00:00:00.000Z', kind: 'lesson_to_fact', subject: 'converted', targets: ['lesson:f', 'fact:1'] }),
    entry({ details: { status: 'approved', changed: { rule: { from: 'a', to: 'b' }, paths: { from: [], to: ['x'] } }, supersedes: 'lesson:dup' } }),
    entry({ details: { status: 'revoked' }, subject: 'revoked lesson "x"' }),
    entry({ details: { status: 'approved' }, subject: 'edited lesson "x"' }),
    entry({ actor: 'operator:codex', details: { status: 'rejected' }, subject: 'rejected lesson "x"' }),
    entry({ details: { status: 'rejected' }, subject: 'rejected lesson "x"', targets: [] }),
    entry({ kind: 'feedback_decided', details: { status: 'confirmed' }, targets: ['c1'] }),
    entry({ kind: 'feedback_decided', details: { status: 'rejected' }, targets: ['c2'] }),
    entry({ kind: 'feedback_decided', details: { status: 'other' }, targets: ['c3'] }),
    entry({ kind: 'decision_applied', details: { decisionType: 'approve_lesson', action: 'approve' }, targets: ['dec:1', 'lesson:z', 'lesson:b'] }),
    entry({ kind: 'decision_made', details: { decisionType: 'approve_lesson', action: 'keep' }, targets: ['dec:2'] }),
    entry({ kind: 'decision_made', details: { decisionType: 'link_misses', action: 'reject' }, targets: ['dec:3', 'miss:a'] }),
    entry({ kind: 'decision_rolled_back', details: { decisionType: 'link_misses', action: 'cascade' }, targets: ['dec:4', 'miss:b'] }),
    entry({ kind: 'decision_made', details: { decisionType: 'link_misses', action: 'overridden' }, targets: ['dec:5'] }),
    entry({ kind: 'decision_made', details: {}, targets: ['dec:6'] }),
    entry({ kind: 'context_served', details: {}, targets: ['lesson:a'] }),
  ]);
  expect(as.map((a) => [a.kind, a.target, a.other ?? a.targets ?? null])).toEqual([
    ['approved', 'lesson:a', null], ['edited_text', 'lesson:a', null], ['edited_scope', 'lesson:a', null], ['merged', 'lesson:a', 'lesson:dup'],
    ['revoked', 'lesson:a', null],
    ['inbox_confirmed', 'c1', null], ['inbox_rejected', 'c2', null],
    ['kept_decision', 'dec:1', ['lesson:b', 'lesson:z']], ['kept_decision', 'dec:2', []], ['undid_decision', 'dec:3', ['miss:a']], ['undid_decision', 'dec:4', ['miss:b']],
    ['to_fact', 'lesson:f', null],
  ]);
  expect(ownerActions([entry({ kind: 'decision_rolled_back', details: { decisionType: 'link_misses' }, targets: [] })])).toEqual([
    expect.objectContaining({ kind: 'undid_decision', target: '', targets: [] }),
  ]);
});

test('verdictOf: each type against the owner\'s actions on its targets; the first status action decides', () => {
  const a = [lessonT('lesson:a')];
  expect(verdictOf(decision('approve_lesson', a), [act('approved', 'lesson:a')])).toBe('agree');
  expect(verdictOf(decision('approve_lesson', a), [act('rejected', 'lesson:a'), act('approved', 'lesson:a')])).toBe('contradict');
  expect(verdictOf(decision('approve_lesson', a), [act('approved', 'lesson:b')])).toBe('unlabelled');
  expect(verdictOf(decision('reject_lesson', a), [act('rejected', 'lesson:a')])).toBe('agree');
  expect(verdictOf(decision('reject_lesson', a), [act('approved', 'lesson:a')])).toBe('contradict');
  expect(verdictOf(decision('retire_lesson', a), [act('revoked', 'lesson:a')])).toBe('agree');
  expect(verdictOf(decision('retire_lesson', a), [act('edited_text', 'lesson:a')])).toBe('unlabelled');
  expect(verdictOf(decision('reword_lesson', a), [act('edited_text', 'lesson:a')])).toBe('agree');
  expect(verdictOf(decision('narrow_scope', a), [act('edited_scope', 'lesson:a')])).toBe('agree');
  expect(verdictOf(decision('record_fact', a), [act('to_fact', 'lesson:a')])).toBe('agree');
  // A decision with only a keeper names it as its primary target by position.
  expect(verdictOf(decision('approve_lesson', [lessonT('lesson:a', 'keeper')]), [act('approved', 'lesson:a')])).toBe('agree');

  const merge = decision('merge_duplicates', [lessonT('lesson:k', 'keeper'), lessonT('lesson:d', 'merged')]);
  expect(verdictOf(merge, [act('merged', 'lesson:k', { other: 'lesson:d' })])).toBe('agree');
  expect(verdictOf(merge, [act('merged', 'lesson:d', { other: 'lesson:k' })])).toBe('agree');
  expect(verdictOf(merge, [act('merged', 'lesson:k', { other: 'lesson:x' })])).toBe('unlabelled');
  expect(verdictOf(merge, [act('rejected', 'lesson:d')])).toBe('agree');

  const confirm = decision('triage_inbox', [{ kind: 'candidate', id: 'c', role: 'primary' }], { after: [{ kind: 'candidate', id: 'c', fields: { status: 'confirmed' }, fingerprint: 'f' }] });
  const reject = decision('triage_inbox', [{ kind: 'candidate', id: 'c', role: 'primary' }], { after: [{ kind: 'candidate', id: 'c', fields: { status: 'rejected' }, fingerprint: 'f' }] });
  expect(verdictOf(confirm, [act('inbox_confirmed', 'c')])).toBe('agree');
  expect(verdictOf(confirm, [act('inbox_rejected', 'c')])).toBe('contradict');
  expect(verdictOf(reject, [act('inbox_rejected', 'c')])).toBe('agree');
  expect(verdictOf(reject, [act('inbox_confirmed', 'c')])).toBe('contradict');

  const link = decision('link_misses', [{ kind: 'miss', id: 'miss:b', role: 'primary' }, { kind: 'miss', id: 'miss:a', role: 'keeper' }]);
  expect(verdictOf(link, [])).toBe('unlabelled');
  expect(verdictOf(decision('rank_weight', a), [act('approved', 'lesson:a')])).toBe('unlabelled');
  expect(verdictOf(decision('tune_threshold', [{ kind: 'project', id: 'p', role: 'primary' }]), [])).toBe('unlabelled');
  // The owner's verdict on the loop's own decision for the same call wins.
  expect(verdictOf(link, [act('kept_decision', 'dec:9', { decisionType: 'link_misses', targets: ['miss:a', 'miss:b'] })])).toBe('agree');
  expect(verdictOf(link, [act('undid_decision', 'dec:9', { decisionType: 'link_misses', targets: ['miss:a', 'miss:b'] })])).toBe('contradict');
  expect(verdictOf(link, [act('undid_decision', 'dec:9', { decisionType: 'rank_weight', targets: ['miss:a', 'miss:b'] })])).toBe('unlabelled');
  expect(verdictOf(decision('approve_lesson', a), [act('undid_decision', 'dec:9', { decisionType: 'approve_lesson', targets: ['lesson:a'] }), act('approved', 'lesson:a')])).toBe('contradict');
});

test('the held-out split: frozen projects or months, picked by a fixed hash', () => {
  const keys = Array.from({ length: 20 }, (_, i) => `p${i}`);
  const s = freezeSplit([...keys, 'p1'], 0.25);
  expect(s.projects).toHaveLength(5);
  expect(s.projects).toEqual([...s.projects].sort());
  expect(freezeSplit([...keys].reverse(), 0.25)).toEqual(s);
  expect(freezeSplit(keys, 0)).toEqual({ projects: [], months: [] });
  expect(isHeldOut({ projects: ['a'], months: [] }, 'a', '2026-11-01T00:00:00.000Z')).toBe(true);
  expect(isHeldOut({ projects: ['a'], months: [] }, 'b', '2026-11-01T00:00:00.000Z')).toBe(false);
  expect(isHeldOut({ projects: ['a'], months: [] }, null, '2026-11-01T00:00:00.000Z')).toBe(false);
  expect(isHeldOut({ projects: [], months: ['2026-11'] }, null, '2026-11-01T00:00:00.000Z')).toBe(true);
  expect(isHeldOut(NO_SPLIT, 'a', '2026-11-01T00:00:00.000Z')).toBe(false);
});

test('scoreCut and the report: precision over the labelled calls, strict precision over all, recall over the owner\'s actions, per split', () => {
  const t0 = '2026-11-01T00:00:00.000Z';
  const split = { projects: ['held'], months: [] };
  const cut = scoreCut(t0, [
    decision('approve_lesson', [lessonT('lesson:a')]),
    decision('approve_lesson', [lessonT('lesson:b')]),
    decision('approve_lesson', [lessonT('lesson:c')]),
    decision('approve_lesson', [lessonT('lesson:h')], { projectKey: 'held' }),
    decision('link_misses', [{ kind: 'miss', id: 'miss:x', role: 'primary' }]),
  ], [
    act('approved', 'lesson:a'), act('rejected', 'lesson:b'), act('approved', 'lesson:d'), act('approved', 'lesson:h', { projectKey: 'held' }),
    act('kept_decision', 'dec:1', { decisionType: 'link_misses', targets: ['miss:y'] }),
  ], split);
  expect(cut.decisions.map((d) => [d.verdict, d.heldOut])).toEqual([['agree', false], ['contradict', false], ['unlabelled', false], ['agree', true], ['unlabelled', false]]);
  expect(cut.actions.map((a) => [a.action.target, a.type, a.caught, a.heldOut])).toEqual([
    ['lesson:a', 'approve_lesson', true, false], ['lesson:b', 'reject_lesson', false, false], ['lesson:d', 'approve_lesson', false, false], ['lesson:h', 'approve_lesson', true, true],
  ]);

  const r = replayReport([cut]);
  expect(r.cuts).toEqual([t0]);
  expect(r.tuning.map((s) => s.type)).toEqual(['approve_lesson', 'link_misses', 'reject_lesson']);
  expect(r.tuning[0]).toMatchObject({ decisions: 3, agree: 1, contradict: 1, unlabelled: 1, precision: { k: 1, n: 2 }, strictPrecision: { k: 1, n: 3 }, recall: { k: 1, n: 2 } });
  expect(r.tuning[2]).toMatchObject({ decisions: 0, recall: { k: 0, n: 1 } });
  expect(r.heldOut).toEqual([expect.objectContaining({ type: 'approve_lesson', decisions: 1, agree: 1, recall: expect.objectContaining({ k: 1, n: 1 }) })]);

  const text = formatReplayReport(r);
  expect(text).toContain('## Tuning set');
  expect(text).toMatch(/\| approve_lesson \| 3 \| 1 \| 1 \| 1 \| 50% \[\d+–\d+\] n=2 \| 33% \[\d+–\d+\] n=3 \| 50% \[\d+–\d+\] n=2 \|/);
  expect(text).toContain('| reject_lesson | 0 | 0 | 0 | 0 | – | – | 0% [0–79] n=1 |');
  expect(formatReplayReport(replayReport([]))).toContain('Nothing to score.');
});
