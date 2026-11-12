import { expect, test } from 'vitest';
import { shortenLinks } from './CandidateDetail.tsx';

test('short links stay as written; long or percent-encoded ones are cut to their host', () => {
  expect(shortenLinks('see https://github.com/me/shop/pull/3 for it')).toBe('see https://github.com/me/shop/pull/3 for it');
  expect(shortenLinks(`Visit Preview (https://vercel.com/acme/shop/${'a'.repeat(80)})`)).toBe('Visit Preview (vercel.com/…)');
  expect(shortenLinks('https://x.io/?u=%2F%2F%2Fpath')).toBe('x.io/…');
});

test('a long link that is not a valid URL is cut to its first 40 characters', () => {
  const bad = `https://bad%host/${'x'.repeat(80)}`;
  expect(shortenLinks(`open ${bad} now`)).toBe(`open ${bad.slice(0, 40)}… now`);
});
