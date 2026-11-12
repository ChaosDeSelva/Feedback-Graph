import { expect, test } from 'vitest';
import { addPenalty, penaltyGroup, readPenalties, score, sigmoid } from './policy.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { m, getCursor: async (k: string) => m.get(k) ?? null, setCursor: async (k: string, v: string) => { m.set(k, v); } };
};
const t = { weights: { bias: -1, a: 2, b: 1 }, groups: { evidence: ['a'], scope: ['b'] } };

test('score is σ(bias + Σ w·x); unknown features count 0', () => {
  expect(sigmoid(0)).toBe(0.5);
  expect(score(t, {})).toBeCloseTo(sigmoid(-1), 12);
  expect(score(t, { a: 1, b: 0.5, c: 9 })).toBeCloseTo(sigmoid(-1 + 2 + 0.5), 12);
});

test('penalties scale down their group, 0.9 per rollback reason', () => {
  expect(score(t, { a: 1, b: 1 }, { evidence: 2, scope: 1 })).toBeCloseTo(sigmoid(-1 + 2 * 0.81 + 0.9), 12);
  expect(score({ weights: { bias: 0, a: 1 } }, { a: 1 }, { evidence: 5, scope: 5 })).toBeCloseTo(sigmoid(1), 12);
});

test('rollback reasons are counted per type and group; the others count nothing', async () => {
  const c = memory();
  expect(await readPenalties(c, 'link_misses')).toEqual({ evidence: 0, scope: 0 });
  await addPenalty(c, 'link_misses', 'wrong_evidence');
  await addPenalty(c, 'link_misses', 'wrong_evidence');
  await addPenalty(c, 'link_misses', 'too_broad');
  await addPenalty(c, 'link_misses', 'wording');
  await addPenalty(c, 'link_misses', null);
  expect(await readPenalties(c, 'link_misses')).toEqual({ evidence: 2, scope: 1 });
  expect(await readPenalties(c, 'rank_weight')).toEqual({ evidence: 0, scope: 0 });
  expect([penaltyGroup('not_now'), penaltyGroup('other')]).toEqual([null, null]);
  c.m.set('loop-penalty:rank_weight', '{');
  expect(await readPenalties(c, 'rank_weight')).toEqual({ evidence: 0, scope: 0 });
});
