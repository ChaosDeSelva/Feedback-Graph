import type { ScanJob } from '@fb/core';
import { describe, expect, test, vi } from 'vitest';
import { parkScanProvider, ScanRunner, type ScanRunnerDeps } from './runner.ts';

const job = (id: string, provider: string | null = null): ScanJob => ({
  id, projectKey: id, repoPath: `/vibe/${id}`, provider, status: 'queued', requestedAt: 't', startedAt: null, finishedAt: null,
  filesScanned: 0, factsAdded: 0, error: null, attempts: 0, retryAt: null,
});

/** A queue of jobs; each run waits until the test releases it. */
function fakes(jobs: ScanJob[], over: Partial<ScanRunnerDeps> = {}) {
  const queue = [...jobs];
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const deps: ScanRunnerDeps = {
    next: async (exclude) => queue.find((j) => !exclude.includes(j.id)) ?? null,
    agentic: (j) => j.provider === 'codex-cli',
    empty: async () => false,
    run: (j) => new Promise<boolean>((res) => {
      started.push(j.id);
      release.set(j.id, () => {
        queue.splice(queue.findIndex((q) => q.id === j.id), 1);
        res(true);
      });
    }),
    concurrency: 2,
    ...over,
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const drop = (id: string) => queue.splice(queue.findIndex((q) => q.id === id), 1);
  return { deps, started, drop, release: async (id: string) => { release.get(id)!(); await settle(); await settle(); }, settle };
}

test('runs up to SCAN_CONCURRENCY scans at once, and starts the next as one finishes', async () => {
  const f = fakes([job('a'), job('b'), job('c')]);
  const r = new ScanRunner(f.deps);
  r.kick();
  await f.settle();
  await f.settle();
  expect(f.started).toEqual(['a', 'b']);
  expect(r.running()).toEqual(['a', 'b']);
  await f.release('a');
  expect(f.started).toEqual(['a', 'b', 'c']);
  await f.release('b');
  await f.release('c');
  await r.idle();
  expect(r.running()).toEqual([]);
});

test('agentic scans run one at a time; a per-file scan queued behind one is not held up', async () => {
  const f = fakes([job('x', 'codex-cli'), job('y', 'codex-cli'), job('z')]);
  const r = new ScanRunner(f.deps);
  r.kick();
  await f.settle();
  await f.settle();
  expect(f.started).toEqual(['x', 'z']);
  await f.release('x');
  expect(f.started).toEqual(['x', 'z', 'y']);
});

test('a project with no code files is finished at once without taking a slot', async () => {
  const runs: string[] = [];
  const f = fakes([job('a'), job('empty'), job('b')], { empty: async (j) => j.id === 'empty', concurrency: 1 });
  const run = f.deps.run;
  f.deps.run = (j, turn) => {
    runs.push(j.id);
    if (j.id !== 'empty') return run(j, turn);
    f.drop('empty');
    return Promise.resolve(true);
  };
  const r = new ScanRunner(f.deps);
  r.kick();
  await f.settle();
  await f.settle();
  expect(runs).toEqual(['a', 'empty']);
  expect(r.running()).toEqual(['a']);
});

test('a run that made no progress (the job waits out a retry) does not restart the queue by itself', async () => {
  let calls = 0;
  const f = fakes([job('a')], { concurrency: 1 });
  f.deps.run = async () => { calls++; return false; };
  const r = new ScanRunner(f.deps);
  r.kick();
  await r.idle();
  expect(calls).toBe(1);
});

test('stop() waits for running scans and starts nothing new', async () => {
  const f = fakes([job('a'), job('b')], { concurrency: 1 });
  const r = new ScanRunner(f.deps);
  r.kick();
  await f.settle();
  const stopped = r.stop();
  await f.release('a');
  await stopped;
  r.kick();
  await f.settle();
  expect(f.started).toEqual(['a']);
});

test('a run that throws is logged and frees its slot', async () => {
  const logs: string[] = [];
  const f = fakes([job('a')], { concurrency: 1, log: (m) => logs.push(m) });
  f.deps.run = async () => { throw new Error('boom'); };
  const r = new ScanRunner(f.deps);
  r.kick();
  await r.idle();
  expect(logs).toContain('scan runner: a scan threw');
  expect(r.running()).toEqual([]);
});

/**
 * The store's fair queue (FactsStore.nextScanJob, contract-tested in facts.int.test.ts): queued jobs by how long they
 * have waited, a job that gave way waiting from then; a job never served yet from its project's oldest unread file
 * request when that is older. Each run is a sharded scan that asks after every shard whether another scan waits for
 * its slot, and gives way when one does. `askedFirst`: the 0.6.2 rule, under which an old file request kept a job that
 * gave way at the front (the runner must not hand it the slot back anyway).
 */
function shardedQueue(specs: { id: string; shards: number; provider?: string | null; asked?: number }[], o: { askedFirst?: boolean } = {}) {
  let clock = 0;
  const jobs = specs.map((s) => ({ job: job(s.id, s.provider === undefined ? 'codex-cli' : s.provider), shards: s.shards, done: 0, since: clock++, served: false, asked: s.asked, status: 'queued' as 'queued' | 'done' }));
  const ran: string[] = [];
  const finished: string[] = [];
  const add = (id: string, shards: number, provider: string | null = 'codex-cli') => jobs.push({ job: job(id, provider), shards, done: 0, since: clock++, served: false, asked: undefined, status: 'queued' });
  const waitingSince = (j: (typeof jobs)[number]) =>
    j.asked === undefined || (j.served && !o.askedFirst) ? j.since : Math.min(j.since, j.asked);
  const deps: ScanRunnerDeps = {
    next: async (exclude) => jobs.filter((j) => j.status === 'queued' && !exclude.includes(j.job.id)).sort((a, b) => waitingSince(a) - waitingSince(b) || a.since - b.since)[0]?.job ?? null,
    agentic: (j) => j.provider === 'codex-cli',
    empty: async () => false,
    run: async (j, turn) => {
      const rec = jobs.find((x) => x.job.id === j.id)!;
      while (rec.done < rec.shards) {
        await new Promise((r) => setTimeout(r, 0));
        rec.done++;
        ran.push(`${j.id}:${rec.done}`);
        if (rec.done < rec.shards && (await turn.waiting())) {
          rec.since = clock++;
          rec.served = true;
          return true;
        }
      }
      rec.status = 'done';
      finished.push(j.id);
      return true;
    },
    concurrency: 2,
  };
  return { deps, ran, finished, add, jobs };
}

test('a 40-shard scan queued first takes turns with three small scans queued after it: they finish before its shard 5', async () => {
  const q = shardedQueue([{ id: 'big', shards: 40 }, { id: 'a', shards: 1 }, { id: 'b', shards: 1 }, { id: 'c', shards: 1 }]);
  const r = new ScanRunner(q.deps);
  r.kick();
  await r.idle();
  expect(q.finished).toEqual(['a', 'b', 'c', 'big']);
  const at = (step: string) => q.ran.indexOf(step);
  for (const small of ['a:1', 'b:1', 'c:1']) expect(at(small)).toBeLessThan(at('big:5'));
  expect(q.ran.slice(0, 5)).toEqual(['big:1', 'a:1', 'b:1', 'c:1', 'big:2']);
  // Every shard of the big scan ran once, in order: resumable, and its progress whole.
  expect(q.ran.filter((s) => s.startsWith('big:'))).toEqual(Array.from({ length: 40 }, (_, i) => `big:${i + 1}`));
});

test('a scan queued while a big one runs gets the next turn, not the end of the big one', async () => {
  const q = shardedQueue([{ id: 'big', shards: 10 }]);
  const r = new ScanRunner(q.deps);
  r.kick();
  await new Promise((res) => setTimeout(res, 0));
  await new Promise((res) => setTimeout(res, 0));
  q.add('late', 1);
  await r.idle();
  expect(q.ran.indexOf('late:1')).toBeLessThan(q.ran.indexOf('big:4'));
  expect(q.finished).toEqual(['late', 'big']);
});

test('a big agentic scan does not give way to a per-file scan a free slot can run: that one starts beside it', async () => {
  const q = shardedQueue([{ id: 'big', shards: 3 }]);
  let waitedTrue = 0;
  const run = q.deps.run;
  q.deps.run = (j, turn) => run(j, { waiting: async () => { const w = await turn.waiting(); if (w) waitedTrue++; return w; } });
  const r = new ScanRunner(q.deps);
  r.kick();
  await new Promise((res) => setTimeout(res, 0));
  q.add('files', 1, null);
  await r.idle();
  expect(waitedTrue).toBe(0);
  expect(q.finished).toEqual(['files', 'big']);
  expect(q.ran.filter((s) => s.startsWith('big:'))).toEqual(['big:1', 'big:2', 'big:3']);
});

test('stopping asks a sharded scan to give way after its shard, so shutdown does not wait for its last one', async () => {
  const q = shardedQueue([{ id: 'big', shards: 40 }]);
  const r = new ScanRunner(q.deps);
  r.kick();
  await new Promise((res) => setTimeout(res, 0));
  await r.stop();
  expect(q.ran.length).toBeLessThan(5);
  expect(q.jobs[0]).toMatchObject({ status: 'queued' });
});

describe.each([
  ['the store serves a job that gave way after those waiting', false],
  ['the store would serve the job that gave way first (an old file request): the runner still does not', true],
])('a 40-shard codex scan with an old unread file request in a later shard, and an agentic scan queued behind it: %s', (_, askedFirst) => {
  test('the queued scan runs right after the first shard; the big one goes on after it; every shard runs once', async () => {
    // The big scan's project had a file asked for (get_task_context) before either scan was queued.
    const q = shardedQueue([{ id: 'big', shards: 40, asked: -1 }], { askedFirst });
    let gaveWay = 0;
    const run = q.deps.run;
    q.deps.run = (j, turn) => run(j, { waiting: async () => { const w = await turn.waiting(); if (w && j.id === 'big') gaveWay++; return w; } });
    const r = new ScanRunner(q.deps);
    r.kick();
    await new Promise((res) => setTimeout(res, 0));
    q.add('b', 1);
    await r.idle();
    expect(q.ran.indexOf('b:1')).toBe(q.ran.indexOf('big:1') + 1);
    expect(q.finished).toEqual(['b', 'big']);
    expect(q.ran.filter((s) => s.startsWith('big:'))).toEqual(Array.from({ length: 40 }, (_, i) => `big:${i + 1}`));
    // It gave way once, to b; after that no one waited, so it was not sent back through the queue (a re-list each time).
    expect(gaveWay).toBe(1);
  });
});


test('an unavailable provider is parked with exponential readiness backoff while unrelated scans proceed', async () => {
  let now = 0, probes = 0, healthy = false;
  const f = fakes([job('blocked', 'codex-cli'), job('other', 'ollama:local')], {
    now: () => now,
    ready: async j => { if (j.provider === 'codex-cli') { probes++; if (!healthy) throw new Error('sandbox unavailable'); } },
  });
  const runner = new ScanRunner(f.deps);
  runner.kick(); await f.settle(); await f.settle();
  expect(f.started).toEqual(['other']); expect(probes).toBe(1);
  await f.release('other');
  now = 119_999; runner.kick(); await runner.idle(); expect(probes).toBe(1);
  now = 120_000; runner.kick(); await runner.idle(); expect(probes).toBe(2);
  now = 359_999; runner.kick(); await runner.idle(); expect(probes).toBe(2);
  healthy = true; now = 360_000; runner.kick(); await f.settle(); await f.settle();
  expect(probes).toBe(3); expect(f.started).toEqual(['other', 'blocked']);
  await f.release('blocked'); await runner.idle();
});


test('readiness has its own timer while the main worker cycle is busy, and stops cleanly', async () => {
  vi.useFakeTimers();
  let probes = 0;
  const runner = new ScanRunner({
    next: async () => job('blocked'), empty: async () => false, agentic: () => true,
    run: async () => { throw Error('must not run'); }, concurrency: 1,
    ready: async () => { probes++; throw Error('unavailable'); },
  });
  try {
    runner.startPolling();
    await vi.advanceTimersByTimeAsync(1);
    expect(probes).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(probes).toBe(2);
    await runner.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(probes).toBe(2);
  } finally { vi.useRealTimers(); }
});

test('default and explicit provider aliases share one probe and one persisted provider-wide park', async () => {
  const parks: unknown[] = [];
  let probes = 0;
  const f = fakes([job('implicit'), job('explicit', 'codex-cli'), job('blank', '  ')], {
    providerKey: j => j.provider?.trim() || 'codex-cli',
    now: () => 0,
    ready: async () => { probes++; throw Error('cannot mount proc'); },
    parkProvider: async (...args) => { parks.push(args); },
  });
  const runner = new ScanRunner(f.deps);
  runner.kick(); await runner.idle();
  expect(probes).toBe(1);
  expect(parks).toEqual([['codex-cli', 'Error: cannot mount proc', '1970-01-01T00:02:00.000Z']]);
  expect(f.started).toEqual([]);
});


test('provider outage refreshes all queued peers, preserving attempts and excluding active/other jobs', async () => {
  const queue = [job('blank', ''), job('explicit', 'codex-cli'), job('other', 'ollama:local'), { ...job('active', 'codex-cli'), status: 'running' as const }];
  queue[0].error = 'stale error'; queue[0].retryAt = '2000-01-01T00:00:00Z'; queue[0].attempts = 3;
  queue[1].retryAt = '2999-01-01T00:00:00Z';
  const updates: unknown[] = [];
  await parkScanProvider({
    scanQueue: async () => queue.map(j => ({ ...j, waitingSince: j.requestedAt })),
    updateScanJob: async (id, patch) => { updates.push({ id, patch }); },
  }, 'codex-cli', 'codex-cli', 'new sandbox error', '2030-01-01T00:02:00Z');
  expect(updates).toEqual(['blank', 'explicit'].map(id => ({ id, patch: {
    error: 'scan parked: new sandbox error; checking readiness with backoff before copying the repository', retryAt: '2030-01-01T00:02:00Z',
  } })));
  expect(queue[0].attempts).toBe(3);
});
