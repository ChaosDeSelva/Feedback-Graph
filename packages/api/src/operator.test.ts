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
  expect(decided).toEqual([['c1', 'confirmed', null]]);
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
  expect((await app.request('/api/candidates/c1/decision', call('POST', { status: 'confirmed' }, bearer('x'.repeat(32))))).status).toBe(403);
  expect((await app.request('/api/candidates/c1/decision', call('POST', { status: 'confirmed' }, bearer(OP.slice(1))))).status).toBe(403);
  const off = setup({ token: null });
  expect((await off.app.request('/api/candidates/c1/decision', call('POST', { status: 'confirmed' }, bearer(OP)))).status).toBe(403);
  // An empty token is never a match, even for an empty bearer.
  const empty = setup({ token: '' });
  expect((await empty.app.request('/api/candidates/c1/decision', call('POST', { status: 'confirmed' }, { authorization: 'Bearer ' }))).status).toBe(403);
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

test('deleting an uploaded document is its own verb, off by default', () => {
  expect(OWNER_ROUTES.find(([m, path]) => m === 'DELETE' && path === '/api/docs/:id')?.[2]).toBe('docs_delete');
  expect(OWNER_ROUTES.find(([m, path]) => m === 'POST' && path === '/api/projects/:key/docs')?.[2]).toBe('docs');
});
