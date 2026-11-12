import { expect, test } from 'vitest';
import { LOOP_DECISION_TYPES } from '@fb/core';
import { LOOP_TYPES } from './index.ts';

test('the engine runs every decision type, each once', () => {
  expect(LOOP_TYPES.map((t) => t.type).sort()).toEqual([...LOOP_DECISION_TYPES].sort());
});
