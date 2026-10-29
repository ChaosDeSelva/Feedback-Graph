import { expect, test, vi } from 'vitest';
import { Admission } from './admission.ts';

/** A call that ends when released. */
function gate<T>(value: T) {
  let release!: () => void;
  const done = new Promise<T>((r) => { release = () => r(value); });
  return { fn: () => done, release };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('runs up to `concurrency` calls at once; the rest wait their turn, first come first served, and say how many were ahead', async () => {
  const a = new Admission({ concurrency: 2, timeoutMs: 10_000 });
  const [g1, g2, g3, g4] = [gate(1), gate(2), gate(3), gate(4)];
  const r1 = a.run(g1.fn);
  const r2 = a.run(g2.fn);
  const r3 = a.run(g3.fn);
  const r4 = a.run(g4.fn);
  await tick();
  expect([a.running, a.waiting]).toEqual([2, 2]);
  g1.release();
  expect(await r1).toMatchObject({ ok: true, value: 1, ahead: 0 });
  await tick();
  expect([a.running, a.waiting]).toEqual([2, 1]);
  g2.release();
  g3.release();
  g4.release();
  expect(await r2).toMatchObject({ ok: true, value: 2, ahead: 0 });
  expect(await r3).toMatchObject({ ok: true, value: 3, ahead: 2 });
  expect(await r4).toMatchObject({ ok: true, value: 4, ahead: 3 });
  expect([a.running, a.waiting]).toEqual([0, 0]);
});

test('a call still waiting at the deadline answers "timeout" at once and leaves the queue; nothing hangs', async () => {
  const a = new Admission({ concurrency: 1, timeoutMs: 30 });
  const g = gate('slow');
  const first = a.run(g.fn);
  const t = Date.now();
  expect(await a.run(async () => 'never')).toMatchObject({ ok: false, ahead: 1 });
  expect(Date.now() - t).toBeLessThan(500);
  expect(a.waiting).toBe(0);
  g.release();
  await first;
});

test('a call running past the deadline answers "timeout"; its slot stays taken until it really ends', async () => {
  const a = new Admission({ concurrency: 1, timeoutMs: 30 });
  const g = gate('late');
  expect(await a.run(g.fn)).toMatchObject({ ok: false, ahead: 0 });
  expect(a.running).toBe(1);
  g.release();
  await tick();
  expect(a.running).toBe(0);
});

test('a call is given the deadline it must answer by, and its signal fires when the caller gives up, so it can stop and free its slot', async () => {
  const a = new Admission({ concurrency: 1, timeoutMs: 40 });
  let seen: { deadline: number; aborted: () => boolean } | undefined;
  const t = Date.now();
  const r = await a.run(({ signal, deadline }) => {
    seen = { deadline, aborted: () => signal.aborted };
    return new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  });
  expect(r).toMatchObject({ ok: false, ahead: 0 });
  expect(seen!.deadline).toBeGreaterThanOrEqual(t + 40);
  expect(seen!.deadline).toBeLessThan(t + 200);
  expect(seen!.aborted()).toBe(true);
  await tick();
  expect(a.running).toBe(0);
});

test("a call's error is the caller's, and frees its slot", async () => {
  const a = new Admission({ concurrency: 1, timeoutMs: 1000 });
  await expect(a.run(async () => { throw new Error('model down'); })).rejects.toThrow('model down');
  expect(await a.run(async () => 'next')).toMatchObject({ ok: true, value: 'next' });
});


test('warm ETA simulates FIFO across actual capacity and removes cancelled waiters without ghost slots', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const a = new Admission({ concurrency: 2, timeoutMs: 10000 });
    const train = a.run(() => new Promise(resolve => setTimeout(resolve, 1000)));
    await vi.advanceTimersByTimeAsync(1000); await train;
    const x = gate('x'), y = gate('y');
    const rx = a.run(x.fn), ry = a.run(y.fn);
    await vi.advanceTimersByTimeAsync(100);
    const abort = new AbortController();
    const waiting = a.run(async () => 'never', { signal: abort.signal });
    expect(a.snapshot('waiting', 1).estimate).toMatchObject({ source: 'observed', samples: 1, startMs: [900, 900], completionMs: [1900, 1900] });
    expect(a.snapshot('waiting', 3).estimate.startMs).toEqual([1900, 1900]);
    abort.abort();
    expect(a.waiting).toBe(0); // cancellation removes the entry synchronously, before a response snapshot
    expect((await waiting).ok).toBe(false);
    expect(a.snapshot().nextRetryPosition).toBe(1);
    expect(a.snapshot().estimate.samples).toBe(1); // queued cancellation is not a completed service observation
    x.release(); y.release(); await rx; await ry;
    expect([a.running, a.waiting]).toEqual([0, 0]);
  } finally { vi.useRealTimers(); }
});

test('a hung call keeps capacity and makes an overdue upper ETA unknown until the slot really releases', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const a = new Admission({ concurrency: 1, timeoutMs: 100 });
    const hung = gate('late'); const result = a.run(hung.fn);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ ok: false, ran: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(a.snapshot()).toMatchObject({ running: 1, estimate: { source: 'response_budget', samples: 0, overdue: true, startMs: [0, null] } });
    hung.release(); await vi.advanceTimersByTimeAsync(0);
    expect(a.snapshot()).toMatchObject({ running: 0, estimate: { source: 'observed', samples: 1, completionMs: [600, 600] } });
    expect(await a.run(async () => 'recovered')).toMatchObject({ ok: true });
  } finally { vi.useRealTimers(); }
});

test('cold-start ETA is a labeled response-budget scenario rather than an observed service guarantee', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const a = new Admission({ concurrency: 1, timeoutMs: 50000 });
    const busy = gate('done'); const running = a.run(busy.fn);
    expect(a.snapshot()).toMatchObject({ capacity: 1, running: 1, retained: false, nextRetryPosition: 1,
      estimate: { source: 'response_budget', samples: 0, startMs: [0, 50000], completionMs: [0, 100000] } });
    busy.release(); await running;
  } finally { vi.useRealTimers(); }
});

test('observed ETA widens for variable service times instead of substituting the response budget', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const a = new Admission({ concurrency: 1, timeoutMs: 50000 });
    for (const duration of [100, 200, 400, 800]) {
      const result = a.run(() => new Promise(resolve => setTimeout(resolve, duration)));
      await vi.advanceTimersByTimeAsync(duration); await result;
    }
    const held = gate('done'); const active = a.run(held.fn);
    await vi.advanceTimersByTimeAsync(50);
    expect(a.snapshot().estimate).toMatchObject({ source: 'observed', samples: 4, startMs: [50, 750], completionMs: [150, 1550], overdue: false });
    held.release(); await active;
  } finally { vi.useRealTimers(); }
});


test('a hung lane does not erase usable capacity or finite FIFO estimates from a healthy lane', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const a = new Admission({ concurrency: 2, timeoutMs: 1000 });
    const training = a.run(() => new Promise(resolve => setTimeout(resolve, 100)));
    await vi.advanceTimersByTimeAsync(100); await training;
    const hung = gate('hung'); const first = a.run(hung.fn);
    await vi.advanceTimersByTimeAsync(1000); await first;
    expect(a.snapshot().estimate).toMatchObject({ overdue: true, startMs: [0, 0] });
    expect(a.snapshot('waiting', 2).estimate.startMs).toEqual([0, 100]);
    expect(a.snapshot('waiting', 4).estimate.startMs).toEqual([100, 300]);
    const other = gate('other'); const second = a.run(other.fn);
    await vi.advanceTimersByTimeAsync(1000); await second;
    expect(a.snapshot().estimate.startMs).toEqual([0, null]);
    hung.release(); other.release(); await vi.advanceTimersByTimeAsync(0);
    expect(a.running).toBe(0);
  } finally { vi.useRealTimers(); }
});


test.each(['synchronous', 'microtask'])('an abort during %s running notification cannot start cancelled service or sample it', async timing => {
  const a = new Admission({ concurrency: 1, timeoutMs: 10000 });
  const abort = new AbortController(); let calls = 0;
  const result = await a.run(async () => { calls++; }, { signal: abort.signal, onState: state => {
    if (state.state !== 'running') return;
    if (timing === 'synchronous') abort.abort(); else queueMicrotask(() => abort.abort());
  } });
  expect(result).toMatchObject({ ok: false, ran: false });
  expect(calls).toBe(0);
  expect(a.snapshot()).toMatchObject({ running: 0, waiting: 0, estimate: { samples: 0 } });
  expect(await a.run(async () => 'next')).toMatchObject({ ok: true, value: 'next' });
});

test('a waiter aborted just after its slot is granted releases that slot once without running', async () => {
  const a = new Admission({ concurrency: 1, timeoutMs: 10000 });
  const first = gate('first'); const active = a.run(first.fn);
  const abort = new AbortController(); let calls = 0;
  const waiting = a.run(async () => { calls++; }, { signal: abort.signal });
  const next = a.run(async () => 'next', { onState: state => {
    // First waiter has just been granted its slot, and the next waiter moved up before its continuation ran.
    if (state.state === 'waiting' && state.position === 1) abort.abort();
  } });
  first.release(); await active;
  expect(await waiting).toMatchObject({ ok: false, ran: false });
  expect(await next).toMatchObject({ ok: true, value: 'next' });
  expect(calls).toBe(0);
  expect([a.running, a.waiting]).toEqual([0, 0]);
  expect(a.snapshot().estimate.samples).toBe(2);
});
