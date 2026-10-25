import { ModelOutputError, ProviderUnavailableError, type ChatAnswer, type ChatJob, type ChatTurn, type LlmProvider } from '@fb/core';
import { expect, test } from 'vitest';
import { ChatRunner, sharesModel, type ChatRunnerDeps } from './runner.ts';

const turn = (id: string, seq: number, role: ChatTurn['role'], status: ChatTurn['status']): ChatTurn => ({
  id, conversationId: 'chat-1', seq, role, text: role === 'user' ? 'q?' : '', status, error: null, answer: null, sources: [], provider: null, createdAt: 't', startedAt: null, finishedAt: null,
});
const job = (id = 'a1'): ChatJob => {
  const turns = [turn('u1', 1, 'user', 'done'), turn(id, 2, 'assistant', 'pending')];
  return { conversation: { id: 'chat-1', projectKey: 'demo-shop', title: 'x', provider: 'local', createdAt: 't', updatedAt: 't', pending: true, turns }, turn: turns[1], question: turns[0], context: 'pack' };
};
const answer: ChatAnswer = { answer: 'a [S1]', examples: [], prompt: 'p' };
const llm = (id = 'ollama:gemma4'): LlmProvider => ({ id, agentic: false, json: async () => ({}) });

/** A store holding a queue of jobs, recording every transition. */
function setup(o: Partial<ChatRunnerDeps> = {}, jobs: ChatJob[] = [job()]) {
  const events: string[] = [];
  const queue = [...jobs];
  const deps: ChatRunnerDeps = {
    store: {
      nextPendingTurn: async () => queue[0] ?? null,
      markAnswering: async (id, p) => { events.push(`answering ${id} ${p}`); queue.shift(); return true; },
      saveAnswer: async (id, a) => { events.push(`done ${id} ${a.answer}`); return true; },
      failTurn: async (id, e) => { events.push(`failed ${id} ${e}`); queue.shift(); return true; },
      requeueStaleTurns: async () => { events.push('requeue'); return 0; },
    },
    provider: () => ({ llm: llm(), spec: 'ollama:gemma4' }),
    answer: async () => answer,
    timeoutMs: 1000,
    log: () => {},
    ...o,
  };
  return { runner: new ChatRunner(deps), events, queue };
}

test('a pending turn is claimed for its provider, answered and saved; with nothing queued a tick does nothing', async () => {
  const { runner, events } = setup();
  expect(await runner.tick()).toBe(true);
  expect(events).toEqual(['answering a1 ollama:gemma4', 'done a1 a [S1]']);
  expect(await runner.tick()).toBe(false);
  expect(events).toHaveLength(2);
});

test('one at a time: a tick while an answer is running starts nothing, and running() names its provider', async () => {
  let release!: () => void;
  const { runner, events } = setup({ answer: () => new Promise((r) => { release = () => r(answer); }) }, [job('a1'), job('a2')]);
  const first = runner.tick();
  await new Promise((r) => setTimeout(r, 5));
  expect(runner.running()).toBe('ollama:gemma4');
  expect(await runner.tick()).toBe(false);
  release();
  await first;
  expect(runner.running()).toBeNull();
  expect(events).toEqual(['answering a1 ollama:gemma4', 'done a1 a [S1]']);
});

test('a provider that cannot be built fails the turn with the reason, and nothing is retried', async () => {
  const { runner, events } = setup({ provider: () => ({ llm: null, spec: 'claude-cli', reason: 'CLAUDE_CODE_OAUTH_TOKEN is not set' }) });
  await runner.tick();
  expect(events).toEqual(['failed a1 model unavailable: claude-cli: CLAUDE_CODE_OAUTH_TOKEN is not set']);
  expect(await runner.tick()).toBe(false);
});

test('an unavailable model, an unusable answer and any other error each fail the turn with a plain reason', async () => {
  const unavailable = setup({ answer: async () => { throw new ProviderUnavailableError('claude is not signed in (401)'); } });
  await unavailable.runner.tick();
  expect(unavailable.events.at(-1)).toBe('failed a1 model unavailable: claude is not signed in (401)');
  const bad = setup({ answer: async () => { throw new ModelOutputError('the answer did not match the schema: prompt: Required', '{"answer":"x"}'); } });
  await bad.runner.tick();
  expect(bad.events.at(-1)).toMatch(/^failed a1 the model's answer could not be used: the answer did not match the schema/);
  const key = `ghp_${'E'.repeat(36)}`;
  const boom = setup({ answer: async () => { throw new Error(`claude exit 1: failed with ${key}`); } });
  await boom.runner.tick();
  expect(boom.events.at(-1)).toMatch(/^failed a1 claude exit 1/);
  expect(boom.events.at(-1)).not.toContain(key);
});

test('an answer that takes longer than the timeout fails the turn', async () => {
  const { runner, events } = setup({ timeoutMs: 20, answer: () => new Promise(() => {}) });
  await runner.tick();
  expect(events.at(-1)).toBe('failed a1 no answer within 0 s: try again, or pick a faster model for this chat');
});

test('a turn claimed by someone else meanwhile is skipped', async () => {
  const { runner, events, queue } = setup({});
  runner['d'].store.markAnswering = async () => { queue.shift(); return false; };
  expect(await runner.tick()).toBe(true);
  expect(events).toEqual([]);
});

test('start requeues turns a dead worker left answering, then polls; stop waits for the answer in hand', async () => {
  const { runner, events } = setup({ intervalMs: 5 });
  await runner.start();
  await new Promise((r) => setTimeout(r, 30));
  await runner.stop();
  expect(events).toEqual(['requeue', 'answering a1 ollama:gemma4', 'done a1 a [S1]']);
});

test('a running chat makes another job\'s model busy when they share it: the same provider, or any two models on the one Ollama', () => {
  expect(sharesModel('ollama:gemma4', 'ollama:gemma4')).toBe(true);
  expect(sharesModel('ollama:qwen3', 'ollama:gemma4')).toBe(true);
  expect(sharesModel('claude-cli', 'claude-cli')).toBe(true);
  expect(sharesModel('claude-cli', 'ollama:gemma4')).toBe(false);
  expect(sharesModel(null, 'ollama:gemma4')).toBe(false);
  expect(sharesModel('ollama:gemma4', undefined)).toBe(false);
});

test('a turn that timed out is failed at once, but its model stays busy (and nothing new starts) until the call really ends', async () => {
  let release!: () => void;
  const { runner, events } = setup({ timeoutMs: 40, answer: () => new Promise((r) => { release = () => r(answer); }) }, [job('a1'), job('a2')]);
  const first = runner.tick();
  await new Promise((r) => setTimeout(r, 60));
  expect(events).toContain('failed a1 no answer within 0 s: try again, or pick a faster model for this chat');
  // The call under the timeout is still running on the model: the runner says so and takes nothing else.
  expect(runner.running()).toBe('ollama:gemma4');
  expect(await runner.tick()).toBe(false);
  release();
  await first;
  expect(runner.running()).toBeNull();
  expect(events.filter((e) => e.startsWith('done'))).toEqual([]);
});
