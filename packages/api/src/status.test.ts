import type { WorkerStatus } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as ApiRepo;
const beat = (ago: number): WorkerStatus => ({
  version: '0.2.0', startedAt: 't', lastBeat: new Date(Date.now() - ago).toISOString(), lastCycleAt: null, lastCycle: null, lastError: null, providers: { classify: 'ollama:gemma4' },
});

test('status reports the graph, the worker heartbeat and whether sign-in is needed', async () => {
  const app = createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => beat(10_000) } });
  const s = await (await app.request('/api/status')).json();
  expect(s).toMatchObject({ version: '0.2.0', graph: true, workerHealthy: true, authRequired: false });
  expect(s.worker.providers.classify).toBe('ollama:gemma4');
});

test('a worker silent for more than 3 minutes is reported unhealthy', async () => {
  const app = createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => beat(4 * 60_000) } });
  expect((await (await app.request('/api/status')).json()).workerHealthy).toBe(false);
});

test('readiness fails while the graph is unreachable', async () => {
  const down = createApp(repo, { system: { version: '0.2.0', ping: async () => false, worker: async () => null } });
  expect((await down.request('/api/ready')).status).toBe(503);
  const up = createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => null } });
  expect((await up.request('/api/ready')).status).toBe(200);
});

test('status and readiness say which store the tool runs on', async () => {
  for (const store of ['neo4j', 'postgres'] as const) {
    const app = createApp(repo, { system: { version: '0.2.0', store, ping: async () => true, worker: async () => null } });
    expect((await (await app.request('/api/status')).json()).store).toBe(store);
    expect(await (await app.request('/api/ready')).json()).toEqual({ ok: true, store });
  }
  const down = createApp(repo, { system: { version: '0.2.0', store: 'postgres', ping: async () => false, worker: async () => null } });
  expect(await (await down.request('/api/ready')).json()).toEqual({ ok: false, store: 'postgres' });
});

test('status says which model is unavailable and why, and how many turns the classifier gave up on', async () => {
  const w: WorkerStatus = {
    ...beat(10_000),
    providers: { classify: 'ollama:gemma4', postmortem: 'claude-cli', scan: 'ollama:gemma4' },
    health: {
      classify: { provider: 'ollama:gemma4', ok: false, reason: 'model not found (ollama 404)', at: 't' },
      postmortem: { provider: 'claude-cli', ok: true, reason: null, at: 't' },
    },
  };
  const app = createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => w, givenUpTurns: async () => 7 } });
  const s = await (await app.request('/api/status')).json();
  expect(s.models).toEqual({
    classify: { provider: 'ollama:gemma4', ok: false, reason: 'model not found (ollama 404)', since: 't', checkedAt: 't' },
    postmortem: { provider: 'claude-cli', ok: true, reason: null },
    scan: { provider: 'ollama:gemma4', ok: true, reason: null },
    summary: { provider: null, ok: true, reason: null },
    // A worker from before the docs reader (or Ask) does not report one: unknown, not broken.
    docs: { provider: null, ok: true, reason: null },
    chat: { provider: null, ok: true, reason: null },
  });
  expect(s.givenUpTurns).toBe(7);
});

test("the Ask model is a job of its own: the worker reports its default provider and how it last fared", async () => {
  const w: WorkerStatus = {
    ...beat(10_000),
    providers: { classify: 'ollama:gemma4', chat: 'claude-cli' },
    health: { chat: { provider: 'claude-cli', ok: false, reason: 'claude is not signed in (401)', at: 't' } },
  };
  const app = createApp(repo, { system: { version: '0.5.0', ping: async () => true, worker: async () => w } });
  const s = await (await app.request('/api/status')).json();
  expect(s.models.chat).toEqual({ provider: 'claude-cli', ok: false, reason: 'claude is not signed in (401)', since: 't', checkedAt: 't' });
});

test('a worker that runs without a classifier reports it unavailable; no worker reports no model health', async () => {
  const none = createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => ({ ...beat(10_000), providers: { classify: null } }) } });
  const s = await (await none.request('/api/status')).json();
  expect(s.models.classify).toEqual({ provider: null, ok: false, reason: 'no classifier is configured (see the worker log)' });
  expect(s.givenUpTurns).toBeNull();
  const off = createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => null } });
  expect((await (await off.request('/api/status')).json()).models).toBeNull();
});

test('status reports whether Ollama answers; an Ollama job is unavailable while it does not, even before it was asked', async () => {
  const w: WorkerStatus = { ...beat(10_000), providers: { classify: 'ollama:gemma4', postmortem: 'claude-cli', scan: 'ollama:gemma4' } };
  const down = { url: 'http://host.docker.internal:11434', ok: false, reason: 'Ollama is not reachable at http://host.docker.internal:11434: start it' };
  const app = createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => w, ollama: async () => down } });
  const s = await (await app.request('/api/status')).json();
  expect(s.ollama).toEqual(down);
  expect(s.models).toEqual({
    classify: { provider: 'ollama:gemma4', ok: false, reason: down.reason },
    postmortem: { provider: 'claude-cli', ok: true, reason: null },
    scan: { provider: 'ollama:gemma4', ok: false, reason: down.reason },
    summary: { provider: null, ok: true, reason: null },
    docs: { provider: null, ok: true, reason: null },
    chat: { provider: null, ok: true, reason: null },
  });
  const up = createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => w, ollama: async () => ({ ...down, ok: true, reason: null }) } });
  const u = await (await up.request('/api/status')).json();
  expect(u.ollama.ok).toBe(true);
  expect(u.models.classify).toEqual({ provider: 'ollama:gemma4', ok: true, reason: null });
  const unknown = createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => w } });
  expect((await (await unknown.request('/api/status')).json()).ollama).toBeNull();
});

test('status lists the summary model: its health, paused when it cannot be built, and off when SUMMARY_LLM=off', async () => {
  const at = (w: Partial<WorkerStatus>) => createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => ({ ...beat(10_000), ...w }) } });
  const models = async (w: Partial<WorkerStatus>) => (await (await at(w).request('/api/status')).json()).models;
  expect((await models({ providers: { classify: 'ollama:gemma4', summary: 'ollama:gemma4' } })).summary).toEqual({ provider: 'ollama:gemma4', ok: true, reason: null });
  const down = await models({
    providers: { classify: 'ollama:gemma4', summary: 'claude-cli' },
    health: { summary: { provider: 'claude-cli', ok: false, reason: 'claude is not signed in', at: 't' } },
  });
  expect(down.summary).toEqual({ provider: 'claude-cli', ok: false, reason: 'claude is not signed in', since: 't', checkedAt: 't' });
  // Enabled, but the provider could not be built: summaries are paused, and that is not "off".
  expect((await models({ providers: { classify: 'ollama:gemma4', summary: null } })).summary)
    .toEqual({ provider: null, ok: false, reason: 'no summary model could be built (SUMMARY_LLM; see the worker log): summaries are paused' });
  expect((await models({ providers: { classify: 'ollama:gemma4', summary: null }, off: ['summary'] })).summary).toEqual({ provider: null, ok: true, reason: null, off: true });
  // While Ollama is down, an Ollama summary model is paused too.
  const ollamaDown = { url: 'http://o', ok: false, reason: 'Ollama is not reachable at http://o: start it' };
  const app = createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => ({ ...beat(10_000), providers: { classify: 'claude-cli', summary: 'ollama:gemma4' } }), ollama: async () => ollamaDown } });
  expect((await (await app.request('/api/status')).json()).models.summary).toEqual({ provider: 'ollama:gemma4', ok: false, reason: ollamaDown.reason });
});

test('status says what the worker is doing: the step, since when, the item in hand, and done of total', async () => {
  const w: WorkerStatus = { ...beat(10_000), stage: { name: 'classify', startedAt: '2026-10-24T10:00:00.000Z', done: 3, total: 50, current: 'turn-9' } };
  const s = await (await createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => w } }).request('/api/status')).json();
  expect(s.stage).toEqual({ name: 'classify', startedAt: '2026-10-24T10:00:00.000Z', current: 'turn-9' });
  expect(s.progress).toEqual({ done: 3, total: 50 });
  // A step that does not count items has no progress; an offline worker has neither.
  const scan: WorkerStatus = { ...beat(10_000), stage: { name: 'scan', startedAt: 't', done: null, total: null, current: 'demo-shop' } };
  const s2 = await (await createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => scan } }).request('/api/status')).json();
  expect(s2.progress).toBeNull();
  const stale = await (await createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => ({ ...w, lastBeat: beat(4 * 60_000).lastBeat }) } }).request('/api/status')).json();
  expect([stale.stage, stale.progress]).toEqual([null, null]);
  // An older worker does not say.
  const old = await (await createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => beat(10_000) } }).request('/api/status')).json();
  expect([old.stage, old.progress]).toEqual([null, null]);
});

test('an unavailable model says since when; a later answer from the same provider (another job) clears the stale reason', async () => {
  const w: WorkerStatus = {
    ...beat(10_000),
    providers: { classify: 'ollama:gemma4', postmortem: 'claude-cli', scan: 'ollama:gemma4', summary: 'ollama:gemma4' },
    health: {
      summary: { provider: 'ollama:gemma4', ok: false, reason: 'Ollama is not reachable: connect ECONNREFUSED', at: '2026-10-24T10:00:00.000Z', since: '2026-10-24T09:40:00.000Z' },
      classify: { provider: 'ollama:gemma4', ok: true, reason: null, at: '2026-10-24T10:05:00.000Z' },
      postmortem: { provider: 'claude-cli', ok: false, reason: 'claude is not signed in', at: '2026-10-24T10:06:00.000Z', since: '2026-10-24T10:01:00.000Z' },
    },
  };
  const s = await (await createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => w } }).request('/api/status')).json();
  expect(s.models.summary).toEqual({ provider: 'ollama:gemma4', ok: true, reason: null });
  expect(s.models.postmortem).toEqual({ provider: 'claude-cli', ok: false, reason: 'claude is not signed in', since: '2026-10-24T10:01:00.000Z', checkedAt: '2026-10-24T10:06:00.000Z' });
});

test('a connection failure to Ollama is re-checked on read: Ollama answering now clears it; other reasons stay', async () => {
  const w = (reason: string): WorkerStatus => ({
    ...beat(10_000),
    providers: { classify: 'ollama:gemma4', summary: 'ollama:gemma4' },
    health: { summary: { provider: 'ollama:gemma4', ok: false, reason, at: 't' } },
  });
  const up = { url: 'http://o', ok: true, reason: null };
  const read = async (reason: string) =>
    (await (await createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => w(reason), ollama: async () => up } }).request('/api/status')).json()).models.summary;
  expect(await read('connect ECONNREFUSED 192.168.65.254:11434')).toEqual({ provider: 'ollama:gemma4', ok: true, reason: null });
  expect(await read('Ollama is not reachable at http://o: start it')).toEqual({ provider: 'ollama:gemma4', ok: true, reason: null });
  expect((await read('structured output is unavailable (ollama 501)')).ok).toBe(false);
});

test('status names the check_before_done judge model', async () => {
  const app = createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => null }, context: { judgeId: 'ollama:gemma4', k: {} } as never });
  expect((await (await app.request('/api/status')).json()).judge).toBe('ollama:gemma4');
});
