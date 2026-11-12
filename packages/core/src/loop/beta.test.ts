import { expect, test } from 'vitest';
import { betaCdf, betaLower, betaQuantile, betaSummary } from './beta.ts';

test('betaCdf matches closed forms', () => {
  // Beta(1,1) is uniform; Beta(a,1) has cdf x^a; Beta(1,b) has cdf 1-(1-x)^b.
  expect(betaCdf(0.3, 1, 1)).toBeCloseTo(0.3, 10);
  expect(betaCdf(0.7, 4, 1)).toBeCloseTo(0.7 ** 4, 10);
  expect(betaCdf(0.2, 1, 4)).toBeCloseTo(1 - 0.8 ** 4, 10);
  expect(betaCdf(0.5, 30, 30)).toBeCloseTo(0.5, 10);
  // Beta(.3,.3) is symmetric (and exercises Γ below one half).
  expect(betaCdf(0.5, 0.3, 0.3)).toBeCloseTo(0.5, 8);
  expect(betaCdf(0, 2, 3)).toBe(0);
  expect(betaCdf(1, 2, 3)).toBe(1);
});

test('betaQuantile inverts the cdf', () => {
  expect(betaQuantile(0.1, 4, 1)).toBeCloseTo(0.1 ** 0.25, 8);
  expect(betaQuantile(0.1, 1, 4)).toBeCloseTo(1 - 0.9 ** 0.25, 8);
  for (const [a, b] of [[2, 5], [40, 3], [0.5, 0.5], [120, 9]]) expect(betaCdf(betaQuantile(0.1, a, b), a, b)).toBeCloseTo(0.1, 8);
});

test('betaSummary: the mean and the 10th percentile', () => {
  const s = betaSummary(4, 1);
  expect(s.p).toBe(0.8);
  expect(s.lower).toBeCloseTo(0.5623, 4);
  // 20 kept of 20 from the agent-facing prior: well above the prior, which is near 0.
  expect(betaSummary(21, 4).lower).toBeGreaterThan(0.7);
  expect(betaSummary(1, 4).lower).toBeLessThan(0.05);
  expect(betaLower(4, 1)).toBe(s.lower);
});
