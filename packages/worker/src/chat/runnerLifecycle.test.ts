import type { ChatAnswer, ChatJob, ChatTurn, LlmProvider } from '@fb/core';
import { expect, test } from 'vitest';
import { ChatRunner, type ChatRunnerDeps } from './runner.ts';

const turn = (id: string, seq: number, role: ChatTurn['role']): ChatTurn => ({
  id, conversationId: 'chat-1', seq, role, text: 'q?', status: role === 'user' ? 'done' : 'pending', error: null, answer: null, sources: [], provider: null, createdAt: 't', startedAt: null, finishedAt: null,
});
const job = (): ChatJob => {
  const turns = [turn('u1', 1, 'user'), turn('a1', 2, 'assistant')];
  return { conversation: { id: 'chat-1', projectKey: 'demo', title: 'x', provider: 'local', createdAt: 't', updatedAt: 't', pending: true, turns }, turn: turns[1], question: turns[0], context: 'pack' };
};
const answer: ChatAnswer = { answer: 'a', examples: [], prompt: 'p' };
const llm: LlmProvider = { id: 'ollama:gemma4', agentic: false, json: async () => ({}) };

/** The worker's wiring: no lane, interval or timeout of its own. */
function setup(o: Partial<ChatRunnerDeps> = {}, requeued = 0) {
  const events: string[] = [];
  const logs: [string, object | undefined][] = [];
  let queue: ChatJob[] = [job()];
  const deps: ChatRunnerDeps = {
    store: {
      pendingTurns: async () => { events.push('poll'); return queue.map((j) => ({ id: j.turn.id, conversationId: j.conversation.id, provider: j.conversation.provider, createdAt: 't' })); },
      nextPendingTurn: async () => queue[0] ?? null,
      setQueueAhead: async () => {},
      markAnswering: async (id) => { events.push(`answering ${id}`); queue = []; return true; },
      saveAnswer: async (id) => { events.push(`done ${id}`); return true; },
      failTurn: async (id, e) => { events.push(`failed ${id} ${e}`); queue = []; return true; },
      requeueStaleTurns: async () => requeued,
    },
    provider: () => ({ llm, spec: 'ollama:gemma4' }),
    answer: async () => answer,
    log: (m, x) => logs.push([m, x]),
    ...o,
  };
  return { runner: new ChatRunner(deps), store: deps.store, events, logs };
}
const until = async (cond: () => boolean) => { while (!cond()) await new Promise((r) => setTimeout(r, 5)); };

test('turns a dead worker left answering are logged as requeued at start, and the queue is then answered with the default timeout', async () => {
  const s = setup({}, 2);
  await s.runner.start();
  await until(() => s.events.includes('done a1'));
  await s.runner.stop();
  expect(s.logs[0]).toEqual(['chat: turns left answering went back to the queue', { turns: 2 }]);
  expect(s.events).toEqual(['poll', 'answering a1', 'done a1']);
});

test('stopped before its first look at the queue, the runner never reads it', async () => {
  const s = setup();
  await s.runner.start();
  await s.runner.stop();
  await new Promise((r) => setTimeout(r, 20));
  expect(s.events).toEqual([]);
  expect(await s.runner.tick()).toBe(false);
});

test('stopped while claiming a question, the runner leaves it waiting for the next start', async () => {
  const s = setup();
  // The store answers the claim only after the worker began shutting down.
  s.store.nextPendingTurn = async () => { void s.runner.stop(); return job(); };
  expect(await s.runner.tick()).toBe(false);
  expect(s.events).toEqual(['poll']);
});

test('a model that cannot be built, with no reason given, fails the turn naming the model', async () => {
  const s = setup({ provider: () => ({ llm: null, spec: 'openai:gpt-x' }) });
  await s.runner.tick();
  expect(s.events).toContain('failed a1 model unavailable: openai:gpt-x');
});

test('an answer that fails with something other than an Error is stored as what was thrown', async () => {
  const s = setup({ answer: () => Promise.reject('socket hang up') });
  await s.runner.tick();
  await s.runner.settled();
  expect(s.events).toContain('failed a1 socket hang up');
});
