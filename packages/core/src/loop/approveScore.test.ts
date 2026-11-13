import { describe, expect, test } from 'vitest';
import type { CalibrationBucket, Decision, DecisionType, Lesson } from '../types.ts';
import {
  BLOCKING_SCORE_CAP, byScore, CLAIM_FLAG_CAP, fromSignal, judgementFirst, posteriorOf, scoreBand, scoreCandidate, scoreClaim, scoreDecision,
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
const lesson = (checks: Lesson['checks'], status: Lesson['status'] = 'proposed') => ({ id: 'l1', status, checks });
const pending = (label: 'pushback' | 'neutral', confidence: number) => ({ id: 'c1', status: 'pending' as const, classification: { label, confidence, summary: '', signals: [] } });

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

describe('a calibrated call', () => {
  const post = posteriorOf([bucket('approve_lesson', 4, 60, 2), bucket('reject_lesson', 4, 60, 2)]);
  test('an approve call scores 10 x p, shrunk, with the record in its why', () => {
    const s = scoreLesson(lesson([]), [call('approve_lesson', 'l1')], post);
    expect(s.score).toBeGreaterThanOrEqual(7);
    expect(s.score).toBeLessThan(10 * (61 / 67));
    expect(s.scoreWhy).toMatch(/^\d\.\d · loop proposes approve_lesson: you kept 60 of 62 in its band \(p \.91\)$/);
  });
  test('a reject call scores 10 x (1 - p)', () => {
    const s = scoreLesson(lesson([]), [call('reject_lesson', 'l1')], post);
    expect(s.score).toBeLessThanOrEqual(3);
    const a = scoreLesson(lesson([]), [call('approve_lesson', 'l1')], post).score!;
    expect(s.score! + a).toBeCloseTo(10, 0);
  });
  test('a cold band (prior only) stays near 5 and says so', () => {
    const s = scoreLesson(lesson([]), [call('approve_lesson', 'l1')], none);
    expect(s.score).toBeGreaterThan(3);
    expect(s.score).toBeLessThan(5);
    expect(s.scoreWhy).toContain('none of yours in its band yet (prior p .20)');
  });
  test('only a proposed loop call on the item as primary counts, newest first', () => {
    const others = [
      call('approve_lesson', 'l1', { status: 'rejected' }),
      call('approve_lesson', 'l1', { author: 'owner' }),
      call('approve_lesson', 'l2'),
      call('approve_lesson', 'l1', { targets: [{ kind: 'lesson', id: 'l1', role: 'keeper' }] }),
    ];
    expect(scoreLesson(lesson([]), others, post).scoreWhy).toContain('no lesson check flags it');
    expect(scoreLesson(lesson([]), [call('reject_lesson', 'l1'), call('approve_lesson', 'l1')], post).scoreWhy).toContain('reject_lesson');
  });
});

describe('lessons', () => {
  test('only a proposed lesson is scored', () => {
    expect(scoreLesson(lesson([], 'approved'), [], none)).toEqual(UNSCORED);
  });
  test('falls back to its checks: unchecked 5, clean above 5, blocking below', () => {
    expect(scoreLesson(lesson(null), [], none)).toEqual({ score: 5, scoreWhy: '5.0 · not checked yet' });
    expect(scoreLesson(lesson([]), [], none).score).toBeGreaterThan(5);
    expect(scoreLesson(lesson([{ name: 'bad-path', why: '' }]), [], none).score).toBe(5);
    const bad = scoreLesson(lesson([{ name: 'generic', why: '' }]), [], none);
    expect(bad.score).toBeLessThan(5);
    expect(bad.scoreWhy).toContain('fails check generic');
  });
  test('a blocking flag caps it low, however sure the call, and leads the why', () => {
    const post = posteriorOf([bucket('approve_lesson', 4, 200, 0)]);
    for (const name of ['risky-command', 'may-hold-secret', 'off-turn', 'example-applies-when'] as const) {
      const s = scoreLesson(lesson([{ name, why: '' }]), [call('approve_lesson', 'l1')], post);
      expect(s.score).toBe(BLOCKING_SCORE_CAP);
      expect(s.scoreWhy).toBe(`2.0 · flagged ${name}; loop proposes approve_lesson: you kept 200 of 200 in its band (p .98)`);
    }
  });
  test('a cap never raises a score already under it', () => {
    const post = posteriorOf([bucket('reject_lesson', 4, 200, 0)]);
    const s = scoreLesson(lesson([{ name: 'risky-command', why: '' }]), [call('reject_lesson', 'l1')], post);
    expect(s.score).toBeLessThan(BLOCKING_SCORE_CAP);
    expect(s.scoreWhy).not.toContain('flagged');
  });
});

describe('Inbox items', () => {
  test('a triage call: confirm approves, reject rejects', () => {
    const post = posteriorOf([bucket('triage_inbox', 4, 40, 0)]);
    expect(scoreCandidate(pending('pushback', 0.9), [call('triage_inbox', 'c1')], post).score).toBeGreaterThanOrEqual(7);
    expect(scoreCandidate(pending('pushback', 0.2), [call('triage_inbox', 'c1', { afterStatus: 'rejected' })], post).score).toBeLessThanOrEqual(3);
  });
  test('else the classifier, uncalibrated: never in the green band on its own', () => {
    const sure = scoreCandidate(pending('pushback', 0.99), [], none);
    expect(sure.score).toBeGreaterThan(5);
    expect(sure.score).toBeLessThan(7);
    expect(sure.scoreWhy).toContain('classifier 99% sure it is pushback');
    expect(scoreCandidate(pending('neutral', 0.9), [], none).score).toBeLessThan(5);
  });
  test('a decided item is not scored', () => {
    expect(scoreCandidate({ ...pending('pushback', 0.9), status: 'confirmed' }, [], none)).toEqual(UNSCORED);
  });
});

describe('claims and questions', () => {
  const claim = (o: { flags?: never[] | ('quote-fuzzy' | 'statement-adds')[]; conflicts?: unknown[]; confidence?: number } = {}) =>
    ({ id: 'k1', status: 'proposed' as const, confidence: o.confidence ?? 0.95, flags: o.flags ?? [], conflicts: o.conflicts ?? [] });
  test('an accept_claim call, a flag or an open conflict caps at a judgement call', () => {
    const post = posteriorOf([bucket('accept_claim', 4, 100, 0)]);
    expect(scoreClaim(claim(), [call('accept_claim', 'k1')], post).score).toBeGreaterThanOrEqual(7);
    expect(scoreClaim(claim({ flags: ['quote-fuzzy'] }), [call('accept_claim', 'k1')], post)).toMatchObject({ score: CLAIM_FLAG_CAP });
    expect(scoreClaim(claim({ conflicts: [{}] }), [], post).scoreWhy).toMatch(/^5\.0 · an open conflict names it; extraction/);
  });
  test('a low-confidence claim scores under 5; a decided one is not scored', () => {
    expect(scoreClaim(claim({ confidence: 0.1 }), [], none).score).toBeLessThan(5);
    expect(scoreClaim({ ...claim(), status: 'accepted' }, [], none)).toEqual(UNSCORED);
  });
  test('a question is scored only under an assign or close proposal', () => {
    const q = { id: 'q1', status: 'open' as const };
    expect(scoreQuestion(q, [], none)).toEqual(UNSCORED);
    expect(scoreQuestion(q, [call('close_question', 'q1')], none).scoreWhy).toContain('close_question');
    expect(scoreQuestion({ ...q, status: 'answered' }, [call('close_question', 'q1')], none)).toEqual(UNSCORED);
  });
});

describe('decisions', () => {
  test('a proposed loop decision reads its live band; others are not scored', () => {
    const post = posteriorOf([bucket('approve_lesson', 4, 12, 0)]);
    expect(scoreDecision(call('approve_lesson', 'l1'), post).scoreWhy).toContain('you kept 12 of 12 in its band (p .76)');
    expect(scoreDecision(call('approve_lesson', 'l1', { status: 'applied' }), post)).toEqual(UNSCORED);
    expect(scoreDecision(call('approve_lesson', 'l1', { author: 'owner' }), post)).toEqual(UNSCORED);
  });
  test('housekeeping cold-starts above 5 (its prior trusts it)', () => {
    expect(scoreDecision(call('link_misses', 'm1'), none).score).toBeGreaterThan(5);
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
  test('fromSignal at one half is exactly 5', () => {
    expect(fromSignal(0.5, '').q).toBeCloseTo(0.5, 10);
  });
});
