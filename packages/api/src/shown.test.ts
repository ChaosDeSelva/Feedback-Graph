import { shownProjects, type Candidate, type Lesson, type ProjectSummary } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo, type AppOpts } from './app.ts';

/**
 * Outside Settings, only the selected projects (and the clone folders that follow them) are shown. One project is
 * selected here, `shop` (with its clone `shop-2`); `old` has data from before the selection existed.
 */
const SELECTED = shownProjects({ tracked: ['shop'], initialized: true }, { excludeProjects: [] }, new Map([['shop-2', 'shop']]));
const NOTHING_YET = shownProjects({ tracked: [], initialized: false }, { excludeProjects: [] });

const cand = (id: string, projectKey: string): Candidate => ({
  id, turnUuid: id, sessionId: 's', projectKey, source: 'claude',
  classification: { label: 'pushback', confidence: 0.9, summary: 'x', signals: [] },
  status: 'pending', createdAt: 't', decidedAt: null, note: null,
});
const lesson = (id: string, projectKey: string | null, origin: string | null): Lesson => ({
  id, projectKey, origin, title: id, rule: 'r', appliesWhen: 'w', scope: projectKey ? 'project' : 'global', paths: ['src/a.ts'],
  status: 'approved', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: null,
});
const summary = (key: string, aliases: string[] = []): ProjectSummary => ({ key, repoPath: `/vibe/${key}`, remote: null, aliases, sessions: 1, feedback: 1, lessons: 0, facts: 0, lastScan: null, pinned: false });
const json = (method: string, body: object) => ({ method, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://localhost' }, body: JSON.stringify(body) });

const LESSONS = [lesson('lesson:shop', 'shop', 'shop'), lesson('lesson:old-global', null, 'old'), lesson('lesson:old', 'old', 'old'), lesson('memory:any', null, null)];

function setup(shown = SELECTED, over: Partial<AppOpts> = {}) {
  const calls: unknown[][] = [];
  const cands = [cand('c-shop', 'shop'), cand('c-old', 'old')];
  const repo: ApiRepo = {
    listCandidates: async (f) => { calls.push(['candidates', f]); return cands; },
    candidateDetail: async (id) => {
      const c = cands.find((x) => x.id === id);
      return c ? { candidate: c, turn: { text: 't' } as never, before: [], after: [], commits: [], postmortem: null } : null;
    },
    decide: async (...a) => { calls.push(['decide', ...a]); },
    stats: async () => [
      { projectKey: 'shop', week: '2026-W40', humanTurns: 3, pushback: 1 },
      { projectKey: 'shop-2', week: '2026-W40', humanTurns: 1, pushback: 0 },
      { projectKey: 'old', week: '2026-W40', humanTurns: 9, pushback: 4 },
    ],
  };
  const module = (key: string, path: string) => ({ file: { path }, symbols: [], imports: [], importers: [], tests: [], facts: [], misses: [], lessons: LESSONS }) as never;
  const app = createApp(repo, {
    shown: async () => shown,
    facts: {
      listProjects: async () => [summary('old'), summary('shop', ['shop-2'])],
      requestScan: async () => ({}) as never,
      listFacts: async (q) => { calls.push(['facts', q]); return []; },
      searchFacts: async () => [],
    },
    projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }, { key: 'fresh', name: 'fresh', repoPath: '/vibe/fresh' }],
    embed: async (t) => t.map(() => [1]),
    docs: {
      listDocs: async (key) => { calls.push(['docs', key]); return []; },
      upsertDoc: async () => 'doc:x',
      deleteDoc: async (id) => { calls.push(['deleteDoc', id]); return true; },
    },
    knowledge: {
      listLessons: async (f) => { calls.push(['lessons', f]); return LESSONS; },
      lessonDetail: async (id) => {
        const l = LESSONS.find((x) => x.id === id);
        return l ? { lesson: l, miss: null, feedback: null, contextItems: [], fixCommits: [], supersedes: [] } : null;
      },
      updateLesson: async (...a) => { calls.push(['updateLesson', ...a]); return { unscoped: false }; },
      retryPostmortem: async (id) => { calls.push(['retry', id]); return true; },
    },
    activity: { record: async () => {}, list: async (q) => { calls.push(['activity', q]); return []; } },
    insights: {
      projectGraph: async (key) => { calls.push(['graph', key]); return { nodes: [], links: [] }; },
      patterns: async (q) => { calls.push(['patterns', q]); return {} as never; },
    },
    codegraph: {
      hotspots: async () => [], codeMapMeta: async () => null, moduleContext: async (k, p) => module(k, p),
      impact: async () => ({ paths: ['src/a.ts'], dependents: [], tests: [], misses: [], lessons: LESSONS }) as never,
      mapGraph: async () => ({ nodes: [], links: [], lessons: LESSONS.map((l) => ({ id: l.id, title: l.title, paths: l.paths })) }) as never,
    },
    portability: { exportData: async (o) => { calls.push(['export', o]); return { exportedAt: '2026-10-24T00:00:00Z' } as never; }, deleteProject: async () => 0 },
    ...over,
  });
  const get = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };
  return { app, calls, get };
}

test('GET /api/projects lists only the selected projects and folders, never the others', async () => {
  const { get } = setup();
  expect(((await get('/api/projects')).body as ProjectSummary[]).map((p) => p.key)).toEqual(['shop']);
});

test('with no selection saved yet, every list is empty', async () => {
  const { get, calls } = setup(NOTHING_YET);
  expect((await get('/api/projects')).body).toEqual([]);
  await get('/api/candidates?status=pending');
  await get('/api/lessons?status=approved');
  await get('/api/activity');
  await get('/api/patterns');
  expect((await get('/api/stats')).body).toEqual([]);
  expect(calls.find((c) => c[0] === 'candidates')![1]).toMatchObject({ projectKeys: [] });
  expect(calls.find((c) => c[0] === 'lessons')![1]).toMatchObject({ projectKeys: [] });
  expect(calls.find((c) => c[0] === 'activity')![1]).toMatchObject({ projectKeys: [] });
  expect(calls.find((c) => c[0] === 'patterns')![1]).toMatchObject({ projectKeys: [] });
});

test('GET /api/candidates asks the store for the selected projects only; another project asked for by name finds nothing', async () => {
  const { get, calls } = setup();
  await get('/api/candidates?status=pending');
  await get('/api/candidates?status=pending&project=old');
  expect(calls[0]).toEqual(['candidates', { status: 'pending', limit: 201, offset: 0, projectKeys: ['shop', 'shop-2'] }]);
  expect(calls[1]).toEqual(['candidates', { status: 'pending', projectKey: 'old', limit: 201, offset: 0, projectKeys: [] }]);
});

test('an Inbox item of another project is not found, and cannot be decided or retried', async () => {
  const { app, get, calls } = setup();
  expect((await get('/api/candidates/c-shop')).status).toBe(200);
  expect((await get('/api/candidates/c-old')).status).toBe(404);
  expect((await app.request('/api/candidates/c-old/decision', json('POST', { status: 'rejected' }))).status).toBe(404);
  expect((await app.request('/api/feedback/c-old/retry', json('POST', {}))).status).toBe(404);
  expect(calls.filter((c) => c[0] === 'decide' || c[0] === 'retry')).toEqual([]);
});

test('GET /api/stats keeps the selected projects and their clones', async () => {
  const { get } = setup();
  expect(((await get('/api/stats')).body as { projectKey: string }[]).map((r) => r.projectKey)).toEqual(['shop', 'shop-2']);
});

test('lessons: the list is asked for the selected projects; a lesson learned elsewhere is not found', async () => {
  const { app, get, calls } = setup();
  await get('/api/lessons?status=proposed');
  expect(calls[0]).toEqual(['lessons', { status: 'proposed', projectKeys: ['shop', 'shop-2'] }]);
  expect((await get('/api/lessons/lesson:shop')).status).toBe(200);
  expect((await get('/api/lessons/memory:any')).status).toBe(200);
  expect((await get('/api/lessons/lesson:old-global')).status).toBe(404);
  expect((await get('/api/lessons/lesson:old')).status).toBe(404);
  expect((await app.request('/api/lessons/lesson:old', json('PATCH', { status: 'approved' }))).status).toBe(404);
  expect(calls.some((c) => c[0] === 'updateLesson')).toBe(false);
});

test('activity and patterns cover the selected projects only', async () => {
  const { get, calls } = setup();
  await get('/api/activity?limit=10');
  await get('/api/activity?project=old');
  await get('/api/patterns');
  await get('/api/patterns?project=shop');
  expect(calls).toEqual([
    ['activity', { limit: 10, unlabelled: true, maxDetailBytes: 1024, projectKeys: ['shop', 'shop-2'] }],
    ['activity', { projectKey: 'old', unlabelled: true, maxDetailBytes: 1024, projectKeys: [] }],
    ['patterns', { projectKeys: ['shop', 'shop-2'] }],
    ['patterns', { projectKey: 'shop', projectKeys: ['shop'] }],
  ]);
});

test("another project's evidence graph, facts, docs and export are not found", async () => {
  const { app, get, calls } = setup();
  expect((await get('/api/graph?project=old')).status).toBe(404);
  expect((await get('/api/projects/old/facts')).status).toBe(404);
  expect((await get('/api/projects/old/docs')).status).toBe(404);
  expect((await get('/api/export?project=old')).status).toBe(404);
  expect((await app.request('/api/docs/doc:old:upload:a.md', json('DELETE', {}))).status).toBe(404);
  expect(calls).toEqual([]);
  expect((await get('/api/graph?project=shop')).status).toBe(200);
  expect((await get('/api/projects/shop/facts')).status).toBe(200);
  expect((await get('/api/projects/shop/docs')).status).toBe(200);
});

test('an export with no project covers the selected projects only, never one you unselected', async () => {
  const { get, calls } = setup();
  expect((await get('/api/export')).status).toBe(200);
  expect((await get('/api/export?approved=1')).status).toBe(200);
  expect(calls).toEqual([
    ['export', { projectKeys: ['shop', 'shop-2'], approvedOnly: false }],
    ['export', { projectKeys: ['shop', 'shop-2'], approvedOnly: true }],
  ]);
  const none = setup(NOTHING_YET);
  await none.get('/api/export');
  expect(none.calls).toEqual([['export', { projectKeys: [], approvedOnly: false }]]);
});

test('naming an unselected project for export is refused with a reason', async () => {
  const res = await setup().app.request('/api/export?project=old');
  expect(res.status).toBe(404);
  expect((await res.json()).error).toMatch(/not selected/);
});

test('the code map leaves out lessons learned in a project that is not selected', async () => {
  const { get } = setup();
  const ids = (ls: { id: string }[]) => ls.map((l) => l.id);
  expect(ids((await get('/api/projects/shop/codemap/module?path=src/a.ts')).body.lessons)).toEqual(['lesson:shop', 'memory:any']);
  expect(ids((await get('/api/projects/shop/codemap/impact?path=src/a.ts')).body.lessons)).toEqual(['lesson:shop', 'memory:any']);
  expect(ids((await get('/api/projects/shop/codemap/graph')).body.lessons)).toEqual(['lesson:shop', 'memory:any']);
});
