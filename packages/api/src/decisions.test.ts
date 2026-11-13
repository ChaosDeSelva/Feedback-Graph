import { CascadeBlockedError, DecisionStateError, LESSON_SIGNAL_COUNTS, LOOP_DECISION_TYPES, LOOP_SETTINGS_CURSOR, TargetChangedError, UnsupportedTargetError, writeLoopRound, type Decision, type LoopRound, type OperatorVerb } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { createApp, type ApiRepo, type AppOpts } from './app.ts';
import { decisionWire, lessonRepeats, noteWire, summaryOf } from './decisions.ts';
import { decision, fakeLoop, snap } from './testing/loop.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const OWNER = 'loop-owner-token-0123456789abcdefghij';
const OP = 'o'.repeat(32);
const API = 'a'.repeat(32);

type Loop = ReturnType<typeof fakeLoop>;
function setup(o: Parameters<typeof fakeLoop>[0] & { auth?: AppOpts['auth'] | null; allow?: OperatorVerb[]; shown?: string[]; repeats?: Loop['deps']['repeats'] } = {}) {
  const loop = fakeLoop(o);
  if (o.repeats) loop.deps.repeats = o.repeats;
  const auth = o.auth === null ? undefined : o.auth ?? { token: API, ownerToken: OWNER, operator: { token: OP, allow: o.allow ?? ['loop_decide', 'loop_settings'] } };
  const app = createApp(repo, { loop: loop.deps, auth, ...(o.shown && { shown: () => ({ keys: o.shown!, has: (k: string) => o.shown!.includes(k) }) as never }) });
  return { app, ...loop };
}

const owner = { authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' };
const reader = { authorization: `Bearer ${API}` };
const get = (app: Setup['app'], path: string, headers: Record<string, string> = reader) => app.request(path, { headers });
const post = (app: Setup['app'], path: string, body: unknown, headers: Record<string, string> = owner, method = 'POST') =>
  app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
type Setup = ReturnType<typeof setup>;

const proposed = decision('dec:p', { type: 'approve_lesson', tier: 'A', mode: 'propose', status: 'proposed', appliedAt: null, decidedAt: null, decidedBy: null, createdAt: '2026-11-10T12:00:00.000Z', rationale: 'The miss repeated twice' });
const applied = decision('dec:a');
const observed = decision('dec:o', { type: 'link_misses', status: 'observed', mode: 'observe', appliedAt: null, decidedAt: null, decidedBy: null, targets: [{ kind: 'miss', id: 'miss:2', role: 'primary' }, { kind: 'miss', id: 'miss:3', role: 'keeper' }], before: [], after: [], createdAt: '2026-11-08T12:00:00.000Z', projectKey: 'other' });
const later = decision('dec:later', { type: 'rank_weight', dependsOn: ['dec:a'], createdAt: '2026-11-10T00:00:00.000Z', targets: [{ kind: 'lesson', id: 'lesson:1', role: 'primary' }] });
const all = [proposed, applied, observed, later];

describe('GET /api/decisions', () => {
  test('every status, newest first, as the page types them (absent rather than null), filtered and paged by x-next-offset', async () => {
    const { app } = setup({ decisions: all });
    const res = await get(app, '/api/decisions');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-next-offset')).toBeNull();
    const rows = await res.json();
    expect(rows.map((d: Decision) => d.id)).toEqual(['dec:p', 'dec:later', 'dec:a', 'dec:o']);
    expect(rows[0]).not.toHaveProperty('appliedAt');
    expect(rows[0]).not.toHaveProperty('rollback');
    expect(rows[2]).toMatchObject({ appliedAt: applied.appliedAt, decidedBy: 'loop:1' });

    const page = await get(app, '/api/decisions?limit=2');
    expect(page.headers.get('x-next-offset')).toBe('2');
    const next = await get(app, '/api/decisions?limit=2&offset=2');
    expect(next.headers.get('x-next-offset')).toBeNull();
    expect((await next.json()).map((d: Decision) => d.id)).toEqual(['dec:a', 'dec:o']);

    const ids = async (qs: string) => (await (await get(app, `/api/decisions?${qs}`)).json()).map((d: Decision) => d.id);
    expect(await ids('status=proposed')).toEqual(['dec:p']);
    expect(await ids('type=link_misses')).toEqual(['dec:o']);
    expect(await ids('project=other')).toEqual(['dec:o']);
    expect(await ids('mode=observe')).toEqual(['dec:o']);
    expect(await ids('band=4')).toEqual(['dec:p', 'dec:later', 'dec:a', 'dec:o']);
    expect(await ids('target=miss:3')).toEqual(['dec:o']);
    expect(await ids('since=2026-11-09T12:00:00.000Z&until=2026-11-10T06:00:00Z')).toEqual(['dec:later', 'dec:a']);
    expect(await ids('q=REPEATED')).toEqual(['dec:p']);
  });

  test('x-next-after pages by keyset in created order: the same pages as offsets, and refused where it does not apply', async () => {
    // Ties on createdAt are broken by id, as the stores order them.
    const many = Array.from({ length: 7 }, (_, i) => decision(`dec:k${i}`, { createdAt: `2026-11-0${1 + (i >> 1)}T00:00:00.000Z` }));
    const { app } = setup({ decisions: many });
    const walk = async (next: (res: Response) => string | null) => {
      const seen: string[][] = [];
      for (let qs: string | null = 'limit=3'; qs !== null;) {
        const res = await get(app, `/api/decisions?${qs}`);
        seen.push((await res.json()).map((d: Decision) => d.id));
        qs = next(res);
      }
      return seen;
    };
    const byOffset = await walk((r) => (r.headers.get('x-next-offset') ? `limit=3&offset=${r.headers.get('x-next-offset')}` : null));
    const byKey = await walk((r) => (r.headers.get('x-next-after') ? `limit=3&after=${r.headers.get('x-next-after')}` : null));
    expect(byKey).toEqual(byOffset);
    expect(byKey.flat()).toEqual(['dec:k6', 'dec:k5', 'dec:k4', 'dec:k3', 'dec:k2', 'dec:k1', 'dec:k0']);
    const after = (await get(app, '/api/decisions?limit=3')).headers.get('x-next-after')!;
    for (const qs of ['after=nope', `after=${after}&offset=3`, `after=${after}&appliedSince=2026-11-01T00:00:00Z`]) expect((await get(app, `/api/decisions?${qs}`)).status, qs).toBe(400);
    expect((await get(app, '/api/decisions?limit=3&appliedSince=2026-11-01T00:00:00Z')).headers.get('x-next-after')).toBeNull();
  });

  test('bad filters are a 400; a project that is not shown has none, and decisions of hidden projects are left out', async () => {
    const { app } = setup({ decisions: all, shown: ['shop'] });
    for (const qs of ['status=nope', 'band=5', 'limit=501', 'since=yesterday', 'mode=off']) expect((await get(app, `/api/decisions?${qs}`)).status, qs).toBe(400);
    expect(await (await get(app, '/api/decisions?project=other')).json()).toEqual([]);
    expect((await (await get(app, '/api/decisions')).json()).map((d: Decision) => d.id)).toEqual(['dec:p', 'dec:later', 'dec:a']);
  });

  test('decisions of hidden projects never count toward a page: no x-next-offset that says a hidden one matched', async () => {
    const hidden = [1, 2].map((i) => decision(`dec:h${i}`, { projectKey: 'other', rationale: 'HIDDEN-RATIONALE-zebra', createdAt: `2026-11-1${i}T00:00:00.000Z` }));
    const { app } = setup({ decisions: [...all, ...hidden], shown: ['shop'] });
    for (const qs of ['q=HIDDEN-RATIONALE-zebra&limit=1', 'q=HIDDEN-RATIONALE-zebrX&limit=1', 'target=lesson:1&type=retire_lesson&limit=1&offset=1']) {
      const res = await get(app, `/api/decisions?${qs}`);
      expect(await res.json(), qs).toEqual([]);
      expect(res.headers.get('x-next-offset'), qs).toBeNull();
    }
    const first = await get(app, '/api/decisions?limit=3');
    expect((await first.json()).map((d: Decision) => d.id)).toEqual(['dec:p', 'dec:later', 'dec:a']);
    expect(first.headers.get('x-next-offset')).toBeNull();
  });

  test('since and until are instants: any offset names the same time, and an offset past ±14:00 is a 400', async () => {
    const { app } = setup({ decisions: all });
    const ids = async (qs: string) => (await (await get(app, `/api/decisions?${qs}`)).json()).map((d: Decision) => d.id);
    const z = await ids('since=2026-11-09T12:00:00Z');
    expect(z).toEqual(['dec:p', 'dec:later', 'dec:a']);
    expect(await ids(`since=${encodeURIComponent('2026-11-09T04:00:00-08:00')}`)).toEqual(z);
    expect(await ids(`since=${encodeURIComponent('2026-11-09T20:00:00+08:00')}`)).toEqual(z);
    expect(await ids(`until=${encodeURIComponent('2026-11-10T09:00:00+08:00')}`)).toEqual(['dec:later', 'dec:a', 'dec:o']);
    for (const t of ['2026-11-09T12:00:00+99:00', '2026-11-09T12:00:00-14:30', '2026-11-09T12:00:00+05:75']) {
      expect((await get(app, `/api/decisions?since=${encodeURIComponent(t)}`)).status, t).toBe(400);
    }
    expect((await get(app, `/api/decisions?since=${encodeURIComponent('2026-11-09T12:00:00+14:00')}`)).status).toBe(200);
  });

  test('reads need a credential like every other read; a tokenless install reads', async () => {
    const { app } = setup({ decisions: all });
    expect((await get(app, '/api/decisions', {})).status).toBe(401);
    expect((await get(app, '/api/loop', {})).status).toBe(401);
    expect((await get(app, '/api/decisions', { authorization: `Bearer ${OP}` })).status).toBe(200);
    const tokenless = setup({ decisions: all, auth: null });
    expect((await get(tokenless.app, '/api/decisions', {})).status).toBe(200);
  });

  test('a store that does not answer is a 503 the page retries', async () => {
    const { app, fail } = setup({ decisions: all });
    fail.store = new Error('connection refused');
    for (const path of ['/api/decisions', '/api/decisions/dec:a', '/api/loop', '/api/loop/events']) {
      const res = await get(app, path);
      expect(res.status, path).toBe(503);
      expect(await res.json()).toEqual({ error: 'the store did not answer: connection refused', retryable: true });
    }
  });
});

describe('GET /api/decisions/:id', () => {
  test('the decision, its targets now, evidence resolved to lines with links, what it depends on and what depends on it, its notes', async () => {
    const d = decision('dec:a', {
      dependsOn: ['dec:gone', 'dec:p'],
      targets: [{ kind: 'lesson', id: 'lesson:1', role: 'primary' }, { kind: 'lesson', id: 'lesson:gone', role: 'merged' }],
      evidence: [
        { kind: 'activity', id: 'act:1', role: 'verdict', weight: 0.6, observedAt: 't' },
        { kind: 'activity', id: 'act:nope', role: 'served', weight: 0.1, observedAt: 't' },
        { kind: 'session', id: 'sess-1', role: 'served in', weight: 0.2, observedAt: 't' },
        { kind: 'session', id: 'sess-gone', role: 'served in', weight: 0.2, observedAt: 't' },
        { kind: 'session', id: 'sess-2', role: 'served in', weight: 0.2, observedAt: 't' },
        { kind: 'lesson', id: 'lesson:1', role: 'target', weight: 1, observedAt: 't' },
        { kind: 'fact', id: 'fact:1', role: 'cited', weight: 0.1, observedAt: 't' },
        { kind: 'miss', id: 'miss:2', role: 'repeat of', weight: 0.5, observedAt: 't' },
        { kind: 'candidate', id: 'cand:1', role: 'from', weight: 0.5, observedAt: 't' },
        { kind: 'candidate', id: 'cand:2', role: 'from', weight: 0.5, observedAt: 't' },
        { kind: 'miss', id: 'miss:gone', role: 'repeat of', weight: 0.5, observedAt: 't' },
        { kind: 'check', id: 'check:9', role: 'judge said generic', weight: 0.1, observedAt: 't' },
      ],
    });
    const { app, record, snapshots, notes } = setup({ decisions: [d, proposed, later] });
    record({ kind: 'predone_check', actor: 'judge', projectKey: 'shop', subject: 'checked 3 lessons', why: 'w', details: {}, targets: [] });
    snapshots.set('lesson:lesson:1', snap('lesson:1', { title: 'Validate totals (edited)', projectKey: 'shop' }));
    snapshots.set('fact:fact:1', snap('fact:1', { statement: 'Totals live in cart.ts', path: 'src/cart.ts', projectKey: 'shop' }, 'fact'));
    snapshots.set('miss:miss:2', snap('miss:2', { missed: 'missed the server check' }, 'miss'));
    snapshots.set('candidate:cand:1', snap('cand:1', { classification: { summary: 'no, keep cents' } }, 'candidate'));
    snapshots.set('candidate:cand:2', snap('cand:2', {}, 'candidate'));
    notes.push({ id: 'dnote:1', decisionId: 'dec:a', ts: 't', by: 'you', text: 'Right call', verdict: 'agree', reason: null });
    const res = await get(app, '/api/decisions/dec:a');
    expect(res.status).toBe(200);
    const body = await res.json();
    // Applied: nothing to approve, so no approve score.
    expect(body.decision).toEqual({ ...decisionWire(d), approveScore: null, scoreWhy: null });
    expect(body.current).toEqual([snapshots.get('lesson:lesson:1')]);
    expect(body.evidence).toEqual([
      expect.objectContaining({ kind: 'activity', id: 'act:1', label: 'checked 3 lessons', projectKey: 'shop', activity: expect.objectContaining({ id: 'act:1', kind: 'predone_check' }) }),
      { kind: 'activity', id: 'act:nope', role: 'served', weight: 0.1, observedAt: 't', label: 'served', activity: null, missing: true },
      expect.objectContaining({ kind: 'session', label: 'Refactor checkout', projectKey: 'shop' }),
      expect.objectContaining({ kind: 'session', id: 'sess-gone', label: 'served in', missing: true }),
      expect.objectContaining({ kind: 'session', id: 'sess-2', label: 'sess-2', projectKey: 'shop' }),
      expect.objectContaining({ kind: 'lesson', label: 'Validate totals (edited)', projectKey: 'shop', path: null }),
      expect.objectContaining({ kind: 'fact', label: 'Totals live in cart.ts', projectKey: 'shop', path: 'src/cart.ts' }),
      expect.objectContaining({ kind: 'miss', label: 'missed the server check', projectKey: null }),
      expect.objectContaining({ kind: 'candidate', id: 'cand:1', label: 'no, keep cents' }),
      expect.objectContaining({ kind: 'candidate', id: 'cand:2', label: 'cand:2' }),
      expect.objectContaining({ kind: 'miss', id: 'miss:gone', label: 'repeat of', missing: true }),
      { kind: 'check', id: 'check:9', role: 'judge said generic', weight: 0.1, observedAt: 't', label: 'judge said generic' },
    ]);
    expect(body.dependsOn).toEqual([{ id: 'dec:p', type: 'approve_lesson', status: 'proposed', createdAt: proposed.createdAt, projectKey: 'shop', label: 'approve lesson · lesson:1' }]);
    expect(body.dependents).toEqual([expect.objectContaining({ id: 'dec:later', label: 'rank weight · lesson:1' })]);
    expect(body.notes).toEqual([{ id: 'dnote:1', decisionId: 'dec:a', ts: 't', by: 'you', text: 'Right call', verdict: 'agree' }]);
  });

  test('without an executor: no current targets, evidence by its role; unknown or hidden ids are 404; an entry of a hidden project is missing', async () => {
    const d = decision('dec:x', { targets: [], evidence: [{ kind: 'lesson', id: 'lesson:1', role: 'target', weight: 1, observedAt: 't' }, { kind: 'activity', id: 'act:1', role: 'served', weight: 1, observedAt: 't' }] });
    const { app, record } = setup({ decisions: [d, observed], exec: false, shown: ['shop'] });
    record({ kind: 'context_served', actor: 'agent', projectKey: 'other', subject: 'secret task', why: 'w' });
    const body = await (await get(app, '/api/decisions/dec:x')).json();
    expect(body.current).toEqual([]);
    expect(body.evidence).toEqual([
      { kind: 'lesson', id: 'lesson:1', role: 'target', weight: 1, observedAt: 't', label: 'target' },
      { kind: 'activity', id: 'act:1', role: 'served', weight: 1, observedAt: 't', label: 'served', activity: null, missing: true },
    ]);
    expect(body.dependsOn).toEqual([]);
    expect((await get(app, '/api/decisions/dec:none')).status).toBe(404);
    expect((await get(app, '/api/decisions/dec:o')).status).toBe(404);
  });

  test("evidence and links of a hidden project are masked: its sessions, its lessons (a global one by origin), what it depends on and what depends on it", async () => {
    const secret = decision('dec:secret', { projectKey: 'other', type: 'link_misses', targets: [{ kind: 'miss', id: 'miss:hid-1c', role: 'primary' }] });
    const hiddenChild = decision('dec:child', { projectKey: 'other', dependsOn: ['dec:x'], createdAt: '2026-11-10T00:00:00.000Z' });
    const shownChild = decision('dec:kid', { dependsOn: ['dec:x'], createdAt: '2026-11-10T01:00:00.000Z' });
    const d = decision('dec:x', {
      dependsOn: ['dec:secret', 'dec:p'],
      evidence: [
        { kind: 'session', id: 'hid-sess', role: 'served in', weight: 0.2, observedAt: 't' },
        { kind: 'session', id: 'sess-1', role: 'served in', weight: 0.2, observedAt: 't' },
        { kind: 'lesson', id: 'lesson:g', role: 'target', weight: 1, observedAt: 't' },
        { kind: 'lesson', id: 'lesson:h', role: 'target', weight: 1, observedAt: 't' },
      ],
    });
    const { app, snapshots, deps } = setup({
      decisions: [d, secret, hiddenChild, shownChild, proposed], shown: ['shop'],
      lessons: { 'lesson:g': { id: 'lesson:g', projectKey: null, origin: 'other', title: 'HIDDEN GLOBAL LESSON TITLE' } as never },
    });
    deps.sessionDetail = async (id) => ({ id, projectKey: id === 'hid-sess' ? 'other' : 'shop', snippet: id === 'hid-sess' ? 'HIDDEN SESSION SUMMARY' : 'Refactor checkout' }) as never;
    snapshots.set('lesson:lesson:g', snap('lesson:g', { title: 'HIDDEN GLOBAL LESSON TITLE', projectKey: null }));
    snapshots.set('lesson:lesson:h', snap('lesson:h', { title: 'HIDDEN PROJECT LESSON', projectKey: 'other' }));
    const body = await (await get(app, '/api/decisions/dec:x')).json();
    expect(JSON.stringify(body)).not.toMatch(/HIDDEN|hid-1c|"other"/);
    expect(body.evidence).toEqual([
      { kind: 'session', id: 'hid-sess', role: 'served in', weight: 0.2, observedAt: 't', label: 'served in', missing: true },
      expect.objectContaining({ kind: 'session', id: 'sess-1', label: 'Refactor checkout', projectKey: 'shop' }),
      { kind: 'lesson', id: 'lesson:g', role: 'target', weight: 1, observedAt: 't', label: 'target', missing: true },
      { kind: 'lesson', id: 'lesson:h', role: 'target', weight: 1, observedAt: 't', label: 'target', missing: true },
    ]);
    expect(body.dependsOn.map((x: { id: string }) => x.id)).toEqual(['dec:p']);
    expect(body.dependents.map((x: { id: string }) => x.id)).toEqual(['dec:kid']);
  });

  test('a summary names the primary target, else the first, else the decision', () => {
    expect(summaryOf(decision('dec:k', { targets: [{ kind: 'lesson', id: 'lesson:keep', role: 'keeper' }, { kind: 'lesson', id: 'lesson:p', role: 'primary' }] })).label).toBe('retire lesson · lesson:p');
    expect(summaryOf(decision('dec:k', { type: 'merge_duplicates', targets: [{ kind: 'lesson', id: 'lesson:keep', role: 'keeper' }] })).label).toBe('merge duplicates · lesson:keep');
    expect(summaryOf(decision('dec:k', { type: 'tune_threshold', targets: [] })).label).toBe('tune threshold · dec:k');
  });

  test('a request its client closed is not answered as a store outage', async () => {
    const { app, fail } = setup({ decisions: all });
    fail.store = new Error('cancelled');
    const ctl = new AbortController();
    const pending = app.request(new Request('http://localhost/api/decisions', { headers: reader, signal: ctl.signal }));
    ctl.abort();
    expect((await pending).status).toBe(499);
  });

  test('the clock defaults to now', async () => {
    const loop = fakeLoop({});
    const { now: _, ...deps } = loop.deps;
    const app = createApp(repo, { loop: deps });
    const s = await (await app.request('/api/loop')).json();
    expect(s.budget.llmCallsToday).toBe(0);
  });

  test('a session label without a session lookup is its role', async () => {
    const d = decision('dec:x', { evidence: [{ kind: 'session', id: 's', role: 'served in', weight: 1, observedAt: 't' }] });
    const loop = fakeLoop({ decisions: [d] });
    const { sessionDetail: _, ...deps } = loop.deps;
    const app = createApp(repo, { loop: deps });
    expect((await (await app.request('/api/decisions/dec:x')).json()).evidence).toEqual([{ kind: 'session', id: 's', role: 'served in', weight: 1, observedAt: 't', label: 'served in' }]);
  });
});

describe('POST /api/decisions/:id/approve | reject | keep | rollback', () => {
  test('approve applies a proposal through the executor as you, keeps a note, and logs decision_applied', async () => {
    const { app, calls, notes, entries } = setup({ decisions: all });
    const res = await post(app, '/api/decisions/dec:p/approve', { expect: 'proposed', note: 'good one' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'dec:p', status: 'applied', decidedBy: 'you' });
    expect(calls.apply).toEqual([['dec:p', 'you']]);
    expect(notes).toEqual([expect.objectContaining({ decisionId: 'dec:p', by: 'you', text: 'good one', verdict: 'agree' })]);
    expect(entries).toEqual([expect.objectContaining({
      kind: 'decision_applied', actor: 'you', projectKey: 'shop', subject: 'approve lesson · lesson:1: approved and applied', why: 'you approved it',
      details: expect.objectContaining({ decisionId: 'dec:p', decisionType: 'approve_lesson', status: 'applied', action: 'approve' }), targets: ['dec:p', 'lesson:1'],
    })]);
  });

  test('an approve whose target changed since is a 409; the executor marked it overridden, and that is logged', async () => {
    const { app, fail, entries } = setup({ decisions: all });
    fail.apply = new TargetChangedError('lesson:1', 'a', 'b');
    const res = await post(app, '/api/decisions/dec:p/approve', { expect: 'proposed' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/lesson:1 changed since it was proposed, so nothing was applied; it is marked overridden/);
    expect(entries).toEqual([expect.objectContaining({
      kind: 'decision_made', why: 'you tried to approve it after lesson:1 changed',
      details: expect.objectContaining({ decisionId: 'dec:p', status: 'overridden', action: 'overridden' }),
    })]);
    fail.apply = new Error('boom');
    expect((await post(app, '/api/decisions/dec:p/approve', { expect: 'proposed' })).status).toBe(503);
  });

  test("the executor's refusals: moved meanwhile and a blocked cascade are 409s (the cascade named), a write it cannot make a 422; nothing is logged", async () => {
    const { app, fail, entries } = setup({ decisions: all });
    fail.apply = new DecisionStateError('dec:p', 'applying', 'proposed or observed');
    expect(await (await post(app, '/api/decisions/dec:p/approve', { expect: 'proposed' })).json()).toEqual({ error: 'decision dec:p is applying, not proposed or observed: reload it' });
    fail.apply = new UnsupportedTargetError({ kind: 'project', id: 'shop' }, 'apply');
    const unsupported = await post(app, '/api/decisions/dec:p/approve', { expect: 'proposed' });
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toEqual({ error: 'cannot apply project shop' });
    fail.rollback = new CascadeBlockedError([{ id: 'dec:later', reason: 'lesson:1 changed since' }]);
    const blocked = await post(app, '/api/decisions/dec:a/rollback', { expect: 'applied' });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: expect.stringMatching(/also undoes dec:later.*nothing was rolled back$/), blocked: [{ id: 'dec:later', reason: 'lesson:1 changed since' }] });
    fail.rollback = new DecisionStateError('dec:a', 'rolled_back', 'applied');
    expect((await post(app, '/api/decisions/dec:a/rollback', { expect: 'applied', cascade: 'preview' })).status).toBe(409);
    expect(entries).toEqual([]);
  });

  test('a note that cannot be saved after a reject, keep or approve leaves the action done and answered, saying so', async () => {
    const { app, entries, decisions, deps } = setup({ decisions: all });
    deps.decisions.addNote = async () => { throw Object.assign(new Error('Neo.TransientError.Transaction.DeadlockDetected'), { code: 'Neo.TransientError.Transaction.DeadlockDetected' }); };
    for (const [id, action, expect_, status] of [['dec:o', 'reject', 'observed', 'rejected'], ['dec:a', 'keep', 'applied', 'applied'], ['dec:p', 'approve', 'proposed', 'applied']] as const) {
      const r = await post(app, `/api/decisions/${id}/${action}`, { expect: expect_, note: 'why' });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ id, status, noteError: expect.stringMatching(/^done, but its note was not saved .*: add it again$/) });
      expect(decisions.get(id)!.status).toBe(status);
    }
    expect(entries.map((e) => e.details.action)).toEqual(['reject', 'keep', 'approve']);
  });

  test('reject and keep move the decision in the store, with your note and reason, and log decision_made', async () => {
    const { app, notes, entries, decisions } = setup({ decisions: all });
    const r = await post(app, '/api/decisions/dec:o/reject', { expect: 'observed', note: 'not the same miss', reason: 'wrong_evidence' });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id: 'dec:o', status: 'rejected', decidedBy: 'you' });
    const k = await post(app, '/api/decisions/dec:a/keep', { expect: 'applied', note: 'keep it' });
    expect(k.status).toBe(200);
    expect(await k.json()).toMatchObject({ id: 'dec:a', status: 'applied', ratifiedBy: 'you' });
    expect(decisions.get('dec:a')!.ratifiedBy).toBe('you');
    expect(notes.map((n) => [n.decisionId, n.verdict, n.reason])).toEqual([['dec:o', 'disagree', 'wrong_evidence'], ['dec:a', 'agree', null]]);
    expect(entries.map((e) => [e.kind, e.details.action, e.details.status, e.details.reason])).toEqual([['decision_made', 'reject', 'rejected', 'wrong_evidence'], ['decision_made', 'keep', 'applied', undefined]]);
    // A note without a reason.
    const { app: app3, notes: notes3 } = setup({ decisions: all });
    await post(app3, '/api/decisions/dec:p/reject', { expect: 'proposed', note: 'no' });
    expect(notes3.map((n) => [n.verdict, n.reason])).toEqual([['disagree', null]]);
    // Without a note, nothing but the move.
    const { app: app2, notes: notes2 } = setup({ decisions: all });
    expect((await post(app2, '/api/decisions/dec:p/reject', { expect: 'proposed' })).status).toBe(200);
    expect((await post(app2, '/api/decisions/dec:a/keep', { expect: 'applied' })).status).toBe(200);
    expect(notes2).toEqual([]);
  });

  test('a stale expect, or a status the action does not take, is a 409 with an error the page shows', async () => {
    const { app } = setup({ decisions: all });
    const stale = await post(app, '/api/decisions/dec:a/rollback', { expect: 'proposed' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'it is applied now, not proposed: reload it' });
    expect(await (await post(app, '/api/decisions/dec:a/approve', { expect: 'applied' })).json()).toEqual({ error: 'a decision that is applied cannot be approved' });
    expect(await (await post(app, '/api/decisions/dec:p/keep', { expect: 'proposed' })).json()).toEqual({ error: 'a decision that is proposed cannot be kept' });
    expect(await (await post(app, '/api/decisions/dec:p/rollback', { expect: 'proposed' })).json()).toEqual({ error: 'a decision that is proposed cannot be rolled back' });
    expect(await (await post(app, '/api/decisions/dec:a/reject', { expect: 'applied' })).json()).toEqual({ error: 'a decision that is applied cannot be rejected' });
  });

  test('a decision that moved between the read and the write is a 409', async () => {
    const { app, deps } = setup({ decisions: all });
    deps.decisions.markStatus = async () => false;
    deps.decisions.ratify = async () => false;
    expect(await (await post(app, '/api/decisions/dec:p/reject', { expect: 'proposed' })).json()).toEqual({ error: 'approve lesson · lesson:1 changed meanwhile: reload it' });
    expect((await post(app, '/api/decisions/dec:a/keep', { expect: 'applied' })).status).toBe(409);
  });

  test('bodies are checked: expect is required, cascade and restoreAnyway go with rollback only; unknown ids 404', async () => {
    const { app } = setup({ decisions: all });
    expect((await post(app, '/api/decisions/dec:p/approve', {})).status).toBe(400);
    expect((await post(app, '/api/decisions/dec:p/approve', { expect: 'proposed', extra: 1 })).status).toBe(400);
    expect((await post(app, '/api/decisions/dec:p/approve', { expect: 'proposed', reason: 'nope' })).status).toBe(400);
    expect((await app.request('/api/decisions/dec:p/approve', { method: 'POST', headers: { 'content-type': 'application/json', ...owner }, body: '{' })).status).toBe(400);
    expect(await (await post(app, '/api/decisions/dec:p/approve', { expect: 'proposed', cascade: 'preview' })).json()).toEqual({ error: 'cascade and restoreAnyway go only with rollback' });
    expect((await post(app, '/api/decisions/dec:a/keep', { expect: 'applied', restoreAnyway: false })).status).toBe(400);
    expect((await post(app, '/api/decisions/dec:none/keep', { expect: 'applied' })).status).toBe(404);
  });

  test('rollback preview changes nothing and answers the cascade newest first and what blocks it', async () => {
    const blocking = decision('dec:blk', { status: 'overridden', dependsOn: ['dec:a'], createdAt: '2026-11-10T06:00:00.000Z' });
    const { app, decisions, entries, calls } = setup({ decisions: [...all, blocking] });
    const res = await post(app, '/api/decisions/dec:a/rollback', { expect: 'applied', cascade: 'preview', reason: 'too_broad' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cascade: [expect.objectContaining({ id: 'dec:blk', status: 'overridden' }), expect.objectContaining({ id: 'dec:later', label: 'rank weight · lesson:1' })],
      blocked: [{ id: 'dec:blk', reason: 'you changed its target since' }],
    });
    expect(calls.rollback).toEqual([['dec:a', { by: 'you', cascade: 'preview', reason: 'too_broad' }]]);
    expect(decisions.get('dec:a')!.status).toBe('applied');
    expect(entries).toEqual([]);
  });

  test('a rollback preview that finds the decision\'s own target changed since marks it overridden with a 409, so Restore anyway is offered', async () => {
    const { app, deps, decisions, entries } = setup({ decisions: [applied, later] });
    const own = { targetId: 'lesson:1', expected: applied.after[0]!.fingerprint, actual: 'fp:the owner reworded it' };
    deps.exec!.rollback = async () => ({ cascade: [later], blocked: [{ id: 'dec:a', reason: 'lesson lesson:1 changed since it was applied' }], own });
    const res = await post(app, '/api/decisions/dec:a/rollback', { expect: 'applied', cascade: 'preview' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'its lesson lesson:1 changed since it was applied, so nothing was rolled back; it is marked overridden: reload it to compare, or restore anyway' });
    expect(decisions.get('dec:a')!.status).toBe('overridden');
    expect(entries).toEqual([expect.objectContaining({ kind: 'decision_made', why: 'you tried to roll it back after its target changed', details: expect.objectContaining({ decisionId: 'dec:a', status: 'overridden', action: 'overridden' }) })]);
    // Only a dependent blocked: the preview answers as before, and nothing moves.
    const dep = setup({ decisions: [applied, later] });
    dep.deps.exec!.rollback = async () => ({ cascade: [later], blocked: [{ id: 'dec:later', reason: 'lesson lesson:1 changed since it was applied' }], own: null });
    expect((await post(dep.app, '/api/decisions/dec:a/rollback', { expect: 'applied', cascade: 'preview' })).status).toBe(200);
    expect(dep.decisions.get('dec:a')!.status).toBe('applied');
    expect(dep.entries).toEqual([]);
  });

  test('a rollback preview whose own target another applied decision left so is a 409 naming that decision, not an owner override', async () => {
    // Recorded without the dependency, so it is not in the cascade: its `after` is the target as it is now.
    const other = decision('dec:other', { type: 'rank_weight', createdAt: '2026-11-10T02:00:00.000Z', after: [snap('lesson:1', { title: 'Validate totals', servingWeight: 0.9 })] });
    const { app, deps, decisions, entries } = setup({ decisions: [applied, other] });
    deps.exec!.rollback = async () => ({ cascade: [], blocked: [{ id: 'dec:a', reason: 'lesson lesson:1 changed since it was applied' }], own: { targetId: 'lesson:1', expected: applied.after[0]!.fingerprint, actual: other.after[0]!.fingerprint } });
    const res = await post(app, '/api/decisions/dec:a/rollback', { expect: 'applied', cascade: 'preview' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'lesson:1 was changed since by dec:other, still applied: roll that back first', blocked: [{ id: 'dec:other', reason: 'lesson:1 is as it left it' }] });
    expect(decisions.get('dec:a')!.status).toBe('applied');
    expect(entries).toEqual([]);
  });

  test('rollback applies the cascade and the decision (the default), with your reason and note, and logs decision_rolled_back', async () => {
    const { app, calls, entries } = setup({ decisions: [...all, decision('dec:later2', { dependsOn: ['dec:a'], createdAt: '2026-11-10T01:00:00.000Z' })] });
    const res = await post(app, '/api/decisions/dec:a/rollback', { expect: 'applied', reason: 'too_broad', note: 'still useful in checkout' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'rolled_back', rollback: { by: 'you', reason: 'too_broad', note: 'still useful in checkout', cascade: ['dec:later2', 'dec:later'] } });
    expect(calls.rollback).toEqual([['dec:a', { by: 'you', cascade: 'apply', reason: 'too_broad', note: 'still useful in checkout' }]]);
    // One entry per decision undone: the cascaded ones first, each pointing at the one you rolled back.
    expect(entries).toEqual([
      expect.objectContaining({ kind: 'decision_rolled_back', subject: 'retire lesson · lesson:1: rolled back with dec:a', why: 'you rolled back a decision it depended on', targets: ['dec:later2', 'lesson:1'], details: expect.objectContaining({ decisionId: 'dec:later2', decisionType: 'retire_lesson', status: 'rolled_back', action: 'cascade', cascadeOf: 'dec:a' }) }),
      expect.objectContaining({ kind: 'decision_rolled_back', details: expect.objectContaining({ decisionId: 'dec:later', decisionType: 'rank_weight', status: 'rolled_back', action: 'cascade', cascadeOf: 'dec:a' }) }),
      expect.objectContaining({
        kind: 'decision_rolled_back', subject: 'retire lesson · lesson:1: rolled back with 2 later decisions', why: 'you rolled it back',
        details: expect.objectContaining({ decisionId: 'dec:a', decisionType: 'retire_lesson', status: 'rolled_back', action: 'rollback', cascade: ['dec:later2', 'dec:later'], reason: 'too_broad', note: 'still useful in checkout' }),
      }),
    ]);
  });

  test('a rollback whose target the owner changed since is refused with 409 and marks the decision overridden; Restore anyway writes before over it', async () => {
    const { app, fail, decisions, entries, calls } = setup({ decisions: [applied] });
    fail.rollback = new TargetChangedError('lesson:1', 'a', 'b');
    const refused = await post(app, '/api/decisions/dec:a/rollback', { expect: 'applied', cascade: 'apply' });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/lesson:1 was changed since this decision was applied.*marked overridden/);
    expect(decisions.get('dec:a')!.status).toBe('overridden');
    expect(entries).toEqual([expect.objectContaining({
      kind: 'decision_made', subject: 'retire lesson · lesson:1: overridden: its target changed since', why: 'you tried to roll it back after lesson:1 changed',
      details: expect.objectContaining({ decisionId: 'dec:a', decisionType: 'retire_lesson', status: 'overridden', action: 'overridden' }),
    })]);
    entries.length = 0;
    // Overridden meanwhile by someone else: the 409 still, and no second entry.
    const raced = setup({ decisions: [applied] });
    raced.fail.rollback = new TargetChangedError('lesson:1', 'a', 'b');
    raced.deps.decisions.markStatus = async () => false;
    expect((await post(raced.app, '/api/decisions/dec:a/rollback', { expect: 'applied' })).status).toBe(409);
    expect(raced.entries).toEqual([]);
    delete fail.rollback;
    // Overridden: a plain rollback says to restore anyway; restoreAnyway on an applied one is a 400.
    expect(await (await post(app, '/api/decisions/dec:a/rollback', { expect: 'overridden' })).json()).toEqual({ error: expect.stringMatching(/send restoreAnyway/) });
    const restored = await post(app, '/api/decisions/dec:a/rollback', { expect: 'overridden', restoreAnyway: true });
    expect(restored.status).toBe(200);
    expect(calls.rollback.at(-1)).toEqual(['dec:a', { by: 'you', cascade: 'apply', restoreAnyway: true }]);
    expect(entries).toEqual([expect.objectContaining({ kind: 'decision_rolled_back', subject: 'retire lesson · lesson:1: restored over a later change', why: 'you restored it anyway', details: expect.objectContaining({ decisionId: 'dec:a', decisionType: 'retire_lesson', status: 'overridden', action: 'restore_anyway' }) })]);
    await post(app, '/api/decisions/dec:a/rollback', { expect: 'rolled_back' });
    const again2 = setup({ decisions: [decision('dec:a', { status: 'overridden' })] });
    await post(again2.app, '/api/decisions/dec:a/rollback', { expect: 'overridden', restoreAnyway: true, reason: 'other', note: 'mine' });
    expect(again2.entries[0].details).toMatchObject({ action: 'restore_anyway', reason: 'other', note: 'mine' });
    const again = setup({ decisions: [applied] });
    expect((await post(again.app, '/api/decisions/dec:a/rollback', { expect: 'applied', restoreAnyway: true })).status).toBe(400);
    again.fail.rollback = new Error('db down');
    expect((await post(again.app, '/api/decisions/dec:a/rollback', { expect: 'applied' })).status).toBe(503);
  });

  test('a rollback with no cascade record logs plain "rolled back"', async () => {
    const { app, deps, entries } = setup({ decisions: [applied] });
    deps.exec!.rollback = async (d) => ({ ...d, status: 'rolled_back' });
    expect((await post(app, '/api/decisions/dec:a/rollback', { expect: 'applied' })).status).toBe(200);
    expect(entries[0].subject).toBe('retire lesson · lesson:1: rolled back');
    deps.exec!.rollback = async (d) => ({ ...d, status: 'rolled_back', rollback: { at: 't', by: 'you', reason: null, note: null, cascade: ['dec:later'] } });
    expect((await post(app, '/api/decisions/dec:a/rollback', { expect: 'applied' })).status).toBe(200);
    expect(entries[1].subject).toBe('retire lesson · lesson:1: rolled back with 1 later decision');
  });

  test('without an executor, approve and rollback answer 501; reject and keep still work', async () => {
    const { app } = setup({ decisions: all, exec: false });
    expect((await post(app, '/api/decisions/dec:p/approve', { expect: 'proposed' })).status).toBe(501);
    expect((await post(app, '/api/decisions/dec:a/rollback', { expect: 'applied' })).status).toBe(501);
    expect((await post(app, '/api/decisions/dec:p/reject', { expect: 'proposed' })).status).toBe(200);
  });
});

describe('who may decide', () => {
  test('the operator token needs loop_decide (off by default) and is logged as the agent; the API token never decides', async () => {
    const refused = setup({ decisions: all, allow: ['scan'] });
    const res = await post(refused.app, '/api/decisions/dec:p/reject', { expect: 'proposed' }, { authorization: `Bearer ${OP}`, 'x-fg-operator': 'codex' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/loop_decide/);
    const allowed = setup({ decisions: all });
    expect((await post(allowed.app, '/api/decisions/dec:p/reject', { expect: 'proposed' }, { authorization: `Bearer ${OP}`, 'x-fg-operator': 'codex' })).status).toBe(200);
    expect(allowed.decisions.get('dec:p')!.decidedBy).toBe('operator:codex');
    expect(allowed.entries[0]).toMatchObject({ actor: 'operator:codex', why: 'an agent (operator:codex) rejected it' });
    expect((await post(allowed.app, '/api/decisions/dec:a/keep', { expect: 'applied' }, reader)).status).toBe(403);
    expect((await post(allowed.app, '/api/loop/pause', {}, reader)).status).toBe(403);
    expect((await post(refused.app, '/api/loop/pause', {}, { authorization: `Bearer ${OP}` })).status).toBe(403);
  });

  test('a tokenless install is read-only: every loop write is refused, and the loop runs at most in observe', async () => {
    const { app, cursors } = setup({ decisions: all, auth: null });
    for (const [path, body] of [['/api/decisions/dec:p/approve', { expect: 'proposed' }], ['/api/decisions/dec:p/notes', { text: 'x' }], ['/api/loop/pause', {}], ['/api/loop/resume', {}]] as const) {
      const res = await post(app, path, body, {});
      expect(res.status, path).toBe(403);
      expect(await res.json()).toMatchObject({ readOnly: true });
    }
    expect((await post(app, '/api/loop/settings', { mode: 'auto' }, {}, 'PUT')).status).toBe(403);
    expect(cursors.get(LOOP_SETTINGS_CURSOR)).toBeUndefined();
    expect(await (await get(app, '/api/loop', {})).json()).toMatchObject({ mode: 'auto', effectiveMode: 'observe', capped: 'tokenless' });
  });
});

describe('POST /api/decisions/:id/notes', () => {
  test('adds your note (201), redacted by the store, and logs decision_noted; a reason goes only with disagree', async () => {
    const { app, entries } = setup({ decisions: all });
    const res = await post(app, '/api/decisions/dec:a/notes', { text: 'too broad for checkout', verdict: 'disagree', reason: 'too_broad' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'dnote:1', decisionId: 'dec:a', ts: expect.any(String), by: 'you', text: 'too broad for checkout', verdict: 'disagree', reason: 'too_broad' });
    const plain = await post(app, '/api/decisions/dec:a/notes', { text: 'fine' });
    expect(await plain.json()).toEqual({ id: 'dnote:2', decisionId: 'dec:a', ts: expect.any(String), by: 'you', text: 'fine', verdict: null });
    expect(entries.map((e) => [e.kind, e.subject, e.details.verdict, e.details.reason])).toEqual([
      ['decision_noted', 'retire lesson · lesson:1: note (disagree)', 'disagree', 'too_broad'],
      ['decision_noted', 'retire lesson · lesson:1: note', undefined, undefined],
    ]);
    expect((await post(app, '/api/decisions/dec:a/notes', { text: 'x', verdict: 'agree', reason: 'too_broad' })).status).toBe(400);
    expect((await post(app, '/api/decisions/dec:a/notes', { text: '   ' })).status).toBe(400);
    expect((await post(app, '/api/decisions/dec:none/notes', { text: 'x' })).status).toBe(404);
  });

  test('a decision gone between the read and the note is a 404', async () => {
    const { app, deps } = setup({ decisions: all });
    deps.decisions.addNote = async () => null;
    expect((await post(app, '/api/decisions/dec:a/notes', { text: 'x' })).status).toBe(404);
  });

  test('noteWire leaves a null reason out', () => {
    expect(noteWire({ id: 'n', decisionId: 'd', ts: 't', by: 'you', text: 'x', verdict: null, reason: null })).toEqual({ id: 'n', decisionId: 'd', ts: 't', by: 'you', text: 'x', verdict: null });
  });
});

describe('GET /api/loop', () => {
  test('the mode as set and as it runs, every type with its calibration, rollback rate and breaker, the budget, counts and the round', async () => {
    const recent = (id: string, o: Partial<Decision>) => decision(id, { createdAt: '2026-11-10T00:00:00.000Z', ...o });
    const { app, cursors, buckets } = setup({
      decisions: [
        recent('w:obs', { mode: 'observe', status: 'observed', appliedAt: null }),
        recent('w:prop', { mode: 'propose', status: 'proposed', appliedAt: null }),
        recent('w:prop2', { mode: 'propose', status: 'proposed', appliedAt: null, projectKey: 'hidden' }),
        recent('w:rb', { status: 'rolled_back' }),
        decision('old:applied', { createdAt: '2026-10-01T00:00:00.000Z' }),
      ],
      shown: ['shop'],
    });
    cursors.set('loop-budget', JSON.stringify({ day: '2026-11-11', llmCalls: 7, auto: 1, autoByProject: { shop: 1 } }));
    cursors.set('loop-breaker:merge_duplicates', JSON.stringify({ tripped: true, at: '2026-11-08T00:00:00.000Z', reason: '2 rollbacks in 7 days' }));
    const round: LoopRound = { id: 'round:1', startedAt: 't0', finishedAt: null, phase: 'scoring', signalsIngested: 3, targetsScored: 1, targetsTotal: 2, decisions: { observed: 0, proposed: 0, applied: 0, skipped: 0 }, skipped: [], llmCalls: 0, error: null };
    await writeLoopRound({ getCursor: async (k) => cursors.get(k) ?? null, setCursor: async (k, v) => { cursors.set(k, v); } }, round);
    buckets.push({ type: 'retire_lesson', band: 4, policyVersion: 1, alpha: 10, beta: 2, n: 7, updatedAt: 't' });
    const s = await (await get(app, '/api/loop')).json();
    expect(s).toMatchObject({
      mode: 'auto', effectiveMode: 'auto', disabled: false, paused: null, capped: null, policyVersion: 1,
      budget: { llmCallsToday: 7, llmCallsPerDay: 40, autoToday: 1, autoPerDay: 5, autoPerProject: 2 },
      counts: { proposed: 1, week: { observed: 1, proposed: 1, applied: 1, rolledBack: 1 } },
      rollbackRate: { rolledBack: 1, of: 1 },
      round, holdout: null,
    });
    expect(s.types.map((t: { type: string }) => t.type)).toEqual([...LOOP_DECISION_TYPES]);
    const retire = s.types.find((t: { type: string }) => t.type === 'retire_lesson');
    expect(retire).toMatchObject({ tier: 'H', mode: null, effectiveMode: 'auto', tau: 0.5, tauDefault: 0.5, rollbackRate: { rolledBack: 1, of: 2 }, breaker: { tripped: false, at: null, reason: null } });
    expect(retire.bands).toHaveLength(5);
    expect(retire.bands[4]).toMatchObject({ band: 4, alpha: 10, beta: 2, n: 7 });
    expect(retire.bands[0]).toMatchObject({ band: 0, alpha: 4, beta: 1, n: 0 });
    // Every band's labels on one prior: Beta(4 + 6, 1 + 1).
    expect(retire.calibration.n).toBe(7);
    expect(retire.calibration.p).toBeCloseTo(10 / 12);
    expect(retire.calibration.lower).toBeLessThan(retire.calibration.p);
    expect(s.types.find((t: { type: string }) => t.type === 'merge_duplicates')).toMatchObject({ effectiveMode: 'propose', breaker: { tripped: true, reason: '2 rollbacks in 7 days' } });
    expect(s.types.find((t: { type: string }) => t.type === 'approve_lesson')).toMatchObject({ tier: 'A', tau: 0.9, calibration: { p: 0.2, n: 0 } });
    expect(s.types.find((t: { type: string }) => t.type === 'tune_threshold')).toMatchObject({ tier: 'P', effectiveMode: 'propose' });
  });

  test('LOOP_DISABLED caps it at off; an API without the loop has no /api/loop (404)', async () => {
    const { app } = setup({ config: { disabled: true, mode: 'propose' } });
    expect(await (await get(app, '/api/loop')).json()).toMatchObject({ mode: 'propose', effectiveMode: 'off', disabled: true, capped: 'disabled', round: null });
    expect((await createApp(repo, {}).request('/api/loop')).status).toBe(404);
  });

  test('the counts read every page of a long log', async () => {
    const many = Array.from({ length: 600 }, (_, i) => decision(`dec:${String(i).padStart(4, '0')}`, { status: 'proposed', mode: 'propose', appliedAt: null, createdAt: '2026-11-10T00:00:00.000Z' }));
    const { app } = setup({ decisions: many });
    expect((await (await get(app, '/api/loop')).json()).counts.proposed).toBe(600);
  });

  test('the shown projects are read once a request and the decisions counted in the store: as many reads for 4 decisions as for 4,000', async () => {
    const reads = async (n: number) => {
      const many = Array.from({ length: n }, (_, i) => decision(`dec:${String(i).padStart(5, '0')}`, {
        status: (['proposed', 'applied', 'rolled_back', 'observed'] as const)[i % 4], mode: i % 4 === 3 ? 'observe' : 'propose', createdAt: '2026-11-10T00:00:00.000Z',
        projectKey: i % 8 < 4 ? 'shop' : 'hidden', ...(i % 4 !== 1 && i % 4 !== 2 && { appliedAt: null }),
      }));
      const loop = fakeLoop({ decisions: many });
      const calls: string[] = [];
      for (const [k, f] of Object.entries(loop.deps.decisions)) Object.assign(loop.deps.decisions, { [k]: (...a: unknown[]) => { calls.push(k); return (f as (...x: unknown[]) => unknown)(...a); } });
      let views = 0;
      const app = createApp(repo, { loop: loop.deps, auth: { token: API, ownerToken: OWNER }, shown: () => { views++; return { keys: ['shop'], has: (k: string) => k === 'shop' } as never; } });
      const s = await (await get(app, '/api/loop')).json();
      return { views, calls: calls.length, listed: calls.filter((c) => c === 'list').length, counts: s.counts, rate: s.rollbackRate };
    };
    const small = await reads(4);
    const big = await reads(4000);
    expect(small.views).toBe(1);
    expect(big.views).toBe(1);
    expect(big.calls).toBe(small.calls);
    // A type's last few applied (one list a type), never a page of the log.
    expect(big.listed).toBe(LOOP_DECISION_TYPES.length);
    // Half of each status is in the hidden project.
    expect(big.counts).toEqual({ proposed: 500, week: { observed: 500, proposed: 1500, applied: 1000, rolledBack: 500 } });
    expect(big.rate).toEqual({ rolledBack: 500, of: 1000 });
  });
});

describe('PUT /api/loop/settings, POST /api/loop/pause | resume', () => {
  test('changes the mode and per-type modes and taus, resets a tripped breaker it sets, logs what changed and answers the new state', async () => {
    const { app, cursors, entries } = setup();
    cursors.set('loop-breaker:merge_duplicates', JSON.stringify({ tripped: true, at: 't', reason: 'r' }));
    const res = await post(app, '/api/loop/settings', { mode: 'propose', types: { merge_duplicates: { mode: 'auto' }, approve_lesson: { tau: 0.95 } } }, owner, 'PUT');
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.mode).toBe('propose');
    expect(s.types.find((t: { type: string }) => t.type === 'merge_duplicates')).toMatchObject({ mode: 'auto', effectiveMode: 'auto', breaker: { tripped: false } });
    expect(s.types.find((t: { type: string }) => t.type === 'approve_lesson')).toMatchObject({ mode: null, tau: 0.95, effectiveMode: 'propose' });
    expect(entries).toEqual([expect.objectContaining({
      kind: 'loop_settings_changed', actor: 'you', projectKey: null, why: 'you changed the learning loop settings',
      subject: 'learning loop: mode auto → propose, merge_duplicates mode global → auto, merge_duplicates breaker reset, approve_lesson tau default → 0.95',
    })]);
    // Back to following the global mode and the default tau; a type with no breaker tripped is not reset.
    await post(app, '/api/loop/settings', { types: { merge_duplicates: { mode: null }, approve_lesson: { tau: null, mode: 'observe' } } }, owner, 'PUT');
    expect(entries[1].subject).toBe('learning loop: merge_duplicates mode auto → global, approve_lesson mode global → observe, approve_lesson tau 0.95 → default');
    // Nothing changed: nothing logged.
    await post(app, '/api/loop/settings', { mode: 'propose' }, owner, 'PUT');
    expect(entries).toHaveLength(2);
  });

  test('tau below the default or above 1, an unknown type or mode, or a stray field is a 400', async () => {
    const { app } = setup();
    for (const body of [{ types: { approve_lesson: { tau: 0.5 } } }, { types: { approve_lesson: { tau: 1.1 } } }, { types: { teleport: { mode: 'auto' } } }, { mode: 'yolo' }, { paused: true }]) {
      expect((await post(app, '/api/loop/settings', body, owner, 'PUT')).status, JSON.stringify(body)).toBe(400);
    }
    expect(await (await post(app, '/api/loop/settings', { types: { approve_lesson: { tau: 0.5 } } }, owner, 'PUT')).json()).toEqual({ error: 'approve_lesson: tau must be from 0.9 (its default) to 1' });
    expect((await app.request('/api/loop/settings', { method: 'PUT', headers: { 'content-type': 'application/json', ...owner }, body: 'x' })).status).toBe(400);
  });

  test('a tier P type (always a proposal: a conflict\'s resolution, a question assigned or closed) refuses auto; observe and propose are kept', async () => {
    const { app, entries } = setup();
    for (const type of ['propose_resolution', 'assign_question', 'close_question', 'tune_threshold']) {
      const res = await post(app, '/api/loop/settings', { types: { [type]: { mode: 'auto' } } }, owner, 'PUT');
      expect(res.status, type).toBe(400);
      expect((await res.json()).error).toBe(`${type} is always a proposal (tier P): it cannot apply on its own; set observe, propose or off`);
    }
    expect(entries).toEqual([]);
    const ok = await (await post(app, '/api/loop/settings', { types: { propose_resolution: { mode: 'propose' }, accept_claim: { mode: 'auto', tau: 0.95 } } }, owner, 'PUT')).json();
    expect(ok.types.find((t: { type: string }) => t.type === 'propose_resolution')).toMatchObject({ mode: 'propose', tier: 'P' });
    expect(ok.types.find((t: { type: string }) => t.type === 'accept_claim')).toMatchObject({ mode: 'auto', tau: 0.95, tier: 'A' });
    // accept_claim's bar is 0.92: it cannot be lowered.
    expect((await post(app, '/api/loop/settings', { types: { accept_claim: { tau: 0.9 } } }, owner, 'PUT')).status).toBe(400);
  });

  test('pause stops it at once (logged loop_paused), resume starts it again; a repeat changes nothing; refused while LOOP_DISABLED', async () => {
    const { app, entries } = setup();
    const paused = await (await post(app, '/api/loop/pause', {})).json();
    expect(paused).toMatchObject({ effectiveMode: 'off', capped: 'paused', paused: { by: 'you', at: '2026-11-11T12:00:00.000Z' } });
    await post(app, '/api/loop/pause', {});
    const resumed = await (await post(app, '/api/loop/resume', {})).json();
    expect(resumed).toMatchObject({ effectiveMode: 'auto', capped: null, paused: null });
    await post(app, '/api/loop/resume', {});
    expect(entries.map((e) => [e.kind, e.subject, e.details.paused])).toEqual([['loop_paused', 'learning loop paused', true], ['loop_paused', 'learning loop resumed', false]]);
    const off = setup({ config: { disabled: true } });
    const res = await post(off.app, '/api/loop/pause', {});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/LOOP_DISABLED=1/);
  });

  test('the operator token needs loop_settings; its pause is logged as the agent', async () => {
    const { app, entries } = setup({ allow: ['loop_settings'] });
    expect((await post(app, '/api/loop/pause', {}, { authorization: `Bearer ${OP}`, 'x-fg-operator': 'claude' })).status).toBe(200);
    expect(entries[0]).toMatchObject({ actor: 'operator:claude', why: 'an agent (operator:claude) paused the learning loop' });
    const s = await (await get(app, '/api/loop')).json();
    expect(s.paused.by).toBe('operator:claude');
  });
});

describe('GET /api/loop/events', () => {
  const round = (id: string, phase: LoopRound['phase'], at: string): LoopRound => ({
    id, startedAt: at, finishedAt: phase === 'done' ? at : null, phase, signalsIngested: 1, targetsScored: 2, targetsTotal: phase === 'done' ? null : 4,
    decisions: { observed: 1, proposed: 0, applied: 1, skipped: 2 }, skipped: [{ reason: 'suppressed', count: 2 }], llmCalls: 0, error: phase === 'aborted' ? 'store down' : null,
  });
  const kv = (l: Loop) => ({ getCursor: async (k: string) => l.cursors.get(k) ?? null, setCursor: async (k: string, v: string) => { l.cursors.set(k, v); } });

  test('the latest events oldest first, then only what came after the cursor, with rounds merged in; runs and other kinds left out', async () => {
    const l = setup();
    const { app, record } = l;
    record({ kind: 'decision_applied', actor: 'loop:1', projectKey: 'shop', subject: 'retired lesson 1', why: 'w', details: { decisionId: 'dec:a', decisionType: 'retire_lesson', status: 'applied' } });
    record({ kind: 'context_served', actor: 'agent', projectKey: 'shop', subject: 'not a loop event', why: 'w' });
    record({ kind: 'decision_made', actor: 'loop:1', projectKey: 'shop', subject: 'in a run', why: 'w', run: 'r1' });
    await writeLoopRound(kv(l), round('round:1', 'done', '2026-11-11T12:00:01.500Z'));
    const first = await (await get(app, '/api/loop/events')).json();
    expect(first.gap).toBe(false);
    expect(first.events).toEqual([
      { seq: 'a:act:1', ts: '2026-11-11T12:00:01.000Z', kind: 'decision_applied', actor: 'loop:1', subject: 'retired lesson 1', decisionId: 'dec:a', decisionType: 'retire_lesson', status: 'applied', projectKey: 'shop' },
      { seq: 'r:1', ts: '2026-11-11T12:00:01.500Z', kind: 'loop_round', actor: 'loop:1', subject: 'round done: 2 scored, 1 observed, 0 proposed, 1 applied, 2 skipped', decisionId: null, decisionType: null, status: null, projectKey: null },
    ]);
    // Nothing new: the same cursor back.
    const none = await (await get(app, `/api/loop/events?after=${first.next}`)).json();
    expect(none).toEqual({ events: [], next: first.next, gap: false });
    record({ kind: 'loop_paused', actor: 'you', projectKey: null, subject: 'learning loop paused', why: 'w' });
    await writeLoopRound(kv(l), round('round:2', 'aborted', '2026-11-11T12:00:05.000Z'));
    const next = await (await get(app, `/api/loop/events?after=${first.next}`)).json();
    expect(next.events.map((e: { seq: string; subject: string }) => [e.seq, e.subject])).toEqual([
      ['a:act:4', 'learning loop paused'],
      ['r:2', 'round aborted: 2 of 4 scored, 1 observed, 0 proposed, 1 applied, 2 skipped (store down)'],
    ]);
    expect(next.events[0]).toMatchObject({ decisionId: null, decisionType: null, status: null });
  });

  test('a full page leaves later rounds for the next poll, so the stream stays in order', async () => {
    const l = setup();
    const { app, record } = l;
    const start = await (await get(app, '/api/loop/events')).json();
    for (let i = 0; i < 120; i++) record({ kind: 'decision_made', actor: 'loop:1', projectKey: null, subject: `d${i}`, why: 'w' });
    await writeLoopRound(kv(l), round('round:late', 'done', '2099-01-01T00:00:00.000Z'));
    await writeLoopRound(kv(l), round('round:early', 'done', '2026-11-11T12:00:02.500Z'));
    const p1 = await (await get(app, `/api/loop/events?after=${start.next}`)).json();
    // The page holds 98 entries (room is kept for the 2 rounds); the first round by seq is later than all of them.
    expect(p1.events.map((e: { seq: string }) => e.seq)).toEqual(Array.from({ length: 98 }, (_, i) => `a:act:${i + 1}`));
    const p2 = await (await get(app, `/api/loop/events?after=${p1.next}`)).json();
    expect(p2.events.map((e: { seq: string }) => e.seq)).toEqual(['r:2', ...Array.from({ length: 22 }, (_, i) => `a:act:${i + 99}`), 'r:1']);
    // A full page with its rounds in time: they come with it.
    await writeLoopRound(kv(l), round('round:mid', 'writing', '2026-11-11T12:02:30.000Z'));
    for (let i = 0; i < 120; i++) record({ kind: 'decision_made', actor: 'loop:1', projectKey: null, subject: `e${i}`, why: 'w' });
    const p3 = await (await get(app, `/api/loop/events?after=${p2.next}`)).json();
    expect(p3.events).toHaveLength(100);
    expect(p3.events.filter((e: { kind: string }) => e.kind === 'loop_round').map((e: { seq: string }) => e.seq)).toEqual(['r:3']);
  });

  test('a cursor past the ring of kept rounds, or from another store, is a gap; one the API never gave is a 400', async () => {
    const l = setup();
    const { app } = l;
    for (let i = 0; i < 60; i++) await writeLoopRound(kv(l), round(`round:${i}`, 'done', `2026-11-11T12:00:${String(i).padStart(2, '0')}.000Z`));
    const old = Buffer.from(JSON.stringify({ a: null, r: 3 })).toString('base64url');
    const lagging = await (await get(app, `/api/loop/events?after=${old}`)).json();
    expect(lagging.gap).toBe(true);
    expect(lagging.events).toHaveLength(50);
    const foreign = Buffer.from(JSON.stringify({ a: 'neo/act:1', r: 60 })).toString('base64url');
    const moved = await (await get(app, `/api/loop/events?after=${foreign}`)).json();
    expect(moved).toMatchObject({ gap: true, events: [] });
    expect(JSON.parse(Buffer.from(moved.next, 'base64url').toString())).toEqual({ a: null, r: 60 });
    for (const bad of ['garbage', Buffer.from('{"a":1,"r":0}').toString('base64url'), Buffer.from('{"a":null,"r":-1}').toString('base64url'), 'x'.repeat(1001)]) {
      expect((await get(app, `/api/loop/events?after=${bad}`)).status, bad).toBe(400);
    }
    l.deps.activity.since = async () => { throw new Error('connection reset'); };
    expect((await get(app, `/api/loop/events?after=${foreign}`)).status).toBe(503);
  });

  test("events of a project that is not shown are left out", async () => {
    const { app, record } = setup({ shown: ['shop'] });
    record({ kind: 'decision_made', actor: 'loop:1', projectKey: 'other', subject: 'hidden', why: 'w' });
    record({ kind: 'decision_made', actor: 'loop:1', projectKey: 'shop', subject: 'shown', why: 'w' });
    expect((await (await get(app, '/api/loop/events')).json()).events.map((e: { subject: string }) => e.subject)).toEqual(['shown']);
  });
});

describe('GET /api/loop/metrics', () => {
  test('404 without the insights store; a bad weeks is a 400; otherwise the metrics, scoped to the shown projects', async () => {
    expect((await get(setup().app, '/api/loop/metrics')).status).toBe(404);
    const asked: unknown[] = [];
    const loop = fakeLoop({ decisions: [applied, observed] });
    loop.deps.insights = { patterns: async (q) => { asked.push(q); return { weekly: [], preDone: { checks: 4, withGaps: 1, gapsFound: 2 } } as never; } };
    const app = createApp(repo, { loop: loop.deps, auth: { token: API, ownerToken: OWNER }, shown: () => ({ keys: ['shop'], has: (k: string) => k === 'shop' }) as never });
    expect((await get(app, '/api/loop/metrics?weeks=0')).status).toBe(400);
    const m = await (await get(app, '/api/loop/metrics?weeks=4')).json();
    expect(m).toMatchObject({ weeks: 4, checksCaughtGap: { k: 1, n: 4 } });
    expect(m.proposalsPerWeek).toHaveLength(4);
    // dec:o is another project's: not counted.
    expect(m.rollbackRate.find((r: { type: string }) => r.type === 'retire_lesson')).toMatchObject({ of: 1 });
    expect(m.rollbackRate.find((r: { type: string }) => r.type === 'link_misses')).toMatchObject({ of: 0 });
    expect(asked).toEqual([{ projectKeys: ['shop'] }]);
  });
});

describe('GET /api/loop/lessons/:id/track', () => {
  const lesson = { id: 'lesson:1', projectKey: 'shop', title: 'Validate totals' } as never;

  test('the signals the loop folded, and a timeline newest first: served, judged, a gap fixed, repeats, your edits and its decisions', async () => {
    const repeats = async (id: string) => (id === 'lesson:1' ? [
      { missId: 'miss:r1', missed: 'totals again', sessionId: 'sess-1', ts: '2000-01-01T00:00:02.000Z' },
      { missId: 'miss:r2', missed: 'totals elsewhere', sessionId: 'sess-9', ts: '2000-01-01T00:00:01.000Z' },
    ] : []);
    const { app, record, signals } = setup({ decisions: [applied, observed], lessons: { 'lesson:1': lesson }, repeats });
    const counts = Object.fromEntries(LESSON_SIGNAL_COUNTS.map((k, i) => [k, i + 1])) as never;
    signals.set('lesson:1', { lessonId: 'lesson:1', counts, lastServed: '2026-11-09T10:00:00.000Z', lastOwnerTouch: null, updatedAt: 't' });
    record({ kind: 'context_served', actor: 'agent', projectKey: 'shop', subject: 'context for "checkout"', why: 'w', details: { lessons: [{ id: 'lesson:1' }], misses: [{ id: 'miss:1' }] }, targets: ['lesson:1', 'miss:1', 'sess-1'] });
    record({ kind: 'predone_check', actor: 'judge', projectKey: 'shop', subject: 'check', why: 'w', details: { verdicts: [{ lessonId: 'lesson:1', status: 'not_addressed' }] }, targets: ['lesson:1', 'sess-1'] });
    record({ kind: 'predone_check', actor: 'judge', projectKey: 'shop', subject: 'check', why: 'w', details: { sessionId: 'sess-1', verdicts: [{ lessonId: 'lesson:1', status: 'addressed' }] }, targets: ['lesson:1'] });
    record({ kind: 'predone_check', actor: 'judge', projectKey: 'shop', subject: 'check', why: 'w', details: { verdicts: [{ lessonId: 'lesson:2', status: 'addressed' }] }, targets: ['lesson:1'] });
    record({ kind: 'predone_check', actor: 'agent', projectKey: 'shop', subject: 'not judged', why: 'w', details: { notJudged: true, lessons: ['lesson:1', {}] }, targets: ['lesson:1'] });
    record({ kind: 'predone_check', actor: 'judge', projectKey: 'shop', subject: 'check', why: 'w', details: { verdicts: [{ lessonId: 'lesson:1', status: 'not_applicable' }] }, targets: ['lesson:1'] });
    record({ kind: 'lesson_decided', actor: 'you', projectKey: 'shop', subject: 'you edited it', why: 'w', targets: ['lesson:1'] });
    record({ kind: 'lesson_decided', actor: 'loop:1', projectKey: 'shop', subject: 'the loop revoked it', why: 'w', targets: ['lesson:1'] });
    record({ kind: 'context_served', actor: 'agent', projectKey: 'shop', subject: 'in a run', why: 'w', targets: ['lesson:1'], run: 'r1' });
    const res = await get(app, '/api/loop/lessons/lesson:1/track');
    expect(res.status).toBe(200);
    const t = await res.json();
    expect(t).toMatchObject({ lessonId: 'lesson:1', title: 'Validate totals', projectKey: 'shop' });
    expect(t.signals).toEqual({
      served: 1, lastServed: '2026-11-09T10:00:00.000Z', sessions: 2, addressed: 3, notAddressed: 4, notApplicable: 5, cannotTell: 6, gapsFixed: 7,
      repeatServed: 8, repeatUnserved: 9, ownerPushbackAfter: 10, ownerEdits: 13, ownerRejects: 14, holdout: false,
    });
    expect(t.timeline.map((e: { kind: string; label: string; sessionId: string | null; decisionId: string | null }) => [e.kind, e.label, e.sessionId, e.decisionId])).toEqual([
      ['owner', 'you edited it', null, null],
      ['judged', 'not applicable', null, null],
      ['gap_fixed', 'addressed', 'sess-1', null],
      ['judged', 'not addressed', 'sess-1', null],
      ['served', 'context for "checkout"', 'sess-1', null],
      ['decision', 'retire lesson: applied', null, 'dec:a'],
      ['repeat', 'repeated after it was served: totals again', 'sess-1', null],
      ['repeat', 'repeated where it was not served: totals elsewhere', 'sess-9', null],
    ]);
  });

  test('a global lesson learned in a hidden project is a 404; a shown global lesson lists only the shown projects\' entries and decisions', async () => {
    const hid = { id: 'lesson:hid-t1', projectKey: null, origin: 'secret-proj', title: 'HIDDEN GLOBAL LESSON TITLE' } as never;
    const glob = { id: 'lesson:g', projectKey: null, origin: 'shop', title: 'Global' } as never;
    const hiddenDecision = decision('dec:hid', { projectKey: 'secret-proj', targets: [{ kind: 'lesson', id: 'lesson:g', role: 'primary' }] });
    const shownDecision = decision('dec:g', { targets: [{ kind: 'lesson', id: 'lesson:g', role: 'primary' }] });
    const { app, record } = setup({ decisions: [hiddenDecision, shownDecision], lessons: { 'lesson:hid-t1': hid, 'lesson:g': glob }, shown: ['shop'] });
    record({ kind: 'context_served', actor: 'agent', projectKey: 'secret-proj', subject: 'HIDDEN SERVED SUBJECT for task about secret billing', why: 'w', details: { sessionId: 'hid-sess' }, targets: ['lesson:hid-t1', 'lesson:g'] });
    record({ kind: 'context_served', actor: 'agent', projectKey: 'shop', subject: 'context for "checkout"', why: 'w', details: { sessionId: 'sess-1' }, targets: ['lesson:g'] });
    const hidden = await get(app, '/api/loop/lessons/lesson:hid-t1/track');
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toMatch(/HIDDEN/);
    const t = await (await get(app, '/api/loop/lessons/lesson:g/track')).json();
    expect(JSON.stringify(t)).not.toMatch(/HIDDEN|hid-sess|dec:hid/);
    expect(t.timeline.map((e: { kind: string; sessionId: string | null; decisionId: string | null }) => [e.kind, e.sessionId, e.decisionId])).toEqual([
      ['served', 'sess-1', null],
      ['decision', null, 'dec:g'],
    ]);
  });

  test('lessonRepeats: misses recorded after the lesson\'s own, at REPEAT_SIMILARITY or closer, never itself', async () => {
    const miss = (id: string, createdAt: string, o: object = {}) => ({ id, projectKey: 'shop', missed: `missed ${id}`, embedding: [1], createdAt, sessionId: `s-${id}`, ...o });
    const stored: Record<string, object> = {
      'miss:1': miss('miss:1', '2026-11-01T00:00:00.000Z'), 'miss:2': miss('miss:2', '2026-11-01T00:00:00.000Z', { embedding: null }),
      'miss:a': miss('miss:a', '2026-11-03T00:00:00.000Z'), 'miss:d': miss('miss:d', '2026-11-02T00:00:00.000Z', { sessionId: null }),
      'miss:c': miss('miss:c', '2026-10-01T00:00:00.000Z'), 'miss:b': miss('miss:b', '2026-11-02T00:00:00.000Z'),
    };
    const asked: unknown[] = [];
    const d = {
      loopMisses: async (ids: string[]) => ids.flatMap((id) => stored[id] ?? []) as never,
      relatedMisses: async (q: unknown) => {
        asked.push(q);
        // Turn times say nothing of when a miss was recorded: miss:c's is late but it was recorded first.
        return [['miss:1', 1], ['miss:a', 0.95], ['miss:b', 0.5], ['miss:c', 0.99], ['miss:d', 0.9]].map(([missId, score]) => ({ missId, score, ts: '2027-01-01T00:00:00.000Z' })) as never;
      },
    };
    expect(await lessonRepeats('lesson:1', d)).toEqual([
      { missId: 'miss:d', missed: 'missed miss:d', sessionId: null, ts: '2026-11-02T00:00:00.000Z' },
      { missId: 'miss:a', missed: 'missed miss:a', sessionId: 's-miss:a', ts: '2026-11-03T00:00:00.000Z' },
    ]);
    expect(asked).toEqual([{ embedding: [1], projectKey: 'shop', k: 10, run: null }]);
    expect(await lessonRepeats('lesson:2', d)).toEqual([]);
    expect(await lessonRepeats('lesson:none', d)).toEqual([]);
  });

  test('no signals yet: zeros; an unknown lesson, or one of a project not shown, is a 404', async () => {
    const { app } = setup({ lessons: { 'lesson:1': lesson, 'lesson:g': { id: 'lesson:g', projectKey: null, title: 'Global' } as never, 'lesson:h': { id: 'lesson:h', projectKey: 'other', title: 'Hidden' } as never }, shown: ['shop'] });
    const t = await (await get(app, '/api/loop/lessons/lesson:g/track')).json();
    expect(t.signals).toMatchObject({ served: 0, lastServed: null, sessions: 0, holdout: false });
    expect(t.timeline).toEqual([]);
    expect((await get(app, '/api/loop/lessons/lesson:none/track')).status).toBe(404);
    expect((await get(app, '/api/loop/lessons/lesson:h/track')).status).toBe(404);
  });
});

describe('GET /api/lessons with the loop', () => {
  test('changedByLoop marks the lessons a loop decision still applied changed, though a reword leaves decidedBy as it was', async () => {
    const lessons = ['lesson:1', 'lesson:2', 'lesson:3', 'lesson:4'].map((id) => ({ id, projectKey: 'shop', title: id, status: 'approved', decidedBy: 'you', paths: [] }));
    const on = (id: string, o: Partial<Decision> = {}) => decision(`dec:${id}`, {
      type: 'reword_lesson', targets: [{ kind: 'lesson', id, role: 'primary' }], before: [snap(id, { title: 'old' })], after: [snap(id, { title: 'new' })], ...o,
    });
    const loop = fakeLoop({ decisions: [
      on('lesson:1'),
      on('lesson:2', { status: 'rolled_back' }),
      // A proposal you approved is your change, as the Decisions page's "by loop" badge has it.
      on('lesson:3', { decidedBy: 'you' }),
      on('lesson:4', { status: 'overridden' }),
    ] });
    const knowledge = {
      listLessons: async () => lessons,
      lessonDetail: async (id: string) => ({ lesson: lessons.find((l) => l.id === id), contextItems: [] }),
    };
    // The page's lessons are looked up by id, one existence check each: never by listing their decisions.
    const listed: unknown[] = [];
    const list = loop.deps.decisions.list;
    loop.deps.decisions.list = async (f) => { listed.push(f); return list(f); };
    const app = createApp(repo, { loop: loop.deps, knowledge: knowledge as never });
    const rows = await (await app.request('/api/lessons?status=approved')).json() as { id: string; changedByLoop?: boolean; decidedBy: string }[];
    expect(listed).toEqual([]);
    expect(rows.filter((l) => l.changedByLoop).map((l) => l.id)).toEqual(['lesson:1']);
    expect(rows.every((l) => l.decidedBy === 'you')).toBe(true);
    expect((await (await app.request(`/api/lessons/${encodeURIComponent('lesson:1')}`)).json()).lesson.changedByLoop).toBe(true);
    expect((await (await app.request(`/api/lessons/${encodeURIComponent('lesson:2')}`)).json()).lesson).not.toHaveProperty('changedByLoop');
    // Without the loop there is nothing to mark.
    const plain = await (await createApp(repo, { knowledge: knowledge as never }).request('/api/lessons?status=approved')).json() as object[];
    expect(plain.some((l) => 'changedByLoop' in l)).toBe(false);
  });
});

describe('never merge: /api/distinct-pairs and a merge rolled back', () => {
  const merge = decision('dec:m', {
    type: 'merge_duplicates', status: 'applied',
    targets: [{ kind: 'lesson', id: 'lesson:keep', role: 'keeper' }, { kind: 'lesson', id: 'lesson:dup', role: 'merged' }],
  });
  const op = { authorization: `Bearer ${OP}`, 'x-fg-operator': 'agent' };

  test('rolling back a merge records the pair as never to be merged, with the decision and your note', async () => {
    const { app } = setup({ decisions: [merge] });
    expect((await post(app, '/api/decisions/dec:m/rollback', { expect: 'applied', note: 'two different gateways' })).status).toBe(200);
    expect(await (await get(app, '/api/distinct-pairs?ids=lesson:dup')).json()).toEqual([
      expect.objectContaining({ a: 'lesson:dup', b: 'lesson:keep', by: 'you', decisionId: 'dec:m', reason: 'you rolled back the merge: two different gateways' }),
    ]);
  });

  test('marking a pair is an owner route (loop_decide for the operator token); lifting one is yours alone', async () => {
    const { app } = setup();
    expect((await post(app, '/api/distinct-pairs', { a: 'lesson:a', b: 'lesson:a' })).status).toBe(400);
    expect((await post(app, '/api/distinct-pairs', { a: 'lesson:a', b: 'lesson:b' }, reader)).status).toBe(403);
    expect((await post(app, '/api/distinct-pairs', { a: 'lesson:a', b: 'lesson:b' }, op)).status).toBe(201);
    expect(await (await post(app, '/api/distinct-pairs', { a: 'lesson:b', b: 'lesson:a', reason: 'again' })).json()).toMatchObject({ created: false });
    expect((await post(app, '/api/distinct-pairs', { a: 'lesson:a', b: 'lesson:b' }, op, 'DELETE')).status).toBe(403);
    expect((await post(app, '/api/distinct-pairs', { a: 'lesson:a', b: 'lesson:b' }, owner, 'DELETE')).status).toBe(204);
    expect((await post(app, '/api/distinct-pairs', { a: 'lesson:a', b: 'lesson:b' }, owner, 'DELETE')).status).toBe(404);
    expect(await (await get(app, '/api/distinct-pairs?ids=lesson:a')).json()).toEqual([]);
    expect((await get(app, '/api/distinct-pairs')).status).toBe(400);
  });
});

test('a proposed decision says why it needs you, in one line; a decided one does not', async () => {
  const { app } = setup({ decisions: [
    decision('dec:p', { status: 'proposed', tier: 'P', type: 'triage_inbox' }),
    decision('dec:q', { status: 'proposed', rationale: 'Retire it. Proposed rather than applied: you changed lesson:1 in the last 14 days.' }),
    decision('dec:a', { status: 'applied' }),
  ] });
  const rows = await (await get(app, '/api/decisions?status=proposed')).json();
  expect(Object.fromEntries(rows.map((r: { id: string; needsYou?: string }) => [r.id, r.needsYou]))).toEqual({
    'dec:p': 'always your call: the loop only proposes this kind of change', 'dec:q': 'you changed lesson:1 in the last 14 days',
  });
  expect((await (await get(app, '/api/decisions/dec:a')).json()).decision?.needsYou ?? (await (await get(app, '/api/decisions/dec:a')).json()).needsYou).toBeUndefined();
});
