import { expect, test, vi } from 'vitest';
import type { CloudSyncResult } from '@fb/core';
import { CloudSyncSchedule } from './schedule.ts';

test('on the wall clock, the first sync runs at start; a project that failed without a message waits alone with no error shown', async () => {
  const at = new Date().toISOString();
  const r: CloudSyncResult = {
    at, trigger: 'schedule', host: 'cloud.example.com', ok: false, sent: { projects: 0, lessons: 0, misses: 0, facts: 0, docs: 0, codeFiles: 0 },
    projects: [{ key: 'shop', status: 'failed', counts: null }], error: 'shop failed', stopped: false,
  };
  const run = vi.fn(async () => r);
  const s = new CloudSyncSchedule({ host: 'cloud.example.com', intervalMinutes: 60, run, log: () => {} });
  await s.tick();
  expect(run).toHaveBeenCalledTimes(1);
  expect(s.status.waiting).toEqual([expect.objectContaining({ key: 'shop', failures: 1, error: null })]);
  expect(Date.parse(s.status.nextAt!)).toBeGreaterThan(Date.now());
  await s.tick();
  expect(run).toHaveBeenCalledTimes(1);
});
