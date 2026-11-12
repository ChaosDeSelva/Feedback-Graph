import { expect, test } from 'vitest';
import { storedLabel } from './storedLabel.ts';

const RELATION = { depends_on: 'depends on', related: 'related' } as const satisfies Record<'depends_on' | 'related', string>;
const raw = (v: string) => v.replace(/_/g, ' ');

test('a known value gets its entry; one this release no longer knows gets the fallback, never undefined', () => {
  expect(storedLabel(RELATION, 'depends_on', raw)).toBe('depends on');
  expect(storedLabel(RELATION, 'forked_from', raw)).toBe('forked from');
});

test('names inherited from Object are not entries', () => {
  expect(storedLabel(RELATION, 'toString', raw)).toBe('toString');
  expect(storedLabel(RELATION, '__proto__', raw)).toBe('  proto  ');
});
