import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Shutdown, SHUTDOWN_GRACE_MS } from './shutdown.ts';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function shutdown() {
  const logs: { msg: string; extra?: object }[] = [];
  const exits: number[] = [];
  let kills = 0;
  const s = new Shutdown({ log: (msg, extra) => logs.push({ msg, extra }), killRunningCommands: () => { kills++; }, exit: (code) => exits.push(code) });
  return { s, logs, exits, kills: () => kills };
}

test('SIGTERM stops new work, kills running CLI agents, and exits after the grace period whatever still runs', async () => {
  const f = shutdown();
  const proc = new EventEmitter();
  f.s.install(proc as unknown as NodeJS.Process);
  const stopped: string[] = [];
  f.s.onStop(() => { stopped.push('map'); });
  f.s.onStop(() => { stopped.push('scans'); return new Promise(() => {}); }); // never ends
  proc.emit('SIGTERM');
  expect(f.s.stopping).toBe(true);
  expect(stopped).toEqual(['map', 'scans']);
  expect(f.kills()).toBe(1);
  expect(f.logs).toEqual([{ msg: 'shutting down', extra: { signal: 'SIGTERM' } }]);
  await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 1);
  expect(f.exits).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.exits).toEqual([0]);
});

test('a second signal (SIGINT after SIGTERM) does not stop twice', () => {
  const f = shutdown();
  const proc = new EventEmitter();
  f.s.install(proc as unknown as NodeJS.Process);
  let stops = 0;
  f.s.onStop(() => { stops++; });
  proc.emit('SIGINT');
  f.s.begin('SIGTERM');
  expect(stops).toBe(1);
  expect(f.logs).toEqual([{ msg: 'shutting down', extra: { signal: 'SIGINT' } }]);
});

test('running CLI agents are killed when the process exits any other way', () => {
  const f = shutdown();
  const proc = new EventEmitter();
  f.s.install(proc as unknown as NodeJS.Process);
  proc.emit('exit', 1);
  expect(f.kills()).toBe(1);
  expect(f.s.stopping).toBe(false);
});

test('a stage registered after shutdown began is not started on (the loop stops it itself)', () => {
  const f = shutdown();
  f.s.begin('SIGTERM');
  let stopped = false;
  f.s.onStop(() => { stopped = true; });
  expect(stopped).toBe(false);
});

test('the loop sleep ends at once when shutdown begins, and is skipped once stopping', async () => {
  const f = shutdown();
  let woke = false;
  const sleeping = f.s.sleep(60_000).then(() => { woke = true; });
  await vi.advanceTimersByTimeAsync(1000);
  expect(woke).toBe(false);
  f.s.begin('SIGTERM');
  await sleeping;
  expect(woke).toBe(true);
  const t = Date.now();
  await f.s.sleep(60_000);
  expect(Date.now()).toBe(t);
});

test('without a signal the sleep lasts its time', async () => {
  const f = shutdown();
  let woke = false;
  void f.s.sleep(5000).then(() => { woke = true; });
  await vi.advanceTimersByTimeAsync(4999);
  expect(woke).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(woke).toBe(true);
});
