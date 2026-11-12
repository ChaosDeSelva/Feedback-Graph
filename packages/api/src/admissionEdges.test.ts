import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Admission, type QueueInfo } from './admission.ts';

function gate<T>(value: T) {
  let release!: () => void;
  const done = new Promise<T>((r) => { release = () => r(value); });
  return { fn: () => done, release };
}
const states = () => { const seen: QueueInfo[] = []; return { seen, onState: (s: QueueInfo) => { seen.push(s); } }; };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

test('a request whose caller already gave up is refused at once and runs nothing', async () => {
  const a = new Admission({ concurrency: 1, timeoutMs: 1000 });
  const gone = new AbortController(); gone.abort();
  const s = states(); let calls = 0;
  expect(await a.run(async () => { calls++; }, { signal: gone.signal, onState: s.onState })).toEqual({ ok: false, ahead: 0, waitedMs: 0, ran: false });
  expect(calls).toBe(0);
  expect(s.seen.at(-1)?.state).toBe('retry_required');
  expect([a.running, a.waiting]).toEqual([0, 0]);
});

test('retry priority is kept for at most retryPriorityLimit callers: the oldest is forgotten', async () => {
  const a = new Admission({ concurrency: 1, timeoutMs: 1000, retryPriorityLimit: 1 });
  const held = gate('held'); const active = a.run(held.fn);
  const waits = ['k1', 'k2'].map((k) => a.run(async () => k, { retryKey: k, deadline: 10 }));
  await vi.advanceTimersByTimeAsync(10); await Promise.all(waits);
  held.release(); await active;
  const [first, second] = [states(), states()];
  await a.run(async () => 'one', { retryKey: 'k1', onState: first.onState });
  await a.run(async () => 'two', { retryKey: 'k2', onState: second.onState });
  expect(first.seen[0].retryPriority).toMatchObject({ restored: false });
  expect(second.seen[0].retryPriority).toMatchObject({ restored: true });
});

test('a timed-out retry is told it comes after a caller who queued before it and is still waiting', async () => {
  const a = new Admission({ concurrency: 1, timeoutMs: 1000 });
  const held = gate('held'); const active = a.run(held.fn);
  const earlier = a.run(async () => 'earlier');
  const s = states();
  const keyed = a.run(async () => 'keyed', { retryKey: 'k', deadline: 10, onState: s.onState });
  await vi.advanceTimersByTimeAsync(10); await keyed;
  expect(s.seen.at(-1)).toMatchObject({ state: 'retry_required', nextRetryPosition: 2 });
  held.release(); await active; await earlier;
});

test('an identical retry that joins a still-queued original is told its place in the queue', async () => {
  const a = new Admission({ concurrency: 1, timeoutMs: 1000 });
  const held = gate('held'); const active = a.run(held.fn);
  const original = a.run(async () => 'verdict', { retryKey: 'same' });
  const s = states();
  const joiner = a.run(async () => 'duplicate', { retryKey: 'same', onState: s.onState });
  expect(s.seen[0]).toMatchObject({ state: 'waiting', position: 1 });
  held.release(); await active;
  expect(await original).toMatchObject({ ok: true, value: 'verdict' });
  expect(await joiner).toMatchObject({ ok: true, value: 'verdict' });
});

test('a waiter whose turn comes just as its caller gives up is told to retry, and frees the slot', async () => {
  const a = new Admission({ concurrency: 1, timeoutMs: 10_000 });
  const first = gate('first'); const active = a.run(first.fn);
  const abort = new AbortController();
  const s = states();
  const waiting = a.run(async () => 'never', { signal: abort.signal, onState: s.onState });
  const next = a.run(async () => 'next', { onState: (state) => { if (state.state === 'waiting' && state.position === 1) abort.abort(); } });
  first.release(); await active;
  expect(await waiting).toMatchObject({ ok: false, ran: false });
  expect(s.seen.at(-1)?.state).toBe('retry_required');
  expect(await next).toMatchObject({ ok: true, value: 'next' });
});

test('a retry-keyed waiter left with under 250 ms is told to retry, keeping its priority', async () => {
  const a = new Admission({ concurrency: 1, timeoutMs: 1000 });
  const held = gate('held'); const active = a.run(held.fn);
  const s = states();
  const waiting = a.run(async () => 'too late', { retryKey: 'late', deadline: 200, onState: s.onState });
  await vi.advanceTimersByTimeAsync(100);
  held.release(); await active;
  expect(await waiting).toMatchObject({ ok: false, ran: false });
  expect(s.seen.at(-1)).toMatchObject({ state: 'retry_required', retryPriority: { retained: true } });
});

test('the duration sample keeps the last 64 calls', async () => {
  const a = new Admission({ concurrency: 1, timeoutMs: 1000 });
  for (let i = 0; i < 65; i++) {
    const call = a.run(() => new Promise((r) => setTimeout(r, 1)));
    await vi.advanceTimersByTimeAsync(1); await call;
  }
  expect(a.snapshot().estimate.samples).toBe(64);
});

test('a deadline that passes after admission but before the call starts runs nothing and samples nothing', async () => {
  const a = new Admission({ concurrency: 1, timeoutMs: 100 });
  const s = states(); let calls = 0;
  const result = await a.run(async () => { calls++; }, { onState: (state) => {
    s.onState(state);
    // Time passes between the running notification and the call's start.
    if (state.state === 'running') queueMicrotask(() => vi.setSystemTime(500));
  } });
  expect(result).toMatchObject({ ok: false, ran: false });
  expect(calls).toBe(0);
  expect(s.seen.map((x) => x.state)).toEqual(['running', 'retry_required']);
  expect(a.snapshot()).toMatchObject({ running: 0, estimate: { samples: 0 } });
});

test('a call that fails tells its caller to retry before the error reaches it', async () => {
  const a = new Admission({ concurrency: 1, timeoutMs: 1000 });
  const s = states();
  await expect(a.run(async () => { throw new Error('provider down'); }, { onState: s.onState })).rejects.toThrow('provider down');
  expect(s.seen.at(-1)?.state).toBe('retry_required');
});

test('a kept-alive call slower than the observed tail estimates its completion by its own service deadline', async () => {
  // A retry window as long as the response budget, so the kept-alive call's service window is that budget too.
  const a = new Admission({ concurrency: 1, timeoutMs: 1000, retryPriorityMs: 1000 });
  for (const ms of [100, 200]) { const c = a.run(() => new Promise((r) => setTimeout(r, ms))); await vi.advanceTimersByTimeAsync(ms); await c; }
  // Waits 200 ms behind a blocker, then is still running past the 2.5x-slowest tail (500 ms) when its response deadline
  // ends at 1000 ms; its own service deadline is 1000 ms after it started, at 1200.
  const blocker = a.run(() => new Promise((r) => setTimeout(r, 200)));
  const s = states();
  const kept = a.run(() => new Promise((r) => setTimeout(r, 5000, 'late verdict')), { retryKey: 'k', onState: s.onState });
  await vi.advanceTimersByTimeAsync(1000);
  await blocker;
  expect(await kept).toMatchObject({ ok: false, ran: true });
  const last = s.seen.at(-1)!;
  expect(last).toMatchObject({ state: 'retry_required', inFlight: { elapsedMs: 800 } });
  expect(last.estimate.completionMs[1]).toBe(200);
  await vi.advanceTimersByTimeAsync(5000);
});
