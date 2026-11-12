import { expect, test } from 'vitest';
import { missLinkSnapshot } from './snapshots.ts';

test('a miss link snapshot names both ends and whether the link is there; its fingerprint changes with each', () => {
  const off = missLinkSnapshot('miss:b', 'miss:a', false);
  const on = missLinkSnapshot('miss:b', 'miss:a', true);
  expect(off).toEqual({ kind: 'miss', id: 'miss:b', fields: { from: 'miss:b', to: 'miss:a', linked: false }, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(on.fingerprint).not.toBe(off.fingerprint);
  expect(missLinkSnapshot('miss:b', 'miss:c', true).fingerprint).not.toBe(on.fingerprint);
  expect(missLinkSnapshot('miss:b', 'miss:a', true)).toEqual(on);
});
