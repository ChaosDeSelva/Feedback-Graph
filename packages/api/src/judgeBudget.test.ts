import { expect, test, vi } from 'vitest';
import type { Lesson } from '@fb/core';
import { Admission, type QueueInfo } from './admission.ts';
import { checkBeforeDone, type ContextDeps } from './context.ts';

// The value sweep's judge (gemma4 on a loaded host) was slower than the check's response budget, and some checks
// slower than the two-minute retry window: those stayed queued for 20 minutes over 23 retries, each told "6–6 s".
// Here the same, scaled down: a 400 ms response budget, a 2.5 s retry window (room for a loaded test host), and
// CHECK_WAIT_SECONDS of 6 s.
const lesson = (id: string): Lesson => ({ id, projectKey: 'demo', origin: 'demo', title: `Rule ${id}`, rule: `Follow rule ${id} in src/${id}.ts`, appliesWhen: 'editing it', scope: 'project', paths: [`src/${id}.ts`], status: 'approved', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't' });
const BUDGET = 400;
const WINDOW = 2500;
const MAX_SERVICE = 6000;

function deps(queue: Admission, service: number, calls: { n: number }): ContextDeps {
  return {
    roots: [{ host: '/projects', container: '/projects' }], exists: () => true, embed: async () => [[1]], judgeQueue: queue, checkRetryIdentity: 'agent', checkTimeoutMs: BUDGET,
    k: { searchLessons: async () => [{ lesson: lesson('a'), score: .9 }], relatedMisses: async () => [], missesNaming: async () => [], createManualFeedback: async () => 'f', recordPreDoneCheck: async () => {} },
    // Like askJson over Ollama: abandoned at the deadline it was given, or when the call is aborted.
    judge: async (_work, lessons, turn = {}) => {
      calls.n++;
      await new Promise((resolve, reject) => {
        const done = setTimeout(resolve, service);
        const fail = (why: string) => { clearTimeout(done); reject(new Error(why)); };
        if (turn.deadline !== undefined) setTimeout(() => fail('Ollama (gemma4) did not answer within its deadline'), Math.max(0, turn.deadline - Date.now()));
        turn.signal?.addEventListener('abort', () => fail('aborted'), { once: true });
      });
      return lessons.map((h) => ({ lessonId: h.lesson.id, status: 'addressed' as const, applies: true, why: 'done', evidence: ['+ok'] }));
    },
  };
}
const args = { project: 'demo', task: 'edit src/a.ts', summary: 'changed it', filesChanged: ['src/a.ts'], diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+ok\n' };

/** Under fake timers: the clock moves on in small steps until `p` settles, as a real one would. */
async function settled<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  while (!done) await vi.advanceTimersByTimeAsync(10);
  return p;
}

/** An obedient agent: retries the same check after the advised wait (scaled down), until it is not queued. */
async function untilAnswered(d: ContextDeps, max = 60) {
  for (let attempt = 1; attempt <= max; attempt++) {
    const r = await settled(checkBeforeDone(args, d));
    if (!r.queued) return { r, attempt };
    await vi.advanceTimersByTimeAsync(Math.min(r.queue?.retryAfterMs ?? 1000, 1000) / 10);
  }
  return { r: null, attempt: max };
}

test('a judge slower than the retry window but within CHECK_WAIT_SECONDS finishes: its retries get the verdict of the one call', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const calls = { n: 0 };
    const queue = new Admission({ concurrency: 1, timeoutMs: BUDGET, retryPriorityMs: WINDOW, maxServiceMs: MAX_SERVICE });
    const { r } = await untilAnswered(deps(queue, 4000, calls));
    // Before: the call was cut off at the retry window (2.5 s), and each retry after that started it again, forever.
    expect(r?.status).toBe('lesson_judged');
    expect(calls.n).toBe(1);
  } finally { vi.useRealTimers(); }
});

test('a judge slower than CHECK_WAIT_SECONDS: the retries are told it failed, with the lessons to check by hand, and no call starts again in the window', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const calls = { n: 0 };
    const queue = new Admission({ concurrency: 1, timeoutMs: BUDGET, retryPriorityMs: WINDOW, maxServiceMs: 3000 });
    const d = deps(queue, 60_000, calls);
    const { r, attempt } = await untilAnswered(d);
    expect(r?.status).toBe('failed');
    expect(r!.markdown).toMatch(/Not judged: the judge failed \(no answer within 3 s, CHECK_WAIT_SECONDS\)/);
    expect(r!.markdown).toContain('Rule a');
    expect(attempt).toBeLessThan(60);
    // The next retry, inside the window, gets the same answer instead of a fresh call bound to overrun the same way.
    expect((await settled(checkBeforeDone(args, d))).status).toBe('failed');
    expect(calls.n).toBe(1);
  } finally { vi.useRealTimers(); }
});

async function trained(admission: Admission, durations: number[]) {
  for (const duration of durations) {
    const call = admission.run(() => new Promise((resolve) => setTimeout(resolve, duration)));
    await vi.advanceTimersByTimeAsync(duration); await call;
  }
}

test('an unkeyed call is not started once it has waited past the point where even a fast service would fit', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 10_000 });
    await trained(admission, Array(10).fill(1000));
    const busy = admission.run(() => new Promise((resolve) => setTimeout(resolve, 9500)));
    let started = false;
    const states: QueueInfo[] = [];
    // It waits 9.5 s for the slot, leaving 0.5 s: no 1 s call fits, so none is started only to be cancelled.
    const late = admission.run(async () => { started = true; return 'x'; }, { onState: (s) => states.push(s) });
    await vi.advanceTimersByTimeAsync(9500); await busy;
    expect(await late).toMatchObject({ ok: false, ran: false });
    expect(started).toBe(false);
    expect(states.at(-1)!.state).toBe('retry_required');
    expect([admission.running, admission.waiting]).toEqual([0, 0]);
  } finally { vi.useRealTimers(); }
});

test('the ETA of a call running longer than every observed one is as long again as it has run, not the observed median', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 10_000 });
    await trained(admission, Array(10).fill(100));
    const states: QueueInfo[] = [];
    const kept = admission.run(() => new Promise((resolve) => setTimeout(resolve, 30_000, 'verdict')), { retryKey: 'slow', deadline: Date.now() + 2000, onState: (s) => states.push(s) });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await kept).toMatchObject({ ok: false, ran: true });
    // Before: "about 1 s" (the 100 ms median) for a call already 2 s in, and so on for every retry after.
    expect(states.at(-1)).toMatchObject({ state: 'retry_required', inFlight: { elapsedMs: 2000 }, retryAfterMs: 2000, estimate: { medianCompletionMs: 2000, completionMs: [0, 118_000] } });
    await vi.advanceTimersByTimeAsync(28_000);
  } finally { vi.useRealTimers(); }
});

test('a kept-alive call nobody comes back for is abandoned once the retry window after its response has passed', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 400, retryPriorityMs: 1000, maxServiceMs: 60_000 });
    let signal: AbortSignal | undefined;
    const kept = admission.run((turn) => new Promise((resolve, reject) => {
      signal = turn.signal;
      turn.signal.addEventListener('abort', () => reject(turn.signal.reason));
    }), { retryKey: 'gone' });
    await vi.advanceTimersByTimeAsync(400);
    expect(await kept).toMatchObject({ ok: false, ran: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(true);
    expect(admission.running).toBe(0);
    // A retry now starts a fresh call: the abandoned one is not kept as a failure.
    expect(await admission.run(async () => 'fresh', { retryKey: 'gone' })).toMatchObject({ ok: true, value: 'fresh' });
  } finally { vi.useRealTimers(); }
});

test('a kept-alive call that cannot fit the budget but is cancelled before it starts is not run, and says so', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const admission = new Admission({ concurrency: 1, timeoutMs: 10_000 });
    await trained(admission, Array(10).fill(1000));
    const abort = new AbortController();
    let started = false;
    const r = admission.run(async () => { started = true; return 'x'; }, { retryKey: 'k', deadline: Date.now() + 500, signal: abort.signal });
    abort.abort();
    expect(await r).toMatchObject({ ok: false, ran: false });
    expect(started).toBe(false);
    expect(admission.running).toBe(0);
  } finally { vi.useRealTimers(); }
});

test('a judge that fails for another reason as the response budget runs out is "busy": retry with a fresh budget', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  try {
    const d = { ...deps(new Admission({ concurrency: 1, timeoutMs: BUDGET }), 0, { n: 0 }), judgeQueue: undefined, checkRetryIdentity: undefined };
    // A provider that gives up just before the check's deadline: that says the budget ran out, not that the judge broke.
    d.judge = async () => { await new Promise((resolve) => setTimeout(resolve, BUDGET - 100)); throw new Error('socket hang up'); };
    const r = await settled(checkBeforeDone(args, d));
    expect(r.status).toBe('queued');
    expect(r.markdown).toMatch(/Not judged: the check response budget was exhausted while waiting/);
  } finally { vi.useRealTimers(); }
});
