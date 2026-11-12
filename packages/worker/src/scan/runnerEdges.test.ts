import type { ScanJob } from '@fb/core';
import { expect, test, vi } from 'vitest';
import { ScanRunner, type ScanRunnerDeps } from './runner.ts';

const job = (id: string, provider: string | null = null): ScanJob => ({
  id, projectKey: id, repoPath: `/vibe/${id}`, provider, status: 'queued', requestedAt: 't', startedAt: null, finishedAt: null,
  filesScanned: 0, factsAdded: 0, error: null, attempts: 0, retryAt: null,
});

test('polling starts once: a second start, or one after stop(), adds no timer', async () => {
  vi.useFakeTimers();
  let reads = 0;
  const runner = new ScanRunner({ next: async () => { reads++; return null; }, empty: async () => false, agentic: () => false, run: async () => true, concurrency: 1 });
  try {
    runner.startPolling(1000);
    runner.startPolling(1000);
    await vi.advanceTimersByTimeAsync(3500);
    expect(reads).toBe(4); // the first kick, then one a second
    await runner.stop();
    runner.startPolling(1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toBe(4);
  } finally { vi.useRealTimers(); }
});

test('an agentic scan that gave way to a per-file scan (every slot taken) gets its slot back when that one is done', async () => {
  const shards = new Map([['big', 3], ['files', 1]]);
  const done = new Map<string, number>();
  const queue = [job('big', 'codex-cli')];
  const ran: string[] = [];
  let gaveWay = 0;
  const deps: ScanRunnerDeps = {
    next: async (exclude) => queue.find((j) => !exclude.includes(j.id)) ?? null,
    agentic: (j) => j.provider === 'codex-cli',
    empty: async () => false,
    run: async (j, turn) => {
      for (;;) {
        await new Promise((r) => setTimeout(r, 0));
        const n = (done.get(j.id) ?? 0) + 1;
        done.set(j.id, n);
        ran.push(`${j.id}:${n}`);
        if (n === shards.get(j.id)) break;
        if (j.id === 'big' && n === 1) queue.push(job('files'));
        if (await turn.waiting()) { gaveWay++; return true; }
      }
      queue.splice(queue.findIndex((q) => q.id === j.id), 1);
      return true;
    },
    concurrency: 1,
  };
  const r = new ScanRunner(deps);
  r.kick();
  await r.idle();
  expect(gaveWay).toBe(1);
  expect(ran).toEqual(['big:1', 'files:1', 'big:2', 'big:3']);
});

test('a provider failing its readiness check with a non-Error is parked with that as the reason', async () => {
  const parks: unknown[][] = [];
  const logged: [string, object | undefined][] = [];
  const r = new ScanRunner({
    next: async (exclude) => [job('a', 'codex-cli')].find((j) => !exclude.includes(j.id)) ?? null,
    empty: async () => false, agentic: () => true, run: async () => true, concurrency: 1, now: () => 0,
    ready: async () => { throw 'sandbox: permission denied'; },
    parkProvider: async (...a) => { parks.push(a); },
    log: (m, e) => logged.push([m, e]),
  });
  r.kick();
  await r.idle();
  expect(parks).toEqual([['codex-cli', 'sandbox: permission denied', '1970-01-01T00:02:00.000Z']]);
  expect(logged).toEqual([['scan provider parked; readiness will be checked without copying repositories', { provider: 'codex-cli', retryAt: '1970-01-01T00:02:00.000Z', error: 'sandbox: permission denied' }]]);
});

test('a fill reads only the head of a long queue when its jobs cannot start: parked providers, or no free slot', async () => {
  const many = Array.from({ length: 200 }, (_, i) => job(`j${i}`, `p${i}`));
  const reads = { parked: 0, full: 0 };
  const parked = new ScanRunner({
    next: async (exclude) => { reads.parked++; return many.find((j) => !exclude.includes(j.id)) ?? null; },
    empty: async () => false, agentic: () => false, run: async () => true, concurrency: 1, now: () => 0,
    ready: async () => { throw new Error('down'); },
  });
  parked.kick();
  await parked.idle();
  expect(reads.parked).toBeLessThan(50);

  let release!: () => void;
  const full = new ScanRunner({
    next: async (exclude) => { reads.full++; return many.find((j) => !exclude.includes(j.id)) ?? null; },
    empty: async () => false, agentic: () => false, concurrency: 1,
    run: () => new Promise<boolean>((res) => { release = () => res(false); }),
  });
  full.kick();
  await new Promise((r) => setTimeout(r, 10));
  expect(full.running()).toEqual(['j0']);
  expect(reads.full).toBeLessThan(50);
  release();
  await full.idle();
});
