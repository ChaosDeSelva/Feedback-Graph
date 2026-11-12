import { expect, test } from 'vitest';
import { rankLessons } from '../lessonRank.ts';
import type { Lesson } from '../types.ts';
import { thresholdsSnapshot } from './snapshots.ts';
import { orderByServingWeight, roundWeight, servingWeightOf } from './weights.ts';

const hit = (id: string, score: number, servingWeight?: number) => ({ lesson: { id, ...(servingWeight !== undefined && { servingWeight }) }, score });

test('a weight is kept in range, to one decimal; none is 1', () => {
  expect([roundWeight(0.3), roundWeight(1.7), roundWeight(1.1 + 0.1 + 0.1), roundWeight(0.95)]).toEqual([0.5, 1.5, 1.3, 1]);
  expect([servingWeightOf({}), servingWeightOf({ servingWeight: 0.7 })]).toEqual([1, 0.7]);
});

test('orderByServingWeight: a weight breaks near-ties among weighted lessons only; with no weight, the very same list', () => {
  const plain = [hit('a', 0.7), hit('b', 0.9)];
  expect(orderByServingWeight(plain)).toBe(plain);
  // Weighted ones swap within the band (0.02); unweighted ones keep their places.
  expect(orderByServingWeight([hit('a', 0.9), hit('b', 0.85, 0.9), hit('c', 0.86), hit('d', 0.845, 1.5)]).map((h) => h.lesson.id)).toEqual(['a', 'd', 'c', 'b']);
  // Never past a clearly better match, however far apart the weights.
  expect(orderByServingWeight([hit('best', 0.905, 0.5), hit('next', 0.845, 1.5)]).map((h) => h.lesson.id)).toEqual(['best', 'next']);
});

test('one rank_weight step never drops the best match from the six served (sweep: charge.ts, the best at 0.9, the rest at 1.1)', () => {
  const scores: [string, number][] = [['w02', 0.866], ['w01', 0.845], ['w08', 0.83], ['w03', 0.8], ['w05', 0.785], ['w04', 0.756], ['w06', 0.753], ['w07', 0.73]];
  const hits = scores.map(([id, score]) => hit(id, score, id === 'w02' ? 0.9 : 1.1));
  expect(orderByServingWeight(hits).slice(0, 6).map((h) => h.lesson.id)).toEqual(['w02', 'w01', 'w08', 'w03', 'w05', 'w04']);
  // Held-out lessons (never weighted) keep their places, so treated neighbours at 1.3 never push them out of the six.
  const held = ['w03', 'w05', 'w07', 'w08'];
  const treated = scores.map(([id, score]) => hit(id, score, held.includes(id) ? undefined : 1.3));
  const before = treated.slice(0, 6).map((h) => h.lesson.id).filter((id) => held.includes(id));
  expect(orderByServingWeight(treated).slice(0, 6).map((h) => h.lesson.id).filter((id) => held.includes(id))).toEqual(before);
});

test('rankLessons weighs only the lessons tied to the files: an untied heavy one is never served, a heavy one never passes a clearly better match', () => {
  const lesson = (id: string, o: Partial<Lesson> = {}): Lesson => ({
    id, projectKey: 'p', title: id, rule: 'r', appliesWhen: 'w', scope: 'project', paths: ['src/a.ts'], status: 'approved', source: 'postmortem',
    cause: null, missId: null, createdAt: 't', decidedAt: 't', ...o,
  });
  const hits = [
    { lesson: lesson('first'), score: 0.9 },
    { lesson: lesson('heavy', { servingWeight: 1.5 }), score: 0.7 },
    { lesson: lesson('untied', { servingWeight: 1.5, paths: ['src/b.ts'] }), score: 0.95 },
  ];
  expect(rankLessons(hits, 'task', { files: ['src/a.ts'], projectKey: 'p' }).map((h) => h.lesson.id)).toEqual(['first', 'heavy']);
});

test('a project floors snapshot: both floors, null for the default; the fingerprint changes with each and with the project', () => {
  const none = thresholdsSnapshot('p', { similarityFloor: null, factRankFloor: null });
  expect(none).toEqual({ kind: 'project', id: 'p', fields: { similarityFloor: null, factRankFloor: null }, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
  const fps = [none, thresholdsSnapshot('p', { similarityFloor: 0.8, factRankFloor: null }), thresholdsSnapshot('p', { similarityFloor: null, factRankFloor: 0.8 }), thresholdsSnapshot('q', { similarityFloor: null, factRankFloor: null })].map((s) => s.fingerprint);
  expect(new Set(fps).size).toBe(4);
});
