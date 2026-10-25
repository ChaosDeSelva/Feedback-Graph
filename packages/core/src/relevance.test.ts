import { expect, test } from 'vitest';
import type { FactHit, StoredFact } from './graph/facts.ts';
import { factOrigin, isNonMiss, pathAffinity, rankFacts, rankMisses, relevanceBand } from './relevance.ts';

const hit = (statement: string, score: number, relevance: number | null): FactHit => ({
  fact: { id: statement, statement, relevance, relevanceBy: relevance === null ? null : 'model' } as StoredFact,
  score,
});

test('rankFacts weighs similarity by relevance, so an everyday fact beats a slightly closer setup fact', () => {
  const ranked = rankFacts([hit('setup the linter in your editor', 0.74, 0.1), hit('every query is scoped by orgId', 0.7, 0.9)], 5);
  expect(ranked.map((h) => h.fact.statement)).toEqual(['every query is scoped by orgId']);
});

test('rankFacts keeps a low-relevance fact when the task is very close to it (a setup task)', () => {
  const ranked = rankFacts([hit('how to configure the deploy tool', 0.85, 0.1), hit('every query is scoped by orgId', 0.6, 0.9)], 5);
  expect(ranked.map((h) => h.fact.statement).sort()).toEqual(['every query is scoped by orgId', 'how to configure the deploy tool']);
});

test('rankFacts ranks unscored facts as middling, keeps n, and returns the weighted score', () => {
  const ranked = rankFacts([hit('a', 0.8, null), hit('b', 0.8, 1), hit('c', 0.8, 0.5), hit('d', 0.5, 1)], 2);
  expect(ranked.map((h) => h.fact.statement)).toEqual(['b', 'a']);
  expect(ranked[0].score).toBeCloseTo(0.8);
  expect(ranked[1].score).toBeCloseTo(0.8 * (0.55 + 0.45 * 0.5));
});

test('relevanceBand names the three bands, and unscored', () => {
  expect([0.9, 0.8, 0.5, 0.4, 0.39, 0, null].map(relevanceBand)).toEqual(['everyday', 'everyday', 'sometimes', 'sometimes', 'rare', 'rare', 'unscored']);
});

test('factOrigin: as recorded, else a document by its docId and a manifest fact by its reason', () => {
  expect(factOrigin({ origin: 'manifest', docId: null, why: 'w' })).toBe('manifest');
  expect(factOrigin({ docId: 'doc:demo:upload:a.md', why: 'w' })).toBe('document');
  expect(factOrigin({ docId: null, why: 'Read directly from package.json; no model involved.' })).toBe('manifest');
  expect(factOrigin({ docId: null, why: 'callers rely on it' })).toBe('model');
});

test('the everyday band starts where the rubric says it does (0.8), so a 0.7 "some changes" fact is not everyday', () => {
  expect(relevanceBand(0.8)).toBe('everyday');
  expect(relevanceBand(0.7)).toBe('sometimes');
});

test('isNonMiss spots a post-mortem that concluded there was no miss', () => {
  expect(isNonMiss('The agent did not miss the feedback, as the feedback was directed at a different pull request')).toBe(true);
  expect(isNonMiss("The agent didn't miss anything: the comment was about another file")).toBe(true);
  expect(isNonMiss('No miss: the reviewer was asking a question')).toBe(true);
  expect(isNonMiss('This was not a miss by the agent')).toBe(true);
  expect(isNonMiss('The agent did not update the unit tests for the new route')).toBe(false);
  expect(isNonMiss('The agent missed the tenant check')).toBe(false);
});

test('pathAffinity favours paths in the named files\' folders and service, and disfavours another service', () => {
  const files = ['src/webapp/core/src/features/users/router.ts'];
  expect(pathAffinity('src/webapp/AGENTS.md', files)).toBeGreaterThan(pathAffinity('src/webapp/apps/spa/main.ts', files));
  expect(pathAffinity('src/webapp/apps/spa/main.ts', files)).toBeGreaterThan(1);
  expect(pathAffinity('src/context-graph/service.go', files)).toBeLessThan(1);
  expect(pathAffinity('.', files)).toBe(1);
  expect(pathAffinity('README.md', files)).toBeGreaterThanOrEqual(1);
  expect(pathAffinity('src/context-graph/service.go', [])).toBe(1);
});

test('rankFacts with named files puts the facts of their service first and drops what falls far below the best', () => {
  const at = (statement: string, path: string, score: number): FactHit => ({ fact: { id: statement, statement, path, relevance: 0.8, relevanceBy: 'model' } as StoredFact, score });
  const ranked = rankFacts([
    at('ingest uses sqlc mutations', 'src/ingest/AGENTS.md', 0.66),
    at('confirm the router is wired', 'src/webapp/AGENTS.md', 0.6),
    at('unrelated gateway rule', 'src/llm-gateway/README.md', 0.3),
  ], 5, ['src/webapp/core/src/features/users/router.ts']);
  expect(ranked.map((h) => h.fact.statement)).toEqual(['confirm the router is wired', 'ingest uses sqlc mutations']);
});

test('rankMisses drops non-misses and weak matches, and favours misses that name the named files\' service', () => {
  const m = (missed: string, score: number, feedbackText = '') => ({ missId: missed, missed, feedbackText, score });
  const ranked = rankMisses([
    m('The agent did not miss the feedback, it was about another PR', 0.9),
    m('Missed the exists=true filter in src/context-graph/internal/page.go', 0.66),
    m('Missed the admin gate in src/webapp/core/src/features/settings/usage.ts', 0.6),
    m('Missed a Brotli CVE bump', 0.2),
  ], 4, ['src/webapp/core/src/features/settings/users/router.ts']);
  expect(ranked.map((x) => x.missId)).toEqual([
    'Missed the admin gate in src/webapp/core/src/features/settings/usage.ts',
    'Missed the exists=true filter in src/context-graph/internal/page.go',
  ]);
  expect(rankMisses([m('a', 0.8), m('b', 0.4)], 4, []).map((x) => x.missId)).toEqual(['a']);
});
