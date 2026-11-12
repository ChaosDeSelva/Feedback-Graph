import type { WorkerStatus } from '@fb/core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Heartbeat, HEARTBEAT_MS, STAGE_BEAT_MS } from './heartbeat.ts';

beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-10T12:00:00Z') }); });
afterEach(() => { vi.useRealTimers(); });

function heartbeat(o: { file?: () => Promise<void>; repo?: () => Promise<void> } = {}) {
  const status = { lastBeat: '' } as WorkerStatus;
  const files: string[] = [];
  const beats: string[] = [];
  const logs: { msg: string; extra?: object }[] = [];
  const h = new Heartbeat({
    status,
    file: '/tmp/hb',
    writeFile: async (path, data) => { files.push(`${path}=${data}`); await o.file?.(); },
    repo: { heartbeat: async (s) => { beats.push(s.lastBeat); await o.repo?.(); } },
    log: (msg, extra) => logs.push({ msg, extra }),
  });
  return { h, status, files, beats, logs };
}

test('a beat stamps the status and writes it to the file (for the container health check) and the store', () => {
  const f = heartbeat();
  f.h.beat();
  expect(f.status.lastBeat).toBe('2026-11-10T12:00:00.000Z');
  expect(f.files).toEqual(['/tmp/hb=2026-11-10T12:00:00.000Z']);
  expect(f.beats).toEqual(['2026-11-10T12:00:00.000Z']);
});

test('the timer beats on its own until stopped, so a long post-mortem never makes the worker look dead', async () => {
  const f = heartbeat();
  f.h.start();
  await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
  expect(f.beats).toHaveLength(4);
  f.h.stop();
  await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
  expect(f.beats).toHaveLength(4);
});

test('stage changes beat once within a few seconds, however many there were', async () => {
  const f = heartbeat();
  f.h.soon();
  f.h.soon();
  await vi.advanceTimersByTimeAsync(STAGE_BEAT_MS - 1);
  f.h.soon();
  expect(f.beats).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.beats).toHaveLength(1);
  f.h.soon();
  await vi.advanceTimersByTimeAsync(STAGE_BEAT_MS);
  expect(f.beats).toHaveLength(2);
});

test('a pending stage beat is dropped on stop', async () => {
  const f = heartbeat();
  f.h.soon();
  f.h.stop();
  await vi.advanceTimersByTimeAsync(STAGE_BEAT_MS);
  expect(f.beats).toHaveLength(0);
});

test('a store that is down is logged and the beat goes on; an unwritable file is ignored', async () => {
  const f = heartbeat({ file: async () => { throw new Error('EROFS'); }, repo: async () => { throw new Error('ServiceUnavailable: connection refused'); } });
  f.h.beat();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.logs).toEqual([{ msg: 'heartbeat failed', extra: { error: 'Error: ServiceUnavailable: connection refused' } }]);
  f.h.beat();
  expect(f.beats).toHaveLength(2);
});

test('a stage change after stop schedules no beat, so a stopped worker never overwrites a newer status', async () => {
  const f = heartbeat();
  f.h.start();
  f.h.stop();
  f.h.soon();
  await vi.advanceTimersByTimeAsync(STAGE_BEAT_MS * 2);
  expect(f.beats).toHaveLength(1);
  expect(f.files).toHaveLength(1);
});
