import type { ProjectSummary } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const summary = (key: string, facts = 0, over: Partial<ProjectSummary> = {}): ProjectSummary => ({ key, repoPath: `/vibe/${key}`, remote: null, aliases: [], sessions: 2, feedback: 1, lessons: 1, facts, lastScan: null, pinned: false, ...over });

function setup(projects = [summary('alpha', 5)]) {
  const calls: unknown[][] = [];
  const facts = {
    listProjects: async () => projects,
    requestScan: async (p: object, provider: string | null) => { calls.push(['scan', p, provider]); return { id: 'scan:1', status: 'queued' } as never; },
    listFacts: async (q: object) => { calls.push(['list', q]); return []; },
    searchFacts: async (q: object) => { calls.push(['search', q]); return []; },
    setPinned: async (p: object, pinned: boolean) => { calls.push(['pin', p, pinned]); },
    setFactRelevance: async (u: { id: string }[]) => { calls.push(['relevance', u]); return u[0]?.id === 'missing' ? 0 : u.length; },
  };
  const activity: { kind: string; subject: string }[] = [];
  const app = createApp(repo, {
    facts,
    embed: async (t) => t.map(() => [1]),
    projectDirs: async () => [{ key: 'alpha', name: 'alpha', repoPath: '/vibe/alpha' }, { key: 'beta', name: 'beta', repoPath: '/vibe/beta' }],
    activity: { record: async (a) => { activity.push(a); }, list: async () => [] },
  });
  return { app, calls, activity };
}

const json = (method: string, body: object) => ({ method, headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(body) });

test('GET /api/projects merges graph projects with local folders that have no data yet', async () => {
  const { app } = setup();
  const list = (await (await app.request('/api/projects')).json()) as ProjectSummary[];
  expect(list.map((p) => [p.key, p.facts])).toEqual([['alpha', 5], ['beta', 0]]);
});

test('GET /api/projects shows each remote, and a folder that is a clone of a project is not listed on its own', async () => {
  const { app } = setup([summary('alpha', 5, { remote: 'github.com/org/alpha', aliases: ['beta'] })]);
  const list = (await (await app.request('/api/projects')).json()) as ProjectSummary[];
  expect(list.map((p) => [p.key, p.remote, p.aliases])).toEqual([['alpha', 'github.com/org/alpha', ['beta']]]);
});

test('folders with no data yet are listed with no remote', async () => {
  const { app } = setup();
  const list = (await (await app.request('/api/projects')).json()) as ProjectSummary[];
  expect(list.find((p) => p.key === 'beta')).toMatchObject({ remote: null, aliases: [] });
});

test('POST /api/projects/:key/scan queues a scan for a known folder with an optional provider', async () => {
  const { app, calls } = setup();
  const res = await app.request('/api/projects/beta/scan', json('POST', { provider: 'codex-cli' }));
  expect(res.status).toBe(202);
  expect(calls[0]).toEqual(['scan', { key: 'beta', name: 'beta', repoPath: '/vibe/beta' }, 'codex-cli']);
});

test('scan requests for unknown folders or malformed providers are rejected', async () => {
  const { app } = setup();
  expect((await app.request('/api/projects/nope/scan', json('POST', {}))).status).toBe(404);
  expect((await app.request('/api/projects/beta/scan', json('POST', { provider: 'rm -rf /' }))).status).toBe(400);
});

test('GET /api/projects/:key/facts lists, or searches when q is given', async () => {
  const { app, calls } = setup();
  await app.request('/api/projects/alpha/facts?kind=convention');
  await app.request('/api/projects/alpha/facts?q=auth');
  expect(calls[0]).toEqual(['list', { projectKey: 'alpha', kind: 'convention', limit: 500 }]);
  expect(calls[1]).toEqual(['search', { embedding: [1], projectKey: 'alpha', k: 30 }]);
});

test('PATCH /api/projects/:key/facts/:id/relevance sets your relevance for a fact of that project, and logs it', async () => {
  const { app, calls, activity } = setup();
  const res = await app.request('/api/projects/alpha/facts/f1/relevance', json('PATCH', { relevance: 0.1 }));
  expect(res.status).toBe(204);
  expect(calls).toEqual([['relevance', [{ id: 'f1', relevance: 0.1, by: 'you', projectKey: 'alpha' }]]]);
  expect(activity[0]).toMatchObject({ kind: 'fact_relevance_set', subject: 'set a fact to rare (0.1)' });
});

test('fact relevance: out of range, unknown facts, unshown projects and requests without an origin are refused', async () => {
  const { app } = setup();
  expect((await app.request('/api/projects/alpha/facts/f1/relevance', json('PATCH', { relevance: 2 }))).status).toBe(400);
  expect((await app.request('/api/projects/alpha/facts/missing/relevance', json('PATCH', { relevance: 0.5 }))).status).toBe(404);
  const noOrigin = { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relevance: 0.5 }) };
  expect((await app.request('/api/projects/alpha/facts/f1/relevance', noOrigin)).status).toBe(403);
});

test('GET /api/projects lists pinned projects first, then by name; folders with no data are unpinned', async () => {
  const { app } = setup([summary('alpha', 5), summary('zeta', 1, { pinned: true })]);
  const list = (await (await app.request('/api/projects')).json()) as ProjectSummary[];
  expect(list.map((p) => [p.key, p.pinned])).toEqual([['zeta', true], ['alpha', false], ['beta', false]]);
});

test('PUT /api/projects/:key/pin pins a known folder (owner only) and logs it', async () => {
  const { app, calls, activity } = setup();
  expect((await app.request('/api/projects/beta/pin', json('PUT', { pinned: true }))).status).toBe(204);
  expect(calls).toEqual([['pin', { key: 'beta', name: 'beta', repoPath: '/vibe/beta' }, true]]);
  expect(activity[0]).toMatchObject({ kind: 'project_pinned', projectKey: 'beta', subject: 'pinned beta' });
  expect((await app.request('/api/projects/nope/pin', json('PUT', { pinned: true }))).status).toBe(404);
  expect((await app.request('/api/projects/beta/pin', json('PUT', { pinned: 'yes' }))).status).toBe(400);
  expect((await app.request('/api/projects/beta/pin', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"pinned":true}' })).status).toBe(403);
});

test('a listed project with data but no folder under the roots can be pinned too', async () => {
  const { app, calls } = setup([summary('alpha', 5), summary('imported', 3, { repoPath: '/examples/imported' })]);
  expect((await app.request('/api/projects/imported/pin', json('PUT', { pinned: true }))).status).toBe(204);
  expect(calls).toEqual([['pin', { key: 'imported', name: 'imported', repoPath: '/examples/imported' }, true]]);
});
