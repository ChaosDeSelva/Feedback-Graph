import type { WorkerStatus } from '@fb/core';
import { describe, expect, test } from 'vitest';
import type { CycleResult } from './cycle.ts';
import { runRound, runWorkerLoop, type WorkerLoopDeps } from './loop.ts';

const idle: CycleResult = { filesIngested: 0, turnsClassified: 0, candidates: 0 };

/**
 * A worker loop over fakes: `cycles` are the cycle results in order (then idle), `wakes` how many wakes run before
 * shutdown (the sleep after the last one begins it). Records the steps in order.
 */
function loop(o: { cycles?: (CycleResult | Error)[]; wakes?: number; settled?: boolean; ready?: boolean; over?: Partial<WorkerLoopDeps> } = {}) {
  const calls: string[] = [];
  const logs: { msg: string; extra?: Record<string, unknown> }[] = [];
  const stages: string[] = [];
  const sleeps: number[] = [];
  let stopping = false;
  let wakes = 0;
  let inWake = false;
  let settled = o.settled ?? true;
  const cycles = [...(o.cycles ?? [])];
  const status: WorkerStatus = { version: 't', startedAt: '', lastBeat: '', lastCycleAt: null, lastCycle: null, lastError: null, providers: {} };
  const step = (name: string) => async () => { calls.push(name); };
  const d: WorkerLoopDeps = {
    status,
    stage: { enter: (name) => { stages.push(name); } },
    log: (msg, extra) => { logs.push({ msg, extra: extra as Record<string, unknown> }); },
    stopping: () => stopping,
    sleep: async (ms) => {
      inWake = false;
      sleeps.push(ms);
      if (wakes >= (o.wakes ?? 1)) stopping = true;
    },
    pollMs: 30_000,
    // A wake is counted at its first scope refresh (each round refreshes it again).
    refreshScope: async () => {
      if (!inWake) wakes++;
      inWake = true;
      calls.push('scope');
    },
    refreshProjectLayout: step('layout'),
    kickMapStage: () => { calls.push('map'); },
    refreshCandidates: step('candidates'),
    forgetDeletedReads: step('forget'),
    syncGithubDocs: step('github'),
    syncFeedback: step('feedback'),
    detectLinks: () => { calls.push('links'); },
    retention: step('retention'),
    evidence: {
      ready: () => o.ready ?? false,
      recheck: step('recheck'),
      settled: () => settled,
      afterIngest: async () => { calls.push('afterIngest'); settled = true; },
    },
    cloudTick: () => { calls.push('cloud'); },
    kickScans: () => { calls.push('scans'); },
    scansRunning: () => 2,
    readDocOne: async () => { calls.push('doc'); return false; },
    postmortems: async () => { calls.push('postmortems'); return { done: 0, failed: 0 }; },
    lessonTriggers: null,
    cycle: async () => {
      calls.push('cycle');
      const next = cycles.shift() ?? idle;
      if (next instanceof Error) throw next;
      return next;
    },
    kickSummaries: () => { calls.push('summaries'); },
    scoreSome: async () => { calls.push('score'); return 0; },
    importMemories: async () => { calls.push('memories'); return 0; },
    learningLoop: () => { calls.push('learning'); },
    ...o.over,
  };
  return { d, calls, logs, stages, sleeps, status, stop: () => { stopping = true; } };
}

const count = (calls: string[], name: string) => calls.filter((c) => c === name).length;

describe('one wake', () => {
  test('refreshes what it reads, syncs, runs rounds, then imports memory notes, then the learning loop, in that order', async () => {
    const f = loop({ ready: true });
    await runWorkerLoop(f.d);
    expect(f.calls).toEqual([
      'scope', 'layout', 'map', 'candidates', 'forget', 'github', 'feedback', 'links', 'retention', 'recheck',
      'scope', 'cloud', 'forget', 'scans', 'doc', 'postmortems', 'cycle', 'afterIngest', 'summaries', 'score',
      'memories', 'learning',
    ]);
    expect(f.stages).toEqual(['sync', 'waiting']);
    expect(f.sleeps).toEqual([30_000]);
  });

  test('the lesson re-check runs each wake only once the session evidence is current', async () => {
    const f = loop({ ready: false });
    await runWorkerLoop(f.d);
    expect(f.calls).not.toContain('recheck');
  });

  test('GitHub or Linear being down is logged, redacted, and never holds up reading transcripts', async () => {
    const f = loop({
      over: {
        syncGithubDocs: async () => { throw new Error('GET https://x:ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789@api.github.com failed'); },
        syncFeedback: async () => { throw new Error('linear down'); },
      },
    });
    await runWorkerLoop(f.d);
    expect(f.calls).toContain('cycle');
    expect(f.logs.find((l) => l.msg === 'github sync failed')?.extra?.error).not.toContain('ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(f.logs.find((l) => l.msg === 'comment sync failed')?.extra).toEqual({ error: 'Error: linear down' });
    expect(f.status.lastError).toBeNull();
  });

  test('memory notes imported are logged; none, nothing is', async () => {
    const f = loop({ over: { importMemories: async () => 3 } });
    await runWorkerLoop(f.d);
    expect(f.logs.filter((l) => l.msg === 'memory lessons imported')).toEqual([{ msg: 'memory lessons imported', extra: { imported: 3 } }]);
    const g = loop();
    await runWorkerLoop(g.d);
    expect(g.logs.map((l) => l.msg)).not.toContain('memory lessons imported');
  });
});

describe('rounds', () => {
  test('go again without sleeping while turns are classified, then sleep once nothing moves', async () => {
    const f = loop({ cycles: [{ ...idle, turnsClassified: 3 }, { ...idle, turnsClassified: 1 }] });
    await runWorkerLoop(f.d);
    expect(count(f.calls, 'cycle')).toBe(3);
    expect(f.sleeps).toHaveLength(1);
    // A round that classified turns leaves the relevance backfill alone; only the idle round scores.
    expect(count(f.calls, 'score')).toBe(1);
  });

  test('the lesson-trigger backfill runs once the post-mortems have nothing to do; lessons done are progress, a failure is logged', async () => {
    let left = 2;
    const f = loop({ over: { lessonTriggers: async () => { f.calls.push('triggers'); return left-- > 0 ? 1 : 0; } } });
    await runWorkerLoop(f.d);
    // Two rounds that gave lessons triggers go straight on; the third, with none left, sleeps. No relevance backfill meanwhile.
    expect(count(f.calls, 'triggers')).toBe(3);
    expect(count(f.calls, 'score')).toBe(1);
    expect(f.calls.indexOf('triggers')).toBeGreaterThan(f.calls.indexOf('postmortems'));

    // The learning loop is offered a round after each round that went on, not only once the backlog is through.
    expect(f.calls.filter((c) => c === 'triggers' || c === 'learning')).toEqual(['triggers', 'learning', 'triggers', 'learning', 'triggers', 'learning']);

    const busy = loop({ over: { postmortems: async () => ({ done: 0, failed: 1 }), lessonTriggers: async () => { busy.calls.push('triggers'); return 0; } } });
    await runWorkerLoop(busy.d);
    expect(busy.calls).not.toContain('triggers');
    const unsettled = loop({ settled: false, over: { lessonTriggers: async () => { unsettled.calls.push('triggers'); return 0; } } });
    await runRound(unsettled.d);
    expect(unsettled.calls).not.toContain('triggers');

    const broken = loop({ over: { lessonTriggers: async () => { throw new Error('store down'); } } });
    await runWorkerLoop(broken.d);
    expect(broken.logs.find((l) => l.msg === 'lesson trigger backfill failed')?.extra).toEqual({ error: 'Error: store down' });
    expect(count(broken.calls, 'cycle')).toBe(1);
  });

  test('an upload read or a post-mortem written is progress too', async () => {
    let docs = 1;
    let pms = 1;
    const f = loop({
      over: {
        readDocOne: async () => docs-- > 0,
        postmortems: async () => ({ done: pms-- > 0 ? 1 : 0, failed: 0 }),
      },
    });
    await runWorkerLoop(f.d);
    expect(count(f.calls, 'cycle')).toBe(2);
    expect(count(f.calls, 'score')).toBe(1);
  });

  test('a code map rebuild asked for during a document backlog starts between doc reads, not after the backlog', async () => {
    let docs = 5;
    let asked = false;
    const built: number[] = [];
    const f = loop({
      over: {
        // The map stage starts a pass when kicked; the pass builds the map you asked for.
        kickMapStage: () => { if (asked) { built.push(docs); asked = false; } },
        readDocOne: async () => {
          if (docs === 5) asked = true; // asked for while the first document is read
          return docs-- > 0;
        },
      },
    });
    await runWorkerLoop(f.d);
    expect(built).toEqual([4]);
  });

  test('the relevance backfill never keeps the loop from sleeping, and its count is logged', async () => {
    const f = loop({ over: { scoreSome: async () => 7 } });
    await runWorkerLoop(f.d);
    expect(count(f.calls, 'cycle')).toBe(1);
    expect(f.logs).toContainEqual({ msg: 'relevance backfill', extra: { scored: 7 } });
  });

  test('post-mortems wait for the first ingest of the start, and the round that let them through goes straight on', async () => {
    const pmRounds: number[] = [];
    let round = 0;
    const f = loop({
      settled: false,
      over: {
        cycle: async () => { round++; return idle; },
        postmortems: async () => { pmRounds.push(round); return { done: 0, failed: 0 }; },
      },
    });
    await runWorkerLoop(f.d);
    // Round 1 ran no post-mortems (evidence not settled) but goes on; round 2 runs them.
    expect(round).toBe(2);
    expect(pmRounds).toEqual([1]);
  });

  test('with no post-mortem model, an unsettled round does not go again', async () => {
    const f = loop({ settled: false, over: { postmortems: null } });
    await runWorkerLoop(f.d);
    expect(count(f.calls, 'cycle')).toBe(1);
  });

  test('the cycle is recorded for /api/status, and lastError says which model is down', async () => {
    const f = loop({ cycles: [{ ...idle, filesIngested: 2, classifierUnavailable: 'ollama: connection refused' }] });
    f.d.postmortems = async () => ({ done: 0, failed: 1, unavailable: 'claude-cli: not logged in' });
    expect(await runRound(f.d)).toBe(false);
    expect(f.status.lastCycle).toEqual({ filesIngested: 2, turnsClassified: 0, candidates: 0, postmortems: 0, postmortemFailures: 1, scanned: 2 });
    expect(f.status.lastCycleAt).not.toBeNull();
    expect(f.status.lastError).toBe('classifier unavailable: ollama: connection refused');
    expect(f.logs.find((l) => l.msg === 'cycle')?.extra).toMatchObject({ classifierUnavailable: 'ollama: connection refused', postmortemUnavailable: 'claude-cli: not logged in', scanned: 2 });

    await runRound(f.d);
    expect(f.status.lastError).toBe('post-mortem model unavailable: claude-cli: not logged in');
    f.d.postmortems = async () => ({ done: 0, failed: 0 });
    await runRound(f.d);
    expect(f.status.lastError).toBeNull();
  });

  test('shutdown during the rounds ends the loop without another round or a sleep', async () => {
    const f = loop({ cycles: [{ ...idle, turnsClassified: 5 }, { ...idle, turnsClassified: 5 }] });
    const cycle = f.d.cycle;
    f.d.cycle = async () => { const r = await cycle(); f.stop(); return r; };
    await runWorkerLoop(f.d);
    expect(count(f.calls, 'cycle')).toBe(1);
    // The wake still finishes its memory import (it is quick), but nothing waits.
    expect(f.sleeps).toEqual([]);
    expect(f.stages).not.toContain('waiting');
  });
});

describe('a failing wake', () => {
  test('a store or database error is kept as lastError (redacted, capped), and the next wake tries again', async () => {
    const deadlock = new Error('Neo.TransientError.Transaction.DeadlockDetected: ForsetiClient[1] can\'t acquire ExclusiveLock; password=hunter2hunter2 ' + 'x'.repeat(600));
    const f = loop({ cycles: [deadlock], wakes: 2 });
    await runWorkerLoop(f.d);
    expect(count(f.calls, 'cycle')).toBe(2);
    const failed = f.logs.filter((l) => l.msg === 'cycle failed');
    expect(failed).toHaveLength(1);
    expect(String(failed[0].extra?.error)).toMatch(/^Error: Neo\.TransientError\.Transaction\.DeadlockDetected/);
    expect(String(failed[0].extra?.error)).not.toContain('hunter2hunter2');
    expect(String(failed[0].extra?.error)).toHaveLength(500);
    // The wake after recovers and the failure is no longer reported.
    expect(f.status.lastError).toBeNull();
    expect(f.sleeps).toEqual([30_000, 30_000]);
  });

  test('a failure before the rounds (the selection unreadable) skips them and the memory import', async () => {
    const f = loop({ over: { refreshCandidates: async () => { throw new Error('connection refused'); } } });
    await runWorkerLoop(f.d);
    expect(f.calls).not.toContain('cycle');
    expect(f.calls).not.toContain('memories');
    expect(f.status.lastError).toBe('Error: connection refused');
    expect(f.stages).toEqual(['waiting']);
  });

  test('a shutdown that begins while a wake fails ends the loop without sleeping', async () => {
    const f = loop();
    f.d.cycle = async () => { f.stop(); throw new Error('store closed'); };
    await runWorkerLoop(f.d);
    expect(f.sleeps).toEqual([]);
    expect(f.status.lastError).toBe('Error: store closed');
  });
});

test('a loop already stopping runs no wake', async () => {
  const f = loop();
  f.stop();
  await runWorkerLoop(f.d);
  expect(f.calls).toEqual([]);
});
