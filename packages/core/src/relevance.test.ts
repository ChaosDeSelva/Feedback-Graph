import { expect, test } from 'vitest';
import type { FactHit, StoredFact } from './graph/facts.ts';
import { rankFacts, relevanceBand } from './relevance.ts';

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
  expect([0.9, 0.7, 0.5, 0.4, 0.39, 0, null].map(relevanceBand)).toEqual(['everyday', 'everyday', 'sometimes', 'sometimes', 'rare', 'rare', 'unscored']);
});
