import type { ActivityInput, ExportBundle } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as ApiRepo;
const bundle = { format: 'feedback-graph-export', schemaVersion: 1, exportedAt: '2026-10-22T00:00:00Z', projectKey: 'demo', lessons: [], misses: [], facts: [], docs: [] } as unknown as ExportBundle;

function app() {
  const calls: unknown[] = [];
  const log: ActivityInput[] = [];
  const a = createApp(repo, {
    portability: {
      exportData: async (o) => { calls.push(['export', o]); return bundle; },
      deleteProject: async (k) => { calls.push(['delete', k]); return 42; },
    },
    docs: { upsertDoc: async () => 'doc:demo:upload:upload:a.md', listDocs: async () => [], deleteDoc: async () => true },
    activity: { record: async (x) => { log.push(x); }, list: async () => [] },
    embed: async (t) => t.map(() => [1]),
    projectDirs: async () => [{ key: 'demo', name: 'demo', repoPath: '/vibe/demo' }],
  });
  return { a, calls, log };
}
const ui = { 'sec-fetch-site': 'same-origin', origin: 'http://localhost', 'content-type': 'application/json' };

test('export downloads a JSON bundle for a project, optionally approved lessons only', async () => {
  const { a, calls } = app();
  const res = await a.request('/api/export?project=demo&approved=1');
  expect(res.status).toBe(200);
  expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="feedback-graph-demo-.*\.json"/);
  expect(await res.json()).toEqual(bundle);
  expect(calls).toEqual([['export', { projectKey: 'demo', approvedOnly: true }]]);
});

test('deleting a project needs you, from the UI, typing its name', async () => {
  const { a, calls, log } = app();
  expect((await a.request('/api/projects/demo', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'demo' }) })).status).toBe(403);
  expect((await a.request('/api/projects/demo', { method: 'DELETE', headers: ui, body: JSON.stringify({ confirm: 'dem' }) })).status).toBe(400);
  const res = await a.request('/api/projects/demo', { method: 'DELETE', headers: ui, body: JSON.stringify({ confirm: 'demo' }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ removed: 42 });
  expect(calls).toEqual([['delete', 'demo']]);
  expect(log).toEqual([expect.objectContaining({ kind: 'project_deleted', actor: 'you', projectKey: null, subject: expect.stringContaining('demo') })]);
});

test('removing a document is logged', async () => {
  const { a, log } = app();
  expect((await a.request('/api/docs/doc%3Ademo%3Aupload%3Aupload%3Aa.md', { method: 'DELETE', headers: ui, body: '{}' })).status).toBe(204);
  expect(log).toEqual([expect.objectContaining({ kind: 'doc_removed', actor: 'you', projectKey: 'demo', targets: ['doc:demo:upload:upload:a.md'] })]);
});
