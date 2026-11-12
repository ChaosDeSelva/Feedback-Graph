import { expect, test } from 'vitest';
import { contextWhy, NO_CONTEXT_WHY } from './types.ts';

test("contextWhy keeps a real reason, trimmed", () => {
  expect(contextWhy('  the lesson names this file ')).toBe('the lesson names this file');
  expect(contextWhy('True story: it was loaded')).toBe('True story: it was loaded');
});

test('contextWhy says no reason was given for an empty value, a bare value or an echoed field name', () => {
  for (const why of [null, undefined, '', '   ', 'true', 'FALSE', 'null', 'undefined', 'None', 'n/a', 'wasAvailable', 'contextItem', 'why', 'Kind', 'ref', 'excerpt']) {
    expect(contextWhy(why), String(why)).toBe(NO_CONTEXT_WHY);
  }
});
