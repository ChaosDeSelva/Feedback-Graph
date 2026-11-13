import { describe, expect, test } from 'vitest';
import type { VerdictNeighbour } from '../store.ts';
import type { CalibrationBucket, Decision, DecisionType, Lesson } from '../types.ts';
import {
  BLOCKING_SCORE_CAP, byScore, CLAIM_FLAG_CAP, judgementFirst, posteriorOf, scoreBand, scoreCandidate, scoreClaim, scoreDecision,
  scoreLesson, scoreQuestion, shrink, UNSCORED,
} from './approveScore.ts';
import { LOOP_POLICY_VERSION } from './state.ts';

const bucket = (type: DecisionType, band: number, kept: number, undone: number, policyVersion = LOOP_POLICY_VERSION): CalibrationBucket =>
  ({ type, band, policyVersion, alpha: 1 + kept, beta: 4 + undone, n: kept + undone, updatedAt: '2026-11-01T00:00:00Z' });
const call = (type: DecisionType, id: string, o: Partial<Decision> & { afterStatus?: string } = {}): Decision => ({
  id: `dec:${type}:${id}`, type, projectKey: 'p', targets: [{ kind: 'lesson', id, role: 'primary' }], before: [],
  after: [{ kind: 'candidate', id, fields: { status: o.afterStatus ?? 'confirmed' }, fingerprint: 'f' }], evidence: [], features: {}, score: 0.9,
  confidence: { p: 0.5, lower: 0.3, n: 0, band: 4 }, tier: 'A', mode: 'propose', rationale: '', model: null, policyVersion: 1, status: 'proposed',
  dependsOn: [], createdAt: '2026-11-01T00:00:00Z', appliedAt: null, decidedAt: null, decidedBy: null, supersededBy: null, rollback: null,
  ratifiedAt: null, ratifiedBy: null, syncHoldUntil: null, ...o,
});
const none = posteriorOf([]);
const near = (approved: boolean, n: number, cosine = 0.95): VerdictNeighbour[] =>
  Array.from({ length: n }, (_, i) => ({ id: `v${approved}${i}`, projectKey: 'shop', approved, cosine, sameProject: true, decidedAt: '2026-11-01T00:00:00Z' }));
const lesson = (checks: Lesson['checks'], status: Lesson['status'] = 'proposed') => ({ status, checks });
const pending = { status: 'pending' as const, source: 'github' as const, external: null, classification: { label: 'pushback' as const, confidence: 0.8, summary: '', signals: [] } };

describe('shrink', () => {
  test('no evidence (Beta(1,1)) is exactly 5, and the weight grows with labels', () => {
    expect(shrink(0.9, { alpha: 1, beta: 1 })).toBeCloseTo(0.5, 10);
    const few = shrink(0.9, { alpha: 9, beta: 1 });
    const many = shrink(0.9, { alpha: 90, beta: 10 });
    expect(few).toBeGreaterThan(0.5);
    expect(many).toBeGreaterThan(few);
    expect(many).toBeLessThan(0.9);
  });
  test('is symmetric about one half', () => {
    expect(shrink(0.2, { alpha: 20, beta: 80 }) - 0.5).toBeCloseTo(-(shrink(0.8, { alpha: 80, beta: 20 }) - 0.5), 10);
  });
});

describe('posteriorOf', () => {
  test('reads the bucket of the type and band, else the prior with no labels, ignoring other policy versions', () => {
    const post = posteriorOf([bucket('approve_lesson', 4, 12, 1), bucket('approve_lesson', 3, 50, 0, LOOP_POLICY_VERSION + 1)]);
    expect(post('approve_lesson', 4)).toEqual({ alpha: 13, beta: 5, n: 13 });
    expect(post('approve_lesson', 3)).toEqual({ alpha: 1, beta: 4, n: 0 });
    expect(post('link_misses', 0)).toEqual({ alpha: 4, beta: 1, n: 0 });
  });
});

describe('Inbox items: your verdicts on similar items rank them', () => {
  test('ten close confirmed neighbours score above ten close rejected ones, each saying so first', () => {
    const up = scoreCandidate(pending, near(true, 10));
    const down = scoreCandidate(pending, near(false, 10));
    expect(up.score!).toBeGreaterThan(down.score!);
    expect(up.scoreWhy).toMatch(/^\d\.\d · you confirmed 10 of 10 similar Inbox items in shop/);
    expect(down.scoreWhy).toMatch(/^\d\.\d · you confirmed 0 of 10 similar Inbox items in shop/);
  });
  test('more of the same verdicts move it further from 5 (thin evidence stays near 5)', () => {
    const one = scoreCandidate(pending, near(true, 1)).score!;
    const ten = scoreCandidate(pending, near(true, 10)).score!;
    expect(ten).toBeGreaterThan(one);
    expect(Math.abs(scoreCandidate({ ...pending, classification: { ...pending.classification, confidence: 0.5 } }, []).score! - 5)).toBeLessThan(1);
  });
  test('the same item and neighbours give the same score; a decided item is unscored', () => {
    expect(scoreCandidate(pending, near(true, 3))).toEqual(scoreCandidate(pending, near(true, 3)));
    expect(scoreCandidate({ ...pending, status: 'confirmed' as never }, near(true, 3))).toEqual(UNSCORED);
  });
});

describe('lessons and claims', () => {
  test('a blocking flag caps a lesson whatever its neighbours say, and is the first reason', () => {
    const s = scoreLesson(lesson([{ name: 'risky-command', why: 'curl | sh' }]), near(true, 10));
    expect(s.score).toBeLessThanOrEqual(BLOCKING_SCORE_CAP);
    expect(s.scoreWhy).toMatch(/^\d\.\d · flagged risky-command; you approved 10 of 10 similar lessons in shop$/);
    expect(scoreLesson(lesson([]), near(true, 10)).score!).toBeGreaterThan(scoreLesson(lesson([]), near(false, 10)).score!);
    expect(scoreLesson(lesson([], 'approved'), [])).toEqual(UNSCORED);
  });
  const claim = (o: { flags?: ('quote-fuzzy' | 'statement-adds')[]; conflicts?: unknown[]; confidence?: number } = {}) =>
    ({ status: 'proposed' as const, type: 'fact' as const, confidence: o.confidence ?? 0.95, flags: o.flags ?? [], conflicts: o.conflicts ?? [] });
  test('a claim flag or an open conflict caps at a judgement call; low confidence scores under 5', () => {
    expect(scoreClaim(claim({ flags: ['quote-fuzzy'] }), near(true, 10))).toMatchObject({ score: CLAIM_FLAG_CAP });
    expect(scoreClaim(claim({ conflicts: [{}] }), near(true, 10)).scoreWhy).toMatch(/^5\.0 · an open conflict names it; /);
    expect(scoreClaim(claim({ confidence: 0.1 })).score).toBeLessThan(5);
    expect(scoreClaim({ ...claim(), status: 'accepted' as never })).toEqual(UNSCORED);
  });
});

describe('questions and decisions', () => {
  test('a question is scored only under an assign or close proposal, from its calibration', () => {
    const q = { id: 'q1', status: 'open' as const };
    expect(scoreQuestion(q, [], none)).toEqual(UNSCORED);
    expect(scoreQuestion(q, [call('close_question', 'q1')], none).scoreWhy).toContain('close_question');
    expect(scoreQuestion({ ...q, status: 'answered' }, [call('close_question', 'q1')], none)).toEqual(UNSCORED);
  });
  test('a call on one reviewed item scores as the item, reversed when it rejects it', () => {
    const item = { score: 8.1, scoreWhy: '8.1 · you confirmed 9 of 10 similar reviewer comments in shop' };
    const flat = posteriorOf([bucket('triage_inbox', 4, 1, 3)]);
    expect(scoreDecision(call('triage_inbox', 'c1'), flat, item)).toEqual({ score: 8.1, scoreWhy: item.scoreWhy });
    expect(scoreDecision(call('triage_inbox', 'c1', { afterStatus: 'rejected' }), flat, item)).toEqual({ score: 1.9, scoreWhy: '1.9 · you confirmed 9 of 10 similar reviewer comments in shop' });
    expect(scoreDecision(call('reject_lesson', 'l1'), flat, { score: 2, scoreWhy: '2.0 · fails check generic' }).score).toBe(8);
  });
  test('without its item, or for housekeeping, a call reads its live band; applied and owner ones are unscored', () => {
    const post = posteriorOf([bucket('approve_lesson', 4, 12, 0)]);
    expect(scoreDecision(call('approve_lesson', 'l1'), post).scoreWhy).toContain('you kept 12 of 12 in its band (p .76)');
    expect(scoreDecision(call('link_misses', 'm1'), none).score).toBeGreaterThan(5);
    expect(scoreDecision(call('approve_lesson', 'l1', { status: 'applied' }), post)).toEqual(UNSCORED);
    expect(scoreDecision(call('approve_lesson', 'l1', { author: 'owner' }), post)).toEqual(UNSCORED);
  });
});

describe('bands and orders', () => {
  test('bands at 3 and 7', () => {
    expect([0, 3, 3.1, 6.9, 7, 10].map(scoreBand)).toEqual(['low', 'low', 'middle', 'middle', 'high', 'high']);
  });
  test('byScore: highest first, unscored last; judgementFirst: the middle band nearest 5 first', () => {
    const rows = [{ score: 9, scoreWhy: '' }, UNSCORED, { score: 4.5, scoreWhy: '' }, { score: 1, scoreWhy: '' }, { score: 6, scoreWhy: '' }];
    expect([...rows].sort(byScore).map((r) => r.score)).toEqual([9, 6, 4.5, 1, null]);
    expect([...rows].sort(judgementFirst).map((r) => r.score)).toEqual([4.5, 6, 9, 1, null]);
  });
});
