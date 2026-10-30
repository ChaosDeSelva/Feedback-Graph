import { expect, test, vi } from 'vitest';
import type { CloudSyncResult } from '@fb/core';
import { CloudSyncSchedule } from './schedule.ts';

/** ok, or a run a 401 stopped (the token: no project fares better). */
const result = (ok: boolean, at = '2026-10-23T10:00:00.000Z'): CloudSyncResult => ({
  at, trigger: 'schedule', host: 'cloud.example.com', ok,
  sent: { projects: 1, lessons: 2, misses: 1, facts: 3, docs: 0, codeFiles: 4 },
  projects: [{ key: 'shop', status: ok ? 'sent' : 'failed', counts: null, ...(ok ? {} : { error: 'the cloud refused the token (401)' }) }],
  error: ok ? null : 'shop: the cloud refused the token (401)',
  stopped: !ok,
});

test('with no interval the schedule never syncs on its own', async () => {
  const run = vi.fn(async () => result(true));
  const s = new CloudSyncSchedule({ host: 'cloud.example.com', intervalMinutes: null, run, now: () => 0, log: () => {} });
  await s.tick();
  expect(run).not.toHaveBeenCalled();
  expect(s.status).toMatchObject({ host: 'cloud.example.com', intervalMinutes: null, lastAt: null, nextAt: null });
});

test('the first sync runs at start, the next one an interval later; runs a 401 stopped back off and a success resets it', async () => {
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
  expect(s.status).toMatchObject({ lastOk: false, lastError: 'shop: the cloud refused the token (401)', failures: 1, nextAt: '2026-10-23T13:00:00.000Z' });

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

test('one failing project backs off alone: the others keep their interval, and it is tried again when its wait is over', async () => {
  let now = Date.parse('2026-10-23T10:00:00Z');
  const iso = (t: number) => new Date(t).toISOString();
  const asked: (string | null)[][] = [];
  // big fails (a 422 it will get every time until it changes); shop is fine.
  let bigFails = true;
  const run = vi.fn(async (waiting: (key: string) => string | null): Promise<CloudSyncResult> => {
    asked.push(['big', 'shop'].map(waiting));
    const projects: CloudSyncResult['projects'] = [
      waiting('big') ? { key: 'big', status: 'waiting', counts: null, until: waiting('big')! }
        : bigFails ? { key: 'big', status: 'failed', counts: null, error: 'the cloud rejected the bundle (422)' } : { key: 'big', status: 'sent', counts: null },
      { key: 'shop', status: 'sent', counts: null },
    ];
    const failed = projects[0].status === 'failed';
    return { at: iso(now), trigger: 'schedule', host: 'h', ok: !failed, sent: result(true).sent, projects, error: failed ? 'big: the cloud rejected the bundle (422)' : null, stopped: false };
  });
  const s = new CloudSyncSchedule({ host: 'h', intervalMinutes: 60, run, now: () => now, log: () => {} });
  await s.tick(); // 10:00: big fails
  expect(s.status).toMatchObject({ failures: 0, nextAt: '2026-10-23T11:00:00.000Z' });
  expect(s.status.waiting).toEqual([{ key: 'big', failures: 1, until: '2026-10-23T12:00:00.000Z', error: 'the cloud rejected the bundle (422)' }]);
  now = Date.parse('2026-10-23T11:00:00Z'); // shop's interval: big waits
  await s.tick();
  expect(asked[1]).toEqual(['2026-10-23T12:00:00.000Z', null]);
  expect(s.status.nextAt).toBe('2026-10-23T12:00:00.000Z');
  now = Date.parse('2026-10-23T12:00:00Z'); // big's wait is over: tried, fails again, waits twice as long
  await s.tick();
  expect(asked[2]).toEqual([null, null]);
  expect(s.status.waiting).toEqual([expect.objectContaining({ key: 'big', failures: 2, until: '2026-10-23T16:00:00.000Z' })]);
  expect(s.status.failures).toBe(0);
  now = Date.parse('2026-10-23T16:00:00Z');
  bigFails = false;
  await s.tick();
  expect(s.status.waiting).toEqual([]);
});


test('a worker restart restores the previous scheduled result before another tick', () => {
  const last = result(true);
  const schedule = new CloudSyncSchedule({ host: last.host, last, intervalMinutes: 60, run: async () => last, log: () => {} });
  expect(schedule.status).toMatchObject({ lastAt: last.at, lastOk: true, lastSent: last.sent });
});
