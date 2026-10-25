import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candidate } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const cand: Candidate = {
  id: 'c1', turnUuid: 'c1', sessionId: 's', projectKey: 'demo', source: 'claude',
  classification: { label: 'pushback', confidence: 0.9, summary: 'x', signals: [] },
  status: 'pending', createdAt: 't', decidedAt: null, note: null,
};

function fakeRepo() {
  const calls: unknown[][] = [];
  const repo: ApiRepo = {
    listCandidates: async (f) => { calls.push(['list', f]); return [cand]; },
    candidateDetail: async (id) => (id === 'c1' ? { candidate: cand, turn: {} as never, before: [], after: [], commits: [], postmortem: null } : null),
    decide: async (...a) => { calls.push(['decide', ...a]); },
    stats: async () => [{ projectKey: 'demo', week: '2026-W40', humanTurns: 3, pushback: 1 }],
  };
  return { repo, calls };
}

test('GET /api/candidates passes filters through', async () => {
  const { repo, calls } = fakeRepo();
  const res = await createApp(repo).request('/api/candidates?status=pending&project=demo&limit=5');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([cand]);
  // One more than the page, to know whether another page follows.
  expect(calls[0]).toEqual(['list', { status: 'pending', projectKey: 'demo', limit: 6, offset: 0 }]);
  expect(res.headers.get('x-next-offset')).toBeNull();
});

test('GET /api/candidates pages: offset skips, and a full page says where the next one starts', async () => {
  const calls: unknown[] = [];
  const many = Array.from({ length: 7 }, (_, i) => ({ ...cand, id: `c${i}` }));
  const repo = { ...fakeRepo().repo, listCandidates: async (f: { limit?: number; offset?: number }) => { calls.push(f); return many.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 200)); } };
  const app = createApp(repo);
  const first = await app.request('/api/candidates?limit=3');
  expect(((await first.json()) as Candidate[]).map((c) => c.id)).toEqual(['c0', 'c1', 'c2']);
  expect(first.headers.get('x-next-offset')).toBe('3');
  const last = await app.request('/api/candidates?limit=3&offset=6');
  expect(((await last.json()) as Candidate[]).map((c) => c.id)).toEqual(['c6']);
  expect(last.headers.get('x-next-offset')).toBeNull();
  expect((await app.request('/api/candidates?offset=-1')).status).toBe(400);
});

test('GET /api/candidates rejects an unknown status', async () => {
  const res = await createApp(fakeRepo().repo).request('/api/candidates?status=bogus');
  expect(res.status).toBe(400);
});

test('GET /api/candidates filters by source, and refuses an unknown one', async () => {
  const { repo, calls } = fakeRepo();
  const app = createApp(repo);
  expect((await app.request('/api/candidates?source=github')).status).toBe(200);
  expect(calls[0]).toEqual(['list', { source: 'github', limit: 201, offset: 0 }]);
  expect((await app.request('/api/candidates?source=slack')).status).toBe(400);
});

test('GET /api/candidates/:id returns 404 for unknown ids', async () => {
  const app = createApp(fakeRepo().repo);
  expect((await app.request('/api/candidates/c1')).status).toBe(200);
  expect((await app.request('/api/candidates/nope')).status).toBe(404);
});

test('POST decision validates the body', async () => {
  const { repo, calls } = fakeRepo();
  const app = createApp(repo);
  const bad = await app.request('/api/candidates/c1/decision', { method: 'POST', body: JSON.stringify({ status: 'maybe' }), headers: { 'content-type': 'application/json', origin: 'http://localhost' } });
  expect(bad.status).toBe(400);
  const ok = await app.request('/api/candidates/c1/decision', { method: 'POST', body: JSON.stringify({ status: 'confirmed', note: 'yes' }), headers: { 'content-type': 'application/json', origin: 'http://localhost' } });
  expect(ok.status).toBe(204);
  expect(calls).toContainEqual(['decide', 'c1', 'confirmed', 'yes', 'you']);
});

test('POST decision on an unknown id is 404', async () => {
  const res = await createApp(fakeRepo().repo).request('/api/candidates/nope/decision', { method: 'POST', body: JSON.stringify({ status: 'rejected' }), headers: { 'content-type': 'application/json', origin: 'http://localhost' } });
  expect(res.status).toBe(404);
});

test('GET /api/stats and /api/health', async () => {
  const app = createApp(fakeRepo().repo);
  expect(await (await app.request('/api/stats')).json()).toHaveLength(1);
  expect(await (await app.request('/api/health')).json()).toEqual({ ok: true });
});

const post = (headers: Record<string, string>) => ({
  method: 'POST', body: JSON.stringify({ status: 'rejected' }), headers: { 'content-type': 'application/json', ...headers },
});

test('rejects requests whose Host is not local (DNS rebinding)', async () => {
  const app = createApp(fakeRepo().repo);
  const res = await app.request('http://evil.example/api/candidates?status=pending', { headers: { host: 'evil.example' } });
  expect(res.status).toBe(403);
  expect((await app.request('http://localhost:8787/api/health', { headers: { host: 'localhost:8787' } })).status).toBe(200);
});

test('rejects cross-origin writes', async () => {
  const { repo, calls } = fakeRepo();
  const res = await createApp(repo).request('/api/candidates/c1/decision', post({ origin: 'https://evil.example' }));
  expect(res.status).toBe(403);
  expect(calls.filter((c) => c[0] === 'decide')).toEqual([]);
});

test('rejects writes that are not application/json (no simple-request CSRF)', async () => {
  const res = await createApp(fakeRepo().repo).request('/api/candidates/c1/decision', {
    method: 'POST', body: JSON.stringify({ status: 'rejected' }), headers: { 'content-type': 'text/plain' },
  });
  expect(res.status).toBe(415);
});

test('same-origin writes are allowed', async () => {
  const res = await createApp(fakeRepo().repo).request('http://localhost:8787/api/candidates/c1/decision', post({ origin: 'http://localhost:8787', host: 'localhost:8787' }));
  expect(res.status).toBe(204);
});

test('an opaque "null" origin is rejected, not a 500', async () => {
  const res = await createApp(fakeRepo().repo).request('/api/candidates/c1/decision', post({ origin: 'null' }));
  expect(res.status).toBe(403);
});

test('writes from another localhost port are rejected', async () => {
  const res = await createApp(fakeRepo().repo).request('http://localhost:8787/api/candidates/c1/decision', post({ origin: 'http://localhost:3000', host: 'localhost:8787' }));
  expect(res.status).toBe(403);
});

test('the vite dev origin is allowed', async () => {
  const res = await createApp(fakeRepo().repo).request('http://localhost:8787/api/candidates/c1/decision', post({ origin: 'http://localhost:5173', host: 'localhost:8787' }));
  expect(res.status).toBe(204);
});

test('an unknown /api path is a JSON 404, never the UI page; the UI\'s own routes still get it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fg-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Feedback Graph</title>');
  const app = createApp(fakeRepo().repo, { staticDir: dir });
  for (const path of ['/api/nope', '/api/projects/demo/nothing-here', '/api/']) {
    const res = await app.request(path);
    expect(res.status, path).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect((await res.json()).error).toMatch(/no such API route.*openapi\.json/);
  }
  const page = await app.request('/projects');
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('<title>Feedback Graph</title>');
});

test('a request body over the limit is refused before it is read: 1 MB by default, more only for uploads', async () => {
  const { repo, calls } = fakeRepo();
  const docs = { listDocs: async () => [], deleteDoc: async () => true, upsertDoc: async () => 'doc:demo:upload:big.md' };
  const app = createApp(repo, { docs: docs as never, embed: async (t) => t.map(() => [0]), projectDirs: async () => [{ key: 'demo', name: 'demo', repoPath: '/v/demo' }] });
  const big = JSON.stringify({ status: 'confirmed', note: 'x'.repeat(1_100_000) });
  const res = await app.request('/api/candidates/c1/decision', { method: 'POST', body: big, headers: { 'content-type': 'application/json', origin: 'http://localhost', 'content-length': String(big.length) } });
  expect(res.status).toBe(413);
  expect((await res.json()).error).toMatch(/1 MB/);
  expect(calls.filter((c) => c[0] === 'decide')).toEqual([]);
  // Streamed without a length: counted as it arrives.
  const streamed = await app.request('/api/candidates/c1/decision', { method: 'POST', body: new Blob([big]).stream(), duplex: 'half', headers: { 'content-type': 'application/json', origin: 'http://localhost' } } as RequestInit);
  expect(streamed.status).toBe(413);
  // A document upload may be larger.
  const doc = JSON.stringify({ title: 'Big', name: 'big.md', text: 'word '.repeat(400_000) });
  const up = await app.request('/api/projects/demo/docs', { method: 'POST', body: doc, headers: { 'content-type': 'application/json', origin: 'http://localhost', 'content-length': String(doc.length) } });
  expect(up.status).toBe(201);
});

test('Sec-Fetch-Site cross-site writes are rejected even without Origin', async () => {
  const res = await createApp(fakeRepo().repo).request('/api/candidates/c1/decision', post({ 'sec-fetch-site': 'cross-site' }));
  expect(res.status).toBe(403);
});
