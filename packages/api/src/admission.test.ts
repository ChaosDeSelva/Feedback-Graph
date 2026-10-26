import { expect, test } from 'vitest';
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
