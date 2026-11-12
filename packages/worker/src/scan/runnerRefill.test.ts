import type { ScanJob } from '@fb/core';
import { expect, test } from 'vitest';
import { ScanRunner } from './runner.ts';

const job = (id: string): ScanJob => ({
  id, projectKey: id, repoPath: `/vibe/${id}`, provider: null, status: 'queued', requestedAt: 't', startedAt: null, finishedAt: null,
  filesScanned: 0, factsAdded: 0, error: null, attempts: 0, retryAt: null,
});
const settle = () => new Promise((r) => setTimeout(r, 0));

test('a scan queued while the queue is being read is picked up by a second read, not left for the next cycle', async () => {
  const queue: ScanJob[] = [];
  const started: string[] = [];
  let readOpen: () => void = () => {};
  let reads = 0;
  const r = new ScanRunner({
    next: async (exclude) => {
      reads++;
      const found = queue.find((j) => !exclude.includes(j.id)) ?? null;
      // The first read is slow: the request arrives after it looked and before it returns.
      if (reads === 1) await new Promise<void>((res) => { readOpen = res; });
      return found;
    },
    agentic: () => false,
    empty: async () => false,
    run: async (j) => { started.push(j.id); queue.splice(queue.indexOf(j), 1); return true; },
    concurrency: 2,
  });
  r.kick();
  await settle();
  queue.push(job('late'));
  r.kick(); // reading: remembered, not a second reader
  readOpen();
  await r.idle();
  await settle();
  await r.idle();
  expect(started).toEqual(['late']);
});
