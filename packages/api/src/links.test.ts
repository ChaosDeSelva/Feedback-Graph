import { shownProjects, type ActivityInput, type ProjectLink } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const link = (a: string, b: string, status: ProjectLink['status']): ProjectLink => ({
  id: `link:${a}|${b}`, a, b, relation: 'related', note: '', status, source: 'detected', score: 0.9,
  evidence: [{ signal: 'manifest', detail: `${b} depends on ${a}`, path: 'package.json', from: b }], createdAt: 't', updatedAt: 't', decidedBy: null,
});

function setup(links: ProjectLink[] = [link('api', 'game', 'suggested'), link('game', 'secret', 'confirmed')]) {
  const calls: unknown[][] = [];
  const activity: ActivityInput[] = [];
  const app = createApp(repo, {
    links: {
      listLinks: async (q) => links.filter((l) => !q.projectKey || l.a === q.projectKey || l.b === q.projectKey),
      setLink: async (x, y, patch) => { calls.push(['set', x, y, patch]); return { ...link(x < y ? x : y, x < y ? y : x, patch.status ?? 'confirmed'), note: patch.note ?? '' }; },
      deleteLink: async (id) => { calls.push(['delete', id]); return id !== 'link:no|pe'; },
    },
    shown: () => shownProjects({ tracked: ['api', 'game', 'web'], initialized: true }, { excludeProjects: [] }),
    activity: { record: async (a) => { activity.push(a); }, list: async () => [] },
  });
  return { app, calls, activity };
}

const json = (method: string, body: object) => ({ method, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://localhost' }, body: JSON.stringify(body) });

test('GET /api/projects/:key/links lists the project links whose other end is shown', async () => {
  const { app } = setup();
  const res = await app.request('/api/projects/game/links');
  const body = (await res.json()) as ProjectLink[];
  expect(body.map((l) => l.id)).toEqual(['link:api|game']);
  expect((await app.request('/api/projects/secret/links')).status).toBe(404);
});

test('PUT /api/links confirms, dismisses or makes a link between two shown projects, and logs your decision', async () => {
  const { app, calls, activity } = setup();
  expect((await app.request('/api/links', json('PUT', { a: 'game', b: 'api', status: 'confirmed', note: 'client and api' }))).status).toBe(200);
  expect(calls[0]).toEqual(['set', 'game', 'api', { status: 'confirmed', note: 'client and api', decidedBy: 'you' }]);
  expect(activity[0]).toMatchObject({ kind: 'link_decided', actor: 'you', projectKey: 'game', subject: 'confirmed the link api ↔ game' });
  await app.request('/api/links', json('PUT', { a: 'web', b: 'api', relation: 'same_product' }));
  expect(calls[1]).toEqual(['set', 'web', 'api', { relation: 'same_product', decidedBy: 'you' }]);
});

test('link changes: unknown or hidden projects, a project and itself, bad fields and requests without an origin are refused', async () => {
  const { app } = setup();
  expect((await app.request('/api/links', json('PUT', { a: 'game', b: 'secret', status: 'confirmed' }))).status).toBe(404);
  expect((await app.request('/api/links', json('PUT', { a: 'game', b: 'game', status: 'confirmed' }))).status).toBe(400);
  expect((await app.request('/api/links', json('PUT', { a: 'game', b: 'api', status: 'maybe' }))).status).toBe(400);
  expect((await app.request('/api/links', json('PUT', { a: 'game', b: 'api', note: 'x'.repeat(600) }))).status).toBe(400);
  expect((await app.request('/api/links', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'game', b: 'api', status: 'confirmed' }) })).status).toBe(403);
});

test('DELETE /api/links/:id removes a link between shown projects', async () => {
  const { app, calls, activity } = setup();
  expect((await app.request('/api/links/link%3Aapi%7Cgame', json('DELETE', {}))).status).toBe(204);
  expect(calls[0]).toEqual(['delete', 'link:api|game']);
  expect(activity[0]).toMatchObject({ kind: 'link_decided', subject: 'removed the link api ↔ game' });
  expect((await app.request('/api/links/link%3Agame%7Csecret', json('DELETE', {}))).status).toBe(404);
});
