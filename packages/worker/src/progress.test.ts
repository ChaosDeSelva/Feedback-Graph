import type { ProviderHealth, WorkerStatus } from '@fb/core';
import { expect, test } from 'vitest';
import { healthSince, StageTracker } from './progress.ts';

const blank = (): WorkerStatus => ({ version: 't', startedAt: 't', lastBeat: 't', lastCycleAt: null, lastCycle: null, lastError: null, providers: {} });

function clock(start = Date.parse('2026-10-24T10:00:00Z')) {
  let t = start;
  return { now: () => new Date(t), tick: (ms: number) => (t += ms) };
}

test('a stage says its name, when it started, its counts and the item in hand; each change is announced', () => {
  const status = blank();
  const c = clock();
  let changes = 0;
  const s = new StageTracker(status, () => changes++, c.now);
  s.enter('classify', { total: 3 });
  expect(status.stage).toEqual({ name: 'classify', startedAt: '2026-10-24T10:00:00.000Z', done: 0, total: 3, current: null });
  c.tick(5000);
  s.step('turn-1');
  s.step('turn-2');
  expect(status.stage).toEqual({ name: 'classify', startedAt: '2026-10-24T10:00:00.000Z', done: 2, total: 3, current: 'turn-2' });
  expect(changes).toBe(3);
});

test('a stage without a total counts its items alone; entering the same stage again starts it over', () => {
  const status = blank();
  const c = clock();
  const s = new StageTracker(status, () => {}, c.now);
  s.enter('ingest');
  s.step('a.jsonl');
  expect(status.stage).toMatchObject({ name: 'ingest', done: 1, total: null, current: 'a.jsonl' });
  c.tick(1000);
  s.enter('scan', { current: 'demo-shop' });
  expect(status.stage).toEqual({ name: 'scan', startedAt: '2026-10-24T10:00:01.000Z', done: null, total: null, current: 'demo-shop' });
  s.step('demo-shop'); // a step in a stage without counts only moves the current item
  expect(status.stage).toMatchObject({ done: null, current: 'demo-shop' });
});

test('waiting keeps the time it started while the worker stays idle', () => {
  const status = blank();
  const c = clock();
  const s = new StageTracker(status, () => {}, c.now);
  s.enter('waiting');
  c.tick(30_000);
  s.enter('waiting');
  expect(status.stage?.startedAt).toBe('2026-10-24T10:00:00.000Z');
});

const h = (ok: boolean, at: string, reason: string | null = ok ? null : 'connection refused'): ProviderHealth => ({ provider: 'ollama:gemma4', ok, reason, at });

test('healthSince: a run of failures keeps when it began; an answer clears it', () => {
  const first = healthSince(undefined, h(false, '10:00'));
  expect(first).toEqual({ ...h(false, '10:00'), since: '10:00' });
  const second = healthSince(first, h(false, '10:05', 'timed out'));
  expect(second).toEqual({ ...h(false, '10:05', 'timed out'), since: '10:00' });
  const ok = healthSince(second, h(true, '10:10'));
  expect(ok).toEqual(h(true, '10:10'));
  expect(healthSince(ok, h(false, '10:20')).since).toBe('10:20');
});

test('healthSince: a different provider for the job starts a new run', () => {
  const before = healthSince(undefined, h(false, '10:00'));
  const other = healthSince(before, { provider: 'claude-cli', ok: false, reason: 'not signed in', at: '10:01' });
  expect(other.since).toBe('10:01');
});
