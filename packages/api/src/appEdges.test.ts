import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shownProjects, type Candidate, type Lesson, type ScanQueueEntry, type WorkerStatus } from '@fb/core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp, scanQueueOf, type ApiRepo } from './app.ts';

const OWNER = 'owner-test-token-01234567890123456789';
const API = 'api-test-token-0123456789012345678901';
const OP = 'operator-test-token-01234567890123456';
const RUN_KEY = 'c2ad856fb97403e18a2e7dc9015b6f438670dcaeb3219a845f0d7c8b6e109234';
const owner = { authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true', 'content-type': 'application/json' };
const json = { 'content-type': 'application/json' };

const cand = (o: Partial<Candidate> = {}): Candidate => ({
  id: 'c1', turnUuid: 'c1', sessionId: 's', projectKey: 'demo', source: 'claude',
  classification: { label: 'pushback', confidence: 0.9, summary: 'x', signals: [] },
  status: 'pending', createdAt: 't', decidedAt: null, note: null, ...o,
});
const lesson = (o: Partial<Lesson> = {}): Lesson => ({
  id: 'l1', projectKey: 'demo', title: 'T', rule: 'R', appliesWhen: 'a', scope: 'project', paths: [],
  status: 'proposed', source: 'postmortem', cause: 'requirement_unstated', missId: null, createdAt: 't', decidedAt: null, ...o,
});
const repo = (o: Partial<ApiRepo> = {}): ApiRepo => ({
  listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [], ...o,
} as ApiRepo);
const shown = (...keys: string[]) => () => shownProjects({ tracked: keys, initialized: true }, { excludeProjects: [] }, new Map());
const logs = () => {
  const lines: [string, unknown][] = [];
  return { lines, log: (msg: string, extra?: object) => { lines.push([msg, extra]); } };
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('helpers', () => {
  test('a running scan with no start time counts from when it started waiting', () => {
    const entry = { id: 'j1', projectKey: 'demo', status: 'running', waitingSince: '2026-11-01T10:00:00Z', startedAt: null, shards: null } as unknown as ScanQueueEntry;
    expect(scanQueueOf([entry]).running).toEqual([expect.objectContaining({ since: '2026-11-01T10:00:00Z' })]);
  });
});

describe('the request pipeline', () => {
  test('an unexpected error is logged without secrets and answered with a plain 500', async () => {
    const { lines, log } = logs();
    const app = createApp(repo({ listCandidates: async () => { throw new Error('boom'); } }), { log });
    const res = await app.request('/api/candidates');
    expect(res.status).toBe(500);
    expect(lines).toContainEqual(['request failed', { error: 'boom' }]);
  });

  test('a tokenless install refuses a reader that is not on this machine, and logs it', async () => {
    const { lines, log } = logs();
    const app = createApp(repo(), { log, peerAddress: () => '10.0.0.9', localPeer: () => false });
    expect((await app.request('/api/candidates')).status).toBe(403);
    expect(lines).toContainEqual(['auth refused', { method: 'GET', path: '/api/candidates', reason: 'tokenless install, peer not on this machine' }]);
  });

  test('a tokenless same-origin write with no Origin header is not the local owner: refused read-only, and logged', async () => {
    const { lines, log } = logs();
    const app = createApp(repo({ candidateDetail: async () => ({ candidate: cand(), turn: {} as never, before: [], after: [], commits: [], postmortem: null }) }), { log, peerAddress: () => '127.0.0.1', localPeer: () => true });
    const res = await app.request('/api/candidates/c1/decision', { method: 'POST', headers: { ...json, 'sec-fetch-site': 'same-origin', host: 'localhost' }, body: JSON.stringify({ status: 'confirmed' }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ readOnly: true });
    expect(lines).toContainEqual(['owner decision refused', expect.objectContaining({ reason: 'missing same-origin browser provenance' })]);
  });

  test('with only the operator token configured, a read with another bearer is not recognised', async () => {
    const app = createApp(repo(), { auth: { operator: { token: OP, allow: [] } } });
    expect((await app.request('/api/candidates', { headers: { authorization: 'Bearer something-else' } })).status).toBe(401);
  });

  test('an owner-token decision is logged as one', async () => {
    const { lines, log } = logs();
    const app = createApp(repo({ candidateDetail: async () => ({ candidate: cand(), turn: {} as never, before: [], after: [], commits: [], postmortem: null }) }), { log, auth: { ownerToken: OWNER } });
    expect((await app.request('/api/candidates/c1/decision', { method: 'POST', headers: owner, body: JSON.stringify({ status: 'confirmed' }) })).status).toBe(204);
    expect(lines).toContainEqual(['owner token decision', { method: 'POST', path: '/api/candidates/c1/decision' }]);
  });

  test('with the operator token configured, an owner route with an unknown bearer is not recognised', async () => {
    const app = createApp(repo(), { auth: { token: API, operator: { token: OP, allow: [] } } });
    const res = await app.request('/api/candidates/c1/decision', { method: 'POST', headers: { ...json, authorization: `Bearer ${API}` }, body: JSON.stringify({ status: 'confirmed' }) });
    expect(res.status).toBe(403);
    const stale = await app.request('/api/candidates/c1/decision', { method: 'POST', headers: { ...json, authorization: 'Bearer stale' }, body: JSON.stringify({ status: 'confirmed' }) });
    expect(stale.status).toBe(401);
  });

  test('a sandbox run with the API token and its run key may reset the bundled demo, nothing else', async () => {
    const owners = new Map<string, unknown>();
    const app = createApp(repo(), {
      auth: { token: API, runKeySalt: 'salt' },
      runs: { owner: async (id) => (owners.get(id) as never) ?? null, claim: async (run, principal, actor) => { if (!owners.has(run)) owners.set(run, { run, principal, actor, firstSeen: 'now' }); return owners.get(run) as never; }, sandbox: async () => true, items: async () => [], remove: async () => ({}) as never },
    });
    const headers = { ...json, authorization: `Bearer ${API}`, 'x-fg-run': 'probe-1', 'x-fg-sandbox': '1', 'x-fg-run-key': RUN_KEY };
    // Past the owner check: no demo is configured here, so the route itself is not found.
    expect((await app.request('/api/demo', { method: 'DELETE', headers })).status).toBe(404);
    expect((await app.request('/api/candidates/c1/decision', { method: 'POST', headers, body: JSON.stringify({ status: 'confirmed' }) })).status).toBe(403);
  });
});

describe('health and status', () => {
  const worker = (o: Partial<WorkerStatus> = {}): WorkerStatus => ({ startedAt: new Date().toISOString(), lastBeat: new Date().toISOString(), version: 'v', providers: { classify: 'ollama:m', postmortem: 'codex-cli', scan: 'ollama:m', summary: 'ollama:m', chat: 'ollama:m', docs: 'ollama:m' }, health: {}, ...o } as WorkerStatus);

  test('health is 503 while the store does not answer', async () => {
    const app = createApp(repo(), { system: { version: 'v', ping: async () => false, worker: async () => null } as never });
    expect((await app.request('/api/health')).status).toBe(503);
  });

  test('status: a parked codex runner with no reason, a stale failure with no reason, and code maps of the selected projects only', async () => {
    const meta = { 'a': null, 'b': { builtAt: '2026-01-01T00:00:00Z', fingerprint: 'f', lastFailureAt: null }, 'c': { builtAt: '2026-01-01T00:00:00Z', fingerprint: null, lastFailureAt: null, checkedAt: null } } as Record<string, unknown>;
    const app = createApp(repo(), {
      auth: { token: API },
      system: {
        version: 'v', ping: async () => true,
        worker: async () => worker({ health: { classify: { provider: 'ollama:m', ok: false, reason: null, at: '2026-11-01T00:00:00Z' }, scan: { provider: 'ollama:m', ok: true, reason: null, at: '2026-11-02T00:00:00Z' } } as never }),
        runner: async () => ({ ok: false, reason: null }),
        selection: async () => ({ initialized: true, tracked: ['a', 'b', 'c'] }),
      } as never,
      facts: { listProjects: async () => ['a', 'b', 'c', 'hidden'].map((key) => ({ key })), requestScan: async () => {}, listFacts: async () => [], searchFacts: async () => [] } as never,
      codegraph: { codeMapMeta: async (k: string) => meta[k] ?? null, hotspots: async () => [], moduleContext: async () => null, impact: async () => null } as never,
    });
    const s = await (await app.request('/api/status', { headers: { authorization: `Bearer ${API}` } })).json();
    expect(s.models.postmortem).toMatchObject({ ok: false, reason: 'codex runner sandbox unavailable' });
    // Another job of the same provider answered since: the old failure is no longer reported.
    expect(s.models.classify).toMatchObject({ ok: true });
    expect(s.codeMaps.map((m: { projectKey: string }) => m.projectKey)).toEqual(['c']);
    expect(s.ownerSetupRequired).toBe(true);
  });

  test('pipeline for a project with no selection to narrow it, a stage with no current item, and an unanswered inbox', async () => {
    const app = createApp(repo({ listCandidates: async () => { throw new Error('down'); } }), {
      system: { version: 'v', ping: async () => true, worker: async () => worker({ stage: { name: 'classify', current: null, startedAt: 't' }, backlog: { classify: 3, classifyCapped: false, oldestAt: null } } as never) } as never,
      facts: { listProjects: async () => [], requestScan: async () => {}, listFacts: async () => [], searchFacts: async () => [], scanQueue: async () => [{ id: 'j', projectKey: 'other', status: 'queued', waitingSince: 't' }] } as never,
      knowledge: { listLessons: async () => [], lessonDetail: async () => null, updateLesson: async () => ({}) as never, postmortemBacklog: async () => 0, postmortemQueue: async () => null, decidedLessons: async (q: unknown) => { expect(q).toMatchObject({ projectKeys: ['demo'] }); return []; } } as never,
    });
    const p = await (await app.request('/api/pipeline?project=demo')).json();
    expect(p.queues.classify.running).toEqual([{ what: 'classify', since: 't' }]);
    expect(p.queues.scans.waiting).toBe(0);
    expect(p.inbox).toBeNull();
  });
});

describe('owner sessions', () => {
  test('a sign-out that cannot be saved is a 500 that says the session was not revoked, and is logged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fb-owner-sessions-'));
    const { lines, log } = logs();
    const app = createApp(repo(), { log, auth: { ownerToken: OWNER, sessionStateFile: join(dir, 'sessions.json') } });
    const signIn = await app.request('/api/session', { method: 'POST', headers: { ...json, 'sec-fetch-site': 'same-origin', origin: 'http://localhost' }, body: JSON.stringify({ token: OWNER }) });
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0];
    chmodSync(dir, 0o500);
    try {
      const res = await app.request('/api/session', { method: 'DELETE', headers: { ...json, cookie } });
      expect(res.status).toBe(500);
      expect(lines.some(([m]) => m === 'sign-out not saved')).toBe(true);
    } finally { chmodSync(dir, 0o700); }
  });
});

// ── Inbox, scans, facts ───────────────────────────────────────────────

/** An operator request labelled with run `r1` (not a sandbox, so it may not change what it did not write). */
const opRun = { ...json, authorization: `Bearer ${OP}`, 'x-fg-run': 'r1' };
const operator = (allow: string[]) => ({ auth: { ownerToken: OWNER, operator: { token: OP, allow: allow as never } } });
const detail = (c: Candidate, text = 'no') => ({ candidate: c, turn: { text } as never, before: [], after: [], commits: [], postmortem: null });

describe('Inbox items', () => {
  test("a sandbox run's item is not found outside that run", async () => {
    const app = createApp(repo({ candidateDetail: async () => detail(cand({ sandbox: true, run: 'probe' } as never)) }));
    expect((await app.request('/api/candidates/c1')).status).toBe(404);
  });

  test('undo: a missing item is 404, and a run cannot undo an item it did not decide', async () => {
    const gone = createApp(repo(), operator(['inbox_decide']));
    expect((await gone.request('/api/candidates/c1/undo', { method: 'POST', headers: owner, body: JSON.stringify({ decidedAt: '2026-11-01T00:00:00Z' }) })).status).toBe(404);
    const app = createApp(repo({ candidateDetail: async () => detail(cand()) }), operator(['inbox_decide']));
    const res = await app.request('/api/candidates/c1/undo', { method: 'POST', headers: opRun, body: JSON.stringify({ decidedAt: '2026-11-01T00:00:00Z' }) });
    expect(res.status).toBe(409);
  });

  test('a long turn is shortened in the decision\'s Activity entry; a store failure in a batch is a server error', async () => {
    const recorded: { subject: string }[] = [];
    const app = createApp(repo({ candidateDetail: async () => detail(cand(), 'x'.repeat(100)) }), { auth: { ownerToken: OWNER }, activity: { record: async (a: unknown) => { recorded.push(a as never); }, list: async () => [] } as never });
    await app.request('/api/candidates/c1/decision', { method: 'POST', headers: owner, body: JSON.stringify({ status: 'confirmed' }) });
    expect(recorded[0].subject).toBe(`confirmed: "${'x'.repeat(80)}…"`);
    const broken = createApp(repo({ candidateDetail: async () => detail(cand()), decide: async () => { throw new Error('db down'); } }), { auth: { ownerToken: OWNER } });
    expect((await broken.request('/api/candidates/decisions', { method: 'POST', headers: owner, body: JSON.stringify({ items: [{ id: 'c1', decision: 'confirm' }] }) })).status).toBe(500);
  });
});

describe('scans', () => {
  const project = { key: 'demo', name: 'demo', repoPath: '/vibe/demo' };
  const facts = (o: Record<string, unknown> = {}) => ({ listProjects: async () => [], requestScan: async () => ({ id: 'j1', status: 'queued' }), listFacts: async () => [], searchFacts: async () => [], ...o }) as never;

  test('a provider outside SCAN_PROVIDER_ALLOW is refused, for one folder and for many', async () => {
    vi.stubEnv('SCAN_PROVIDER_ALLOW', 'ollama');
    const app = createApp(repo(), { auth: { ownerToken: OWNER }, facts: facts(), projectDirs: async () => [project] });
    for (const [path, body] of [['/api/projects/demo/scan', { provider: 'codex-cli' }], ['/api/projects/scan', { all: true, provider: 'codex-cli' }]] as const) {
      expect((await app.request(path, { method: 'POST', headers: owner, body: JSON.stringify(body) })).status).toBe(403);
    }
    expect((await app.request('/api/projects/demo/scan', { method: 'POST', headers: owner, body: JSON.stringify({ provider: 'ollama:qwen' }) })).status).toBe(202);
  });

  test('a parked codex runner with no reason says "runner unavailable"', async () => {
    const app = createApp(repo(), { auth: { ownerToken: OWNER }, facts: facts(), projectDirs: async () => [project], system: { version: 'v', ping: async () => true, worker: async () => null, runner: async () => ({ ok: false, reason: null }) } as never });
    const res = await app.request('/api/projects/demo/scan', { method: 'POST', headers: owner, body: JSON.stringify({ provider: 'codex-cli' }) });
    expect((await res.json()).warning).toMatch(/^Scan queued but parked: runner unavailable\./);
  });

  test('cancel: no such scan, or one that started meanwhile', async () => {
    const app = (o: Record<string, unknown>) => createApp(repo(), { auth: { ownerToken: OWNER }, facts: facts(o), projectDirs: async () => [project] });
    expect((await app({ scanJob: async () => null }).request('/api/projects/demo/scan/j1/cancel', { method: 'POST', headers: owner, body: '{}' })).status).toBe(404);
    const started = app({ scanJob: async () => ({ id: 'j1', projectKey: 'demo', status: 'queued' }), cancelQueuedScan: async () => false });
    expect((await started.request('/api/projects/demo/scan/j1/cancel', { method: 'POST', headers: owner, body: '{}' })).status).toBe(409);
  });

  test('a queued scan that is not in the queue any more has no position', async () => {
    const app = createApp(repo(), { facts: facts({ scanJob: async () => ({ id: 'j1', projectKey: 'demo', status: 'queued', provider: null }), scanQueue: async () => [] }), projectDirs: async () => [project] });
    expect((await (await app.request('/api/scans/j1')).json()).queuePosition).toBeNull();
  });
});

describe('fact relevance', () => {
  const facts = { listProjects: async () => [], requestScan: async () => {}, listFacts: async () => [], searchFacts: async () => [], setFactRelevance: async () => false } as never;
  test('a project not shown is 404; in a run, a fact it did not write is not found among its facts', async () => {
    const hidden = createApp(repo(), { auth: { ownerToken: OWNER }, facts, projectDirs: async () => [], shown: shown('other') });
    expect((await hidden.request('/api/projects/demo/facts/f1/relevance', { method: 'PATCH', headers: owner, body: JSON.stringify({ relevance: 0.5 }) })).status).toBe(404);
    const app = createApp(repo(), { ...operator(['relevance']), facts, projectDirs: async () => [] });
    const res = await app.request('/api/projects/demo/facts/f1/relevance', { method: 'PATCH', headers: opRun, body: JSON.stringify({ relevance: 0.5 }) });
    expect(await res.json()).toEqual({ error: 'no such fact in this project among the facts this run wrote' });
  });
});

// ── Documents ─────────────────────────────────────────────────────────

describe('documents', () => {
  const project = { key: 'demo', name: 'demo', repoPath: '/vibe/demo' };
  const docsStore = (o: Record<string, unknown> = {}) => ({ upsertDoc: async () => 'doc:demo:upload:a.md', listDocs: async () => [], deleteDoc: async () => true, ...o }) as never;
  const make = (o: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => createApp(repo(), { auth: { ownerToken: OWNER }, docs: docsStore(o), embed: async (t) => t.map(() => [1]), projectDirs: async () => [project], ...extra });

  test('an id that is not a document id is not found, on every document route', async () => {
    const app = make({ docImage: async () => null, requeueDocRead: async () => true });
    expect((await app.request('/api/docs/nonsense')).status).toBe(404);
    expect((await app.request('/api/docs/nonsense/image')).status).toBe(404);
    expect((await app.request('/api/docs/nonsense/reread', { method: 'POST', headers: owner, body: '{}' })).status).toBe(404);
    expect((await app.request('/api/docs/nonsense', { method: 'DELETE', headers: owner })).status).toBe(404);
  });

  test('a document of a project not shown is not found; one of an unknown source is looked up among uploads in progress only', async () => {
    const hidden = make({}, { shown: shown('other') });
    expect((await hidden.request('/api/docs/doc:demo:upload:a.md')).status).toBe(404);
    const listed: unknown[] = [];
    const app = make({ listDocs: async (...a: unknown[]) => { listed.push(a); return []; } });
    expect((await app.request('/api/docs/doc:demo:bogus:a.md')).status).toBe(404);
    expect(listed).toEqual([]);
  });

  test("a large upload that fails is kept as failed for a while with why (logged), then forgotten; another run's id is never shown", async () => {
    const { lines, log } = logs();
    const now = vi.spyOn(Date, 'now');
    try {
      const app = make({}, { log, embed: async () => { throw 'embedder gone'; } });
      const text = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}. ${'word '.repeat(200)}`).join('\n\n');
      const res = await app.request('/api/projects/demo/docs', { method: 'POST', headers: owner, body: JSON.stringify({ name: 'big.md', title: 'Big', text }) });
      expect(res.status).toBe(202);
      const { id } = await res.json();
      await vi.waitFor(() => expect(lines.some(([m]) => m === 'upload failed')).toBe(true));
      expect(lines.find(([m]) => m === 'upload failed')![1]).toMatchObject({ error: 'embedder gone' });
      expect((await (await app.request(`/api/docs/${id}`)).json()).embed).toMatchObject({ status: 'failed', error: 'embedder gone' });
      expect((await app.request(`/api/docs/doc@other-run:demo:upload:big.md`)).status).toBe(404);
      now.mockReturnValue(Date.now() + 24 * 60 * 60 * 1000);
      expect((await app.request(`/api/docs/${id}`)).status).toBe(404);
    } finally { now.mockRestore(); }
  });

  test('a large upload refused for a run says why in Activity', async () => {
    const { NotTheRunsError } = await import('@fb/core');
    const recorded: { subject: string }[] = [];
    const app = make({ upsertDoc: async () => { throw new NotTheRunsError('the document big.md', 'r1'); } }, { activity: { record: async (a: never) => { recorded.push(a); }, list: async () => [] } });
    const text = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}. ${'word '.repeat(200)}`).join('\n\n');
    expect((await app.request('/api/projects/demo/docs', { method: 'POST', headers: owner, body: JSON.stringify({ name: 'big.md', title: 'Big', text }) })).status).toBe(202);
    await vi.waitFor(() => expect(recorded.some((a) => a.subject.startsWith('could not add "Big"'))).toBe(true));
    expect(recorded.find((a) => a.subject.startsWith('could not add'))!.subject).toContain('r1');
  });

  test('a text with nothing to read is refused', async () => {
    const res = await make().request('/api/projects/demo/docs', { method: 'POST', headers: owner, body: JSON.stringify({ name: 'empty.md', title: 'Empty', text: '\n\n \n' }) });
    expect(res.status).toBe(400);
  });

  test('in a run, a document it did not upload cannot be removed', async () => {
    const app = make({ deleteDoc: async () => false }, operator(['docs_delete']));
    const res = await app.request('/api/docs/doc:demo:upload:a.md', { method: 'DELETE', headers: opRun });
    expect(await res.json()).toEqual({ error: 'not found among the documents this run uploaded' });
  });
});

// ── Links, code map, export, queues ───────────────────────────────────

describe('links', () => {
  const link = (status: string) => ({ id: 'link:a|b', a: 'a', b: 'b', relation: 'related', note: '', status, source: 'you', score: 0, evidence: [], createdAt: 't', updatedAt: 't', decidedBy: 'you' });
  test('reopening and dismissing a link say so; in a run, a link it did not make cannot be removed', async () => {
    const recorded: { subject: string; why: string }[] = [];
    const app = createApp(repo(), { ...operator(['links_delete']), activity: { record: async (a: unknown) => { recorded.push(a as never); }, list: async () => [] } as never, links: { listLinks: async () => [], setLink: async (_a, _b, p) => link((p as { status?: string }).status ?? 'suggested') as never, deleteLink: async () => false } });
    await app.request('/api/links', { method: 'PUT', headers: owner, body: JSON.stringify({ a: 'a', b: 'b', status: 'suggested' }) });
    await app.request('/api/links', { method: 'PUT', headers: owner, body: JSON.stringify({ a: 'a', b: 'b', status: 'dismissed' }) });
    expect(recorded.map((r) => [r.subject, r.why])).toEqual([
      ['reopened the link a ↔ b', 'you changed the link'],
      ['dismissed the link a ↔ b', 'you said they do not belong together: it is not suggested again'],
    ]);
    const res = await app.request('/api/links/link:a|b', { method: 'DELETE', headers: opRun });
    expect(await res.json()).toEqual({ error: 'not found among the links this run made' });
  });
});

describe('code map routes', () => {
  const cg = (o: Record<string, unknown> = {}) => ({ hotspots: async () => [], moduleContext: async () => null, impact: async () => null, codeMapMeta: async () => ({ builtAt: 't' }), ...o }) as never;

  test('a project not shown has no code map; a drop with no Activity store still answers; a rebuild the store refuses is 404', async () => {
    expect((await createApp(repo(), { codegraph: cg(), shown: shown('other') }).request('/api/projects/demo/codemap/hotspots')).status).toBe(404);
    const app = createApp(repo(), { auth: { ownerToken: OWNER }, codegraph: cg({ dropCodeMap: async () => 3, requestCodeMapRebuild: async () => false }) });
    expect(await (await app.request('/api/projects/demo/codemap', { method: 'DELETE', headers: owner })).json()).toEqual({ key: 'demo', removed: 3 });
    expect((await app.request('/api/projects/demo/codemap/rebuild', { method: 'POST', headers: owner, body: '{}' })).status).toBe(404);
  });

  test('top hotspots across projects: score first, then project, then path; a project not shown is left out', async () => {
    const h = (path: string, score: number) => ({ path, score });
    const app = createApp(repo(), {
      shown: shown('a', 'b'),
      projectDirs: async () => ['a', 'b', 'hidden'].map((key) => ({ key, name: key, repoPath: `/vibe/${key}` })),
      codegraph: cg({ hotspots: async (k: string) => (k === 'a' ? [h('z.ts', 1), h('y.ts', 2)] : [h('x.ts', 1), h('w.ts', 2), h('v.ts', 2)]) }),
    });
    const all = await (await app.request('/api/codemap/hotspots?limit=10')).json();
    expect(all.map((x: { projectKey: string; path: string }) => `${x.projectKey}/${x.path}`)).toEqual(['a/y.ts', 'b/v.ts', 'b/w.ts', 'a/z.ts', 'b/x.ts']);
  });
});

describe('export, requeue and retry', () => {
  test('export: a bad query is 400; without a selection everything is exported', async () => {
    const asked: unknown[] = [];
    const app = createApp(repo(), { portability: { exportData: async (q) => { asked.push(q); return { exportedAt: '2026-11-01T00:00:00Z' } as never; }, deleteProject: async () => ({}) as never } });
    expect((await app.request('/api/export?approved=maybe')).status).toBe(400);
    expect((await app.request('/api/export')).status).toBe(200);
    expect(asked).toEqual([{ approvedOnly: false }]);
  });

  test('one turn requeued reads in the singular', async () => {
    const recorded: { subject: string }[] = [];
    const app = createApp(repo(), { auth: { ownerToken: OWNER }, classifyQueue: { givenUpTurns: async () => 1, requeueGivenUpTurns: async () => 1 }, activity: { record: async (a: unknown) => { recorded.push(a as never); }, list: async () => [] } as never });
    await app.request('/api/turns/requeue', { method: 'POST', headers: owner, body: '{}' });
    expect(recorded[0].subject).toBe('re-queued 1 turn the classifier had given up on');
  });

  test('a post-mortem retry: none to retry, or one that finished meanwhile', async () => {
    const pm = (done: boolean) => ({ ...detail(cand()), postmortem: { done } as never });
    const knowledge = (retry: boolean) => ({ listLessons: async () => [], lessonDetail: async () => null, updateLesson: async () => ({}) as never, retryPostmortem: async () => retry }) as never;
    expect((await createApp(repo({ candidateDetail: async () => detail(cand()) }), { auth: { ownerToken: OWNER }, knowledge: knowledge(true) }).request('/api/feedback/c1/retry', { method: 'POST', headers: owner, body: '{}' })).status).toBe(404);
    expect((await createApp(repo({ candidateDetail: async () => pm(false) }), { auth: { ownerToken: OWNER }, knowledge: knowledge(false) }).request('/api/feedback/c1/retry', { method: 'POST', headers: owner, body: '{}' })).status).toBe(404);
  });
});

// ── Lessons ───────────────────────────────────────────────────────────

describe('lessons', () => {
  const store = (l: Lesson, o: Record<string, unknown> = {}) => ({
    listLessons: async () => [], lessonDetail: async (id: string) => (id === l.id ? { lesson: l, miss: null, contextItems: [] } : null), updateLesson: async () => ({}), ...o,
  }) as never;
  const patch = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = owner, id = 'l1') => app.request(`/api/lessons/${id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });

  test('quality needs a valid project, and only an approved lesson can be revoked, alone or in a batch', async () => {
    const app = createApp(repo(), { auth: { ownerToken: OWNER }, knowledge: store(lesson()) });
    expect((await app.request(`/api/lessons/quality?project=${'x'.repeat(300)}`)).status).toBe(400);
    expect((await patch(app, { status: 'revoked' })).status).toBe(409);
    const batch = await (await app.request('/api/lessons/decisions', { method: 'POST', headers: owner, body: JSON.stringify({ items: [{ id: 'l1', status: 'revoked' }] }) })).json();
    expect(batch.results).toEqual([{ id: 'l1', ok: false, error: 'only a previously approved lesson can be revoked' }]);
  });

  test('revoking by you and by an operator, and approving by an operator, each say who did what', async () => {
    const recorded: { why: string }[] = [];
    const app = createApp(repo(), { ...operator(['lesson_decide']), knowledge: store(lesson({ status: 'approved' })), activity: { record: async (a: unknown) => { recorded.push(a as never); }, list: async () => [] } as never });
    await patch(app, { status: 'revoked' });
    await patch(app, { status: 'revoked' }, { ...json, authorization: `Bearer ${OP}`, 'x-fg-operator': 'codex' });
    await patch(app, { status: 'approved' }, { ...json, authorization: `Bearer ${OP}`, 'x-fg-operator': 'codex' });
    expect(recorded.map((r) => r.why.split('.')[0])).toEqual([
      'you revoked a previously approved lesson; agents stop receiving it',
      'an agent (operator:codex) revoked a previously approved lesson; agents stop receiving it',
      'an agent (operator:codex) approved it with the operator token (OPERATOR_ALLOW has lesson_decide), so agents will now be given it',
    ]);
  });

  test('a run cannot change a lesson it did not write; superseding an unknown lesson and an unscoped approval are refused', async () => {
    const app = createApp(repo(), { ...operator(['lesson_decide']), knowledge: store(lesson(), { updateLesson: async () => ({ unscoped: true }) }) });
    expect((await patch(app, { title: 'x' }, opRun)).status).toBe(409);
    expect((await patch(app, { supersedes: 'nope' })).status).toBe(400);
    expect((await patch(app, { title: 'new' })).status).toBe(409);
  });

  test('a global lesson can be narrowed to a project the store knows though no folder holds it, and not to one nobody knows', async () => {
    const global = lesson({ projectKey: undefined, scope: 'global' });
    const withFacts = createApp(repo(), { auth: { ownerToken: OWNER }, knowledge: store(global), projectDirs: async () => [], facts: { listProjects: async () => [{ key: 'demo' }], requestScan: async () => {}, listFacts: async () => [], searchFacts: async () => [] } as never });
    expect((await patch(withFacts, { scope: 'project', projectKey: 'demo' })).status).toBe(200);
    const none = createApp(repo(), { auth: { ownerToken: OWNER }, knowledge: store(global) });
    expect((await patch(none, { scope: 'project', projectKey: 'demo' })).status).toBe(400);
  });

  test('one lesson queued for a re-check reads in the singular', async () => {
    const recorded: { subject: string }[] = [];
    const app = createApp(repo(), { auth: { ownerToken: OWNER }, knowledge: store(lesson(), { requestLessonRecheck: async () => 1 }), activity: { record: async (a: unknown) => { recorded.push(a as never); }, list: async () => [] } as never });
    await app.request('/api/lessons/recheck', { method: 'POST', headers: owner, body: '{}' });
    expect(recorded[0].subject).toBe('1 lesson queued for a re-check');
  });

  test('to-fact: a body that is not JSON takes the defaults; a run cannot convert a lesson it did not write', async () => {
    const facts = { listProjects: async () => [], requestScan: async () => {}, listFacts: async () => [], searchFacts: async () => [], addOwnerFact: async () => ({ id: 'f1' }) } as never;
    const app = createApp(repo(), { ...operator(['lesson_decide']), knowledge: store(lesson({ paths: ['src/a.ts'] })), facts, embed: async (t) => t.map(() => [1]) });
    expect((await app.request('/api/lessons/l1/to-fact', { method: 'POST', headers: owner, body: 'not json' })).status).toBe(201);
    expect((await app.request('/api/lessons/l1/to-fact', { method: 'POST', headers: opRun, body: '{}' })).status).toBe(409);
  });
});

// ── The last route edges ──────────────────────────────────────────────

describe('remaining route edges', () => {
  test('a document cursor that decodes to the wrong shape is refused', async () => {
    const app = createApp(repo(), { docs: { upsertDoc: async () => '', listDocs: async () => [], deleteDoc: async () => true } as never, embed: async () => [], projectDirs: async () => [] });
    const cursor = Buffer.from(JSON.stringify([1, 2])).toString('base64url');
    expect((await app.request(`/api/projects/demo/docs?cursor=${cursor}`)).status).toBe(400);
  });

  test('an operator rejecting or editing a lesson says so', async () => {
    const recorded: { why: string }[] = [];
    const knowledge = { listLessons: async () => [], lessonDetail: async () => ({ lesson: lesson(), miss: null, contextItems: [] }), updateLesson: async () => ({}) } as never;
    const app = createApp(repo(), { ...operator(['lesson_decide']), knowledge, activity: { record: async (a: unknown) => { recorded.push(a as never); }, list: async () => [] } as never });
    const op = { ...json, authorization: `Bearer ${OP}`, 'x-fg-operator': 'codex' };
    await app.request('/api/lessons/l1', { method: 'PATCH', headers: op, body: JSON.stringify({ status: 'rejected' }) });
    await app.request('/api/lessons/l1', { method: 'PATCH', headers: op, body: JSON.stringify({ title: 'New' }) });
    expect(recorded.map((r) => r.why.split('.')[0])).toEqual(['an agent (operator:codex) rejected it with the operator token; agents will not see it', 'an agent (operator:codex) edited it with the operator token']);
  });

  test("an Ollama job's failure with no reason is kept while Ollama answers", async () => {
    const worker = { startedAt: new Date().toISOString(), lastBeat: new Date().toISOString(), providers: { classify: 'ollama:m' }, health: { classify: { provider: 'ollama:m', ok: false, reason: null, at: 't' } } };
    const app = createApp(repo(), { system: { version: 'v', ping: async () => true, worker: async () => worker, ollama: async () => ({ ok: true, reason: null }) } as never });
    expect((await (await app.request('/api/status')).json()).models.classify).toMatchObject({ ok: false });
  });

  test('with the operator token configured, "Bearer none" on an owner route is not recognised', async () => {
    const app = createApp(repo(), { auth: { operator: { token: OP, allow: [] } } });
    expect((await app.request('/api/candidates/c1/decision', { method: 'POST', headers: { ...json, authorization: 'Bearer none' }, body: JSON.stringify({ status: 'confirmed' }) })).status).toBe(401);
  });

  test('lesson quality over everything, an Inbox item of another sandbox run, the plugin asking without a cwd', async () => {
    const asked: unknown[] = [];
    const knowledge = { listLessons: async () => [], lessonDetail: async () => null, updateLesson: async () => ({}), decidedLessons: async (q: unknown) => { asked.push(q); return []; } } as never;
    const context = { roots: [], embed: async () => [], judge: async () => [], k: {} } as never;
    const app = createApp(repo({ candidateDetail: async () => detail(cand({ sandbox: true, run: 'probe' } as never)) }), { knowledge, context, auth: { ownerToken: OWNER } });
    expect((await app.request('/api/lessons/quality')).status).toBe(200);
    expect(asked[0]).toMatchObject({ projectKeys: null });
    expect((await app.request('/api/candidates/c1', { headers: { ...owner, 'x-fg-run': 'other' } })).status).toBe(404);
    expect(await (await app.request('/api/agent/project')).json()).toEqual({ project: null, tracked: false });
  });

  test('removing a link that is not there, and dropping a code map, are recorded or refused plainly', async () => {
    const recorded: { kind: string }[] = [];
    const app = createApp(repo(), {
      auth: { ownerToken: OWNER }, activity: { record: async (a: unknown) => { recorded.push(a as never); }, list: async () => [] } as never,
      links: { listLinks: async () => [], setLink: async () => ({}) as never, deleteLink: async () => false },
      codegraph: { hotspots: async () => [], moduleContext: async () => null, impact: async () => null, codeMapMeta: async () => null, dropCodeMap: async () => 1 } as never,
    });
    expect(await (await app.request('/api/links/link:a|b', { method: 'DELETE', headers: owner })).json()).toEqual({ error: 'not found' });
    await app.request('/api/projects/demo/codemap', { method: 'DELETE', headers: owner });
    expect(recorded.map((r) => r.kind)).toEqual(['code_mapped']);
  });

  test('the bundled demo: a sandbox probe with its key passes, the owner passes with or without a run, the API token without its key does not', async () => {
    const owners = new Map<string, unknown>();
    const runs = { owner: async (id: string) => (owners.get(id) as never) ?? null, claim: async (run: string, principal: string, actor: string | null) => { if (!owners.has(run)) owners.set(run, { run, principal, actor, firstSeen: 'now' }); return owners.get(run) as never; }, sandbox: async () => true, items: async () => [], remove: async () => ({}) as never };
    const app = createApp(repo(), { auth: { token: API, ownerToken: OWNER, runKeySalt: 'salt' }, runs: runs as never });
    const sandbox = { 'x-fg-run': 'probe-1', 'x-fg-sandbox': '1' };
    const post = (headers: Record<string, string>) => app.request('/api/demo/remove', { method: 'POST', headers: { ...json, ...headers }, body: '{}' });
    expect((await post({ authorization: `Bearer ${API}`, ...sandbox, 'x-fg-run-key': RUN_KEY })).status).toBe(404);
    expect((await post(owner)).status).toBe(404);
    expect((await post({ ...owner, 'x-fg-run': 'probe-2', 'x-fg-sandbox': '1' })).status).toBe(404);
    const signIn = await app.request('/api/session', { method: 'POST', headers: { ...json, 'sec-fetch-site': 'same-origin', origin: 'http://localhost' }, body: JSON.stringify({ token: OWNER }) });
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0];
    // The owner's browser with the API token and no run key: the API token never decides.
    expect((await post({ cookie, 'sec-fetch-site': 'same-origin', origin: 'http://localhost', authorization: `Bearer ${API}`, 'x-fg-run': 'probe-3', 'x-fg-sandbox': '1' })).status).toBe(403);
    const ownerOnly = createApp(repo(), { auth: { ownerToken: OWNER }, runs: runs as never });
    expect((await ownerOnly.request('/api/demo/remove', { method: 'POST', headers: { ...owner, 'x-fg-run': 'probe-4', 'x-fg-sandbox': '1' }, body: '{}' })).status).toBe(404);
  });

  test("a labelled session registration is refused for a session another run already holds", async () => {
    const runs = { owner: async () => null, claim: async () => ({ run: 'r1', principal: 'operator', actor: 'k', firstSeen: 'now' }) as never, sandbox: async () => false, items: async () => [], remove: async () => ({}) as never };
    const held = [{ id: 'other', sandbox: false }, { id: 'r1', sandbox: true }];
    const store = { list: async () => ({ sessions: [], next: null }), detail: async () => null, requestRebuild: async () => false, claimRun: async () => false, runFor: async () => held.shift()! };
    const app = createApp(repo(), { auth: { operator: { token: OP, allow: [] }, runKeySalt: 'salt' }, runs: runs as never, sessions: { projects: () => [], inScope: () => true, store } as never });
    // Held by another run, then by this run's name as a sandbox one.
    for (let i = 0; i < 2; i++) {
      const res = await app.request('/api/sessions/s1/run', { method: 'POST', headers: { ...json, authorization: `Bearer ${OP}`, 'x-fg-run': 'r1', 'x-fg-run-key': RUN_KEY }, body: '{}' });
      expect(res.status).toBe(409);
    }
  });

  test('an MCP call naming a session another run holds is refused', async () => {
    const runs = { owner: async () => null, claim: async (run: string, principal: string, actor: string | null) => ({ run, principal, actor, firstSeen: 'now' }) as never, sandbox: async () => false, items: async () => [], remove: async () => ({}) as never };
    const store = { list: async () => ({ sessions: [], next: null }), detail: async () => null, requestRebuild: async () => false, claimRun: async () => false };
    const context = { roots: [{ host: '/Users/test', container: '/repo' }], embed: async (t: string[]) => t.map(() => [1]), judge: async () => [], k: { searchLessons: async () => [], relatedMisses: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'manual:1' } } as never;
    const app = createApp(repo(), { auth: { operator: { token: OP, allow: [] }, runKeySalt: 'salt' }, context, runs: runs as never, sessions: { projects: () => [], inScope: () => true, store } as never });
    const res = await app.request('/mcp', { method: 'POST', headers: { ...json, accept: 'application/json, text/event-stream', authorization: `Bearer ${OP}`, 'x-fg-run': 'r1', 'x-fg-run-key': RUN_KEY }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_task_context', arguments: { cwd: '/Users/test/demo', task: 'x', session_id: 'sess-1' } } }) });
    expect(await res.text()).toContain('session already belongs to the owner or another run');
  });
});
