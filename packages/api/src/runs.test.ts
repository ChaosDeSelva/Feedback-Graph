import { NotTheRunsError, OPERATOR_VERBS, type Activity, type ActivityInput, type Lesson, type OperatorVerb, type RunItem, type RunItemKind, type RunOwner, type RunPrincipal, type RunTag } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo, type AppOpts } from './app.ts';
import { runKey } from './operator.ts';
import type { ContextDeps } from './context.ts';

const OP = 'o'.repeat(32);
const KEY = 'test-run-capability-'.padEnd(40, 'a');
const CALLER = runKey(KEY)!;
const json = (method: string, body: object, headers: Record<string, string> = {}) => ({
  method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
});
const op = (run?: string, more: Record<string, string> = {}) => ({ authorization: `Bearer ${OP}`, 'x-fg-operator': 'tester', 'x-fg-run-key': KEY, ...(run && { 'x-fg-run': run }), ...more });
const browser = { origin: 'http://localhost' };

const lesson = (id: string, o: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'demo', title: `Lesson ${id}`, rule: 'R', appliesWhen: 'W', scope: 'project', paths: ['src/**'], status: 'approved',
  source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't', ...o,
});

const entry = (o: Partial<Activity>): Activity => ({
  id: `act:${Math.random()}`, ts: '2026-10-25T10:00:00.000Z', kind: 'context_served', actor: 'agent (MCP)', projectKey: 'demo', subject: 's', why: 'w', details: {}, targets: [], ...o,
});

const API = 'a'.repeat(32);

function setup(o: { allow?: OperatorVerb[]; items?: RunItem[]; entries?: Activity[]; extra?: Partial<AppOpts>; ctx?: Partial<ContextDeps>; owners?: Record<string, RunPrincipal | [RunPrincipal, string | null]>; token?: string } = {}) {
  const logged: ActivityInput[] = [];
  const listed: unknown[] = [];
  const reports: unknown[] = [];
  const checks: unknown[] = [];
  const searched: unknown[] = [];
  const removed: [string, string[]][] = [];
  const removedEntries: string[] = [];
  const removeArgs: { keep: string[]; ids?: string[]; targets?: string[] }[] = [];
  const entries = o.entries ?? [];
  // Who opened each run (RunsStore.claim): the first claim stands.
  const owners = new Map<string, RunOwner>(Object.entries(o.owners ?? {}).map(([run, p]) => [run, { run, principal: Array.isArray(p) ? p[0] : p, actor: Array.isArray(p) ? p[1] : null, firstSeen: 't0' }]));
  const repo = {
    listCandidates: async () => [], stats: async () => [], decide: async () => {},
    // c1 is the owner's; r:<run> was reported in that run (a run decides only on its own).
    candidateDetail: async (id: string) => (id === 'c1' || id.startsWith('r:')
      ? { candidate: { id, projectKey: 'demo', classification: { label: 'pushback', confidence: 0.9 }, ...(id.startsWith('r:') && { run: id.slice(2) }) }, turn: { text: 'no' }, before: [], after: [], commits: [] }
      : null),
  } as unknown as ApiRepo;
  const ctx: ContextDeps = {
    roots: [{ host: '/Users/j/Vibe', container: '/vibe' }],
    embed: async (t) => t.map(() => [1]),
    k: {
      searchLessons: async (q) => { searched.push(q); return []; },
      relatedMisses: async (q) => { searched.push(q); return []; },
      recordPreDoneCheck: async (c) => { checks.push(c); },
      createManualFeedback: async (i) => { reports.push(i); return 'manual:9'; },
    },
    judge: async () => [],
    activity: { record: async (e) => { logged.push(e); } },
    ...o.ctx,
  };
  const app = createApp(repo, {
    auth: { ...(o.token && { token: o.token }), operator: { token: OP, allow: o.allow ?? [...OPERATOR_VERBS] } },
    activity: {
      record: async (e) => { logged.push(e); },
      list: async (q) => {
        listed.push(q);
        return entries.filter((a) => (!q.run || a.run === q.run) && (!q.target || a.targets.includes(q.target)) && (!q.unlabelled || !a.run) && (!q.noSandbox || !a.sandbox)).slice(0, q.limit ?? Infinity);
      },
      removeRun: async (run, keep, opts) => {
        removedEntries.push(run);
        removeArgs.push({ keep: [...(keep ?? [])], ids: opts?.ids ? [...opts.ids] : undefined, targets: opts?.targets ? [...opts.targets] : undefined });
        return entries.filter((a) => a.run === run && (!opts?.ids || opts.ids.includes(a.id)) && !a.targets.some((t) => opts?.targets?.includes(t))).length;
      },
    },
    context: ctx,
    runs: {
      items: async (run) => (run === 'run-1' ? o.items ?? [] : []),
      remove: async (run, keep) => {
        removed.push([run, keep]);
        return { feedback: 1, lesson: 1, miss: 1, predone_check: 0, fact: 0, doc: 1, link: 0, chat: 0 } as Record<RunItemKind, number>;
      },
      claim: async (run, principal, actor) => {
        if (!owners.has(run)) owners.set(run, { run, principal, actor: actor ?? null, firstSeen: 't1' });
        return owners.get(run)!;
      },
      owner: async (run) => owners.get(run) ?? null,
    },
    ...o.extra,
  });
  return { app, logged, listed, reports, checks, searched, removed, removedEntries, removeArgs, owners };
}

const rpc = (name: string, args: object) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
});
const textOf = async (res: Response) => ((await res.json()) as { result: { content: { text: string }[] } }).result.content[0].text;

test('a request labelled x-fg-run records the run on what it logs; x-fg-sandbox marks it; a malformed label is refused, not ignored', async () => {
  const { app, logged } = setup();
  expect((await app.request('/api/candidates/r:run-1/decision', json('POST', { status: 'confirmed' }, op('run-1')))).status).toBe(204);
  expect(logged[0]).toMatchObject({ kind: 'feedback_decided', actor: 'operator:tester', run: 'run-1' });
  expect(logged[0].sandbox).toBeUndefined();
  await app.request('/api/candidates/r:sbx.2/decision', json('POST', { status: 'confirmed' }, op('sbx.2', { 'x-fg-sandbox': '1' })));
  expect(logged[1]).toMatchObject({ run: 'sbx.2', sandbox: true });
  // No label: nothing changes.
  await app.request('/api/candidates/c1/decision', json('POST', { status: 'confirmed' }, op()));
  expect(logged[2].run).toBeUndefined();
  const bads: Record<string, string>[] = [{ 'x-fg-run': 'two words' }, { 'x-fg-run': 'x'.repeat(65) }, { 'x-fg-sandbox': '1' }, { 'x-fg-run': 'ok', 'x-fg-sandbox': 'maybe' }];
  for (const bad of bads) {
    const res = await app.request('/api/candidates/c1/decision', json('POST', { status: 'confirmed' }, { ...op(), ...bad }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/x-fg-(run|sandbox)/);
  }
  // Reads are labelled too (and refused the same way), so a tester sees its mistake on the first call.
  expect((await app.request('/api/stats', { headers: { 'x-fg-run': 'no spaces please' } })).status).toBe(400);
});

test("an MCP agent labels its connection with ?run= (or the header): its report and pre-done check carry the run, and what it was served is logged with it", async () => {
  const { app, logged, reports } = setup();
  const res = await app.request('/mcp?run=run-1&sandbox=1', rpc('report_feedback', { cwd: '/Users/j/Vibe/demo', feedback: 'missed auth', what_was_done: 'endpoint' }));
  expect(await textOf(res)).toContain('manual:9');
  expect(reports).toEqual([expect.objectContaining({ text: 'missed auth', run: { id: 'run-1', sandbox: true } satisfies RunTag })]);
  expect(logged.at(-1)).toMatchObject({ kind: 'candidate_flagged', run: 'run-1', sandbox: true });
  await app.request('/mcp', { ...rpc('get_task_context', { cwd: '/Users/j/Vibe/demo', task: 'search' }), headers: { ...rpc('x', {}).headers, 'x-fg-run': 'run-2' } });
  expect(logged.at(-1)).toMatchObject({ kind: 'context_served', run: 'run-2' });
  expect((await app.request('/mcp?run=bad%20run', rpc('get_task_context', { cwd: '/Users/j/Vibe/demo', task: 'x' }))).status).toBe(400);
});

test("a sandbox run's lessons reach only that run: the searches are asked for the caller's run, and code-map lessons of other sandbox runs are dropped", async () => {
  const lessons = [lesson('l-real'), lesson('l-mine', { run: 'run-1', sandbox: true }), lesson('l-other', { run: 'run-9', sandbox: true }), lesson('l-plain-run', { run: 'run-9' })];
  const { app, searched } = setup({ ctx: { codegraph: { lessonsForPaths: async () => lessons.map((l) => ({ lesson: l, paths: ['src/a.ts'] })) } } });
  const ask = async (url: string) => textOf(await app.request(url, rpc('get_task_context', { cwd: '/Users/j/Vibe/demo', task: 'tune it', files: ['src/a.ts'] })));
  const real = await ask('/mcp');
  expect(real).toContain('Lesson l-real');
  expect(real).toContain('Lesson l-plain-run');
  expect(real).not.toContain('Lesson l-mine');
  expect(real).not.toContain('Lesson l-other');
  expect(searched.every((q) => ((q as { run?: unknown }).run ?? null) === null)).toBe(true);
  const mine = await ask('/mcp?run=run-1');
  expect(mine).toContain('Lesson l-mine');
  expect(mine).not.toContain('Lesson l-other');
  expect((searched.at(-1) as { run?: unknown }).run).toBe('run-1');
});

test("every store read an MCP agent's answer comes from is asked for its run: the code map's per-file views, lists of lessons, facts, links and linked docs", async () => {
  const asked: [string, unknown][] = [];
  const mod = { file: { path: 'src/a.ts', lang: 'typescript', hash: 'h', loc: 1, isTest: false, churn: null }, symbols: [], importers: [], imports: [], tests: [], facts: [], misses: [], lessons: [] };
  const { app } = setup({
    ctx: {
      k: {
        searchLessons: async () => [], relatedMisses: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'manual:9',
        listLessons: async (f) => { asked.push(['listLessons', f.run]); return []; },
      },
      codegraph: {
        lessonsForPaths: async (_k, _p, run) => { asked.push(['lessonsForPaths', run]); return []; },
        moduleContext: async (_k, _p, run) => { asked.push(['moduleContext', run]); return mod; },
        impact: async (_k, _p, _d, run) => { asked.push(['impact', run]); return { paths: ['src/a.ts'], dependents: [], tests: [], misses: [], lessons: [] }; },
      },
      facts: { searchFacts: async () => [], listFacts: async (q) => { asked.push(['listFacts', q.run]); return []; } },
      links: { listLinks: async (q) => { asked.push(['listLinks', q.run]); return []; } },
    },
  });
  const call = (url: string, name: string, args: object) => app.request(url, rpc(name, { cwd: '/Users/j/Vibe/demo', ...args }));
  for (const url of ['/mcp?run=run-1&sandbox=1', '/mcp']) {
    asked.length = 0;
    await call(url, 'get_task_context', { task: 'tune it', files: ['src/a.ts'] });
    await call(url, 'get_module_context', { path: 'src/a.ts' });
    await call(url, 'impact', { paths: ['src/a.ts'] });
    await call(url, 'check_before_done', { task: 't', summary: 's', files_changed: ['src/a.ts'] });
    const kinds = new Set(asked.map(([k]) => k));
    for (const k of ['listLessons', 'lessonsForPaths', 'moduleContext', 'impact', 'listFacts', 'listLinks']) expect(kinds, k).toContain(k);
    expect(asked.every(([, run]) => (url === '/mcp' ? run === undefined || run === null : run === 'run-1')), JSON.stringify(asked)).toBe(true);
  }
});

test("the owner's lists and code-map views are asked for the request's run: none from the browser, so no sandbox record shows", async () => {
  const asked: [string, unknown][] = [];
  const { app } = setup({
    extra: {
      knowledge: {
        listLessons: async (f) => { asked.push(['listLessons', f.run]); return []; }, updateLesson: async () => ({ unscoped: false }), lessonDetail: async () => null,
      },
      codegraph: {
        codeMapMeta: async () => null,
        hotspots: async (_k, _l, o) => { asked.push(['hotspots', o?.run]); return []; },
        moduleContext: async (_k, _p, run) => { asked.push(['moduleContext', run]); return null; },
        impact: async (_k, _p, _d, run) => { asked.push(['impact', run]); return { paths: [], dependents: [], tests: [], misses: [], lessons: [] }; },
        mapGraph: async (_k, o) => { asked.push(['mapGraph', o.run]); return { files: [], imports: [], tests: [], misses: [], lessons: [], cap: { limit: 1, eligible: 0, neighbors: 0, neighborsFound: 0 } }; },
      },
    },
  });
  const paths = ['/api/lessons', '/api/projects/demo/codemap/hotspots', '/api/projects/demo/codemap/module?path=src/a.ts', '/api/projects/demo/codemap/impact?path=src/a.ts', '/api/projects/demo/codemap/graph'];
  for (const p of paths) await app.request(p, { headers: browser });
  expect(asked.map(([k]) => k)).toEqual(['listLessons', 'hotspots', 'moduleContext', 'impact', 'mapGraph']);
  expect(asked.every(([, run]) => (run ?? null) === null)).toBe(true);
  asked.length = 0;
  for (const p of paths) await app.request(p, { headers: op('run-1') });
  expect(asked.every(([, run]) => run === 'run-1')).toBe(true);
});

test('GET /api/activity?run= lists one run; a malformed one is refused', async () => {
  const { app, listed } = setup({ entries: [entry({ run: 'run-1', subject: 'a' }), entry({ subject: 'b' })] });
  const res = await app.request('/api/activity?run=run-1');
  expect(((await res.json()) as Activity[]).map((a) => a.subject)).toEqual(['a']);
  expect(listed.at(-1)).toMatchObject({ run: 'run-1' });
  expect((await app.request('/api/activity?run=a%20b')).status).toBe(400);
});

test("an upload, a link and a lesson's fact made in a run record it", async () => {
  const upserts: unknown[] = [];
  const linked: unknown[] = [];
  const facts: unknown[] = [];
  const { app } = setup({
    extra: {
      embed: async (t) => t.map(() => [1]),
      projectDirs: async () => [{ key: 'demo', name: 'demo', repoPath: '/vibe/demo' }],
      docs: { upsertDoc: async (_d, _c, opts) => { upserts.push(opts); return 'doc:demo:upload:a.md'; }, listDocs: async () => [], deleteDoc: async () => true },
      links: { listLinks: async () => [], setLink: async (a, b, p) => { linked.push(p); return { id: `link:${a}|${b}`, a, b, relation: 'related', note: '', status: 'confirmed', source: 'you', score: 0, evidence: [], createdAt: 't', updatedAt: 't', decidedBy: null }; }, deleteLink: async () => true },
      facts: {
        listProjects: async () => [], requestScan: async () => ({}) as never, listFacts: async () => [], searchFacts: async () => [],
        addOwnerFact: async (...a: unknown[]) => { facts.push(a); return { id: 'f1' } as never; },
      },
      knowledge: {
        listLessons: async () => [], updateLesson: async () => ({ unscoped: false }),
        lessonDetail: async () => ({ lesson: lesson('l1', { status: 'proposed', run: 'run-1', sandbox: true }), miss: null, feedback: null, contextItems: [], fixCommits: [], supersedes: [] }),
      },
    },
  });
  const tag = { 'x-fg-run': 'run-1', 'x-fg-sandbox': 'true' };
  expect((await app.request('/api/projects/demo/docs', json('POST', { title: 'Spec', name: 'a.md', text: 'keep cents' }, op(undefined, tag)))).status).toBe(201);
  expect(upserts[0]).toMatchObject({ addedBy: 'operator:tester', run: { id: 'run-1', sandbox: true } });
  expect((await app.request('/api/links', json('PUT', { a: 'demo', b: 'web', status: 'confirmed' }, op(undefined, tag)))).status).toBe(200);
  expect(linked[0]).toMatchObject({ run: { id: 'run-1', sandbox: true } });
  expect((await app.request('/api/lessons/l1/to-fact', json('POST', {}, op(undefined, tag)))).status).toBe(201);
  expect(facts[0]).toEqual(['demo', expect.anything(), 'operator:tester', { id: 'run-1', sandbox: true }]);
});

const items: RunItem[] = [
  { kind: 'feedback', id: 'manual:a', projectKey: 'demo', sandbox: true, group: null, merged: false },
  { kind: 'lesson', id: 'lesson:manual:a', projectKey: 'demo', sandbox: true, group: 'manual:a', merged: false },
  { kind: 'feedback', id: 'manual:b', projectKey: 'demo', sandbox: true, group: null, merged: false },
  { kind: 'lesson', id: 'lesson:manual:b', projectKey: 'demo', sandbox: true, group: 'manual:b', merged: false },
  { kind: 'feedback', id: 'manual:c', projectKey: 'demo', sandbox: true, group: null, merged: true },
  { kind: 'doc', id: 'doc:demo:upload:a.md', projectKey: 'demo', sandbox: true, group: null, merged: false },
];
const runEntries = [
  entry({ kind: 'candidate_flagged', actor: 'operator:tester', run: 'run-1', targets: ['manual:a'], details: { via: 'api' } }),
  // The owner approved b's lesson in the browser since: the run did not make that decision, so b stays.
  entry({ kind: 'lesson_decided', actor: 'you', targets: ['lesson:manual:b'], details: { via: 'browser' }, subject: 'approved lesson "B"' }),
  // The worker's own work on the run's records is not a touch.
  entry({ kind: 'postmortem_done', actor: 'ollama:m', targets: ['manual:a', 'lesson:manual:a'] }),
  // A decision the run made on the owner's item: never undone, only reported.
  entry({ kind: 'feedback_decided', actor: 'operator:tester', run: 'run-1', targets: ['c-owner'], details: { via: 'operator' }, subject: 'confirmed: "x"' }),
  // So is a pin (it names no record), but not what the run was served.
  entry({ kind: 'project_pinned', actor: 'operator:tester', run: 'run-1', targets: [], details: { via: 'operator' }, subject: 'pinned demo' }),
  entry({ kind: 'context_served', actor: 'operator:tester', run: 'run-1', targets: ['lesson:owner'], details: { via: 'api' } }),
];

test('a dry run (the default) says per kind what would go, what stays and why, and what the run changed that is not its own; nothing is removed', async () => {
  const { app, removed, logged } = setup({ items, entries: runEntries, owners: { 'run-1': ['operator', CALLER] } });
  const plan = (await (await app.request('/api/runs/run-1', { headers: op() })).json()) as Record<string, any>;
  expect(plan).toMatchObject({ run: 'run-1', dryRun: true, sandbox: true, remove: { feedback: 1, lesson: 1, doc: 1, miss: 0 } });
  expect(plan.kept).toEqual([
    { kind: 'feedback', id: 'manual:b', why: expect.stringMatching(/you.*approved lesson "B"/) },
    { kind: 'feedback', id: 'manual:c', why: expect.stringMatching(/detector/) },
  ]);
  expect(plan.changed).toEqual([expect.objectContaining({ kind: 'feedback_decided', targets: ['c-owner'] }), expect.objectContaining({ kind: 'project_pinned', subject: 'pinned demo' })]);
  const dry = await app.request('/api/runs/run-1', json('DELETE', {}, op()));
  expect(dry.status).toBe(200);
  expect(await dry.json()).toMatchObject({ dryRun: true, remove: { feedback: 1 } });
  expect(removed).toEqual([]);
  expect(logged).toEqual([]);
});

test('cleanup removes what the run wrote, keeping what someone else touched since, and logs it', async () => {
  const { app, removed, logged } = setup({ items, entries: runEntries, owners: { 'run-1': ['operator', CALLER] } });
  const res = await app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, op()));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ dryRun: false, removed: { feedback: 1, lesson: 1, doc: 1 } });
  expect(removed).toEqual([['run-1', ['manual:b']]]);
  expect(logged).toEqual([expect.objectContaining({ kind: 'run_cleaned', actor: 'operator:tester', projectKey: null, details: expect.objectContaining({ run: 'run-1', kept: 2 }) })]);
  expect(logged[0].subject).toMatch(/run-1/);
});

test("the operator token may clean up by default, only its own run; a plain client never", async () => {
  expect((await setup({ items }).app.request('/api/runs/run-1', json('DELETE', { dryRun: false }))).status).toBe(403);
  const narrowed = setup({ items, allow: OPERATOR_VERBS.filter((v) => v !== 'run_cleanup'), owners: { 'run-1': ['operator', CALLER] } });
  expect((await narrowed.app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, op()))).status).toBe(403);
  expect((await setup().app.request('/api/runs/not%20a%20run', { headers: op() })).status).toBe(400);
  // A run that wrote nothing: an empty plan, not an error.
  expect(await (await setup().app.request('/api/runs/run-7', { headers: op() })).json()).toMatchObject({ remove: { feedback: 0 }, kept: [] });
});

test('the first labelled write stamps who opened the run: the operator token, the API token, the browser or an agent', async () => {
  const s = setup({ token: API });
  await s.app.request('/api/candidates/c1/decision', json('POST', { status: 'confirmed' }, op('run-op')));
  await s.app.request('/api/candidates/c1/decision', json('POST', { status: 'confirmed' }, { ...browser, authorization: `Bearer ${API}`, 'x-fg-run': 'run-web' }));
  await s.app.request('/mcp?run=run-tok', { ...rpc('report_feedback', { cwd: '/Users/j/Vibe/demo', feedback: 'x', what_was_done: 'y' }), headers: { ...rpc('x', {}).headers, authorization: `Bearer ${API}` } });
  const open = setup();
  await open.app.request('/mcp?run=run-agent', rpc('report_feedback', { cwd: '/Users/j/Vibe/demo', feedback: 'x', what_was_done: 'y' }));
  expect([...s.owners.values()].map((r) => [r.run, r.principal])).toEqual([['run-op', 'operator'], ['run-web', 'browser'], ['run-tok', 'owner_token']]);
  expect(open.owners.get('run-agent')?.principal).toBe('agent');
  // A read never opens a run.
  await s.app.request('/api/stats', { headers: { 'x-fg-run': 'run-read' } });
  expect(s.owners.has('run-read')).toBe(false);
});

test('a run id belongs to whoever opened it: a write under it by anyone else is refused with 409 and writes nothing', async () => {
  const { app, logged, reports } = setup({ owners: { 'run-1': 'agent' } });
  const res = await app.request('/api/candidates/c1/decision', json('POST', { status: 'confirmed' }, op('run-1')));
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toMatch(/run id belongs to another caller/);
  expect(logged).toEqual([]);
  const mine = setup({ owners: { 'run-1': ['operator', CALLER] } });
  const mcp = await mine.app.request('/mcp?run=run-1', rpc('report_feedback', { cwd: '/Users/j/Vibe/demo', feedback: 'x', what_was_done: 'y' }));
  expect(mcp.status).toBe(409);
  expect(mine.reports).toEqual([]);
  expect(reports).toEqual([]);
  // The one who opened it writes on.
  expect((await mine.app.request('/api/candidates/r:run-1/decision', json('POST', { status: 'confirmed' }, op('run-1')))).status).toBe(204);
});

test("the operator token cleans up its own run, and is refused (403) on an owner-token, browser or legacy run; the owner may clean any", async () => {
  const own = setup({ items });
  expect((await own.app.request('/api/candidates/r:run-1/decision', json('POST', { status: 'confirmed' }, op('run-1')))).status).toBe(204);
  expect((await own.app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, op()))).status).toBe(200);
  expect(own.removed).toHaveLength(1);
  for (const principal of ['owner_token', 'browser', 'agent'] as const) {
    const s = setup({ items, owners: { 'run-1': principal } });
    const refused = await s.app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, op()));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(/private FG_RUN_KEY/);
    expect(s.removed).toEqual([]);
    expect((await s.app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, browser))).status).toBe(200);
    expect(s.removed).toHaveLength(1);
  }
  // Opened before owners were recorded: the owner's only.
  const legacy = setup({ items });
  expect((await legacy.app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, op()))).status).toBe(403);
  expect((await legacy.app.request('/api/runs/run-1', json('DELETE', {}, op()))).status).toBe(403);
  expect((await legacy.app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, browser))).status).toBe(200);
  // However many Activity entries the run has, the owner record decides, not a scan of them.
  const busy = setup({ items, owners: { 'run-1': 'browser' }, entries: Array.from({ length: 6000 }, () => entry({ run: 'run-1', details: { via: 'operator' } })) });
  expect((await busy.app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, op()))).status).toBe(403);
});

test('run ownership requires a secret capability, independent of the display name', async () => {
  const s = setup({ items });
  const path = '/api/candidates/r:run-1/decision';
  expect((await s.app.request(path, json('POST', { status: 'confirmed' }, op('run-1')))).status).toBe(204);
  expect(s.owners.get('run-1')).toMatchObject({ principal: 'operator', actor: CALLER });
  // Copying the display name cannot impersonate the caller.
  const other = { 'x-fg-run-key': 'another-secret-capability'.padEnd(40, 'b') };
  expect((await s.app.request(path, json('POST', { status: 'confirmed' }, op('run-1', other)))).status).toBe(409);
  expect((await s.app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, op(undefined, other)))).status).toBe(403);
  expect(s.removed).toEqual([]);
  // A different display name with the same capability is still the same caller.
  expect((await s.app.request(path, json('POST', { status: 'confirmed' }, op('run-1', { 'x-fg-operator': 'renamed' })))).status).toBe(204);
  expect((await s.app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, op(undefined, { 'x-fg-operator': 'renamed' })))).status).toBe(200);
  for (const actor of [null, 'operator:tester']) {
    const legacy = setup({ items, owners: { 'run-1': ['operator', actor] } });
    expect((await legacy.app.request(path, json('POST', { status: 'confirmed' }, op('run-1')))).status).toBe(409);
    expect((await legacy.app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, op()))).status).toBe(403);
    expect((await legacy.app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, browser))).status).toBe(200);
  }
});

test('an operator cannot clean another agent run; the owner can', async () => {
  const s = setup({ items, owners: { 'run-1': 'agent' } });
  expect((await s.app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, op()))).status).toBe(403);
  expect(s.removed).toEqual([]);
  expect((await s.app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, browser))).status).toBe(200);
});

test("cleanup with --apply also removes the run's Activity entries, all but the run_cleaned entry, which keeps what the run changed; the dry run says so", async () => {
  const { app, removedEntries, logged } = setup({ items, entries: runEntries, owners: { 'run-1': ['operator', CALLER] } });
  const dry = (await (await app.request('/api/runs/run-1', json('DELETE', {}, op()))).json()) as Record<string, any>;
  expect(dry).toMatchObject({ dryRun: true, entries: 4, entriesCapped: false });
  expect(removedEntries).toEqual([]);
  const res = (await (await app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, op()))).json()) as Record<string, any>;
  expect(res).toMatchObject({ dryRun: false, entriesRemoved: 4 });
  expect(removedEntries).toEqual(['run-1']);
  const cleaned = logged.at(-1)!;
  expect(cleaned).toMatchObject({ kind: 'run_cleaned', run: null, details: expect.objectContaining({ entriesRemoved: 4 }) });
  expect((cleaned.details as { changedItems: unknown[] }).changedItems).toEqual([expect.objectContaining({ kind: 'feedback_decided' }), expect.objectContaining({ kind: 'project_pinned' })]);
  expect(cleaned.why).toMatch(/its Activity entries go too/);
});

test('cleanup keeps the history of every record it keeps: the entry that created a record the owner decided on stays', async () => {
  const created = entry({ kind: 'postmortem_done', actor: 'ollama:m', run: 'run-1', targets: ['manual:b', 'lesson:manual:b'], subject: 'proposed lesson "B"' });
  const { app, removeArgs } = setup({ items, entries: [...runEntries, created], owners: { 'run-1': ['operator', CALLER] } });
  const res = (await (await app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, op()))).json()) as Record<string, any>;
  // b (decided by the owner) and c (merged into a session's Inbox item) stay, and so do the entries about them.
  expect([...removeArgs[0].targets!].sort()).toEqual(['lesson:manual:b', 'manual:b', 'manual:c']);
  expect(res.entriesRemoved).toBe(4);
});

test('a run with more entries than a cleanup reads: only the entries it read (and listed) go; every change among them is listed; the rest stay for the next cleanup', async () => {
  const many = Array.from({ length: 5100 }, (_, i) => entry({
    id: `act:${String(i).padStart(5, '0')}`, actor: 'operator:tester', run: 'run-1', ...(i % 20 === 0
      ? { kind: 'project_pinned' as const, details: { via: 'operator' }, subject: `pinned ${i}` }
      : { kind: 'context_served' as const, details: { via: 'api' } }),
  }));
  const { app, removeArgs, logged } = setup({ items: [], entries: many, owners: { 'run-1': ['operator', CALLER] } });
  const res = (await (await app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, op()))).json()) as Record<string, any>;
  expect(res).toMatchObject({ entriesCapped: true, entriesRemoved: 5000 });
  expect(removeArgs[0].ids).toHaveLength(5000);
  expect(removeArgs[0].ids).not.toContain('act:05099');
  const cleaned = logged.at(-1)!;
  // 250 changes in what was read: every one listed, not the first 200.
  expect((cleaned.details as { changedItems: unknown[] }).changedItems).toHaveLength(250);
  expect(cleaned.why).toMatch(/more Activity entries than one cleanup reads \(5000\): those not read stay, with what they changed; clean up again/);
});

test("the default Activity feed leaves out every labelled run's entries; ?run= shows one run's; a record's history (target=) keeps runs but never another's sandbox", async () => {
  const entries = [entry({ subject: 'owner' }), entry({ run: 'run-1', subject: 'stress', targets: ['l1'] }), entry({ run: 'sbx-1', sandbox: true, subject: 'sandbox', targets: ['l1'] })];
  const { app, listed } = setup({ entries });
  const subjects = async (url: string) => ((await (await app.request(url)).json()) as Activity[]).map((a) => a.subject);
  expect(await subjects('/api/activity')).toEqual(['owner']);
  expect(listed.at(-1)).toMatchObject({ unlabelled: true });
  expect(await subjects('/api/activity?kind=context_served')).toEqual(['owner']);
  expect(await subjects('/api/activity?run=run-1')).toEqual(['stress']);
  expect(await subjects('/api/activity?run=sbx-1')).toEqual(['sandbox']);
  expect(await subjects('/api/activity?target=l1')).toEqual(['stress']);
  expect(listed.at(-1)).toMatchObject({ noSandbox: true });
  expect((listed.at(-1) as { unlabelled?: boolean }).unlabelled).toBeUndefined();
  // ?runs=1 (the Activity page with "hide labelled runs" off): every run's entries, but never another's sandbox.
  expect(await subjects('/api/activity?runs=1')).toEqual(['owner', 'stress']);
  expect(listed.at(-1)).toMatchObject({ noSandbox: true });
});

test('a cleanup request never claims a run: the owner cleans an agent run while labelled with it, a dry run of an unused id leaves it free, and run_cleaned is not tagged with the run it removed', async () => {
  // The owner (browser) cleaning a run an agent opened, the request labelled with that run.
  const { app, logged, owners } = setup({ items, entries: runEntries, owners: { 'run-1': 'agent' } });
  const res = await app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, { ...browser, 'x-fg-run': 'run-1' }));
  expect(res.status).toBe(200);
  expect(logged).toEqual([expect.objectContaining({ kind: 'run_cleaned' })]);
  expect(logged[0].run ?? null).toBeNull();
  expect(owners.get('run-1')?.principal).toBe('agent');
  // A dry run (and a plan read) of an id nobody used yet does not open it: the tester's later writes under it are its own.
  expect((await app.request('/api/runs/run-9', json('DELETE', {}, op('run-9')))).status).toBe(200);
  await app.request('/api/runs/run-9', { headers: op('run-9') });
  expect(owners.has('run-9')).toBe(false);
});

test('the admin MCP run_cleanup, in a request labelled with the run, logs run_cleaned untagged', async () => {
  const { app, logged } = setup({ items, entries: runEntries, owners: { 'run-1': ['operator', CALLER] } });
  const req = rpc('run_cleanup', { run: 'run-1', apply: true });
  const res = await app.request('/mcp/admin?run=run-1', { ...req, headers: { ...req.headers, ...op() } });
  expect(res.status).toBe(200);
  const cleaned = logged.filter((e) => e.kind === 'run_cleaned');
  expect(cleaned).toHaveLength(1);
  expect(cleaned[0].run ?? null).toBeNull();
});

// ── A run never takes over a record it does not own ────────────────────

type Ownership = { docs: unknown[]; deletedDocs: unknown[]; links: unknown[]; deletedLinks: unknown[]; relevance: unknown[]; pins: unknown[]; decided: unknown[]; updated: unknown[]; chats: unknown[] };

/** Stores that record what they were asked: the owner's records carry no run, the "mine" ones were made in run-1. */
function owned(o: { owners?: Record<string, RunPrincipal>; refuse?: boolean } = {}) {
  const got: Ownership = { docs: [], deletedDocs: [], links: [], deletedLinks: [], relevance: [], pins: [], decided: [], updated: [], chats: [] };
  const conv = (id: string) => ({ id, projectKey: 'demo', title: 't', provider: null, createdAt: 't', updatedAt: 't', pending: false, turns: [], ...(id === 'chat:mine' && { run: 'run-1' }) });
  const { app } = setup({
    owners: o.owners,
    extra: {
      embed: async (t) => t.map(() => [1]),
      projectDirs: async () => [{ key: 'demo', name: 'demo', repoPath: '/vibe/demo' }, { key: 'web', name: 'web', repoPath: '/vibe/web' }],
      docs: {
        upsertDoc: async (_d, _c, opts) => {
          got.docs.push(opts);
          if (o.refuse) throw new NotTheRunsError('the document a.md', opts?.run?.id ?? '?');
          return 'doc:demo:upload:a.md';
        },
        listDocs: async () => [],
        deleteDoc: async (id, q) => { got.deletedDocs.push([id, q]); return true; },
      },
      links: {
        listLinks: async () => [],
        setLink: async (a, b, p) => {
          got.links.push(p);
          if (o.refuse) throw new NotTheRunsError('the link', p.run?.id ?? '?');
          return { id: `link:${a}|${b}`, a, b, relation: 'related', note: '', status: 'confirmed', source: 'you', score: 0, evidence: [], createdAt: 't', updatedAt: 't', decidedBy: null };
        },
        deleteLink: async (id, q) => { got.deletedLinks.push([id, q]); return true; },
      },
      facts: {
        listProjects: async () => [], requestScan: async () => ({}) as never, listFacts: async () => [], searchFacts: async () => [],
        setFactRelevance: async (u) => { got.relevance.push(...u); return 1; },
        setPinned: async (p, pinned) => { got.pins.push([p.key, pinned]); },
        addOwnerFact: async () => ({ id: 'f1' }) as never,
      },
      knowledge: {
        listLessons: async () => [],
        updateLesson: async (id) => { got.updated.push(id); return { unscoped: false }; },
        lessonDetail: async (id: string) => ({ lesson: lesson(id, { status: 'proposed', ...(id === 'mine' && { run: 'run-1' }) }), miss: null, feedback: null, contextItems: [], fixCommits: [], supersedes: [] }),
      },
      chat: {
        store: {
          listConversations: async () => [],
          createConversation: async () => conv('chat:new'),
          conversation: async (id: string) => conv(id),
          addUserTurn: async () => { got.chats.push('message'); return {} as never; },
          updateConversation: async () => { got.chats.push('patch'); return conv('x'); },
          retryTurn: async () => null,
          deleteConversation: async () => { got.chats.push('delete'); return true; },
        },
        build: async () => ({ context: '', sources: [] }),
      },
    },
  });
  return { app, got };
}

const RUN = { 'x-fg-run': 'run-1' };
const SANDBOX = { 'x-fg-run': 'run-1', 'x-fg-sandbox': '1' };
const del = (headers: Record<string, string>) => ({ method: 'DELETE', headers: { 'content-type': 'application/json', ...headers } });

test("an upload in a run says whether the owner opened it (byOwner); a store's refusal (not the run's document) is a 409 that says why", async () => {
  const body = { title: 'A', name: 'a.md', text: 'x' };
  const { app, got } = owned();
  expect((await app.request('/api/projects/demo/docs', json('POST', body, op(undefined, RUN)))).status).toBe(201);
  expect(got.docs[0]).toMatchObject({ run: { id: 'run-1', sandbox: false } });
  expect((got.docs[0] as { byOwner?: boolean }).byOwner).toBeFalsy();

  const owner = owned({ owners: { 'run-1': 'browser' } });
  expect((await owner.app.request('/api/projects/demo/docs', json('POST', body, { ...browser, ...RUN }))).status).toBe(201);
  expect(owner.got.docs[0]).toMatchObject({ run: { id: 'run-1', sandbox: false }, byOwner: true });

  const refused = owned({ refuse: true });
  const res = await refused.app.request('/api/projects/demo/docs', json('POST', body, op(undefined, RUN)));
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toMatch(/not run run-1's/);
});

test("a link decision in a run carries byOwner only for the owner's run; a refusal is a 409; a removal in a run asks for the run's own row, and a sandbox row's id is understood", async () => {
  const { app, got } = owned();
  expect((await app.request('/api/links', json('PUT', { a: 'demo', b: 'web', status: 'dismissed' }, op(undefined, SANDBOX)))).status).toBe(200);
  expect(got.links[0]).toMatchObject({ run: { id: 'run-1', sandbox: true } });
  expect((await app.request('/api/links/link@run-1:demo|web', del(op(undefined, SANDBOX)))).status).toBe(204);
  expect(got.deletedLinks[0]).toEqual(['link@run-1:demo|web', { run: 'run-1' }]);
  // Outside a run (the owner): any link.
  expect((await app.request('/api/links/link:demo|web', del(browser))).status).toBe(204);
  expect(got.deletedLinks[1]).toEqual(['link:demo|web', {}]);

  const refused = owned({ refuse: true });
  expect((await refused.app.request('/api/links', json('PUT', { a: 'demo', b: 'web', status: 'dismissed' }, op(undefined, RUN)))).status).toBe(409);
});

test('a document removal in a run removes only what the run uploaded', async () => {
  const { app, got } = owned();
  await app.request('/api/docs/doc:demo:upload:a.md', del(op(undefined, RUN)));
  expect(got.deletedDocs[0]).toEqual(['doc:demo:upload:a.md', { run: 'run-1' }]);
  await app.request('/api/docs/doc:demo:upload:a.md', del(browser));
  expect(got.deletedDocs[1]).toEqual(['doc:demo:upload:a.md', {}]);
});

test("relevance in a run changes only the run's facts; the owner's setting is the owner's (run null, so a run's fact becomes theirs)", async () => {
  const { app, got } = owned();
  await app.request('/api/projects/demo/facts/f1/relevance', json('PATCH', { relevance: 0.2 }, op(undefined, RUN)));
  await app.request('/api/projects/demo/facts/f1/relevance', json('PATCH', { relevance: 0.9 }, browser));
  expect(got.relevance).toMatchObject([{ id: 'f1', run: 'run-1' }, { id: 'f1', run: null }]);
});

test("a run never pins, decides on, converts or talks in the owner's records (409, nothing changed); its own are fine, and the owner's own run may", async () => {
  const { app, got } = owned();
  const refused = async (res: Response | Promise<Response>) => {
    const r = await res;
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/not run run-1's/);
  };
  await refused(app.request('/api/projects/demo/pin', json('PUT', { pinned: true }, op(undefined, SANDBOX))));
  await refused(app.request('/api/candidates/c1/decision', json('POST', { status: 'confirmed' }, op(undefined, RUN))));
  await refused(app.request('/api/lessons/owner', json('PATCH', { status: 'approved' }, op(undefined, RUN))));
  await refused(app.request('/api/lessons/owner/to-fact', json('POST', {}, op(undefined, RUN))));
  const bulk = await app.request('/api/lessons/decisions', json('POST', { items: [{ id: 'owner', status: 'approved' }, { id: 'mine', status: 'approved' }] }, op(undefined, RUN)));
  expect(((await bulk.json()) as { results: { ok: boolean }[] }).results.map((r) => r.ok)).toEqual([false, true]);
  await refused(app.request('/api/chats/chat:owner/messages', json('POST', { text: 'q' }, op(undefined, RUN))));
  await refused(app.request('/api/chats/chat:owner', json('PATCH', { title: 'x' }, op(undefined, RUN))));
  await refused(app.request('/api/chats/chat:owner', del(op(undefined, RUN))));
  expect(got.pins).toEqual([]);
  expect(got.updated).toEqual(['mine']);
  expect(got.chats).toEqual([]);

  // Its own: changed.
  expect((await app.request('/api/lessons/mine', json('PATCH', { status: 'approved' }, op(undefined, RUN)))).status).toBe(204);
  expect((await app.request('/api/chats/chat:mine', json('PATCH', { title: 'x' }, op(undefined, RUN)))).status).toBe(200);

  // The owner, in a run the browser opened (not a sandbox): theirs to change.
  const owner = owned({ owners: { 'run-1': 'browser' } });
  expect((await owner.app.request('/api/projects/demo/pin', json('PUT', { pinned: true }, { ...browser, ...RUN }))).status).toBe(204);
  expect((await owner.app.request('/api/lessons/owner', json('PATCH', { status: 'approved' }, { ...browser, ...RUN }))).status).toBe(204);
  // A sandbox run, even the owner's, never changes the owner's records.
  const sbx = owned({ owners: { 'run-1': 'browser' } });
  expect((await sbx.app.request('/api/projects/demo/pin', json('PUT', { pinned: true }, { ...browser, ...SANDBOX }))).status).toBe(409);
});


test('operator-labelled writes require a valid run capability', async () => {
  for (const key of ['', 'short']) {
    const s = setup();
    const res = await s.app.request('/api/candidates/r:run-1/decision', json('POST', { status: 'confirmed' }, op('run-1', { 'x-fg-run-key': key })));
    expect(res.status).toBe(403);
    expect(s.logged).toEqual([]);
    expect(s.owners.size).toBe(0);
  }
});

test('cleanup preserves request Activity written by another displayed caller', async () => {
  const mine = entry({ id: 'mine', run: 'run-1', actor: 'operator:tester', details: { via: 'operator' } });
  const other = entry({ id: 'other', run: 'run-1', actor: 'operator:other', details: { via: 'operator' } });
  const s = setup({ items: [], entries: [mine, other], owners: { 'run-1': ['operator', CALLER] } });
  const res = await s.app.request('/api/runs/run-1', json('DELETE', { dryRun: false }, op()));
  expect(res.status).toBe(200);
  expect(s.removeArgs[0].ids).toEqual(['mine']);
});
