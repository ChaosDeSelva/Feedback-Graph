import type { ClassifiableTurn, WorkerStatus } from '@fb/core';
import { expect, test } from 'vitest';
import { StageTracker, withClassifyBacklog } from './progress.ts';

test('fetching unclassified turns records the backlog and sizes the classify step; the rest of the repo is untouched', async () => {
  const status = {} as WorkerStatus;
  const turns = [{ uuid: 'b', ts: '2026-11-10T10:00:00Z' }, { uuid: 'a', ts: '2026-11-09T10:00:00Z' }] as ClassifiableTurn[];
  const asked: unknown[] = [];
  const repo = {
    tag: 'repo',
    unclassifiedTurns: async (...args: unknown[]) => { asked.push(args); return turns; },
    name(this: { tag: string }) { return this.tag; },
  };
  const now = () => new Date('2026-11-10T12:00:00Z');
  const staged = withClassifyBacklog(repo as never as typeof repo & Parameters<typeof withClassifyBacklog>[0], status, new StageTracker(status, () => {}, now), 1, now);
  expect(await staged.unclassifiedTurns(2, ['demo'])).toBe(turns);
  expect(asked).toEqual([[2, ['demo']]]);
  // As many as the limit asked: the backlog is at least this (capped). The oldest fetched is the last.
  expect(status.backlog).toEqual({ classify: 2, classifyCapped: true, at: '2026-11-10T12:00:00.000Z', oldestAt: '2026-11-09T10:00:00Z' });
  // The model calls this cycle may make: the batch, at most.
  expect(status.stage).toMatchObject({ name: 'classify', total: 1, done: 0 });
  await staged.unclassifiedTurns(50);
  expect(status.backlog?.classifyCapped).toBe(false);
  expect(staged.name()).toBe('repo');
  expect(staged.tag).toBe('repo');
});

test('no turns waiting: an empty backlog with no oldest', async () => {
  const status = {} as WorkerStatus;
  const staged = withClassifyBacklog({ unclassifiedTurns: async (_limit: number) => [] }, status, new StageTracker(status, () => {}), 10);
  await staged.unclassifiedTurns(10);
  expect(status.backlog).toMatchObject({ classify: 0, classifyCapped: false, oldestAt: null });
  expect(status.stage).toMatchObject({ name: 'classify', total: 0 });
});
