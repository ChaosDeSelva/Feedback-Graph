import type { ActivityInput } from '@fb/core';
import { expect, test } from 'vitest';
import { DECIDER_RULE_CURSOR, DECIDER_RULE_VERSION, migrateDeciderRule } from './deciders.ts';

function world(marked: string[]) {
  const cursors = new Map<string, string>();
  const activity: ActivityInput[] = [];
  const logs: [string, object | undefined][] = [];
  let left = [...marked];
  const d = {
    knowledge: { clearMachineOwnerMarks: async () => { const ids = left; left = []; return ids; } },
    cursors: { getCursor: async (k: string) => cursors.get(k) ?? null, setCursor: async (k: string, v: string) => void cursors.set(k, v) },
    activity: { record: async (a: ActivityInput) => void activity.push(a) },
    log: (m: string, x?: object) => void logs.push([m, x]),
  };
  return { d, cursors, activity, logs };
}

test("at start, once per rule version: a machine's decisions stored as the owner's lose the mark, logged and in Activity", async () => {
  const w = world(['lesson:a', 'lesson:b']);
  expect(await migrateDeciderRule(w.d)).toEqual({ cleared: 2 });
  expect(w.cursors.get(DECIDER_RULE_CURSOR)).toBe(`v${DECIDER_RULE_VERSION}`);
  expect(w.activity).toEqual([expect.objectContaining({
    kind: 'lessons_checked', actor: 'lesson-decider', projectKey: null,
    subject: expect.stringMatching(/2 lessons decided by a machine no longer count as yours/),
    targets: ['lesson:a', 'lesson:b'],
  })]);
  expect(w.logs).toContainEqual(['machine decisions no longer marked as yours', { cleared: 2, rule: `v${DECIDER_RULE_VERSION}` }]);
  // Ran for this version: not again.
  expect(await migrateDeciderRule(w.d)).toBeNull();
});

test('nothing to clear: the version is recorded, nothing is logged', async () => {
  const w = world([]);
  expect(await migrateDeciderRule(w.d)).toEqual({ cleared: 0 });
  expect(w.activity).toEqual([]);
  expect(w.cursors.get(DECIDER_RULE_CURSOR)).toBe(`v${DECIDER_RULE_VERSION}`);
});

test('a store that cannot tell: nothing runs and no version is recorded', async () => {
  const w = world([]);
  expect(await migrateDeciderRule({ ...w.d, knowledge: {} })).toBeNull();
  expect(w.cursors.size).toBe(0);
});
