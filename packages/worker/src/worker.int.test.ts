import { EventEmitter } from 'node:events';
import { describeStores } from '@fb/core/testing';
import { expect, test } from 'vitest';
import { keptOpen, until, world } from './testing/workerWorld.ts';
import { runWorker } from './worker.ts';

describeStores('worker process', (h) => {
  test('starts, reads the selected project with every model down, reports why, and stops cleanly on SIGTERM', async () => {
    const w = world();
    const signals = new EventEmitter();
    const exits: number[] = [];
    const logs: { msg: string; extra?: Record<string, unknown> }[] = [];
    const { store, s } = keptOpen(h.store);
    const run = runWorker({ env: w.env, openStore: async () => store, log: (msg, extra) => { logs.push({ msg, extra: extra as Record<string, unknown> }); }, signals: signals as unknown as NodeJS.Process, exit: (c) => exits.push(c) });
    await until(() => logs.some((l) => l.msg === 'cycle' && l.extra?.filesIngested === 1), () => logs);
    // The next beat (a stage change beats within seconds) carries the cycle to /api/status.
    await until(async () => !!(await h.store.graph.workerStatus())?.lastError, () => logs);
    signals.emit('SIGTERM');
    await run;

    expect(exits).toEqual([0]);
    expect(s.closed).toBe(true);
    const msgs = logs.map((l) => l.msg);
    // Start-up passes before the first cycle.
    expect(msgs.indexOf('store')).toBe(0);
    expect(msgs.indexOf('redaction rules applied to stored data')).toBeLessThan(msgs.indexOf('cycle'));
    // A round under way when the signal came finishes; nothing starts after it, and the stop is last.
    expect(msgs.indexOf('shutting down')).toBeGreaterThan(msgs.indexOf('cycle'));
    expect(msgs.at(-1)).toBe('stopped');
    expect(await h.probe.count('Session')).toBe(1);
    // The flagged turn waits for the classifier (never charged), and /api/status says which model is down.
    const status = await h.store.graph.workerStatus();
    expect(status?.lastError).toMatch(/^classifier unavailable: /);
    expect((await h.store.graph.unclassifiedTurns(10)).map((t) => t.uuid)).toContain('u1');
  });

  test('a store that is down fails the start', async () => {
    const w = world();
    const run = runWorker({ env: w.env, openStore: async () => { throw new Error('ServiceUnavailable: connection refused'); }, log: () => {}, signals: new EventEmitter() as unknown as NodeJS.Process, exit: () => {} });
    await expect(run).rejects.toThrow('ServiceUnavailable');
  });
});
