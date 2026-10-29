import { shownProjects, type ActivityInput, type Lesson, type ShownProjects } from '@fb/core';
import { describe, expect, test } from 'vitest';
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

test('GET /api/lessons/:id never shows a context item why that is only a field name (stored before the check)', async () => {
  const item = (why: string) => ({ kind: 'code' as const, ref: 'api/search.ts', excerpt: 'x', why, wasAvailable: true });
  const knowledge = {
    listLessons: async () => [lesson],
    lessonDetail: async () => ({ lesson, miss: null, feedback: null, contextItems: [item('wasAvailable'), item('It scoped by org')], fixCommits: [], supersedes: [] }),
    updateLesson: async () => ({ unscoped: false }),
  };
  const app = createApp(repo, { knowledge, embed: async (t) => t.map(() => [0.5]) });
  const d = await (await app.request('/api/lessons/lesson%3Aa')).json();
  expect(d.contextItems.map((c: { why: string }) => c.why)).toEqual(['the model gave no reason', 'It scoped by org']);
});

test('PATCH approving without text changes does not re-embed', async () => {
  const { app, calls, embedded } = setup();
  const res = await app.request('/api/lessons/lesson%3Aa', patch({ status: 'approved' }));
  expect(res.status).toBe(200);
  expect(embedded).toEqual([]);
  expect(calls).toContainEqual(['update', 'lesson:a', { status: 'approved' }, { reembed: undefined, by: 'you' }]);
});

test('PATCH editing the rule re-embeds the lesson text', async () => {
  const { app, calls, embedded } = setup();
  await app.request('/api/lessons/lesson%3Aa', patch({ rule: 'New rule', scope: 'global' }));
  expect(embedded).toEqual([['T\nNew rule\nApplies when: W']]);
  expect(calls).toContainEqual(['update', 'lesson:a', { rule: 'New rule', scope: 'global' }, { reembed: [0.5], by: 'you' }]);
});

describe('narrowing a global lesson to a project', () => {
  const global: Lesson = { ...lesson, id: 'lesson:g', projectKey: null, origin: null, scope: 'global', source: 'manual' };
  function narrowSetup(o: { shown?: string[] } = {}) {
    const calls: unknown[][] = [];
    const knowledge = {
      listLessons: async () => [global],
      lessonDetail: async (id: string) => (id === global.id ? { lesson: global, miss: null, feedback: null, contextItems: [], fixCommits: [], supersedes: [] } : null),
      // As both stores: a narrowed lesson with neither a project given nor one to trace it to is unscoped.
      updateLesson: async (id: string, p: { scope?: string; projectKey?: string }) => { calls.push(['update', id, p]); return { unscoped: !p.projectKey && (p.scope === 'project' || p.scope === 'task') }; },
    };
    const projectDirs = async () => [{ key: 'web', name: 'web', repoPath: '/repos/web' }, { key: 'data-pipeline', name: 'data-pipeline', repoPath: '/repos/data-pipeline' }];
    const keys = o.shown;
    const shown = keys && (async () => ({ initialized: true, keys, has: (k: string) => keys.includes(k) }) as ShownProjects);
    const app = createApp(repo, { knowledge, projectDirs, ...(shown && { shown }) } as AppOpts);
    return { app, calls };
  }

  test('with no project named it is still refused (409), and the error says to name one', async () => {
    const { app, calls } = narrowSetup();
    const res = await app.request('/api/lessons/lesson%3Ag', patch({ scope: 'project' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/projectKey/);
    expect(calls).toEqual([]);
  });

  test('with a known project it is narrowed to that project', async () => {
    const { app, calls } = narrowSetup();
    expect((await app.request('/api/lessons/lesson%3Ag', patch({ scope: 'project', projectKey: 'data-pipeline' }))).status).toBe(200);
    expect(calls).toContainEqual(['update', 'lesson:g', { scope: 'project', projectKey: 'data-pipeline' }]);
  });

  test('an unknown project, one not selected, or a project on a lesson staying global is a 400', async () => {
    const { app, calls } = narrowSetup({ shown: ['web'] });
    expect((await app.request('/api/lessons/lesson%3Ag', patch({ scope: 'task', projectKey: 'acme-legacy' }))).status).toBe(400);
    expect((await app.request('/api/lessons/lesson%3Ag', patch({ scope: 'project', projectKey: 'data-pipeline' }))).status).toBe(400);
    expect((await app.request('/api/lessons/lesson%3Ag', patch({ projectKey: 'web' }))).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await app.request('/api/lessons/lesson%3Ag', patch({ scope: 'task', projectKey: 'web' }))).status).toBe(200);
  });

  test('a project lesson cannot be moved to another project with projectKey', async () => {
    const { app } = setup();
    expect((await app.request('/api/lessons/lesson%3Aa', patch({ scope: 'project', projectKey: 'web' }))).status).toBe(400);
  });
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

test('GET /api/lessons filters by a check flag and by where the feedback came from; unknown values are a 400', async () => {
  const { app, calls } = setup();
  expect((await app.request('/api/lessons?status=proposed&flag=looks-like-a-fact&source=github')).status).toBe(200);
  expect(calls[0]).toEqual(['list', { status: 'proposed', flag: 'looks-like-a-fact', from: 'github' }]);
  expect((await app.request('/api/lessons?flag=nonsense')).status).toBe(400);
  expect((await app.request('/api/lessons?source=slack')).status).toBe(400);
});

function bulkSetup(o: { auth?: AppOpts['auth'] } = {}) {
  const calls: unknown[][] = [];
  const logged: ActivityInput[] = [];
  const lessons: Lesson[] = [lesson, { ...lesson, id: 'lesson:b', title: 'B' }, { ...lesson, id: 'lesson:hidden', projectKey: 'other' }];
  const knowledge = {
    listLessons: async () => lessons,
    lessonDetail: async (id: string) => {
      const l = lessons.find((x) => x.id === id);
      return l ? { lesson: l, miss: null, feedback: null, contextItems: [], fixCommits: [], supersedes: [] } : null;
    },
    updateLesson: async (...a: unknown[]) => { calls.push(['update', ...a]); return { unscoped: false }; },
    requestLessonRecheck: async () => { calls.push(['recheck']); return 7; },
  };
  const app = createApp(repo, {
    knowledge, ...(o.auth && { auth: o.auth }),
    activity: { record: async (e) => { logged.push(e); }, list: async () => [] },
    shown: async () => shownProjects({ tracked: ['demo'], initialized: true }, { excludeProjects: [] }),
  });
  return { app, calls, logged };
}

test('POST /api/lessons/decisions decides each lesson with its note, records each as yours, and reports the ones not found', async () => {
  const { app, calls, logged } = bulkSetup();
  const res = await app.request('/api/lessons/decisions', post({
    items: [{ id: 'lesson:a', status: 'rejected', note: 'a platitude' }, { id: 'lesson:b', status: 'approved' }, { id: 'lesson:nope', status: 'rejected' }],
  }));
  expect(res.status).toBe(200);
  expect((await res.json()).results).toEqual([
    { id: 'lesson:a', ok: true, status: 'rejected' },
    { id: 'lesson:b', ok: true, status: 'approved' },
    { id: 'lesson:nope', ok: false, error: 'not found' },
  ]);
  expect(calls).toEqual([
    ['update', 'lesson:a', { status: 'rejected' }, { by: 'you', note: 'a platitude' }],
    ['update', 'lesson:b', { status: 'approved' }, { by: 'you' }],
  ]);
  expect(logged.map((e) => [e.kind, e.actor, e.targets])).toEqual([['lesson_decided', 'you', ['lesson:a']], ['lesson_decided', 'you', ['lesson:b']]]);
  expect(logged[0].details).toMatchObject({ status: 'rejected', note: 'a platitude', bulk: true });
});

test('bulk decisions: a bad status, an empty list or more than 500 is a 400; a lesson of a hidden project is not found', async () => {
  const { app, calls } = bulkSetup();
  expect((await app.request('/api/lessons/decisions', post({ items: [{ id: 'lesson:a', status: 'superseded' }] }))).status).toBe(400);
  expect((await app.request('/api/lessons/decisions', post({ items: [] }))).status).toBe(400);
  expect((await app.request('/api/lessons/decisions', post({ items: Array.from({ length: 501 }, (_, i) => ({ id: `l${i}`, status: 'rejected' })) }))).status).toBe(400);
  const res = await app.request('/api/lessons/decisions', post({ items: [{ id: 'lesson:hidden', status: 'approved' }] }));
  expect((await res.json()).results).toEqual([{ id: 'lesson:hidden', ok: false, error: 'not found' }]);
  expect(calls).toEqual([]);
});

test("bulk decisions are the owner's: a bare client is refused, the operator token needs lesson_decide (off by default)", async () => {
  expect((await bulkSetup().app.request('/api/lessons/decisions', post({ items: [{ id: 'lesson:a', status: 'approved' }] }, {}))).status).toBe(403);
  const op = 'o'.repeat(32);
  const off = bulkSetup({ auth: { operator: { token: op, allow: ['inbox_decide', 'retry'] } } });
  const refused = await off.app.request('/api/lessons/decisions', post({ items: [{ id: 'lesson:a', status: 'approved' }] }, { authorization: `Bearer ${op}` }));
  expect(refused.status).toBe(403);
  expect(off.calls).toEqual([]);
  const on = bulkSetup({ auth: { operator: { token: op, allow: ['lesson_decide'] } } });
  await on.app.request('/api/lessons/decisions', post({ items: [{ id: 'lesson:a', status: 'approved' }] }, { authorization: `Bearer ${op}`, 'x-fg-operator': 'codex' }));
  expect(on.calls).toEqual([['update', 'lesson:a', { status: 'approved' }, { by: 'operator:codex' }]]);
  expect(on.logged[0]).toMatchObject({ actor: 'operator:codex' });
});

test('POST /api/lessons/recheck marks every proposed and approved lesson for the worker to re-check', async () => {
  const { app, calls, logged } = bulkSetup();
  const res = await app.request('/api/lessons/recheck', post({}));
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ queued: 7 });
  expect(calls).toEqual([['recheck']]);
  expect(logged).toEqual([expect.objectContaining({ kind: 'lessons_checked', actor: 'you', subject: '7 lessons queued for a re-check' })]);
  // Owner-only, under the operator's `retry` verb.
  expect((await app.request('/api/lessons/recheck', post({}, {}))).status).toBe(403);
});


test('Lessons can be filtered by originating PR and feedback author', async () => {
  const { app, calls } = setup();
  expect((await app.request('/api/lessons?pr=42&author=Octo')).status).toBe(200);
  expect(calls[0]).toEqual(['list', expect.objectContaining({ pr: 42, author: 'Octo' })]);
  expect((await app.request('/api/lessons?pr=-1')).status).toBe(400);
});


test('lesson edits and bulk decisions disclose next-sync sharing in responses and Activity', async () => {
  const { app, logged } = bulkSetup();
  const edit = await app.request('/api/lessons/lesson%3Aa', patch({ rule: 'Use scoped reads' }));
  expect(edit.status).toBe(200);
  const edited = await edit.json();
  expect(edited.sharing).toMatchObject({ mode: 'next_sync_if_enabled', message: expect.stringContaining('next scheduled sync') });
  expect(logged[0].why).toContain('does not start a cloud sync');
  expect(logged[0].details?.sharing).toEqual(edited.sharing);
  const bulk = await app.request('/api/lessons/decisions', post({ items: [{ id: 'lesson:b', status: 'approved' }] }));
  expect((await bulk.json()).sharing).toEqual(edited.sharing);
  expect(logged[1].details?.sharing).toEqual(edited.sharing);
});

test('lesson edit embeddings never send credential values to a provider', async () => {
  const { app, embedded } = setup();
  const secret = 'ghp_' + 'aB12'.repeat(9);
  expect((await app.request('/api/lessons/lesson%3Aa', patch({ rule: `Use ${secret} in CI` }))).status).toBe(200);
  expect(embedded.flat().join(' ')).toContain('[REDACTED]');
  expect(embedded.flat().join(' ')).not.toContain(secret);
});

test('refused lesson edits do not call an embedding provider', async () => {
  const { app, embedded } = setup();
  expect((await app.request('/api/lessons/lesson%3Aa', patch({ rule: 'New wording', supersedes: 'lesson:a' }))).status).toBe(400);
  expect(embedded).toEqual([]);
});
