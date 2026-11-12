import { expect, test, vi } from 'vitest';
import { readLoopBudget, type LlmProvider } from '@fb/core';
import { LoopBudgetGate, LoopBudgetSpent, meteredLlm } from './budget.ts';

const memory = () => {
  const m = new Map<string, string>();
  return { m, getCursor: async (k: string) => m.get(k) ?? null, setCursor: async (k: string, v: string) => { m.set(k, v); } };
};
const DAY = Date.parse('2026-11-11T10:00:00Z');

test('model calls: the day\'s budget is persisted, shared by concurrent calls, and resets the next day', async () => {
  const cursors = memory();
  let now = DAY;
  const gate = new LoopBudgetGate({ cursors, config: { llmCallsPerDay: 2, autoPerDay: 5, autoPerProject: 2 }, now: () => now });
  const results = await Promise.allSettled([gate.reserveLlmCall(), gate.reserveLlmCall(), gate.reserveLlmCall()]);
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
  expect((results[2] as PromiseRejectedResult).reason).toBeInstanceOf(LoopBudgetSpent);
  expect(gate.llmCalls).toBe(2);
  // Another gate (a restart) reads the same budget.
  const again = new LoopBudgetGate({ cursors, config: { llmCallsPerDay: 2, autoPerDay: 5, autoPerProject: 2 }, now: () => now });
  await expect(again.reserveLlmCall()).rejects.toThrow("the learning loop's 2 model calls for today are used");
  now += 86_400_000;
  await again.reserveLlmCall();
  expect((await readLoopBudget(cursors, now)).llmCalls).toBe(1);
});

test('auto-applies: capped per day and per project', async () => {
  const cursors = memory();
  const gate = new LoopBudgetGate({ cursors, config: { llmCallsPerDay: 0, autoPerDay: 3, autoPerProject: 2 }, now: () => DAY });
  expect(await gate.reserveAuto('a')).toBe(true);
  expect(await gate.reserveAuto('a')).toBe(true);
  expect(await gate.reserveAuto('a')).toBe(false);
  expect(await gate.reserveAuto(null)).toBe(true);
  expect(await gate.reserveAuto('b')).toBe(false);
  expect(await readLoopBudget(cursors, DAY)).toEqual({ day: '2026-11-11', llmCalls: 0, auto: 3, autoByProject: { a: 2, '': 1 } });
});

test('meteredLlm takes a call before each request and makes none over budget', async () => {
  const json = vi.fn(async () => ({ ok: true }));
  const p: LlmProvider = { id: 'ollama:x', agentic: false, json };
  const gate = new LoopBudgetGate({ cursors: memory(), config: { llmCallsPerDay: 1, autoPerDay: 0, autoPerProject: 0 }, now: () => DAY });
  const m = meteredLlm(p, gate);
  expect(m.id).toBe('ollama:x');
  expect(await m.json({ system: 's', user: 'u', schema: {} })).toEqual({ ok: true });
  await expect(m.json({ system: 's', user: 'u', schema: {} })).rejects.toBeInstanceOf(LoopBudgetSpent);
  expect(json).toHaveBeenCalledTimes(1);
});
