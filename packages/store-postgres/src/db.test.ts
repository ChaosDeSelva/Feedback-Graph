import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { stripNul, toJson } from './db.ts';

test('stripNul removes NUL from strings, arrays and plain objects (keys too); other values pass through', () => {
  const d = new Date(0);
  expect(stripNul('a\0b')).toBe('ab');
  expect(stripNul(['a\0', 1, null, { 'k\0': ['x\0'] }])).toEqual(['a', 1, null, { k: ['x'] }]);
  expect(stripNul(d)).toBe(d);
  expect(stripNul(42)).toBe(42);
  expect(toJson({ t: 'a\0b' })).toBe('{"t":"ab"}');
});

test('every jsonb parameter is built with toJson: JSON.stringify would carry \\u0000, which jsonb refuses', () => {
  const dir = new URL('.', import.meta.url);
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'db.ts')
    .filter((f) => readFileSync(new URL(f, dir), 'utf8').includes('JSON.stringify('));
  expect(offenders).toEqual([]);
});
