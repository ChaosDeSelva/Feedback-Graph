import type { ScanJob } from '@fb/core';
import { expect, test } from 'vitest';
import { ScanRunner, type ScanRunnerDeps } from './runner.ts';

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
  f.deps.run = (j) => {
    runs.push(j.id);
    if (j.id !== 'empty') return run(j);
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
