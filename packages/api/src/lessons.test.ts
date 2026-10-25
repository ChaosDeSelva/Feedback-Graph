import type { ActivityInput, Lesson } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo, type AppOpts } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const lesson: Lesson = {
  id: 'lesson:a', projectKey: 'demo', title: 'T', rule: 'R', appliesWhen: 'W', scope: 'project', paths: [],
  status: 'proposed', source: 'postmortem', cause: 'verification_gap', missId: 'miss:a', createdAt: 't', decidedAt: null,
};

function setup() {
  const calls: unknown[][] = [];
  const knowledge = {
    listLessons: async (f: object) => { calls.push(['list', f]); return [lesson]; },
    lessonDetail: async (id: string) => (id === lesson.id ? { lesson, miss: null, feedback: null, contextItems: [], fixCommits: [], supersedes: [] } : null),
    updateLesson: async (...a: unknown[]) => { calls.push(['update', ...a]); return { unscoped: false }; },
  };
  const embedded: string[][] = [];
  const app = createApp(repo, { knowledge, embed: async (t) => { embedded.push(t); return t.map(() => [0.5]); } });
  return { app, calls, embedded };
}

const patch = (body: object) => ({ method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(body) });

test('GET /api/lessons filters by status and project', async () => {
  const { app, calls } = setup();
  const res = await app.request('/api/lessons?status=proposed&project=demo');
  expect(await res.json()).toEqual([lesson]);
  expect(calls[0]).toEqual(['list', { status: 'proposed', projectKey: 'demo' }]);
});

test('GET /api/lessons/:id is 404 for unknown ids', async () => {
  const { app } = setup();
  expect((await app.request('/api/lessons/lesson%3Aa')).status).toBe(200);
  expect((await app.request('/api/lessons/nope')).status).toBe(404);
});

test('PATCH approving without text changes does not re-embed', async () => {
  const { app, calls, embedded } = setup();
  const res = await app.request('/api/lessons/lesson%3Aa', patch({ status: 'approved' }));
  expect(res.status).toBe(204);
  expect(embedded).toEqual([]);
  expect(calls).toContainEqual(['update', 'lesson:a', { status: 'approved' }, { reembed: undefined, by: 'you' }]);
});

test('PATCH editing the rule re-embeds the lesson text', async () => {
  const { app, calls, embedded } = setup();
  await app.request('/api/lessons/lesson%3Aa', patch({ rule: 'New rule', scope: 'global' }));
  expect(embedded).toEqual([['T\nNew rule\nApplies when: W']]);
  expect(calls).toContainEqual(['update', 'lesson:a', { rule: 'New rule', scope: 'global' }, { reembed: [0.5], by: 'you' }]);
});

test('PATCH rejects unknown fields and bad statuses', async () => {
  const { app } = setup();
  expect((await app.request('/api/lessons/lesson%3Aa', patch({ status: 'superseded' }))).status).toBe(400);
  expect((await app.request('/api/lessons/lesson%3Aa', patch({ embedding: [1] }))).status).toBe(400);
});

function factSetup(l: Lesson = lesson, o: { auth?: AppOpts['auth'] } = {}) {
  const calls: unknown[][] = [];
  const logged: ActivityInput[] = [];
  const embedded: string[][] = [];
  const knowledge = {
    listLessons: async () => [l],
    lessonDetail: async (id: string) => (id === l.id ? { lesson: l, miss: { id: 'miss:a', missed: 'Read the mirror table', cause: 'verification_gap' as const, causeExplanation: '' }, feedback: null, contextItems: [], fixCommits: [], supersedes: [] } : null),
    updateLesson: async (...a: unknown[]) => { calls.push(['update', ...a]); return { unscoped: false }; },
  };
  const facts = {
    listProjects: async () => [], requestScan: async () => null, listFacts: async () => [], searchFacts: async () => [],
    addOwnerFact: async (...a: unknown[]) => { calls.push(['fact', ...a]); return { id: 'fact:1', ...(a[1] as object), origin: 'you' }; },
  };
  const app = createApp(repo, {
    knowledge, facts: facts as never, ...(o.auth && { auth: o.auth }),
    embed: async (t) => { embedded.push(t); return t.map(() => [0.25]); },
    activity: { record: async (e) => { logged.push(e); }, list: async () => [] },
  });
  return { app, calls, logged, embedded };
}

const post = (body: object, headers: Record<string, string> = { origin: 'http://localhost' }) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('POST /api/lessons/:id/to-fact files the rule as your fact (convention, everyday) and rejects the lesson with a note', async () => {
  const { app, calls, logged, embedded } = factSetup({ ...lesson, rule: 'Orders are read from the source table, not the mirror' });
  const res = await app.request('/api/lessons/lesson%3Aa/to-fact', post({}));
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ id: 'fact:1', origin: 'you', kind: 'convention' });
  // Embedded like a scanned fact: "<path>: <statement>".
  expect(embedded).toEqual([['.: Orders are read from the source table, not the mirror']]);
  expect(calls).toEqual([
    ['fact', 'demo', { kind: 'convention', statement: 'Orders are read from the source table, not the mirror', path: '.', lines: null, confidence: 1, why: 'From the lesson "T": Read the mirror table', relevance: 0.8, origin: 'you', embedding: [0.25] }, 'you'],
    ['update', 'lesson:a', { status: 'rejected' }, { by: 'you', note: 'converted to a fact' }],
  ]);
  expect(logged).toEqual([expect.objectContaining({ kind: 'lesson_to_fact', actor: 'you', projectKey: 'demo', targets: ['lesson:a', 'fact:1'] })]);
  expect(logged[0].why).toMatch(/^you /);
});

test("to-fact takes the kind and relevance you chose, and the lesson's first path (a glob to its folder)", async () => {
  const { app, calls } = factSetup({ ...lesson, paths: ['src/orders/**/*.ts', 'src/other.ts'] });
  expect((await app.request('/api/lessons/lesson%3Aa/to-fact', post({ kind: 'gotcha', relevance: 0.3 }))).status).toBe(201);
  expect(calls[0][2]).toMatchObject({ kind: 'gotcha', relevance: 0.3, path: 'src/orders' });
  const exact = factSetup({ ...lesson, paths: ['./src/orders/sync.ts'] });
  await exact.app.request('/api/lessons/lesson%3Aa/to-fact', post({}));
  expect(exact.calls[0][2]).toMatchObject({ path: 'src/orders/sync.ts' });
});

test('to-fact refuses a bad kind or relevance, an unknown lesson, a decided one, and one with no project', async () => {
  const { app } = factSetup();
  expect((await app.request('/api/lessons/lesson%3Aa/to-fact', post({ kind: 'opinion' }))).status).toBe(400);
  expect((await app.request('/api/lessons/lesson%3Aa/to-fact', post({ relevance: 2 }))).status).toBe(400);
  expect((await app.request('/api/lessons/nope/to-fact', post({}))).status).toBe(404);
  for (const status of ['rejected', 'superseded'] as const) {
    const s = factSetup({ ...lesson, status });
    expect((await s.app.request('/api/lessons/lesson%3Aa/to-fact', post({}))).status).toBe(409);
    expect(s.calls).toEqual([]);
  }
  const global = factSetup({ ...lesson, projectKey: null, origin: null, scope: 'global' });
  expect((await global.app.request('/api/lessons/lesson%3Aa/to-fact', post({}))).status).toBe(409);
  // A global lesson learned in a project files the fact there.
  const learned = factSetup({ ...lesson, projectKey: null, origin: 'shop', scope: 'global' });
  expect((await learned.app.request('/api/lessons/lesson%3Aa/to-fact', post({}))).status).toBe(201);
  expect(learned.calls[0][1]).toBe('shop');
});

test('to-fact is an owner decision: a bare local client is refused, and the operator token needs lesson_decide', async () => {
  expect((await factSetup().app.request('/api/lessons/lesson%3Aa/to-fact', post({}, {}))).status).toBe(403);
  const op = 'o'.repeat(32);
  const off = factSetup(lesson, { auth: { operator: { token: op, allow: ['inbox_decide'] } } });
  expect((await off.app.request('/api/lessons/lesson%3Aa/to-fact', post({}, { authorization: `Bearer ${op}` }))).status).toBe(403);
  const on = factSetup(lesson, { auth: { operator: { token: op, allow: ['lesson_decide'] } } });
  expect((await on.app.request('/api/lessons/lesson%3Aa/to-fact', post({}, { authorization: `Bearer ${op}`, 'x-fg-operator': 'codex' }))).status).toBe(201);
  expect(on.calls[0][3]).toBe('operator:codex');
  expect(on.calls[1][3]).toEqual({ by: 'operator:codex', note: 'converted to a fact' });
  expect(on.logged[0]).toMatchObject({ actor: 'operator:codex' });
});
