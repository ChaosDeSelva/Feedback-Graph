import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;

function setup() {
  const calls: unknown[][] = [];
  const insights = {
    projectGraph: async (key: string) => { calls.push(['graph', key]); return { nodes: [{ id: 'miss:1', kind: 'miss', label: 'x', status: null }], links: [] } as never; },
    patterns: async (q: object) => { calls.push(['patterns', q]); return { causes: [], weekly: [], repeatGroups: [], preDone: { checks: 0, withGaps: 0, gapsFound: 0 } } as never; },
  };
  return { app: createApp(repo, { insights }), calls };
}

test('GET /api/graph returns the evidence graph for a project', async () => {
  const { app, calls } = setup();
  const res = await app.request('/api/graph?project=shop');
  expect(res.status).toBe(200);
  expect(((await res.json()) as { nodes: unknown[] }).nodes).toHaveLength(1);
  expect(calls).toEqual([['graph', 'shop']]);
});

test('GET /api/graph without a project is a 400', async () => {
  const { app } = setup();
  expect((await app.request('/api/graph')).status).toBe(400);
});

test('GET /api/patterns is global by default and scoped with ?project', async () => {
  const { app, calls } = setup();
  expect((await app.request('/api/patterns')).status).toBe(200);
  expect((await app.request('/api/patterns?project=shop')).status).toBe(200);
  expect(calls).toEqual([['patterns', {}], ['patterns', { projectKey: 'shop' }]]);
});
