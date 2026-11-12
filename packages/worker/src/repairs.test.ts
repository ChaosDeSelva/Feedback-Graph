import type { ActivityInput, ExternalRef, InboxText } from '@fb/core';
import { expect, test } from 'vitest';
import { DUPLICATE_DECIDER, duplicateItems, rejectDuplicateItems, retitleThreadTasks, THREAD_TASKS_CURSOR, type RepairDeps } from './repairs.ts';

function deps(over: Partial<RepairDeps['knowledge']> = {}, items: InboxText[] = []) {
  const cursors = new Map<string, string>();
  const activity: ActivityInput[] = [];
  const titles = new Map<string, string>();
  const skipped: { id: string; note: string; by: string }[] = [];
  const d: RepairDeps = {
    knowledge: { threadTasks: async () => [], setTaskTitle: async (id, t) => { titles.set(id, t); return true; }, ...over },
    graph: {
      inboxTexts: async ({ limit, afterId }) => items.filter((i) => !afterId || i.id > afterId).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit),
      skipPendingItem: async (id, s) => { skipped.push({ id, note: s.note, by: s.by }); return true; },
    },
    activity: { record: async (a) => { activity.push(a); return a as never; } },
    cursors: { getCursor: async (k) => cursors.get(k) ?? null, setCursor: async (k, v) => { cursors.set(k, v); } },
  };
  return { d, cursors, activity, titles, skipped };
}

const ext = (thread: string, title: string, source: 'github' | 'linear' = 'github') => ({ source, thread, title }) as ExternalRef;

test('every PR and issue task takes its title from its own thread, once; a task already so is left alone', async () => {
  // Ten unrelated PRs synced in one burst had all been given one work session's task title.
  const shared = 'Refactor the settings page';
  const tasks = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `task:github:acme/shop#${i + 1}`, title: shared, external: ext(`acme/shop#${i + 1}`, `Change ${i + 1}`) })),
    { id: 'task:linear:ENG-4', title: 'ENG-4: Fix login', external: ext('ENG-4', 'Fix login', 'linear') },
  ];
  const f = deps({ threadTasks: async () => tasks });
  expect(await retitleThreadTasks(f.d)).toEqual({ examined: 11, retitled: 10 });
  expect(f.titles.get('task:github:acme/shop#3')).toBe('PR acme/shop#3: Change 3');
  expect(new Set(f.titles.values()).size).toBe(10);
  expect(f.activity).toHaveLength(1);
  expect(f.activity[0]).toMatchObject({ kind: 'misses_reclassified', actor: 'repair', subject: '10 PR and issue tasks retitled from their thread' });
  expect((f.activity[0].details!.changed as unknown[])[0]).toEqual({ id: 'task:github:acme/shop#1', from: shared, to: 'PR acme/shop#1: Change 1' });
  expect(f.cursors.get(THREAD_TASKS_CURSOR)).toBe('v1');
  expect(await retitleThreadTasks(f.d)).toBeNull();
});

const item = (id: string, o: Partial<InboxText> = {}): InboxText => ({
  id, sessionId: 's1', projectKey: 'demo-shop', source: 'codex', status: 'pending', createdAt: '2026-11-01T10:00:00Z', text: 'The filter must run on the server, not in the browser', ...o,
});

test('duplicates: a turn re-read under a new id, a Codex copy of a decided Claude Code turn, the same words twice pending', () => {
  const items = [
    // The same Codex turn, read with its ordinal and later without it, the first already decided.
    item('codex-1:2311', { status: 'rejected', createdAt: '2026-11-01T10:00:00Z' }),
    item('codex-1:L2312', { createdAt: '2026-11-02T10:00:00Z' }),
    // A Claude Code turn decided, and Codex's import of it pending.
    item('cc-u7', { sessionId: 'cc-1', source: 'claude', status: 'confirmed', text: 'Use the shared date helper instead of a new one here' }),
    item('codex-2:9', { sessionId: 'codex-2', text: 'Use the shared date helper instead of a new one here!' }),
    // The same words twice in one PR thread, both pending: the later goes.
    item('github:acme/shop#7/c1', { sessionId: 'github:acme/shop#7', source: 'github', text: 'Please add a test for the empty cart' }),
    item('github:acme/shop#7/c4', { sessionId: 'github:acme/shop#7', source: 'github', text: 'Please add a test for the empty cart', createdAt: '2026-11-03T10:00:00Z' }),
    // Not duplicates: the same words in another thread, a short turn, a repeat in another Claude Code session.
    item('github:acme/shop#8/c1', { sessionId: 'github:acme/shop#8', source: 'github', text: 'Please add a test for the empty cart' }),
    item('codex-3:4', { sessionId: 'codex-3', text: 'no' }),
    item('cc-u9', { sessionId: 'cc-2', source: 'claude', text: 'Use the shared date helper instead of a new one here' }),
  ];
  expect(duplicateItems(items)).toEqual([
    { id: 'codex-1:L2312', of: 'codex-1:2311', why: 'the same turn read again under a new id; that one is rejected' },
    { id: 'codex-2:9', of: 'cc-u7', why: 'a Codex copy of a Claude Code turn; that one is confirmed' },
    { id: 'github:acme/shop#7/c4', of: 'github:acme/shop#7/c1', why: 'the same words again in the same session or thread' },
  ]);
});

test('the duplicate repair rejects each one once, as the repair (never the owner), and says so in Activity', async () => {
  const items = [item('a:1', { status: 'confirmed' }), item('a:L2')];
  const f = deps({}, items);
  expect(await rejectDuplicateItems(f.d)).toEqual({ examined: 2, rejected: 1 });
  expect(f.skipped).toEqual([{ id: 'a:L2', note: 'duplicate of a:1: the same turn read again under a new id; that one is confirmed', by: DUPLICATE_DECIDER }]);
  expect(f.activity[0]).toMatchObject({ kind: 'comments_skipped', actor: 'repair', subject: '1 duplicate Inbox item rejected', targets: ['a:L2'] });
  expect(await rejectDuplicateItems(f.d)).toBeNull();
});

test('a pending item flagged on a compaction summary is rejected too', () => {
  const summary = 'This session is being continued from a previous conversation that ran out of context. Summary: ...';
  expect(duplicateItems([item('cc-x', { sessionId: 'cc-9', source: 'claude', text: summary }), item('cc-y', { sessionId: 'cc-9', source: 'claude', status: 'confirmed', text: summary })])).toEqual([
    { id: 'cc-x', of: 'cc-9', why: 'a compaction summary Claude Code wrote, stored as a human turn' },
  ]);
});
