import { expect, test } from 'vitest';
import type { ActivityInput, CallsAfter, PendingSessionItem, ToolCall } from '@fb/core';
import { DETECT_RULES_VERSION } from './instruction.ts';
import { INSTRUCTION_RULES_CURSOR, resolvePendingInstructions } from './pendingInstructions.ts';

const bash = (command: string): ToolCall => ({ name: 'Bash', ts: '2026-10-20T10:00:00Z', command });
const item = (id: string, text: string, before: ToolCall[] = []): PendingSessionItem => ({ id, turnUuid: `u-${id}`, projectKey: 'demo', text, precedingToolCalls: before });
const ended = '2026-10-20T11:00:00Z';

/** `rejected`: items the detect rules rejected earlier (the store only returns those it decided, never yours). */
function fakes(items: PendingSessionItem[], after: Record<string, CallsAfter>, cursor: string | null = null, rejected: PendingSessionItem[] = []) {
  const skipped: { id: string; rule: string; note: string; by: string }[] = [];
  const reopened: { id: string; rule: string; by: string }[] = [];
  const activity: ActivityInput[] = [];
  const cursors = new Map<string, string>(cursor ? [[INSTRUCTION_RULES_CURSOR, cursor]] : []);
  return {
    skipped, reopened, activity, cursors,
    deps: {
      graph: {
        pendingSessionItems: async (q: { limit: number; afterId?: string | null }) => items.filter((i) => !q.afterId || i.id > q.afterId).slice(0, q.limit),
        skipPendingItem: async (id: string, s: { rule: string; note: string; by: string }) => { skipped.push({ id, ...s }); return true; },
        ruleSkippedItems: async (q: { rule: string; by: string; limit: number; afterId?: string | null }) =>
          q.rule === 'instruction' && q.by === 'detect-rules' ? rejected.filter((i) => !q.afterId || i.id > q.afterId).slice(0, q.limit) : [],
        reopenRuleSkippedItem: async (id: string, s: { rule: string; by: string }) => { reopened.push({ id, ...s }); return true; },
        callsAfter: async (uuid: string) => after[uuid] ?? { calls: [], laterTurns: 1, endedAt: ended },
      },
      cursors: { getCursor: async (k: string) => cursors.get(k) ?? null, setCursor: async (k: string, v: string) => { cursors.set(k, v); } },
      activity: { record: async (a: ActivityInput) => { activity.push(a); } },
      now: () => Date.parse('2026-10-25T12:00:00Z'),
    },
  };
}

const ORDER = 'this should be on its own branch based on main, do not merge back to main, dont push a PR yet';
/** Pushback that mentions git: the first instruction rule (v1) read these as instructions and rejected them. */
const COMPLAINTS = [
  'The PR description is inaccurate, please fix it',
  "Don't use that API, it's deprecated. Commit when done.",
  "That's not right, the commit message should say what changed, please amend it",
  "nope, this is not the approach I want. let's keep the old schema and open a PR",
  'Can you not commit the .env file? That has secrets in it',
  "the tests don't cover the edge case, add one before you commit",
];

test('pending items the instruction rule calls neutral are resolved as not pushback, once per rules version, with a reason', async () => {
  const f = fakes([
    item('a', ORDER),
    item('b', "don't push yet", []),
    item('c', 'you pushed to main, I said not to'),
    item('d', 'this is still broken'),
  ], { 'u-b': { calls: [bash('git push origin fix/x')], laterTurns: 1, endedAt: ended } });
  expect(await resolvePendingInstructions(f.deps)).toEqual({ resolved: 1, reopened: 0 });
  // a: nothing forbidden happened. b: the push after it is evidence, so it stays for the owner. c, d: not instructions.
  expect(f.skipped).toEqual([{ id: 'a', rule: 'instruction', by: 'detect-rules', note: expect.stringMatching(new RegExp(`^not pushback: an instruction about git.*detect rules v${DETECT_RULES_VERSION}`)) }]);
  expect(f.activity).toEqual([expect.objectContaining({ kind: 'comments_skipped', actor: 'detect-rules', projectKey: 'demo', targets: ['a'], details: expect.objectContaining({ rules: { instruction: 1 } }) })]);
  expect(f.cursors.get(INSTRUCTION_RULES_CURSOR)).toBe(`v${DETECT_RULES_VERSION}`);
  // Same version: not run again.
  expect(await resolvePendingInstructions(f.deps)).toBeNull();
});

test('pushback that only mentions git stays pending under the new rules', async () => {
  const f = fakes(COMPLAINTS.map((t, i) => item(`p${i}`, t)), {}, 'v1');
  expect(await resolvePendingInstructions(f.deps)).toEqual({ resolved: 0, reopened: 0 });
  expect(f.skipped).toEqual([]);
});

test('items the old rule rejected that the new one would not are back in the Inbox; true instructions stay resolved', async () => {
  const wrongly = COMPLAINTS.map((t, i) => item(`r${i}`, t));
  const f = fakes([], {}, 'v1', [...wrongly, item('r9', ORDER)]);
  expect(await resolvePendingInstructions(f.deps)).toEqual({ resolved: 0, reopened: COMPLAINTS.length });
  expect(f.reopened).toEqual(wrongly.map((i) => ({ id: i.id, rule: 'instruction', by: 'detect-rules' })));
  expect(f.activity).toEqual([expect.objectContaining({
    kind: 'items_reopened', actor: 'detect-rules', projectKey: 'demo', targets: wrongly.map((i) => i.id),
    details: expect.objectContaining({ rule: 'instruction', reopened: COMPLAINTS.length, rulesVersion: DETECT_RULES_VERSION }),
  })]);
  expect(f.cursors.get(INSTRUCTION_RULES_CURSOR)).toBe(`v${DETECT_RULES_VERSION}`);
});

test('run before the transcripts recorded the calls after each instruction (0.6.1): once they have, what the agent broke comes back', async () => {
  // 0.6.1 ran this at start, before ingest v4 had recorded the push that ended the session, and resolved the item.
  const order = item('o1', ORDER);
  const f = fakes([item('p1', ORDER)], { 'u-o1': { calls: [bash('git push origin HEAD')], laterTurns: 0, endedAt: ended } }, `v${DETECT_RULES_VERSION}`, [order]);
  const r = await resolvePendingInstructions({ ...f.deps, ingestVersion: 5 });
  expect(r).toEqual({ resolved: 1, reopened: 1 });
  expect(f.reopened).toEqual([{ id: 'o1', rule: 'instruction', by: 'detect-rules' }]);
  expect(f.activity.find((a) => a.kind === 'items_reopened')?.why).toBe(
    `the sessions' transcripts were read again (ingest v5), so the git calls after each instruction are known now; the earlier run had resolved it as an instruction`,
  );
  expect(f.cursors.get(INSTRUCTION_RULES_CURSOR)).toBe(`v${DETECT_RULES_VERSION} ingest v5`);
  expect(await resolvePendingInstructions({ ...f.deps, ingestVersion: 5 })).toBeNull();
});

test('an instruction in a session still active is left pending, whatever came after it', async () => {
  for (const laterTurns of [0, 2]) {
    const f = fakes([item('a', ORDER)], { 'u-a': { calls: [], laterTurns, endedAt: '2026-10-25T11:50:00Z' } });
    expect(await resolvePendingInstructions(f.deps)).toEqual({ resolved: 0, reopened: 0 });
    expect(f.skipped).toEqual([]);
    expect(f.activity).toEqual([]);
    // Not recorded: the next start looks again.
    expect(f.cursors.get(INSTRUCTION_RULES_CURSOR)).toBeUndefined();
  }
});
