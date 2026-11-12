import { expect, test } from 'vitest';
import type { Activity, ActivitySinceQuery } from '@fb/core';
import type { LoopCandidate, LoopType } from '../plugin.ts';
import { readLog, readOnlyExecutor, runReplay, type ReplayStore } from './index.ts';
import { NO_SPLIT } from './score.ts';

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const day = (d: number) => new Date(T0 + d * 86_400_000).toISOString();
let n = 0;
const entry = (o: Partial<Activity>): Activity => ({
  id: `act:${++n}`, ts: day(1), kind: 'lesson_decided', actor: 'you', projectKey: 'p', subject: 'approved lesson "x"', why: '', details: { status: 'approved' }, targets: ['lesson:a'], ...o,
});

/** A store with this Activity log (in order) and lessons and Inbox items made at these times. */
function fakeStore(log: Activity[], created: Record<string, string>) {
  const since = async (q: ActivitySinceQuery) => {
    const from = q.after ? Number(q.after) : 0;
    const rows = log.map((e, i) => ({ e, i: i + 1 })).filter(({ e, i }) => i > from && (!q.kinds || q.kinds.includes(e.kind)) && (!q.until || e.ts < q.until)).slice(0, q.limit);
    return { entries: rows.map((r) => r.e), next: rows.length ? String(rows.at(-1)!.i) : q.after ?? null };
  };
  const at = (id: string) => created[id];
  return {
    activity: { since, list: async () => [], record: async () => {} },
    knowledge: {
      lessonDetail: async (id: string) => (at(id) ? { lesson: { id, createdAt: at(id), status: 'proposed', paths: [] } } : null),
      relatedMisses: async () => [],
    },
    graph: { candidateDetail: async (id: string) => (at(id) ? { candidate: { id, createdAt: at(id) } } : null) },
    facts: {}, codegraph: {}, insights: {},
    decisions: { list: async () => [], loopMisses: async () => [], missLinks: async () => [] },
  } as unknown as ReplayStore;
}

/** A type that calls approve on these lessons, every round. */
const approves = (...ids: string[]): LoopType => ({
  type: 'approve_lesson', weights: { bias: 0 },
  candidates: async () => ({
    scanned: ids.length, skipped: {},
    candidates: ids.map((id): LoopCandidate => ({
      projectKey: 'p', targets: [{ kind: 'lesson', id, role: 'primary' }], before: [], after: [], evidence: [{ kind: 'lesson', id, role: 'r', weight: 1, observedAt: 't' }],
      features: {}, subject: id, rationale: 'r',
    })),
  }),
});

test('readLog reads the whole log, page after page', async () => {
  const log = Array.from({ length: 2500 }, () => entry({ ts: day(-1) }));
  const read = await readLog(fakeStore(log, {}).activity);
  expect(read).toHaveLength(2500);
  expect(read.at(-1)).toBe(log.at(-1));
});

test('runReplay: each cut in time order, the owner\'s actions within the horizon on records that existed then', async () => {
  const log = [
    entry({ ts: day(-2), kind: 'postmortem_done', actor: 'postmortem', targets: ['f', 'miss:f'], details: {} }),
    entry({ targets: ['lesson:a'] }),
    entry({ ts: day(2), details: { status: 'rejected' }, subject: 'rejected lesson "b"', targets: ['lesson:b'] }),
    entry({ ts: day(3), targets: ['lesson:late'] }),
    entry({ ts: day(4), targets: ['lesson:gone'] }),
    entry({ ts: day(5), kind: 'feedback_decided', details: { status: 'confirmed' }, targets: ['inbox:1'] }),
    entry({ ts: day(6), kind: 'decision_made', details: { decisionType: 'approve_lesson', action: 'reject' }, targets: ['dec:1', 'lesson:c'] }),
    entry({ ts: day(39), targets: ['lesson:c'] }),
    entry({ ts: day(41), targets: ['lesson:a'] }),
  ];
  const store = fakeStore(log, { 'lesson:a': day(-5), 'lesson:b': day(-5), 'lesson:c': day(-5), 'lesson:late': day(2), 'inbox:1': day(-1) });
  const said: string[] = [];
  const { cuts, report } = await runReplay(
    { store, types: [approves('lesson:a', 'lesson:b', 'lesson:c')], log: (m) => said.push(m) },
    { cuts: [T0 + 86_400_000 * 10, T0], horizonMs: 30 * 86_400_000, split: NO_SPLIT },
  );
  expect(cuts.map((c) => c.t0)).toEqual([day(0), day(10)]);
  expect(said).toEqual([`replaying the loop at ${day(0)}`, `replaying the loop at ${day(10)}`]);
  const [first, second] = cuts;
  expect(first.decisions.map((d) => [d.decision.targets[0].id, d.verdict])).toEqual([['lesson:a', 'agree'], ['lesson:b', 'contradict'], ['lesson:c', 'contradict']]);
  expect(first.actions.map((a) => [a.action.kind, a.action.target])).toEqual([['approved', 'lesson:a'], ['rejected', 'lesson:b'], ['inbox_confirmed', 'inbox:1']]);
  // Ten days on, the 30-day horizon takes in the approval of lesson:c on day 39, not lesson:a's on day 41.
  expect(second.actions.map((a) => a.action.target)).toEqual(['lesson:c']);
  expect(second.decisions.find((d) => d.decision.targets[0].id === 'lesson:c')?.verdict).toBe('agree');
  expect(report.tuning.find((s) => s.type === 'approve_lesson')).toMatchObject({ decisions: 6 });

  // No horizon: every later action counts. No log given: a type's log lines go nowhere.
  const chatty: LoopType = { ...approves('lesson:a'), candidates: async (ctx) => { ctx.log('looked'); return approves('lesson:a').candidates(ctx); } };
  const open = await runReplay({ store, types: [chatty] }, { cuts: [T0], horizonMs: null, split: NO_SPLIT });
  expect(open.cuts[0].actions.map((a) => a.action.target)).toEqual(['lesson:a', 'lesson:b', 'inbox:1', 'lesson:c', 'lesson:a']);
});

test('a cut whose rounds never end is an error, not a hang', async () => {
  const log = Array.from({ length: 3 }, () => entry({ ts: day(-1), kind: 'context_served', actor: 'agent', details: { lessons: [] }, targets: [] }));
  const d = { store: fakeStore(log, {}), types: [], pageSize: 1, maxRounds: 2 };
  await expect(runReplay(d, { cuts: [T0], horizonMs: null, split: NO_SPLIT })).rejects.toThrow(`the replay at ${day(0)} did not finish in 2 rounds`);
  expect((await runReplay({ ...d, maxRounds: 5 }, { cuts: [T0], horizonMs: null, split: NO_SPLIT })).cuts[0].decisions).toEqual([]);
});

test('the replay never applies', async () => {
  await expect(readOnlyExecutor.apply({} as never, { by: 'loop:1', syncHoldUntil: null })).rejects.toThrow(/never writes/);
});
