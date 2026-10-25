import { shownProjects, type ActivityInput, type Project } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const OP = 'o'.repeat(32);
const dirs: Project[] = ['acme', 'demo-shop', 'unpicked'].map((key) => ({ key, name: key, repoPath: `/vibe/${key}` }));

function setup() {
  const scans: [string, string | null][] = [];
  const decided: unknown[][] = [];
  const logged: ActivityInput[] = [];
  const repo = {
    listCandidates: async () => [], stats: async () => [],
    decide: async (...a: unknown[]) => { decided.push(a); },
    candidateDetail: async (id: string) =>
      id.startsWith('c') ? { candidate: { id, projectKey: id === 'c-hidden' ? 'unpicked' : 'acme', classification: { label: 'pushback', confidence: 0.8 } }, turn: { text: 'nope' }, before: [], after: [], commits: [] } : null,
  } as unknown as ApiRepo;
  const app = createApp(repo, {
    auth: { operator: { token: OP, allow: ['scan', 'inbox_decide'] } },
    activity: { record: async (e: ActivityInput) => { logged.push(e); }, list: async () => [] },
    facts: {
      listProjects: async () => [], listFacts: async () => [], searchFacts: async () => [],
      requestScan: async (p: Project, provider: string | null) => { scans.push([p.key, provider]); return { id: `scan:${p.key}`, projectKey: p.key, status: 'queued' }; },
    } as never,
    projectDirs: async () => dirs,
    shown: () => shownProjects({ tracked: ['acme', 'demo-shop'], initialized: true }, { excludeProjects: [] }),
  });
  return { app, scans, decided, logged };
}

const post = (path: string, body: object, auth = true) => ({
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${OP}`, 'x-fg-operator': 'codex' } : {}) },
});

test('POST /api/projects/scan with all queues every selected folder and skips the rest', async () => {
  const { app, scans } = setup();
  const res = await app.request('/api/projects/scan', post('/api/projects/scan', { all: true, provider: 'codex-cli' }));
  expect(res.status).toBe(202);
  const { results } = await res.json();
  expect(results).toEqual([
    expect.objectContaining({ key: 'acme', queued: true, job: expect.objectContaining({ id: 'scan:acme' }) }),
    expect.objectContaining({ key: 'demo-shop', queued: true }),
  ]);
  expect(scans).toEqual([['acme', 'codex-cli'], ['demo-shop', 'codex-cli']]);
});

test('POST /api/projects/scan with keys says per key what happened', async () => {
  const { app, scans } = setup();
  const res = await app.request('/api/projects/scan', post('/api/projects/scan', { keys: ['demo-shop', 'unpicked', 'nowhere'] }));
  expect((await res.json()).results).toEqual([
    { key: 'demo-shop', queued: true, job: expect.anything() },
    { key: 'unpicked', queued: false, error: expect.stringMatching(/not selected/) },
    { key: 'nowhere', queued: false, error: expect.stringMatching(/no such folder/) },
  ]);
  expect(scans).toEqual([['demo-shop', null]]);
});

test('POST /api/projects/scan needs keys or all, and is owner-only', async () => {
  const { app } = setup();
  expect((await app.request('/api/projects/scan', post('/api/projects/scan', {}))).status).toBe(400);
  expect((await app.request('/api/projects/scan', post('/api/projects/scan', { keys: [] }))).status).toBe(400);
  expect((await app.request('/api/projects/scan', post('/api/projects/scan', { all: true }, false))).status).toBe(403);
});

test('POST /api/candidates/decisions decides each item like the single route and reports each', async () => {
  const { app, decided, logged } = setup();
  const res = await app.request('/api/candidates/decisions', post('/api/candidates/decisions', {
    items: [
      { id: 'c1', decision: 'confirm' },
      { id: 'c2', decision: 'reject', reason: 'the author fixing their own PR' },
      { id: 'missing', decision: 'confirm' },
      { id: 'c-hidden', decision: 'reject' },
    ],
  }));
  expect(res.status).toBe(200);
  expect((await res.json()).results).toEqual([
    { id: 'c1', ok: true, status: 'confirmed' },
    { id: 'c2', ok: true, status: 'rejected' },
    { id: 'missing', ok: false, error: 'not found' },
    { id: 'c-hidden', ok: false, error: 'not found' },
  ]);
  expect(decided).toEqual([['c1', 'confirmed', null], ['c2', 'rejected', 'the author fixing their own PR']]);
  expect(logged.map((e) => [e.kind, e.actor, e.targets])).toEqual([
    ['feedback_decided', 'operator:codex', ['c1']],
    ['feedback_decided', 'operator:codex', ['c2']],
  ]);
});

test('POST /api/candidates/decisions refuses a malformed batch outright', async () => {
  const { app, decided } = setup();
  expect((await app.request('/api/candidates/decisions', post('/api/candidates/decisions', { items: [] }))).status).toBe(400);
  expect((await app.request('/api/candidates/decisions', post('/api/candidates/decisions', { items: [{ id: 'c1', decision: 'maybe' }] }))).status).toBe(400);
  expect((await app.request('/api/candidates/decisions', post('/api/candidates/decisions', { items: [{ id: 'c1', decision: 'confirm' }] }, false))).status).toBe(403);
  expect(decided).toEqual([]);
});
