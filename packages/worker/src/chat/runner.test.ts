import { ModelOutputError, ProviderUnavailableError, type ChatAnswer, type ChatConversation, type ChatJob, type ChatTurn, type LlmProvider } from '@fb/core';
import { expect, test } from 'vitest';
import { ChatRunner, laneOf, sharesModel, type ChatRunnerDeps } from './runner.ts';

const turn = (id: string, seq: number, role: ChatTurn['role'], status: ChatTurn['status']): ChatTurn => ({
  id, conversationId: 'chat-1', seq, role, text: role === 'user' ? 'q?' : '', status, error: null, answer: null, sources: [], provider: null, createdAt: 't', startedAt: null, finishedAt: null,
});
const job = (id = 'a1', provider: ChatConversation['provider'] = 'local'): ChatJob => {
  const turns = [turn('u1', 1, 'user', 'done'), turn(id, 2, 'assistant', 'pending')];
  return { conversation: { id: `chat-${id}`, projectKey: 'demo-shop', title: 'x', provider, createdAt: 't', updatedAt: 't', pending: true, turns }, turn: turns[1], question: turns[0], context: 'pack' };
};
const answer: ChatAnswer = { answer: 'a [S1]', examples: [], prompt: 'p' };
const llm = (id = 'ollama:gemma4'): LlmProvider => ({ id, agentic: false, json: async () => ({}) });
/** Each chat provider's model, as the worker builds it: local is the one Ollama, claude and codex their CLIs. */
const SPECS: Record<string, string> = { local: 'ollama:gemma4', claude: 'claude-cli', codex: 'codex-cli' };

/** A store holding a queue of jobs, recording every transition and every queue position written. */
function setup(o: Partial<ChatRunnerDeps> = {}, jobs: ChatJob[] = [job()]) {
  const events: string[] = [];
  const positions = new Map<string, number>();
  const queue = [...jobs];
  const take = (id: string) => { const i = queue.findIndex((j) => j.turn.id === id); if (i >= 0) queue.splice(i, 1); };
  const deps: ChatRunnerDeps = {
    store: {
      pendingTurns: async () => queue.map((j) => ({ id: j.turn.id, conversationId: j.conversation.id, provider: j.conversation.provider, createdAt: 't' })),
      nextPendingTurn: async (q) => queue.find((j) => !q?.id || j.turn.id === q.id) ?? null,
      setQueueAhead: async (u) => { for (const x of u) positions.set(x.id, x.ahead); },
      markAnswering: async (id, p) => { events.push(`answering ${id} ${p}`); take(id); return true; },
      saveAnswer: async (id, a) => { events.push(`done ${id} ${a.answer}`); return true; },
      failTurn: async (id, e) => { events.push(`failed ${id} ${e}`); take(id); return true; },
      requeueStaleTurns: async () => { events.push('requeue'); return 0; },
    },
    provider: (c) => ({ llm: llm(SPECS[c.provider ?? 'local']), spec: SPECS[c.provider ?? 'local'] }),
    lane: (p) => SPECS[p ?? 'local'],
    answer: async () => answer,
    timeoutMs: 1000,
    log: () => {},
    ...o,
  };
  return { runner: new ChatRunner(deps), events, queue, positions };
}

/** A gate per turn: its answer waits until released. */
function gated() {
  const gates = new Map<string, () => void>();
  const answer$ = (j: ChatJob) => new Promise<ChatAnswer>((r) => gates.set(j.turn.id, () => r(answer)));
  return { answer: answer$, release: (id: string) => gates.get(id)!() };
}
const later = () => new Promise((r) => setTimeout(r, 5));

test('questions to different models are answered at the same time, one per model; the rest wait, each told how many are ahead of it', async () => {
  const g = gated();
  const { runner, events, positions } = setup({ answer: g.answer }, [job('a1', 'claude'), job('a2', 'claude'), job('a3', 'local'), job('a4', 'claude')]);
  expect(await runner.tick()).toBe(true);
  await later();
  expect(events).toEqual(['answering a1 claude-cli', 'answering a3 ollama:gemma4']);
  expect(runner.running().sort()).toEqual(['claude-cli', 'ollama:gemma4']);
  // a2 waits behind a1 (answering); a4 behind a1 and a2.
  expect(Object.fromEntries(positions)).toEqual({ a2: 1, a4: 2 });
  g.release('a1');
  await later();
  await runner.tick();
  await later();
  expect(events).toContain('answering a2 claude-cli');
  expect(positions.get('a4')).toBe(1);
  g.release('a2');
  g.release('a3');
  await later();
  await runner.tick();
  await later();
  g.release('a4');
  await runner.settled();
  expect(events.filter((e) => e.startsWith('done')).sort()).toEqual(['done a1 a [S1]', 'done a2 a [S1]', 'done a3 a [S1]', 'done a4 a [S1]']);
  expect(runner.running()).toEqual([]);
});

test('a pending turn is claimed for its provider, answered and saved; with nothing queued a tick does nothing', async () => {
  const { runner, events } = setup();
  expect(await runner.tick()).toBe(true);
  await runner.settled();
  expect(events).toEqual(['answering a1 ollama:gemma4', 'done a1 a [S1]']);
  expect(await runner.tick()).toBe(false);
  expect(events).toHaveLength(2);
});

test('one at a time per model: a tick while its answer is running starts nothing on it, and running() names its provider', async () => {
  let release!: () => void;
  const { runner, events } = setup({ answer: () => new Promise((r) => { release = () => r(answer); }) }, [job('a1'), job('a2')]);
  await runner.tick();
  await new Promise((r) => setTimeout(r, 5));
  expect(runner.running()).toEqual(['ollama:gemma4']);
  expect(await runner.tick()).toBe(false);
  release();
  await runner.settled();
  expect(runner.running()).toEqual([]);
  expect(events).toEqual(['answering a1 ollama:gemma4', 'done a1 a [S1]']);
});

test('without a lane for each provider every question shares one line, as before', async () => {
  let release!: () => void;
  const { runner, events } = setup({ lane: undefined, answer: () => new Promise((r) => { release = () => r(answer); }) }, [job('a1', 'claude'), job('a2', 'local')]);
  await runner.tick();
  await new Promise((r) => setTimeout(r, 5));
  expect(events).toEqual(['answering a1 claude-cli']);
  release();
  await runner.settled();
});

test('a provider that cannot be built fails the turn with the reason, and nothing is retried', async () => {
  const { runner, events } = setup({ provider: () => ({ llm: null, spec: 'claude-cli', reason: 'CLAUDE_CODE_OAUTH_TOKEN is not set' }) });
  await runner.tick();
  await runner.settled();
  expect(events).toEqual(['failed a1 model unavailable: claude-cli: CLAUDE_CODE_OAUTH_TOKEN is not set']);
  expect(await runner.tick()).toBe(false);
});

test('an unavailable model, an unusable answer and any other error each fail the turn with a plain reason', async () => {
  const unavailable = setup({ answer: async () => { throw new ProviderUnavailableError('claude is not signed in (401)'); } });
  await unavailable.runner.tick();
  await unavailable.runner.settled();
  expect(unavailable.events.at(-1)).toBe('failed a1 model unavailable: claude is not signed in (401)');
  const bad = setup({ answer: async () => { throw new ModelOutputError('the answer did not match the schema: prompt: Required', '{"answer":"x"}'); } });
  await bad.runner.tick();
  await bad.runner.settled();
  expect(bad.events.at(-1)).toMatch(/^failed a1 the model's answer could not be used: the answer did not match the schema/);
  const key = `ghp_${'E'.repeat(36)}`;
  const boom = setup({ answer: async () => { throw new Error(`claude exit 1: failed with ${key}`); } });
  await boom.runner.tick();
  await boom.runner.settled();
  expect(boom.events.at(-1)).toMatch(/^failed a1 claude exit 1/);
  expect(boom.events.at(-1)).not.toContain(key);
});

test('an answer that takes longer than the timeout fails the turn', async () => {
  const { runner, events } = setup({ timeoutMs: 20, answer: () => new Promise(() => {}) });
  await runner.tick();
  await new Promise((r) => setTimeout(r, 40));
  expect(events.at(-1)).toBe('failed a1 no answer within 0 s: try again, or pick a faster model for this chat');
});

test('a turn claimed by someone else meanwhile is skipped', async () => {
  const { runner, events, queue } = setup({});
  runner['d'].store.markAnswering = async () => { queue.shift(); return false; };
  expect(await runner.tick()).toBe(false);
  await runner.settled();
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
  await runner.tick();
  await new Promise((r) => setTimeout(r, 60));
  expect(events).toContain('failed a1 no answer within 0 s: try again, or pick a faster model for this chat');
  // The call under the timeout is still running on the model: the runner says so and takes nothing else.
  expect(runner.running()).toEqual(['ollama:gemma4']);
  expect(await runner.tick()).toBe(false);
  release();
  await runner.settled();
  expect(runner.running()).toEqual([]);
  expect(events.filter((e) => e.startsWith('done'))).toEqual([]);
});

test('a line per provider; every Ollama model shares one (the one Ollama runs one generation at a time)', () => {
  expect(laneOf('claude-cli')).toBe('claude-cli');
  expect(laneOf('claude-cli:opus')).toBe('claude-cli');
  expect(laneOf('codex-cli')).toBe('codex-cli');
  expect(laneOf('anthropic:claude-x')).toBe('anthropic');
  expect(laneOf('ollama:gemma4')).toBe(laneOf('ollama:qwen3'));
});
