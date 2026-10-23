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
    classify: { provider: 'ollama:gemma4', ok: false, reason: 'model not found (ollama 404)' },
    postmortem: { provider: 'claude-cli', ok: true, reason: null },
    scan: { provider: 'ollama:gemma4', ok: true, reason: null },
  });
  expect(s.givenUpTurns).toBe(7);
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
  });
  const up = createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => w, ollama: async () => ({ ...down, ok: true, reason: null }) } });
  const u = await (await up.request('/api/status')).json();
  expect(u.ollama.ok).toBe(true);
  expect(u.models.classify).toEqual({ provider: 'ollama:gemma4', ok: true, reason: null });
  const unknown = createApp(repo, { system: { version: '0.2.0', ping: async () => true, worker: async () => w } });
  expect((await (await unknown.request('/api/status')).json()).ollama).toBeNull();
});
