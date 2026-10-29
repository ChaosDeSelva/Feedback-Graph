import { SCANNER_VERSION, shownProjects, type ProjectLink, type ProjectSummary } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const summary = (key: string, facts = 0, over: Partial<ProjectSummary> = {}): ProjectSummary => ({ key, repoPath: `/vibe/${key}`, remote: null, aliases: [], sessions: 2, feedback: 1, lessons: 1, facts, lastScan: null, pinned: false, ...over });

function setup(projects = [summary('alpha', 5)], dirs: { key: string; name: string; repoPath: string; remote?: string | null }[] = [{ key: 'alpha', name: 'alpha', repoPath: '/vibe/alpha' }, { key: 'beta', name: 'beta', repoPath: '/vibe/beta' }]) {
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
    projectDirs: async () => dirs,
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

test('a record a scan or code map made (no path, no remote) is joined with its selected folder', async () => {
  const { app } = setup(
    [summary('alpha', 5, { repoPath: '', remote: null }), summary('kept', 1, { remote: 'github.com/org/kept' })],
    [{ key: 'alpha', name: 'alpha', repoPath: '/vibe/alpha', remote: 'github.com/org/alpha' }, { key: 'kept', name: 'kept', repoPath: '/vibe/other', remote: 'github.com/org/other' }],
  );
  const list = (await (await app.request('/api/projects')).json()) as ProjectSummary[];
  expect(list.map((p) => [p.key, p.repoPath, p.remote])).toEqual([
    ['alpha', '/vibe/alpha', 'github.com/org/alpha'],
    // What the record knows wins: the folder only fills what is missing.
    ['kept', '/vibe/kept', 'github.com/org/kept'],
  ]);
});

test('a folder with no data yet carries the remote its folder has', async () => {
  const { app } = setup([], [{ key: 'beta', name: 'beta', repoPath: '/vibe/beta', remote: 'github.com/org/beta' }]);
  const list = (await (await app.request('/api/projects')).json()) as ProjectSummary[];
  expect(list).toEqual([expect.objectContaining({ key: 'beta', repoPath: '/vibe/beta', remote: 'github.com/org/beta' })]);
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
  // One more than the page, so the response can say there is more.
  expect(calls[0]).toEqual(['list', { projectKey: 'alpha', kind: 'convention', limit: 501, offset: 0 }]);
  expect(calls[1]).toEqual(['search', { embedding: [1], projectKey: 'alpha', k: 30 }]);
});

test('GET /api/projects/:key/facts pages (limit, offset, X-Next-Offset), filters by origin, and never serves the constant confidence', async () => {
  const { app } = setup();
  const stored = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, kind: 'api', statement: `s${i}`, path: 'a.ts', lines: null, confidence: 1, why: '', origin: 'model' }));
  const seen: object[] = [];
  const facts = {
    listProjects: async () => [summary('alpha', 5)], requestScan: async () => ({}) as never,
    listFacts: async (q: { limit?: number; offset?: number }) => { seen.push(q); return stored.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 500)); },
    searchFacts: async () => [{ fact: stored[0], score: 0.9 }],
  };
  const paged = createApp(repo, { facts: facts as never, embed: async (t) => t.map(() => [1]), projectDirs: async () => [] });
  const first = await paged.request('/api/projects/alpha/facts?limit=2&origin=model');
  expect(seen[0]).toEqual({ projectKey: 'alpha', origin: 'model', limit: 3, offset: 0 });
  expect(first.headers.get('x-next-offset')).toBe('2');
  const rows = (await first.json()) as Record<string, unknown>[];
  expect(rows.map((r) => r.id)).toEqual(['f0', 'f1']);
  expect(rows.every((r) => !('confidence' in r))).toBe(true);
  const last = await paged.request('/api/projects/alpha/facts?limit=2&offset=4');
  expect(last.headers.get('x-next-offset')).toBeNull();
  expect(((await last.json()) as unknown[]).length).toBe(1);
  const hits = (await (await paged.request('/api/projects/alpha/facts?q=auth')).json()) as { fact: Record<string, unknown> }[];
  expect('confidence' in hits[0].fact).toBe(false);
  expect((await paged.request('/api/projects/alpha/facts?origin=nope')).status).toBe(400);
  expect((await paged.request('/api/projects/alpha/facts?limit=5000')).status).toBe(400);
  expect((await app.request('/api/projects/alpha/facts?offset=-1')).status).toBe(400);
});

test('PATCH /api/projects/:key/facts/:id/relevance sets your relevance for a fact of that project, and logs it', async () => {
  const { app, calls, activity } = setup();
  const res = await app.request('/api/projects/alpha/facts/f1/relevance', json('PATCH', { relevance: 0.1 }));
  expect(res.status).toBe(204);
  // run null: the owner's setting (a fact a run wrote becomes the owner's).
  expect(calls).toEqual([['relevance', [{ id: 'f1', relevance: 0.1, by: 'you', projectKey: 'alpha', run: null }]]]);
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

test('GET /api/projects counts each project\'s confirmed links whose other end is shown', async () => {
  const link = (a: string, b: string, status: ProjectLink['status']) => ({ id: `link:${a}|${b}`, a, b, status }) as ProjectLink;
  const all = [link('alpha', 'beta', 'confirmed'), link('alpha', 'gamma', 'suggested'), link('alpha', 'secret', 'confirmed'), link('beta', 'gamma', 'dismissed')];
  const app = createApp(repo, {
    facts: { listProjects: async () => [summary('alpha', 5)] } as never,
    projectDirs: async () => [{ key: 'alpha', name: 'alpha', repoPath: '/vibe/alpha' }, { key: 'beta', name: 'beta', repoPath: '/vibe/beta' }],
    links: { listLinks: async () => all, setLink: async () => all[0], deleteLink: async () => true },
    shown: () => shownProjects({ tracked: ['alpha', 'beta', 'gamma'], initialized: true }, { excludeProjects: [] }),
  });
  const list = (await (await app.request('/api/projects')).json()) as ProjectSummary[];
  expect(list.map((p) => [p.key, p.links])).toEqual([['alpha', 1], ['beta', 1]]);
});

test('GET /api/projects leaves the link count out when there is no links store', async () => {
  const { app } = setup();
  const list = (await (await app.request('/api/projects')).json()) as ProjectSummary[];
  expect(list[0].links).toBeUndefined();
});

test('GET /api/projects counts the files an older scanner read (the next scan you start reads them again); none: absent', async () => {
  const asked: string[] = [];
  const withOlder = createApp(repo, {
    facts: { ...plainFacts(), olderScannerFiles: async (v: string) => { asked.push(v); return new Map([['alpha', 12], ['hidden', 3]]); } },
    projectDirs: async () => [{ key: 'alpha', name: 'alpha', repoPath: '/vibe/alpha' }, { key: 'beta', name: 'beta', repoPath: '/vibe/beta' }],
  });
  const list = (await (await withOlder.request('/api/projects')).json()) as ProjectSummary[];
  expect(list.map((p) => [p.key, p.olderScanner])).toEqual([['alpha', 12], ['beta', undefined]]);
  expect(asked).toEqual([SCANNER_VERSION]);
  // A store without the count: nothing is said.
  const { app } = setup();
  expect(((await (await app.request('/api/projects')).json()) as ProjectSummary[]).every((p) => p.olderScanner === undefined)).toBe(true);
});

function plainFacts() {
  return { listProjects: async () => [summary('alpha', 5)], requestScan: async () => ({}) as never, listFacts: async () => [], searchFacts: async () => [] };
}


test('single and batch scan APIs expose blocked readiness and poll status clears once healthy', async () => {
  let healthy = false, probes = 0;
  const scan = { id: 'scan:blocked', projectKey: 'beta', provider: 'codex-cli', status: 'queued' };
  const app = createApp(repo, {
    facts: { requestScan: async () => scan, scanJob: async () => scan, listProjects: async () => [] } as never,
    projectDirs: async () => [{ key: 'beta', name: 'beta', repoPath: '/vibe/beta' }],
    system: { worker: async () => ({ providers: { scan: 'codex-cli' } }), runner: async () => { probes++; return { ok: healthy, reason: healthy ? 'healthy' : 'sandbox cannot start' }; } } as never,
  });
  const single = await app.request('/api/projects/beta/scan', json('POST', {}));
  expect(single.status).toBe(202);
  expect(await single.json()).toMatchObject({ blocked: true, warning: expect.stringContaining('sandbox cannot start') });
  const batch = await app.request('/api/projects/scan', json('POST', { keys: ['beta'] }));
  expect(batch.status).toBe(202);
  expect((await batch.json()).results[0]).toMatchObject({ queued: true, blocked: true, warning: expect.stringContaining('parked'), job: { blocked: true } });
  expect(await (await app.request('/api/scans/scan:blocked')).json()).toMatchObject({ blocked: true });
  healthy = true;
  expect(await (await app.request('/api/scans/scan:blocked')).json()).not.toHaveProperty('blocked');
  expect(probes).toBe(4);
});
