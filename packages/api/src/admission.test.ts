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
    expect(a.snapshot('waiting', 1).estimate).toMatchObject({ source: 'observed', samples: 1, startMs: [900, 2400], completionMs: [1900, 4900] });
    expect(a.snapshot('waiting', 3).estimate.startMs).toEqual([1900, 4900]);
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
    expect(a.snapshot()).toMatchObject({ running: 0, estimate: { source: 'observed', samples: 1, completionMs: [600, 1500] } });
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
    expect(a.snapshot().estimate).toMatchObject({ source: 'observed', samples: 4, startMs: [50, 1950], completionMs: [150, 3950], overdue: false });
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
    expect(a.snapshot('waiting', 2).estimate.startMs).toEqual([0, 250]);
    expect(a.snapshot('waiting', 4).estimate.startMs).toEqual([100, 750]);
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


test('a fresh slow-tail call is not described as past its response deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 5000 });
    const sample = admission.run(() => new Promise(resolve => setTimeout(resolve, 10)));
    await vi.advanceTimersByTimeAsync(10); await sample;
    const held = gate('done'); const active = admission.run(held.fn);
    await vi.advanceTimersByTimeAsync(50);
    expect(admission.snapshot().estimate.overdue).toBe(false);
    held.release(); await active;
  } finally { vi.useRealTimers(); }
});


test.each([false, true])('queued retry preserves relative priority only within TTL (expired=%s)', async expired => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 10000, retryPriorityMs: 100 });
    const held = gate('held'); const active = admission.run(held.fn);
    let abandonedCalls = 0;
    const first = admission.run(async () => { abandonedCalls++; }, { retryKey: 'callerA:check', deadline: 10 });
    await vi.advanceTimersByTimeAsync(10); expect(await first).toMatchObject({ ok: false, ran: false });
    expect(admission.waiting).toBe(0); expect(admission.running).toBe(1);
    if (expired) await vi.advanceTimersByTimeAsync(101);
    const order: string[] = [];
    const newer = admission.run(async () => { order.push('newer'); });
    let restored = false;
    const retry = admission.run(async () => { order.push('retry'); }, { retryKey: 'callerA:check', onState: state => { restored ||= !!state.retryPriority?.restored; } });
    held.release(); await active; await newer; await retry;
    expect(order).toEqual(expired ? ['newer', 'retry'] : ['retry', 'newer']);
    expect(restored).toBe(!expired); expect(abandonedCalls).toBe(0);
    expect([admission.running, admission.waiting]).toEqual([0, 0]);
  } finally { vi.useRealTimers(); }
});

test('different retry identities cannot inherit priority and absent retry holds no physical queue slot', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 10000 });
    const held = gate('held'); const active = admission.run(held.fn);
    const first = admission.run(async () => 'never', { retryKey: 'callerA', deadline: 10 });
    await vi.advanceTimersByTimeAsync(10); await first;
    expect(admission.waiting).toBe(0);
    const order: string[] = [];
    const newer = admission.run(async () => { order.push('newer'); });
    const stranger = admission.run(async () => { order.push('stranger'); }, { retryKey: 'callerB' });
    held.release(); await active; await newer; await stranger;
    expect(order).toEqual(['newer', 'stranger']);
    expect(await admission.run(async () => 'free')).toMatchObject({ ok: true, ahead: 0 });
  } finally { vi.useRealTimers(); }
});

test('retrying an identical check already in service joins its result instead of starting judge work again', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 1000 });
    let calls = 0;
    const first = admission.run(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 40)); return 'verdict'; }, { retryKey: 'caller:check', deadline: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await first).toMatchObject({ ok: false, ran: true });
    const retry = admission.run(async () => { calls++; return 'duplicate'; }, { retryKey: 'caller:check', deadline: 100 });
    await vi.advanceTimersByTimeAsync(30);
    expect(await retry).toMatchObject({ ok: true, value: 'verdict' });
    expect(calls).toBe(1);
    expect([admission.running, admission.waiting]).toEqual([0, 0]);
  } finally { vi.useRealTimers(); }
});

test('a response timeout keeps retry-keyed provider work alive for an identical retry', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 100 });
    let calls = 0;
    const first = admission.run(async ({ signal }) => {
      calls++;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 40);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return 'real verdict';
    }, { retryKey: 'same', deadline: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await first).toMatchObject({ ok: false, ran: true });
    const states: string[] = [];
    const retry = admission.run(async () => { calls++; return 'duplicate'; }, { retryKey: 'same', deadline: 100, onState: s => states.push(s.state) });
    await vi.advanceTimersByTimeAsync(30);
    expect(await retry).toMatchObject({ ok: true, value: 'real verdict' });
    expect(calls).toBe(1);
    expect(states).toEqual(['running', 'completed']);
  } finally { vi.useRealTimers(); }
});

test('identical checks join while the original is still queued', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 1000 });
    const held = gate('held'); const active = admission.run(held.fn);
    let calls = 0;
    const original = admission.run(async () => { calls++; return 'one verdict'; }, { retryKey: 'same', deadline: 500 });
    const duplicate = admission.run(async () => { calls++; return 'duplicate'; }, { retryKey: 'same', deadline: 500 });
    held.release(); await active;
    expect(await original).toMatchObject({ ok: true, value: 'one verdict' });
    expect(await duplicate).toMatchObject({ ok: true, value: 'one verdict' });
    expect(calls).toBe(1);
  } finally { vi.useRealTimers(); }
});

test('a retry-keyed call is not started with less than 250ms of response budget', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 1000 });
    const held = gate('held'); const active = admission.run(held.fn);
    let calls = 0;
    const waiting = admission.run(async () => { calls++; return 'too late'; }, { retryKey: 'late', deadline: 200 });
    await vi.advanceTimersByTimeAsync(100);
    held.release(); await active;
    expect(await waiting).toMatchObject({ ok: false, ran: false });
    expect(calls).toBe(0);
  } finally { vi.useRealTimers(); }
});

test('a timed-out burst receives distinct retained retry positions', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 1000 });
    const held = gate('held'); const active = admission.run(held.fn);
    const positions: number[] = [];
    const waits = [1, 2, 3].map(n => admission.run(async () => n, { retryKey: `burst:${n}`, deadline: 10,
      onState: state => { if (state.state === 'retry_required') positions[n - 1] = state.nextRetryPosition; } }));
    await vi.advanceTimersByTimeAsync(10); await Promise.all(waits);
    expect(positions).toEqual([1, 2, 3]);
    held.release(); await active;
  } finally { vi.useRealTimers(); }
});

test('a completed keyed result remains available to an obedient retry', async () => {
  const admission = new Admission({ concurrency: 1, timeoutMs: 1000 });
  let calls = 0;
  expect(await admission.run(async () => { calls++; return 'verdict'; }, { retryKey: 'same' })).toMatchObject({ ok: true });
  expect(await admission.run(async () => { calls++; return 'duplicate'; }, { retryKey: 'same' })).toMatchObject({ ok: true, value: 'verdict' });
  expect(calls).toBe(1);
});

test('a rejected keyed call is not cached: an identical retry can recover', async () => {
  const admission = new Admission({ concurrency: 1, timeoutMs: 1000 });
  let calls = 0;
  await expect(admission.run(async () => { calls++; throw new Error('transient'); }, { retryKey: 'same' })).rejects.toThrow('transient');
  await expect(admission.run(async () => { calls++; return 'verdict'; }, { retryKey: 'same' })).resolves.toMatchObject({ ok: true, value: 'verdict' });
  expect(calls).toBe(2);
});

test('staggered joiners survive expiry of their queued original and share one replacement', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 1000 });
    const held = gate('held'); const active = admission.run(held.fn);
    let calls = 0;
    const original = admission.run(async () => { calls++; return 'old'; }, { retryKey: 'same', deadline: 10 });
    const early = admission.run(async () => { calls++; return 'replacement'; }, { retryKey: 'same', deadline: 400 });
    await vi.advanceTimersByTimeAsync(5);
    const late = admission.run(async () => { calls++; return 'duplicate'; }, { retryKey: 'same', deadline: 500 });
    await vi.advanceTimersByTimeAsync(5);
    expect(await original).toMatchObject({ ok: false, ran: false });
    held.release(); await active; await vi.advanceTimersByTimeAsync(0);
    expect(await early).toMatchObject({ ok: true, value: 'replacement' });
    expect(await late).toMatchObject({ ok: true, value: 'replacement' });
    expect(calls).toBe(1);
  } finally { vi.useRealTimers(); }
});

test('completed retention expires and permits a genuinely fresh call', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 1000, retryPriorityMs: 20 });
    let calls = 0;
    await admission.run(async () => ++calls, { retryKey: 'same' });
    expect(await admission.run(async () => ++calls, { retryKey: 'same' })).toMatchObject({ value: 1 });
    await vi.advanceTimersByTimeAsync(20);
    expect(await admission.run(async () => ++calls, { retryKey: 'same' })).toMatchObject({ value: 2 });
  } finally { vi.useRealTimers(); }
});

test('one extreme outlier does not dominate ETA after a useful sample exists', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 10000 });
    for (const duration of [...Array(9).fill(100), 5000]) {
      const call = admission.run(() => new Promise(resolve => setTimeout(resolve, duration)));
      await vi.advanceTimersByTimeAsync(duration); await call;
    }
    expect(admission.snapshot().estimate.completionMs[1]).toBe(250);
  } finally { vi.useRealTimers(); }
});

test('a timed-out join renews retry priority from the latest attempt', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 1000, retryPriorityMs: 100 });
    const held = gate('held');
    const original = admission.run(held.fn, { retryKey: 'same', deadline: 500 });
    const joiner = admission.run(async () => 'duplicate', { retryKey: 'same', deadline: 10 });
    await vi.advanceTimersByTimeAsync(10); expect(await joiner).toMatchObject({ ok: false, ran: true });
    await vi.advanceTimersByTimeAsync(95);
    expect(admission.snapshot().nextRetryPosition).toBe(1);
    held.release(); await original;
  } finally { vi.useRealTimers(); }
});
