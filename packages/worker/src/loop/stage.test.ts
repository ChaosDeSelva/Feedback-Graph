import { expect, test, vi } from 'vitest';
import { LoopStage, loopIdle, LOOP_ROUND_MS } from './stage.ts';
import type { LoopRoundResult } from './engine.ts';

const round = { id: 'r', signalsIngested: 3, targetsScored: 1, decisions: { observed: 1, proposed: 0, applied: 0, skipped: 0 }, llmCalls: 0 } as unknown as NonNullable<LoopRoundResult['round']>;

test('a round when idle and due, never two at once; after a full page the next round runs at once while idle', async () => {
  const logs: unknown[] = [];
  let release!: () => void;
  const run = vi.fn(() => new Promise<LoopRoundResult>((resolve) => { release = () => resolve({ round, more: true }); }));
  const s = new LoopStage({ run, idle: async () => true, log: (msg, extra) => logs.push([msg, extra]) });
  const first = s.tick(0)!;
  expect(s.tick(1)).toBeUndefined();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  // The full page's next round runs in the same tick, not at the next worker wake: the last page is short.
  run.mockImplementationOnce(async () => ({ round, more: true })).mockImplementation(async () => ({ round: null, more: false }));
  release();
  await first;
  expect(run).toHaveBeenCalledTimes(3);
  expect(logs).toHaveLength(2);
  expect(logs[0]).toEqual(['learning loop round', { signals: 3, scored: 1, observed: 1, proposed: 0, applied: 0, skipped: 0, llmCalls: 0 }]);
  expect(s.tick(3)).toBeUndefined();
  await s.tick(LOOP_ROUND_MS);
  expect(run).toHaveBeenCalledTimes(4);
});

test('a catch-up stops between rounds when the worker is no longer idle, and goes on at the next tick', async () => {
  let idle = true;
  const run = vi.fn(async () => { idle = false; return { round: null, more: true }; });
  const s = new LoopStage({ run, idle: async () => idle, log: () => {} });
  await s.tick(0);
  expect(run).toHaveBeenCalledTimes(1);
  idle = true;
  await s.tick(1);
  expect(run).toHaveBeenCalledTimes(2);
});

test('not idle: no round, and it is not counted (the next tick tries again)', async () => {
  const run = vi.fn(async () => ({ round: null, more: false }));
  let idle = false;
  const s = new LoopStage({ run, idle: async () => idle, log: () => {}, everyMs: 100 });
  await s.tick(0);
  expect(run).not.toHaveBeenCalled();
  idle = true;
  await s.tick(1);
  expect(run).toHaveBeenCalledTimes(1);
});

test('a failed round is logged redacted and runs again when due', async () => {
  const logs: [string, object | undefined][] = [];
  const s = new LoopStage({ run: async () => { throw new Error(`down ghp_${'A1b2'.repeat(9)}`); }, idle: async () => true, log: (m, e) => logs.push([m, e]), everyMs: 10 });
  await s.tick(0);
  expect(logs[0][0]).toBe('learning loop round failed');
  expect(JSON.stringify(logs[0][1])).not.toContain('A1b2A1b2');
  await s.tick(10);
  expect(logs).toHaveLength(2);
});

test('loopIdle: no scan running and no post-mortem waiting (when post-mortems can run)', async () => {
  expect(await loopIdle({ postmortemBacklog: async () => 0, scansRunning: () => 0 })()).toBe(true);
  expect(await loopIdle({ postmortemBacklog: async () => 2, scansRunning: () => 0 })()).toBe(false);
  expect(await loopIdle({ postmortemBacklog: async () => 0, scansRunning: () => 1 })()).toBe(false);
  expect(await loopIdle({ postmortemBacklog: null, scansRunning: () => 0 })()).toBe(true);
});
