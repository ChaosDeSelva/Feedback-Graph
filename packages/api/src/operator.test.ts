import { OPERATOR_VERBS, type ActivityInput, type Lesson, type OperatorVerb, type ProjectSelection } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo, type AppOpts, type SettingsDeps } from './app.ts';
import { operatorName, OWNER_ROUTES } from './operator.ts';

const OP = 'o'.repeat(32);
const API = 'a'.repeat(32);
const DEFAULT_ALLOW = OPERATOR_VERBS.filter((v) => v !== 'lesson_decide');

const cand = { id: 'c1', projectKey: 'shop', classification: { label: 'pushback', confidence: 0.9 } };
const lesson: Lesson = {
  id: 'l1', projectKey: 'shop', title: 'T', rule: 'R', appliesWhen: 'W', scope: 'project', paths: [],
  status: 'proposed', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: null,
};

function setup(o: { allow?: OperatorVerb[]; token?: string | null; apiToken?: string; extra?: Partial<AppOpts> } = {}) {
  const logged: ActivityInput[] = [];
  const decided: unknown[][] = [];
  const updates: unknown[][] = [];
  const repo = {
    listCandidates: async () => [], stats: async () => [],
    decide: async (...a: unknown[]) => { decided.push(a); },
    candidateDetail: async (id: string) => (id === 'c1' || id === 'c2' ? { candidate: { ...cand, id }, turn: { text: 'no, not like that' }, before: [], after: [], commits: [] } : null),
  } as unknown as ApiRepo;
  const token = o.token === undefined ? OP : o.token;
  const app = createApp(repo, {
    auth: { token: o.apiToken, ...(token !== null && { operator: { token, allow: o.allow ?? DEFAULT_ALLOW } }) },
    activity: { record: async (e: ActivityInput) => { logged.push(e); }, list: async () => [] },
    knowledge: {
      listLessons: async () => [lesson],
      lessonDetail: async () => ({ lesson, miss: null, feedback: null, contextItems: [], fixCommits: [], supersedes: [] }),
      updateLesson: async (...a: unknown[]) => { updates.push(a); return { unscoped: false }; },
    } as never,
    ...o.extra,
  });
  return { app, logged, decided, updates };
}

const call = (method: string, body: object, headers: Record<string, string> = {}) => ({
  method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
});
const bearer = (t: string, name?: string) => ({ authorization: `Bearer ${t}`, ...(name !== undefined && { 'x-fg-operator': name }) });

test('the operator token passes the owner-only gate and the write is logged as the named agent, not you', async () => {
  const { app, logged, decided } = setup();
  const res = await app.request('/api/candidates/c1/decision', call('POST', { status: 'confirmed' }, bearer(OP, 'codex')));
  expect(res.status).toBe(204);
  // The item itself records who decided, not only Activity.
  expect(decided).toEqual([['c1', 'confirmed', null, 'operator:codex']]);
  expect(logged).toEqual([expect.objectContaining({ kind: 'feedback_decided', actor: 'operator:codex' })]);
  // No name: plain operator.
  await app.request('/api/candidates/c1/decision', call('POST', { status: 'rejected' }, bearer(OP)));
  expect(logged[1].actor).toBe('operator');
});

test('the browser is still you, and a bare local client is still refused', async () => {
  const { app, logged } = setup();
  expect((await app.request('/api/candidates/c1/decision', call('POST', { status: 'confirmed' }, { origin: 'http://localhost' }))).status).toBe(204);
  expect(logged[0].actor).toBe('you');
  expect((await app.request('/api/candidates/c1/decision', call('POST', { status: 'confirmed' }))).status).toBe(403);
});

test('a wrong token, or any token while FG_OPERATOR_TOKEN is unset, grants nothing', async () => {
  const { app } = setup();
  // A present but unrecognised bearer on an owner decision is 401, not the "only you" refusal meant for a bare client.
  const wrong = await app.request('/api/candidates/c1/decision', call('POST', { status: 'confirmed' }, bearer('x'.repeat(32))));
  expect(wrong.status).toBe(401);
  expect((await wrong.json()).error).toMatch(/token not recognised/);
  expect((await app.request('/api/candidates/c1/decision', call('POST', { status: 'confirmed' }, bearer(OP.slice(1))))).status).toBe(401);
  const off = setup({ token: null });
  expect((await off.app.request('/api/candidates/c1/decision', call('POST', { status: 'confirmed' }, bearer(OP)))).status).toBe(403);
  // An empty token is never a match, even for an empty bearer.
  const empty = setup({ token: '' });
  expect((await empty.app.request('/api/candidates/c1/decision', call('POST', { status: 'confirmed' }, { authorization: 'Bearer ' }))).status).toBe(403);
});

test('an unrecognised bearer is logged without the token; reads ignore a bearer when no API_TOKEN is set', async () => {
  const lines: [string, object | undefined][] = [];
  const { app } = setup({ extra: { log: (msg, extra) => { lines.push([msg, extra]); } } });
  const wrong = 'w'.repeat(32);
  await app.request('/api/projects/shop/pin', call('PUT', { pinned: true }, bearer(wrong, 'codex')));
  const refused = lines.filter(([m]) => m === 'auth refused');
  expect(refused).toEqual([['auth refused', expect.objectContaining({ method: 'PUT', path: '/api/projects/shop/pin', operator: 'operator:codex' })]]);
  expect(JSON.stringify(lines)).not.toContain(wrong);
  // The Claude Code plugin sends "Bearer none" when it has no token: reading still works.
  expect((await app.request('/api/lessons', { headers: { authorization: 'Bearer none' } })).status).toBe(200);
});

test('deciding lessons stays with you unless OPERATOR_ALLOW names lesson_decide; the refusal says how to allow it', async () => {
  const { app, updates } = setup();
  const res = await app.request('/api/lessons/l1', call('PATCH', { status: 'approved' }, bearer(OP, 'codex')));
  expect(res.status).toBe(403);
  const { error } = await res.json();
  expect(error).toContain('lesson_decide');
  expect(error).toContain('OPERATOR_ALLOW');
  expect(updates).toEqual([]);
});

test('a lesson an allowed agent approves is marked as approved by that agent', async () => {
  const { app, updates, logged } = setup({ allow: ['lesson_decide'] });
  expect((await app.request('/api/lessons/l1', call('PATCH', { status: 'approved' }, bearer(OP, 'codex')))).status).toBe(204);
  expect(updates[0][2]).toEqual(expect.objectContaining({ by: 'operator:codex' }));
  expect(logged[0]).toEqual(expect.objectContaining({ kind: 'lesson_decided', actor: 'operator:codex' }));
  expect(logged[0].why).toMatch(/agent/);
  // Narrowed: inbox decisions are now refused.
  expect((await app.request('/api/candidates/c1/decision', call('POST', { status: 'confirmed' }, bearer(OP)))).status).toBe(403);
});

test('the owner approving from the UI is recorded as you', async () => {
  const { app, updates } = setup();
  expect((await app.request('/api/lessons/l1', call('PATCH', { status: 'approved' }, { origin: 'http://localhost' }))).status).toBe(204);
  expect(updates[0][2]).toEqual(expect.objectContaining({ by: 'you' }));
});

test('with API_TOKEN set the operator token also signs in; the API token alone still cannot decide', async () => {
  const { app } = setup({ apiToken: API });
  expect((await app.request('/api/candidates')).status).toBe(401);
  expect((await app.request('/api/candidates', { headers: bearer(OP) })).status).toBe(200);
  expect((await app.request('/api/candidates/c1/decision', call('POST', { status: 'confirmed' }, bearer(OP)))).status).toBe(204);
  expect((await app.request('/api/candidates/c1/decision', call('POST', { status: 'confirmed' }, bearer(API)))).status).toBe(403);
});

test('the agent name is cleaned and kept short', () => {
  expect(operatorName(undefined)).toBe('operator');
  expect(operatorName('  ')).toBe('operator');
  expect(operatorName('codex')).toBe('operator:codex');
  expect(operatorName('claude code\n<b>')).toBe('operator:claude-code-b');
  expect(operatorName('x'.repeat(200)).length).toBeLessThanOrEqual('operator:'.length + 40);
});

test('writes logged by the Settings routes carry the agent too', async () => {
  let sel: ProjectSelection = { tracked: [], initialized: true, updatedAt: 't' };
  const settings: SettingsDeps = {
    selection: {
      current: async () => sel,
      setTracked: async (tracked) => { const before = sel.tracked; sel = { tracked, initialized: true, updatedAt: 'now' }; return { before, selection: sel }; },
      candidates: async () => null, aliases: async () => new Map(), keysWithData: async () => [],
      exclusive: async (fn) => fn(), forgetReads: async () => {},
    },
    folders: async () => [{ key: 'demo-shop', path: '/Users/me/Vibe/demo-shop' }],
    excluded: [], roots: ['/Users/me/Vibe'],
  };
  const { app, logged } = setup({ extra: { settings } });
  expect((await app.request('/api/settings/projects', call('PUT', { tracked: ['demo-shop'] }, bearer(OP, 'codex')))).status).toBe(200);
  expect(logged).toEqual([expect.objectContaining({ kind: 'projects_selected', actor: 'operator:codex' })]);
  // select_projects off: refused, and nothing is saved.
  const narrow = setup({ allow: ['scan'], extra: { settings } });
  const res = await narrow.app.request('/api/settings/projects', call('PUT', { tracked: [] }, bearer(OP)));
  expect(res.status).toBe(403);
  expect((await res.json()).error).toContain('select_projects');
  expect(sel.tracked).toEqual(['demo-shop']);
});

test('the links verb confirms or dismisses a link but cannot delete one: that is links_delete, off by default', async () => {
  expect(OWNER_ROUTES.find(([m, path]) => m === 'PUT' && path === '/api/links')?.[2]).toBe('links');
  expect(OWNER_ROUTES.find(([m, path]) => m === 'DELETE' && path === '/api/links/:id')?.[2]).toBe('links_delete');
  const deleted: string[] = [];
  const links = { listLinks: async () => [], setLink: async () => ({}) as never, deleteLink: async (id: string) => { deleted.push(id); return true; } } as never;
  const { app } = setup({ allow: OPERATOR_VERBS.filter((v) => v !== 'links_delete'), extra: { links } });
  const res = await app.request('/api/links/link:acme|demo-shop', call('DELETE', {}, bearer(OP)));
  expect(res.status).toBe(403);
  expect((await res.json()).error).toContain('links_delete');
  expect(deleted).toEqual([]);
  const allowed = setup({ allow: ['links_delete'], extra: { links } });
  expect((await allowed.app.request('/api/links/link:acme|demo-shop', call('DELETE', {}, bearer(OP)))).status).toBe(204);
  expect(deleted).toEqual(['link:acme|demo-shop']);
});

test('deleting an uploaded document is its own verb, off by default', () => {
  expect(OWNER_ROUTES.find(([m, path]) => m === 'DELETE' && path === '/api/docs/:id')?.[2]).toBe('docs_delete');
  expect(OWNER_ROUTES.find(([m, path]) => m === 'POST' && path === '/api/projects/:key/docs')?.[2]).toBe('docs');
});

test('asking for a document to be read again is the docs verb, like uploading it', () => {
  expect(OWNER_ROUTES.find(([m, path]) => m === 'POST' && path === '/api/docs/:id/reread')?.[2]).toBe('docs');
});

test('pins, relevance, uploads and links made with the token are recorded as the agent, in the data and the wording', async () => {
  const relevance: unknown[] = [];
  const upserts: unknown[] = [];
  const project = { key: 'shop', name: 'shop', repoPath: '/vibe/shop' };
  const { app, logged } = setup({
    extra: {
      facts: {
        listProjects: async () => [], requestScan: async () => ({}) as never, listFacts: async () => [], searchFacts: async () => [],
        setPinned: async () => {}, setFactRelevance: async (u: unknown[]) => { relevance.push(...u); return 1; },
      } as never,
      projectDirs: async () => [project],
      embed: async (t: string[]) => t.map(() => [0]),
      docs: { listDocs: async () => [], deleteDoc: async () => true, upsertDoc: async (...a: unknown[]) => { upserts.push(a); return 'doc:shop:upload:a.md'; } } as never,
      links: { listLinks: async () => [], deleteLink: async () => true, setLink: async () => ({ id: 'link:shop|web', a: 'shop', b: 'web', status: 'dismissed', relation: 'related' }) } as never,
    },
  });
  expect((await app.request('/api/projects/shop/pin', call('PUT', { pinned: true }, bearer(OP, 'codex')))).status).toBe(204);
  expect((await app.request('/api/projects/shop/facts/f1/relevance', call('PATCH', { relevance: 0.8 }, bearer(OP, 'codex')))).status).toBe(204);
  expect((await app.request('/api/projects/shop/docs', call('POST', { title: 'A', name: 'a.md', text: 'tenants are isolated' }, bearer(OP, 'codex')))).status).toBe(201);
  expect((await app.request('/api/links', call('PUT', { a: 'shop', b: 'web', status: 'dismissed' }, bearer(OP, 'codex')))).status).toBe(200);
  expect(relevance).toEqual([expect.objectContaining({ id: 'f1', by: 'operator:codex' })]);
  expect(upserts[0]).toEqual([expect.anything(), expect.anything(), expect.objectContaining({ addedBy: 'operator:codex' })]);
  for (const e of logged) {
    expect(e.actor).toBe('operator:codex');
    expect(e.why).not.toMatch(/^you /);
    expect(e.why).toContain('operator:codex');
  }
  expect(logged.map((e) => e.kind)).toEqual(['project_pinned', 'fact_relevance_set', 'doc_added', 'link_decided']);
});

test('in the UI the same writes still say you', async () => {
  const { app, logged } = setup({
    extra: {
      facts: { listProjects: async () => [], requestScan: async () => ({}) as never, listFacts: async () => [], searchFacts: async () => [], setPinned: async () => {} } as never,
      projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }],
    },
  });
  await app.request('/api/projects/shop/pin', call('PUT', { pinned: true }, { origin: 'http://localhost' }));
  expect(logged[0].why).toMatch(/^you pinned it/);
});

test('a wrong bearer on a read is 401 with a log line, whichever token is configured; no bearer, or the plugin\'s "Bearer none", reads as before', async () => {
  const wrong = 'w'.repeat(32);
  for (const o of [{}, { token: null, apiToken: API }] as const) {
    const lines: [string, object | undefined][] = [];
    const { app } = setup({ ...o, extra: { log: (msg, extra) => { lines.push([msg, extra]); } } });
    const res = await app.request('/api/lessons', { headers: bearer(wrong, 'codex') });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/token not recognised/);
    expect(lines.filter(([m]) => m === 'auth refused')).toEqual([['auth refused', expect.objectContaining({ method: 'GET', path: '/api/lessons', operator: 'operator:codex' })]]);
    expect(JSON.stringify(lines)).not.toContain(wrong);
  }
  const { app } = setup();
  expect((await app.request('/api/lessons')).status).toBe(200);
  expect((await app.request('/api/lessons', { headers: { authorization: 'Bearer none' } })).status).toBe(200);
  expect((await app.request('/api/lessons', { headers: bearer(OP) })).status).toBe(200);
  // No token configured at all: there is nothing to check a bearer against, so it is ignored as before.
  const open = setup({ token: null });
  expect((await open.app.request('/api/lessons', { headers: bearer(wrong) })).status).toBe(200);
});

test('Activity records how a write arrived: via the operator token or from a browser', async () => {
  const { app, logged } = setup({ extra: { facts: { listProjects: async () => [], requestScan: async () => ({}) as never, listFacts: async () => [], searchFacts: async () => [], setPinned: async () => {} } as never, projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }] } });
  await app.request('/api/projects/shop/pin', call('PUT', { pinned: true }, bearer(OP, 'codex')));
  await app.request('/api/projects/shop/pin', call('PUT', { pinned: false }, { origin: 'http://localhost' }));
  expect(logged.map((e) => [e.actor, e.details?.via])).toEqual([['operator:codex', 'operator'], ['you', 'browser']]);
});

test('a link decision records who made it on the link itself', async () => {
  const patches: unknown[] = [];
  const links = { listLinks: async () => [], deleteLink: async () => true, setLink: async (_a: string, _b: string, p: unknown) => { patches.push(p); return { id: 'link:shop|web', a: 'shop', b: 'web', status: 'confirmed', relation: 'related' }; } };
  const { app } = setup({ extra: { links: links as never } });
  await app.request('/api/links', call('PUT', { a: 'shop', b: 'web', status: 'confirmed' }, bearer(OP, 'codex')));
  await app.request('/api/links', call('PUT', { a: 'shop', b: 'web', status: 'dismissed' }, { origin: 'http://localhost' }));
  expect(patches).toEqual([{ status: 'confirmed', decidedBy: 'operator:codex' }, { status: 'dismissed', decidedBy: 'you' }]);
});

test('asking for a code map rebuild is recorded in Activity, as the agent that asked', async () => {
  const codegraph = { hotspots: async () => [], moduleContext: async () => null, impact: async () => null, codeMapMeta: async () => null, requestCodeMapRebuild: async (k: string) => k === 'shop' };
  const { app, logged } = setup({ extra: { codegraph: codegraph as never } });
  expect((await app.request('/api/projects/shop/codemap/rebuild', call('POST', {}, bearer(OP, 'codex')))).status).toBe(202);
  expect(logged).toEqual([expect.objectContaining({ kind: 'code_mapped', actor: 'operator:codex', projectKey: 'shop', subject: expect.stringMatching(/rebuild/) })]);
  // No map yet: refused, and nothing recorded.
  expect((await app.request('/api/projects/web/codemap/rebuild', call('POST', {}, bearer(OP, 'codex')))).status).toBe(404);
  expect(logged).toHaveLength(1);
});

test('testing an integration\'s token is a read: no OPERATOR_ALLOW verb gates it', () => {
  expect(OWNER_ROUTES.some(([, path]) => path === '/api/settings/integrations/:kind/test')).toBe(false);
  // Saving or removing a token still is the integrations verb.
  expect(OWNER_ROUTES.filter(([, path]) => path.startsWith('/api/settings/integrations')).map(([m, , v]) => `${m} ${v}`)).toEqual(['PUT integrations', 'DELETE integrations', 'PUT integrations']);
});
