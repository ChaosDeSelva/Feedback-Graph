import { expect, test } from 'vitest';
import type { PendingSessionItem } from '@fb/core';
import { INSTRUCTION_RULES_CURSOR, resolvePendingInstructions } from './pendingInstructions.ts';

const ORDER = 'this should be on its own branch based on main, do not merge back to main, dont push a PR yet';
const COMPLAINT = 'The PR description is inaccurate, please fix it';
const item = (id: string, text: string): PendingSessionItem => ({ id, turnUuid: `u-${id}`, projectKey: 'demo', text, precedingToolCalls: [] });

test('items decided by the owner meanwhile are left alone, an earlier instruction in a live session waits, and what changed is logged', async () => {
  const cursors = new Map([[INSTRUCTION_RULES_CURSOR, 'v1']]);
  const logs: [string, object | undefined][] = [];
  const longAgo = '2020-01-01T00:00:00Z';
  const r = await resolvePendingInstructions({
    graph: {
      // a and b are pending: the owner decided a meanwhile (the skip finds it no longer pending).
      pendingSessionItems: async (q) => (q.afterId ? [] : [item('a', ORDER), item('b', ORDER)]),
      skipPendingItem: async (id) => id === 'b',
      // c and d were rejected by v1: the owner decided c meanwhile; e's session is still going.
      ruleSkippedItems: async (q) => (q.afterId ? [] : [item('c', COMPLAINT), item('d', COMPLAINT), item('e', ORDER)]),
      reopenRuleSkippedItem: async (id) => id === 'd',
      callsAfter: async (uuid) => ({ calls: [], laterTurns: 1, endedAt: uuid === 'u-e' ? new Date().toISOString() : longAgo }),
    },
    cursors: { getCursor: async (k) => cursors.get(k) ?? null, setCursor: async (k, v) => void cursors.set(k, v) },
    log: (m, x) => logs.push([m, x]),
  });
  expect(r).toEqual({ resolved: 1, reopened: 1 });
  expect(logs).toEqual([['instruction rule applied to the Inbox', { resolved: 1, reopened: 1, waiting: 1 }]]);
  // Something waits: the version is not recorded, so the next start looks again.
  expect(cursors.get(INSTRUCTION_RULES_CURSOR)).toBe('v1');
});
