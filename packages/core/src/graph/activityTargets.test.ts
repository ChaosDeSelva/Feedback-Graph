import { expect, test } from 'vitest';
import { ActivityTargetIndex } from './activity.ts';
import type { GraphRepo } from './repo.ts';

type Row = { get: (k: string) => unknown };
const row = (o: Record<string, unknown>): Row => ({ get: (k) => o[k] });

/**
 * A store holding `entries` older entries, whose upgrade pages fail as Neo4j fails one over db.memory.transaction.max
 * when they hold more than `fits` entries, or with `fail` while it is set.
 */
function fakeGraph(entries: number, fits: number) {
  const ids = Array.from({ length: entries }, (_, i) => `act:${String(i).padStart(6, '0')}`);
  const task: { done: boolean; owner: string | null; cursor: string | null } = { done: false, owner: null, cursor: null };
  const pages: number[] = [];
  const state = { fail: null as Error | null, pages, task };
  const g = {
    async run(cypher: string, p: Record<string, any>): Promise<Row[]> {
      if (cypher.includes('RETURN coalesce(t.done, false) AS done')) return [row({ done: task.done })];
      if (cypher.startsWith('MERGE (t:SchemaTask')) {
        if (task.done || (task.owner && task.owner !== p.me)) return [];
        task.owner = p.me;
        return [row({ cursor: task.cursor })];
      }
      if (cypher.includes('SET t.owner = null')) {
        task.owner = null;
        task.done ||= p.done;
        return [];
      }
      if (cypher.includes('MATCH (x:Activity) WHERE x.id > $after')) {
        if (state.fail) throw state.fail;
        const page = typeof p.page === 'number' ? p.page : p.page.toNumber();
        pages.push(page);
        if (page > fits) throw Object.assign(new Error('The allocation of an extra 2.0 MiB would use more than the limit 32.0 MiB'), { code: 'Neo.TransientError.General.MemoryPoolOutOfMemoryError' });
        const got = ids.filter((id) => id > p.after).slice(0, page);
        if (got.length) task.cursor = got.at(-1)!;
        return [row({ n: got.length, last: got.at(-1) ?? null })];
      }
      throw new Error(`unexpected: ${cypher}`);
    },
  };
  return { g: g as unknown as GraphRepo, state };
}

test('a page over the transaction memory limit is retried at half the size, and the upgrade completes', async () => {
  const { g, state } = fakeGraph(5000, 100);
  const index = new ActivityTargetIndex(g);
  expect(await index.run()).toBe(5000);
  expect(state.task.done).toBe(true);
  // 500 → 250 → 125 → 62, which fits; never a page over the limit after that.
  expect(state.pages.slice(0, 4)).toEqual([500, 250, 125, 62]);
  expect(Math.max(...state.pages.slice(4))).toBeLessThanOrEqual(100);
});

test('a failed upgrade never fails the start: it is logged, reads stay on the targets lists, and it is tried again', async () => {
  const { g, state } = fakeGraph(300, 1000);
  state.fail = Object.assign(new Error('Neo.TransientError.General.OutOfMemoryError'), { code: 'Neo.TransientError.General.OutOfMemoryError' });
  const logged: unknown[][] = [];
  const index = new ActivityTargetIndex(g, { retryMs: 20 });
  await index.start((...a) => logged.push(a));
  await index.settled();
  expect(index.ready).toBe(false);
  expect(logged[0]?.[0]).toBe('activity target upgrade failed; it is tried again later');
  state.fail = null;
  await new Promise((r) => setTimeout(r, 60));
  expect(await index.settled()).toBe(true);
  expect(state.task.done).toBe(true);
  await index.stop();
});

test('a restart resumes from the cursor the last page left', async () => {
  const { g, state } = fakeGraph(1200, 1000);
  state.task.cursor = 'act:000999';
  const index = new ActivityTargetIndex(g);
  expect(await index.run()).toBe(200);
});

test('a page Neo4j aborts as a deadlock (beside the api writing entries) is run again, not given up', async () => {
  const { g, state } = fakeGraph(700, 1000);
  let deadlocks = 2;
  const run = g.run.bind(g);
  (g as { run: GraphRepo['run'] }).run = async (cypher, p) => {
    if (cypher.includes('MATCH (x:Activity) WHERE x.id > $after') && deadlocks-- > 0) throw Object.assign(new Error('deadlock'), { code: 'Neo.TransientError.Transaction.DeadlockDetected' });
    return run(cypher, p);
  };
  expect(await new ActivityTargetIndex(g).run()).toBe(700);
  expect(state.task.done).toBe(true);
});
