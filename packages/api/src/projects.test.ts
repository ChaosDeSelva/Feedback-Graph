import type { ProjectSummary } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const summary = (key: string, facts = 0, over: Partial<ProjectSummary> = {}): ProjectSummary => ({ key, repoPath: `/vibe/${key}`, remote: null, aliases: [], sessions: 2, feedback: 1, lessons: 1, facts, lastScan: null, ...over });

function setup(projects = [summary('alpha', 5)]) {
  const calls: unknown[][] = [];
  const facts = {
    listProjects: async () => projects,
    requestScan: async (p: object, provider: string | null) => { calls.push(['scan', p, provider]); return { id: 'scan:1', status: 'queued' } as never; },
    listFacts: async (q: object) => { calls.push(['list', q]); return []; },
    searchFacts: async (q: object) => { calls.push(['search', q]); return []; },
  };
  const app = createApp(repo, {
    facts,
    embed: async (t) => t.map(() => [1]),
    projectDirs: async () => [{ key: 'alpha', name: 'alpha', repoPath: '/vibe/alpha' }, { key: 'beta', name: 'beta', repoPath: '/vibe/beta' }],
  });
  return { app, calls };
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
