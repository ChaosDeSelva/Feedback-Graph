import { describe, expect, test } from 'vitest';
import type { VerdictNeighbour } from '../store.ts';
import type { ScoreModel } from '../thresholds.ts';
import type { Candidate, ExternalRef } from '../types.ts';
import { candidateFeatures, claimFeatures, itemChance, lessonFeatures, logit, neighbourNoun, verdictEvidence } from './itemScore.ts';

const near = (approved: boolean, cosine = 0.9, sameProject = true, projectKey = 'shop'): VerdictNeighbour =>
  ({ id: `n${Math.random()}`, projectKey: sameProject ? projectKey : 'elsewhere', approved, cosine, sameProject, decidedAt: '2026-11-01T00:00:00Z' });
const model: ScoreModel = { floor: 0.5, base: 0.6, intercept: logit(0.6), verdicts: 1, features: { prAuthor: -1, flagged: -1 }, featureLabels: 4 };
const ext = (o: Partial<ExternalRef> = {}): ExternalRef => ({
  source: 'github', kind: 'review_comment', author: 'rev', url: 'u', thread: 'acme/shop#1', title: 't', threadUrl: 'u', path: null, line: null,
  diffHunk: null, branch: null, createdAt: '2026-11-01T00:00:00Z', linkedSessionIds: [], threadAuthor: 'dev', ...o,
});
const item = (o: Partial<Pick<Candidate, 'source' | 'external'>> = {}, confidence = 0.9): Pick<Candidate, 'classification' | 'source' | 'external'> =>
  ({ classification: { label: 'pushback', confidence, summary: '', signals: [] }, source: 'github', external: ext(), ...o });

describe('verdictEvidence', () => {
  test('no verdict near: your base rate, with no weight', () => {
    expect(verdictEvidence([], 0.6, 0.5)).toMatchObject({ p: 0.6, weight: 0, n: 0 });
    expect(verdictEvidence([near(true, 0.45)], 0.6, 0.5)).toMatchObject({ p: 0.6, n: 0 });
  });
  test('closer and same-project verdicts weigh more; the rate is pulled toward the base, not to 0 or 1', () => {
    const close = verdictEvidence([near(true, 0.95)], 0.5, 0.5);
    const far = verdictEvidence([near(true, 0.6)], 0.5, 0.5);
    const other = verdictEvidence([near(true, 0.95, false)], 0.5, 0.5);
    expect(close.weight).toBeGreaterThan(far.weight);
    expect(close.weight).toBeGreaterThan(other.weight);
    expect(close.p).toBeGreaterThan(other.p);
    expect(close.p).toBeLessThan(1);
    const all = verdictEvidence(Array.from({ length: 10 }, () => near(false)), 0.5, 0.5);
    expect(all.p).toBeLessThan(0.2);
    expect(all.p).toBeGreaterThan(0);
  });
  test('names the one project its verdicts came from, or none when they span several', () => {
    expect(verdictEvidence([near(true), near(false)], 0.5, 0.5)).toMatchObject({ projects: ['shop'], sameProject: true, approved: 1, n: 2 });
    expect(verdictEvidence([near(true), near(true, 0.9, false)], 0.5, 0.5).sameProject).toBe(false);
  });
});

describe('features', () => {
  const on = (fs: { name: string; x: number }[]) => fs.filter((f) => f.x !== 0).map((f) => f.name).sort();
  test('an Inbox item: who wrote it, a reply, its PR state, a bot', () => {
    expect(on(candidateFeatures(item({ external: ext({ author: 'Dev', threadAuthor: 'dev', isReply: true, threadState: 'merged' }) })))).toEqual(['classifier', 'merged', 'prAuthor', 'reply', 'synced']);
    expect(on(candidateFeatures(item({ external: ext({ authorKind: 'bot', threadState: 'closed' }) })))).toEqual(['bot', 'classifier', 'closedUnmerged', 'synced']);
    expect(on(candidateFeatures(item({ source: 'claude', external: null })))).toEqual(['classifier']);
  });
  test('the classifier reads as its chance of pushback: a confident neutral is negative', () => {
    const x = (label: 'pushback' | 'neutral', c: number) => candidateFeatures({ ...item(), classification: { label, confidence: c, summary: '', signals: [] } })[0].x;
    expect(x('pushback', 0.9)).toBeGreaterThan(0);
    expect(x('neutral', 0.9)).toBeLessThan(0);
    expect(x('pushback', 0.5)).toBeCloseTo(0, 10);
  });
  test('a lesson: failing checks, paths that do not exist, other flags, never checked', () => {
    expect(on(lessonFeatures({ checks: [{ name: 'generic', why: '' }, { name: 'bad-path', why: '' }, { name: 'broad-trigger', why: '' }] }))).toEqual(['badPath', 'failsCheck', 'flagged']);
    expect(on(lessonFeatures({ checks: null }))).toEqual(['unchecked']);
    expect(on(lessonFeatures({ checks: [] }))).toEqual([]);
  });
  test('a claim: confidence, flags, an opinion', () => {
    expect(on(claimFeatures({ confidence: 0.9, flags: ['quote-fuzzy'], type: 'opinion' }))).toEqual(['confidence', 'flagged', 'opinion']);
  });
});

describe('itemChance', () => {
  test('your confirmed neighbours raise it, your rejected ones lower it, in the one reason that says how many', () => {
    const f = candidateFeatures(item());
    const up = itemChance('candidate', f, Array.from({ length: 9 }, () => near(true)).concat(near(false)), model);
    const down = itemChance('candidate', f, Array.from({ length: 9 }, () => near(false)).concat(near(true)), model);
    expect(up.p).toBeGreaterThan(0.6);
    expect(down.p).toBeLessThan(0.6);
    expect(up.reasons[0]).toBe('you confirmed 9 of 10 similar reviewer comments in shop');
    expect(down.reasons[0]).toBe('you confirmed 1 of 10 similar reviewer comments in shop');
    expect(up.labels).toBeGreaterThan(itemChance('candidate', f, [], model).labels);
  });
  test('a feature that pushes the same way is a reason; with no similar verdict, that is said', () => {
    const c = itemChance('candidate', candidateFeatures(item({ external: ext({ author: 'dev' }) })), [], model);
    expect(c.p).toBeLessThan(0.6);
    expect(c.reasons).toEqual(["the PR author's own comment", 'none of your verdicts on similar Inbox items yet']);
    expect(neighbourNoun('candidate', candidateFeatures(item({ external: ext({ author: 'dev' }) })))).toBe('PR-author comments');
  });
  test('neighbours across projects are said to be', () => {
    const c = itemChance('lesson', lessonFeatures({ checks: [] }), [near(true), near(true, 0.9, false)], model);
    expect(c.reasons[0]).toBe('you approved 2 of 2 similar lessons across projects');
  });
  test('deterministic: the same inputs give the same chance', () => {
    const n = [near(true, 0.8), near(false, 0.7)];
    expect(itemChance('claim', claimFeatures({ confidence: 0.7, flags: [], type: 'fact' }), n, model)).toEqual(itemChance('claim', claimFeatures({ confidence: 0.7, flags: [], type: 'fact' }), n, model));
  });
});
