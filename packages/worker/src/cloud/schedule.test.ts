import { expect, test, vi } from 'vitest';
import type { CloudSyncResult } from '@fb/core';
import { CloudSyncSchedule } from './schedule.ts';

const result = (ok: boolean, at = '2026-10-23T10:00:00.000Z'): CloudSyncResult => ({
  at, trigger: 'schedule', host: 'cloud.example.com', ok,
  sent: { projects: 1, lessons: 2, misses: 1, facts: 3, docs: 0, codeFiles: 4 },
  projects: [{ key: 'shop', status: ok ? 'sent' : 'failed', counts: null, ...(ok ? {} : { error: 'the cloud answered 503' }) }],
  error: ok ? null : 'shop: the cloud answered 503',
});

test('with no interval the schedule never syncs on its own', async () => {
  const run = vi.fn(async () => result(true));
  const s = new CloudSyncSchedule({ host: 'cloud.example.com', intervalMinutes: null, run, now: () => 0, log: () => {} });
  await s.tick();
  expect(run).not.toHaveBeenCalled();
  expect(s.status).toMatchObject({ host: 'cloud.example.com', intervalMinutes: null, lastAt: null, nextAt: null });
});

test('the first sync runs at start, the next one an interval later; failures back off and a success resets it', async () => {
  let now = Date.parse('2026-10-23T10:00:00Z');
  const outcomes = [true, false, false, true];
  const run = vi.fn(async () => result(outcomes.shift()!, new Date(now).toISOString()));
  const s = new CloudSyncSchedule({ host: 'cloud.example.com', intervalMinutes: 60, run, now: () => now, log: () => {} });
  await s.tick();
  expect(run).toHaveBeenCalledTimes(1);
  expect(s.status).toMatchObject({ lastOk: true, lastError: null, failures: 0, nextAt: '2026-10-23T11:00:00.000Z', lastSent: { lessons: 2 } });

  now += 59 * 60_000;
  await s.tick();
  expect(run).toHaveBeenCalledTimes(1);

  now += 60_000; // 11:00, fails: next in two hours
  await s.tick();
  expect(s.status).toMatchObject({ lastOk: false, lastError: 'shop: the cloud answered 503', failures: 1, nextAt: '2026-10-23T13:00:00.000Z' });

  now = Date.parse('2026-10-23T13:00:00Z'); // fails again: four hours
  await s.tick();
  expect(s.status).toMatchObject({ failures: 2, nextAt: '2026-10-23T17:00:00.000Z' });

  now = Date.parse('2026-10-23T17:00:00Z');
  await s.tick();
  expect(s.status).toMatchObject({ lastOk: true, failures: 0, nextAt: '2026-10-23T18:00:00.000Z' });
});

test('a run that throws is a failure, logged with the token redacted, and the worker carries on', async () => {
  const token = `fgc_pat_0123456789abcdef_${'B'.repeat(43)}`;
  const logs: unknown[] = [];
  const s = new CloudSyncSchedule({ host: 'h', intervalMinutes: 30, run: async () => { throw new Error(`boom ${token}`); }, now: () => 0, log: (m, x) => logs.push([m, x]) });
  await s.tick();
  expect(s.status.failures).toBe(1);
  expect(s.status.lastError).toMatch(/boom/);
  expect(JSON.stringify([s.status, logs])).not.toContain('B'.repeat(43));
});

test('two ticks at once run one sync', async () => {
  let release!: () => void;
  const run = vi.fn(() => new Promise<CloudSyncResult>((r) => { release = () => r(result(true)); }));
  const s = new CloudSyncSchedule({ host: 'h', intervalMinutes: 30, run, now: () => 0, log: () => {} });
  const a = s.tick();
  const b = s.tick();
  release();
  await Promise.all([a, b]);
  expect(run).toHaveBeenCalledTimes(1);
});
