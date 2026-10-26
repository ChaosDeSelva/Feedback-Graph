import { expect, test } from 'vitest';
import { SandboxPresence } from './sandboxPresence.ts';
import type { RunTag } from './types.ts';

const counted = (answers: boolean[]) => {
  const calls = { n: 0 };
  const check = async () => answers[Math.min(calls.n++, answers.length - 1)];
  return { calls, check };
};

test('asks the store once, then answers from the cache while the answer is fresh', async () => {
  let now = 0;
  const { calls, check } = counted([false]);
  const p = new SandboxPresence(check, { now: () => now });
  expect(await p.any()).toBe(false);
  expect(await p.any()).toBe(false);
  expect(calls.n).toBe(1);
  // A "none" is kept briefly: another process (the worker) may write one.
  now += 10_000;
  expect(await p.any()).toBe(false);
  expect(calls.n).toBe(2);
});

test('concurrent searches share one check', async () => {
  const { calls, check } = counted([false]);
  const p = new SandboxPresence(check);
  expect(await Promise.all(Array.from({ length: 32 }, () => p.any()))).toEqual(Array(32).fill(false));
  expect(calls.n).toBe(1);
});

test('a sandbox write in this process makes the next search filter at once, without asking', async () => {
  const { calls, check } = counted([false]);
  const p = new SandboxPresence(check);
  expect(await p.any()).toBe(false);
  p.mark();
  expect(await p.any()).toBe(true);
  expect(calls.n).toBe(1);
});

test('a check that started before a sandbox write cannot overwrite it with "none"', async () => {
  let release!: (v: boolean) => void;
  const p = new SandboxPresence(() => new Promise<boolean>((r) => (release = r)));
  const inFlight = p.any();
  p.mark();
  release(false);
  await inFlight;
  expect(await p.any()).toBe(true);
});

test('after a run cleanup the store is asked again, so the filter can be skipped once the sandbox records are gone', async () => {
  const { calls, check } = counted([true, false]);
  const p = new SandboxPresence(check);
  expect(await p.any()).toBe(true);
  p.recheck();
  expect(await p.any()).toBe(false);
  expect(calls.n).toBe(2);
});

test('a failed check filters (the safe answer) and is retried next time', async () => {
  let fail = true;
  const p = new SandboxPresence(async () => {
    if (fail) throw new Error('down');
    return false;
  });
  expect(await p.any()).toBe(true);
  fail = false;
  expect(await p.any()).toBe(false);
});

test('wrote(run) marks for a sandbox run (or a sandbox flag read from the record), and only then', async () => {
  const { calls, check } = counted([false]);
  const p = new SandboxPresence(check);
  expect(await p.any()).toBe(false);
  for (const run of [null, undefined, { id: 'r1' } as RunTag, { id: 'r1', sandbox: false } as RunTag, false]) p.wrote(run);
  expect(await p.any()).toBe(false);
  p.wrote({ id: 'r2', sandbox: true } as RunTag);
  expect(await p.any()).toBe(true);
  const q = new SandboxPresence(check);
  expect(await q.any()).toBe(false);
  q.wrote(true);
  expect(await q.any()).toBe(true);
  expect(calls.n).toBe(2);
  // Anything it does not recognise as "not a sandbox" marks: filtering when unsure costs time, skipping could leak.
  for (const odd of ['true', 1, 't', {}, { id: 'r3', sandbox: 'yes' }] as unknown as boolean[]) {
    const r = new SandboxPresence(check);
    expect(await r.any()).toBe(false);
    r.wrote(odd);
    expect(await r.any()).toBe(true);
  }
});
