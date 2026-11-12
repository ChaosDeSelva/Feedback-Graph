import { AliasTakenError, answerClaimIdOf, answerSourceOf, claimFingerprint, TargetChangedError, type ActivityInput, type Claim, type Conflict, type IntakeMeta, type OperatorVerb, type Person, type Question, type StoredFact } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { IntakeReviewDeps } from './intakeReview.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const OWNER = 'intake-owner-token-0123456789abcdefghij';
const OP = 'o'.repeat(32);
const API = 'a'.repeat(32);
const owner = { authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' };
const operator = { authorization: `Bearer ${OP}`, 'x-fg-operator': 'cli' };
const agent = { authorization: `Bearer ${API}` };

const T0 = '2026-11-10T10:00:00.000Z';
const claim = (id: string, o: Partial<Claim> = {}): Claim => ({
  id, projectKey: 'shop', docId: 'doc:call', window: 0, span: { utt: 1, start: 0, end: 10 }, type: 'fact', statement: `statement ${id}`, quote: `quote ${id}`,
  speakerId: 'person:ana', assertedAt: '2026-11-10T09:00:00.000Z', confidence: 0.9, scope: { area: null, files: [] }, about: 'retries', due: null, flags: [],
  status: 'proposed', decidedBy: null, decidedAt: null, factId: null, createdAt: T0, run: null, sandbox: false, ...o,
});
const question = (id: string, o: Partial<Question> = {}): Question => ({
  id, projectKey: 'shop', docId: 'doc:call', window: 0, text: `who owns ${id}?`, kind: 'needs_owner', quote: null, askedBy: 'person:bo', assignee: null,
  status: 'open', answerClaimId: null, decidedBy: null, decidedAt: null, createdAt: T0, run: null, sandbox: false, ...o,
});
const person = (id: string, displayName: string, o: Partial<Person> = {}): Person => ({ id, displayName, isOwner: false, status: 'confirmed', aliases: [displayName.toLowerCase()], claims: 0, createdAt: T0, ...o });
const meta: IntakeMeta = { docId: 'doc:call', kind: 'transcript', format: 'vtt', occurredAt: '2026-11-10', origin: 'weekly sync', private: true, participants: ['person:ana', 'person:bo'], windowsDone: 1, windowsTotal: 1 };

/** An in-memory IntakeStore with what the review routes call, and a fact store that records addOwnerFact. */
function fakeIntake(o: { claims?: Claim[]; questions?: Question[]; people?: Person[]; conflicts?: Conflict[] } = {}) {
  const claims = new Map((o.claims ?? []).map((c) => [c.id, c]));
  const questions = new Map((o.questions ?? []).map((q) => [q.id, q]));
  const people = new Map((o.people ?? [person('person:ana', 'Ana'), person('person:bo', 'Bo')]).map((p) => [p.id, p]));
  const conflicts = o.conflicts ?? [];
  const page = <T>(rows: T[], f: { limit?: number; offset?: number }) => rows.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 100));
  const intake: IntakeReviewDeps['intake'] = {
    async listClaims(f = {}) {
      const rows = [...claims.values()].filter((c) => (!f.status || f.status.includes(c.status)) && (!f.type || f.type.includes(c.type))
        && (!f.projectKeys || c.projectKey === null || f.projectKeys.includes(c.projectKey)) && (!f.docId || c.docId === f.docId) && (!f.speakerId || c.speakerId === f.speakerId)
        && (!c.sandbox || c.run === f.run));
      return page(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)), f);
    },
    async claim(id) { return claims.get(id) ?? null; },
    async decideClaim(id, patch, { by, expect: fp }) {
      const cur = claims.get(id);
      if (!cur) return null;
      if (fp !== undefined && claimFingerprint(cur) !== fp) throw new TargetChangedError(id, fp, claimFingerprint(cur));
      const { embedding: _, ...rest } = patch;
      const next = { ...cur, ...rest, ...(patch.status !== undefined && patch.status !== cur.status && { decidedBy: by, decidedAt: T0 }) };
      claims.set(id, next);
      return next;
    },
    async deleteClaims(ids) { let n = 0; for (const id of ids) if (claims.delete(id)) n++; return n; },
    async metas(ids) { return ids.includes(meta.docId) ? [meta] : []; },
    async conflictsFor(ids) { return conflicts.filter((k) => k.status === 'open' && (ids.includes(k.a.id) || ids.includes(k.b.id))); },
    async people() { return [...people.values()].sort((a, b) => Number(b.isOwner) - Number(a.isOwner) || a.displayName.localeCompare(b.displayName)); },
    async person(id) { return people.get(id) ?? null; },
    async ensureOwner(displayName) {
      const found = [...people.values()].find((p) => p.isOwner);
      if (found) return found;
      const p = person('person:owner', displayName, { isOwner: true });
      people.set(p.id, p);
      return p;
    },
    async updatePerson(id, patch) {
      const p = people.get(id);
      if (!p) return null;
      for (const a of patch.addAliases ?? []) {
        const other = [...people.values()].find((x) => x.id !== id && x.aliases.includes(a.toLowerCase()));
        if (other) throw new AliasTakenError(a, other.id);
      }
      const next = { ...p, ...(patch.displayName && { displayName: patch.displayName }), ...(patch.status && { status: patch.status }),
        aliases: [...p.aliases.filter((a) => !(patch.removeAliases ?? []).map((x) => x.toLowerCase()).includes(a)), ...(patch.addAliases ?? []).map((a) => a.toLowerCase())] };
      people.set(id, next);
      return next;
    },
    async mergePeople(keepId, mergedId) {
      const keep = people.get(keepId);
      const merged = people.get(mergedId);
      if (!keep || !merged) return null;
      people.delete(mergedId);
      for (const [id, c] of claims) if (c.speakerId === mergedId) claims.set(id, { ...c, speakerId: keepId });
      const next = { ...keep, aliases: [...keep.aliases, ...merged.aliases] };
      people.set(keepId, next);
      return next;
    },
    async forgetPerson(id) {
      const p = people.get(id);
      if (!p) return null;
      let claimsRemoved = 0;
      for (const [cid, c] of claims) if (c.speakerId === id && (c.status === 'proposed' || c.status === 'rejected')) { claims.delete(cid); claimsRemoved++; }
      const next = { ...p, displayName: 'former participant', aliases: [], status: 'forgotten' as const };
      people.set(id, next);
      return { person: next, claimsRemoved };
    },
    async listQuestions(f = {}) {
      const rows = [...questions.values()].filter((q) => (!f.status || f.status.includes(q.status)) && (!f.kind || f.kind.includes(q.kind))
        && (!f.projectKeys || q.projectKey === null || f.projectKeys.includes(q.projectKey)) && (!f.docId || q.docId === f.docId) && (!f.assignee || q.assignee === f.assignee));
      return page(rows, f);
    },
    async question(id) { return questions.get(id) ?? null; },
    async updateQuestion(id, patch, by) {
      const q = questions.get(id);
      if (!q) return null;
      const next = { ...q, ...patch, decidedBy: by, decidedAt: T0 };
      questions.set(id, next);
      return next;
    },
    async answerQuestion(id, answer, by) {
      const q = questions.get(id);
      if (!q) return null;
      const c = claim(answerClaimIdOf(id), { ...answer, docId: answerSourceOf(id), projectKey: q.projectKey, window: null, span: null, quote: '', assertedAt: null, confidence: 1, due: null, flags: [], status: 'accepted', decidedBy: by, decidedAt: T0 });
      claims.set(c.id, c);
      const next = { ...q, status: 'answered' as const, answerClaimId: c.id, decidedBy: by, decidedAt: T0 };
      questions.set(id, next);
      return { question: next, claim: c };
    },
  };
  const added: { projectKey: string; fact: Parameters<IntakeReviewDeps['facts']['addOwnerFact']>[1]; by: string; origin: string | undefined }[] = [];
  const facts: IntakeReviewDeps['facts'] = {
    async addOwnerFact(projectKey, f, by, _run, opt) {
      added.push({ projectKey, fact: f, by, origin: opt?.origin });
      const { embedding: _, ...rest } = f;
      return { ...rest, id: `fact:${added.length}`, source: by, createdAt: T0, scanJobId: null, fileHash: null, fileSummary: null, relevance: f.relevance ?? null, relevanceBy: by, origin: opt?.origin } as StoredFact;
    },
  };
  return { intake, facts, claims, questions, people, added };
}

function setup(o: Parameters<typeof fakeIntake>[0] & { allow?: OperatorVerb[]; shown?: string[]; embed?: IntakeReviewDeps['embed']; off?: boolean } = {}) {
  const store = fakeIntake(o);
  const recorded: ActivityInput[] = [];
  const activity = { record: async (e: ActivityInput) => { recorded.push(e); } };
  const embedded: string[][] = [];
  const embed = o.embed ?? (async (texts: string[]) => { embedded.push(texts); return texts.map(() => [0.1, 0.2]); });
  const app = createApp(repo, {
    auth: { token: API, ownerToken: OWNER, operator: { token: OP, allow: o.allow ?? [] } },
    ...(!o.off && { intakeReview: { intake: store.intake, facts: store.facts, embed, activity, ownerName: 'Pat' } }),
    ...(o.shown && { shown: () => ({ initialized: true, keys: o.shown!, has: (k: string) => o.shown!.includes(k) }) }),
  });
  const send = (path: string, body: unknown, headers: Record<string, string> = owner, method = 'POST') =>
    app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const get = (path: string, headers: Record<string, string> = owner) => app.request(path, { headers });
  return { app, send, get, recorded, embedded, ...store };
}

describe('INTAKE_ENABLED', () => {
  test('off: the routes are not there and /api/status says so; on: it says they are', async () => {
    const off = setup({ off: true });
    expect((await off.get('/api/claims')).status).toBe(404);
    expect((await off.send('/api/claims/claim:1', { status: 'accepted' }, owner, 'PATCH')).status).toBe(404);
    expect((await (await off.get('/api/status', agent)).json()).intake).toEqual({ enabled: false });
    const on = setup();
    expect((await (await on.get('/api/status', agent)).json()).intake).toEqual({ enabled: true });
  });
});

describe('who may read and decide', () => {
  test('the agent credential reads none of it: claims quote transcripts and name people', async () => {
    const { get } = setup({ claims: [claim('claim:1')], questions: [question('question:1')] });
    for (const path of ['/api/claims', '/api/claims/claim:1', '/api/questions', '/api/questions/question:1', '/api/people']) {
      const res = await get(path, agent);
      expect(res.status, path).toBe(403);
      expect((await res.json()).error).toMatch(/owner's to read/);
    }
    expect((await get('/api/claims', operator)).status).toBe(200);
    expect((await get('/api/claims', owner)).status).toBe(200);
  });

  test('the operator token decides only with claims_decide, which is off by default, and is logged as itself', async () => {
    const refused = setup({ claims: [claim('claim:1')] });
    const res = await refused.send('/api/claims/claim:1', { status: 'rejected' }, operator, 'PATCH');
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/claims_decide/);
    expect(refused.claims.get('claim:1')!.status).toBe('proposed');

    const allowed = setup({ claims: [claim('claim:1')], allow: ['claims_decide'] });
    expect((await allowed.send('/api/claims/claim:1', { status: 'rejected' }, operator, 'PATCH')).status).toBe(200);
    expect(allowed.claims.get('claim:1')).toMatchObject({ status: 'rejected', decidedBy: 'operator:cli' });
    expect(allowed.recorded[0]).toMatchObject({ kind: 'claim_decided', actor: 'operator:cli' });
  });

  test('the agent credential cannot decide, whatever it forges', async () => {
    const { send, claims } = setup({ claims: [claim('claim:1')] });
    expect((await send('/api/claims/claim:1', { status: 'accepted' }, { ...agent, 'x-fg-owner': 'true', origin: 'http://localhost' }, 'PATCH')).status).toBe(403);
    expect((await send('/api/people/merge', { keepId: 'person:ana', mergedId: 'person:bo' }, agent)).status).toBe(403);
    expect(claims.get('claim:1')!.status).toBe('proposed');
  });
});

describe('GET /api/claims', () => {
  test('filters, pages by x-next-offset, names the open conflicts on each, and leaves out projects not shown', async () => {
    const conflict = { id: 'conflict:1', status: 'open', a: { kind: 'claim', id: 'claim:1' }, b: { kind: 'fact', id: 'fact:9' } } as Conflict;
    const { get } = setup({
      shown: ['shop'],
      conflicts: [conflict],
      claims: [
        claim('claim:1', { createdAt: '2026-11-10T12:00:00.000Z' }), claim('claim:2', { type: 'opinion', speakerId: 'person:bo' }),
        claim('claim:3', { status: 'accepted' }), claim('claim:global', { projectKey: null, createdAt: '2026-11-09T00:00:00.000Z' }), claim('claim:hidden', { projectKey: 'other' }),
      ],
    });
    const ids = async (qs: string) => (await (await get(`/api/claims?${qs}`)).json()).map((c: Claim) => c.id);
    expect(await ids('status=proposed')).toEqual(['claim:1', 'claim:2', 'claim:global']);
    expect(await ids('type=opinion')).toEqual(['claim:2']);
    expect(await ids('person=person:bo')).toEqual(['claim:2']);
    expect(await ids('project=other')).toEqual([]);
    const first = await get('/api/claims?status=proposed&limit=2');
    expect(first.headers.get('x-next-offset')).toBe('2');
    const rows = await first.json();
    expect(rows[0].conflicts).toEqual([{ id: 'conflict:1', with: { kind: 'fact', id: 'fact:9' } }]);
    expect(rows[1].conflicts).toEqual([]);
    expect((await get('/api/claims?status=proposed&limit=2&offset=2')).headers.get('x-next-offset')).toBeNull();
    expect((await get('/api/claims?status=nope')).status).toBe(400);
    expect((await get('/api/claims/claim:hidden')).status).toBe(404);
  });

  test('one claim comes with its fingerprint, speaker and source; another run\'s sandbox claim is not found', async () => {
    const c = claim('claim:1');
    const { get } = setup({ claims: [c, claim('claim:sandbox', { run: 'probe', sandbox: true })] });
    const body = await (await get('/api/claims/claim:1')).json();
    expect(body).toMatchObject({ fingerprint: claimFingerprint(c), speaker: { displayName: 'Ana' }, source: { kind: 'transcript', origin: 'weekly sync' } });
    expect((await get('/api/claims/claim:sandbox')).status).toBe(404);
  });
});

describe('PATCH /api/claims/:id', () => {
  test('accepting a fact claim files a project fact with origin claim, says who said it and when, and records it', async () => {
    const { send, claims, added, recorded, embedded } = setup({ claims: [claim('claim:1', { scope: { area: 'billing', files: ['src/retry.ts'] } })] });
    const res = await send('/api/claims/claim:1', { status: 'accepted', kind: 'config', expect: claimFingerprint(claim('claim:1', { scope: { area: 'billing', files: ['src/retry.ts'] } })) }, owner, 'PATCH');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ projectKey: 'shop', origin: 'claim', by: 'you', fact: { kind: 'config', statement: 'statement claim:1', path: 'src/retry.ts', why: 'Ana, 2026-11-10 call', relevance: 0.8, confidence: 1 } });
    expect(embedded).toEqual([['statement claim:1']]);
    expect(claims.get('claim:1')).toMatchObject({ status: 'accepted', decidedBy: 'you', factId: 'fact:1' });
    expect(body.fact.id).toBe('fact:1');
    expect(recorded).toEqual([expect.objectContaining({ kind: 'claim_decided', targets: ['claim:1', 'fact:1'], why: expect.stringMatching(/agents are now given it as a config fact/) })]);
  });

  test('a decision, plan or commitment files as its own kind, under its source when it names no file', async () => {
    const { send, added } = setup({ claims: [claim('claim:1', { type: 'plan' })] });
    expect((await send('/api/claims/claim:1', { status: 'accepted' }, owner, 'PATCH')).status).toBe(200);
    expect(added[0].fact).toMatchObject({ kind: 'plan', path: 'source:doc:call' });
  });

  test('an opinion is never given to agents until it is re-typed', async () => {
    const { send, claims, added } = setup({ claims: [claim('claim:op', { type: 'opinion' }), claim('claim:keep')] });
    expect((await send('/api/claims/claim:op', { status: 'accepted', asFact: true }, owner, 'PATCH')).status).toBe(400);
    expect((await send('/api/claims/claim:op', { status: 'accepted' }, owner, 'PATCH')).status).toBe(200);
    expect(claims.get('claim:op')).toMatchObject({ status: 'accepted', factId: null });
    expect(added).toEqual([]);
    // Kept as an opinion: a fact claim accepted with asFact false is re-typed and not served.
    expect((await send('/api/claims/claim:keep', { status: 'accepted', asFact: false }, owner, 'PATCH')).status).toBe(200);
    expect(claims.get('claim:keep')).toMatchObject({ type: 'opinion', factId: null });
    expect(added).toEqual([]);
    // Re-typing the accepted opinion later is what serves it.
    expect((await send('/api/claims/claim:op', { type: 'decision' }, owner, 'PATCH')).status).toBe(200);
    expect(claims.get('claim:op')).toMatchObject({ type: 'decision', factId: 'fact:1' });
    expect(added[0].fact.kind).toBe('decision');
  });

  test('a global claim needs the project its fact is filed under; one with a project keeps it', async () => {
    const { send, added } = setup({ claims: [claim('claim:g', { projectKey: null }), claim('claim:p')] });
    const res = await send('/api/claims/claim:g', { status: 'accepted' }, owner, 'PATCH');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/projectKey/);
    expect((await send('/api/claims/claim:g', { status: 'accepted', projectKey: 'shop' }, owner, 'PATCH')).status).toBe(200);
    expect(added[0].projectKey).toBe('shop');
    expect((await send('/api/claims/claim:p', { status: 'accepted', projectKey: 'other' }, owner, 'PATCH')).status).toBe(400);
  });

  test('an edit is embedded again and saved without a fact; a stale page, a claim already a fact and a superseded one are refused', async () => {
    const { send, claims, embedded } = setup({ claims: [claim('claim:1'), claim('claim:fact', { status: 'accepted', factId: 'fact:7' }), claim('claim:lost', { status: 'superseded' })] });
    expect((await send('/api/claims/claim:1', { statement: 'Retries wait 30 s', scope: { area: 'billing', files: [] } }, owner, 'PATCH')).status).toBe(200);
    expect(claims.get('claim:1')).toMatchObject({ statement: 'Retries wait 30 s', status: 'proposed', scope: { area: 'billing', files: [] } });
    expect(embedded).toEqual([['Retries wait 30 s']]);
    expect((await send('/api/claims/claim:1', { status: 'accepted', expect: claimFingerprint(claim('claim:1')) }, owner, 'PATCH')).status).toBe(409);
    expect((await send('/api/claims/claim:fact', { statement: 'changed' }, owner, 'PATCH')).status).toBe(409);
    expect((await send('/api/claims/claim:lost', { status: 'accepted' }, owner, 'PATCH')).status).toBe(409);
    expect((await send('/api/claims/claim:none', { status: 'accepted' }, owner, 'PATCH')).status).toBe(404);
  });

  test('with the embedding model down nothing changes: no claim accepted without its fact', async () => {
    const { send, claims, added } = setup({ claims: [claim('claim:1')], embed: async () => { throw new Error('ollama down'); } });
    expect((await send('/api/claims/claim:1', { status: 'accepted' }, owner, 'PATCH')).status).toBe(500);
    expect(claims.get('claim:1')!.status).toBe('proposed');
    expect(added).toEqual([]);
  });

  test('a run changes only the claims it made', async () => {
    const { app, claims } = setup({ claims: [claim('claim:1')], allow: ['claims_decide'] });
    const res = await app.request('/api/claims/claim:1', { method: 'PATCH', headers: { 'content-type': 'application/json', ...operator, 'x-fg-run': 'probe', 'x-fg-run-key': 'k'.repeat(32) }, body: JSON.stringify({ status: 'accepted' }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/is not run probe's/);
    expect(claims.get('claim:1')!.status).toBe('proposed');
  });
});

describe('DELETE /api/claims/:id', () => {
  test('removes one leftover claim, owner only, audited without its text; an accepted or superseded one is refused', async () => {
    const t = setup({ claims: [claim('claim:left', { status: 'rejected', statement: 'Retries wait 30 seconds' }), claim('claim:live', { status: 'accepted' }), claim('claim:lost', { status: 'superseded' })] });
    const del = (id: string, headers: Record<string, string> = owner) => t.app.request(`/api/claims/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'content-type': 'application/json', ...headers } });
    expect((await del('claim:left', agent)).status).toBe(403);
    expect(t.claims.has('claim:left')).toBe(true);
    expect((await del('claim:left')).status).toBe(204);
    expect(t.claims.has('claim:left')).toBe(false);
    expect(t.recorded.at(-1)).toMatchObject({ kind: 'claim_decided', actor: 'you', subject: 'deleted a rejected fact claim', details: { status: 'deleted', was: 'rejected' }, targets: ['claim:left'] });
    expect(JSON.stringify(t.recorded)).not.toContain('Retries wait 30 seconds');
    expect((await del('claim:left')).status).toBe(404);
    expect((await del('claim:live')).status).toBe(409);
    expect((await del('claim:lost')).status).toBe(409);
    expect(t.claims.has('claim:live') && t.claims.has('claim:lost')).toBe(true);
  });
});

describe('POST /api/claims/decisions', () => {
  test('decides each item on its own; one refused does not stop the rest', async () => {
    const { send, claims } = setup({ claims: [claim('claim:1'), claim('claim:g', { projectKey: null })] });
    const res = await send('/api/claims/decisions', { items: [{ id: 'claim:g', status: 'accepted' }, { id: 'claim:1', status: 'accepted' }, { id: 'claim:none', status: 'rejected' }] });
    const { results } = await res.json();
    expect(results).toEqual([
      { id: 'claim:g', ok: false, error: expect.stringMatching(/global/) },
      { id: 'claim:1', ok: true, status: 'accepted', factId: 'fact:1' },
      { id: 'claim:none', ok: false, error: 'not found' },
    ]);
    expect(claims.get('claim:1')!.status).toBe('accepted');
  });

  test('a source decides every proposed claim it holds, opinions staying opinions', async () => {
    const { send, claims, added } = setup({ claims: [claim('claim:1'), claim('claim:2', { type: 'opinion' }), claim('claim:3', { status: 'rejected' }), claim('claim:other', { docId: 'doc:other' })] });
    const { results } = await (await send('/api/claims/decisions', { source: 'doc:call', status: 'accepted' })).json();
    expect(results.map((r: { id: string }) => r.id).sort()).toEqual(['claim:1', 'claim:2']);
    expect(claims.get('claim:2')).toMatchObject({ status: 'accepted', factId: null });
    expect(claims.get('claim:3')!.status).toBe('rejected');
    expect(claims.get('claim:other')!.status).toBe('proposed');
    expect(added).toHaveLength(1);
    expect((await send('/api/claims/decisions', { source: 'doc:call' })).status).toBe(400);
    expect((await send('/api/claims/decisions', { items: [{ id: 'claim:1', status: 'accepted' }], source: 'doc:call', status: 'accepted' })).status).toBe(400);
  });
});

describe('questions', () => {
  test('assigning marks it assigned, unassigning reopens it, dismissing closes it; each is recorded', async () => {
    const { send, get, questions, recorded } = setup({ questions: [question('question:1')] });
    const assigned = await send('/api/questions/question:1', { assignee: 'person:bo' }, owner, 'PATCH');
    expect(await assigned.json()).toMatchObject({ status: 'assigned', assignee: 'person:bo' });
    expect((await send('/api/questions/question:1', { assignee: null }, owner, 'PATCH')).status).toBe(200);
    expect(questions.get('question:1')).toMatchObject({ status: 'open', assignee: null });
    expect((await send('/api/questions/question:1', { status: 'dismissed' }, owner, 'PATCH')).status).toBe(200);
    expect(questions.get('question:1')!.status).toBe('dismissed');
    expect((await send('/api/questions/question:1', { assignee: 'person:nobody' }, owner, 'PATCH')).status).toBe(404);
    expect(recorded.map((r) => r.kind)).toEqual(['question_changed', 'question_changed', 'question_changed']);
    expect((await (await get('/api/questions?status=dismissed')).json()).map((q: Question) => q.id)).toEqual(['question:1']);
    expect(await (await get('/api/questions/question:1')).json()).toMatchObject({ askedBy: { displayName: 'Bo' }, assignee: null, answer: null });
  });

  test('your answer is an accepted claim said by you, filed as a fact; a question is answered once', async () => {
    const { send, claims, people, added } = setup({ questions: [question('question:1')] });
    const res = await send('/api/questions/question:1/answer', { text: 'Bo owns the retry change', type: 'commitment' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(people.get('person:owner')).toMatchObject({ displayName: 'Pat', isOwner: true });
    expect(claims.get(answerClaimIdOf('question:1'))).toMatchObject({ statement: 'Bo owns the retry change', speakerId: 'person:owner', status: 'accepted', factId: 'fact:1' });
    expect(added[0]).toMatchObject({ origin: 'claim', fact: { kind: 'commitment', why: 'Pat, answering a question' } });
    expect(body.question.status).toBe('answered');
    expect((await send('/api/questions/question:1/answer', { text: 'again' })).status).toBe(409);
    expect((await send('/api/questions/question:1', { status: 'open' }, owner, 'PATCH')).status).toBe(409);
  });

  test('an opinion answer is not served, and a global question needs a project for a fact', async () => {
    const { send, added } = setup({ questions: [question('question:g', { projectKey: null }), question('question:o')] });
    expect((await send('/api/questions/question:g/answer', { text: 'yes' })).status).toBe(409);
    expect((await send('/api/questions/question:o/answer', { text: 'I think so', type: 'opinion' })).status).toBe(201);
    expect(added).toEqual([]);
  });
});

describe('people', () => {
  test('lists, renames and confirms; an alias someone else has is refused with who has it', async () => {
    const { send, get, people, recorded } = setup({ people: [person('person:ana', 'Ana'), person('person:x', 'S2', { status: 'proposed' })] });
    expect((await (await get('/api/people')).json()).map((p: Person) => p.id)).toEqual(['person:ana', 'person:x']);
    const res = await send('/api/people/person:x', { displayName: 'Bo', status: 'confirmed', addAliases: ['Bo'] }, owner, 'PATCH');
    expect(await res.json()).toMatchObject({ displayName: 'Bo', status: 'confirmed' });
    expect(recorded[0]).toMatchObject({ kind: 'person_changed', projectKey: null });
    const taken = await send('/api/people/person:x', { addAliases: ['ana'] }, owner, 'PATCH');
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ personId: 'person:ana' });
    expect(people.get('person:x')!.aliases).toEqual(['s2', 'bo']);
  });

  test('merge moves one person\'s claims to the other; you are never merged away', async () => {
    const { send, claims } = setup({ claims: [claim('claim:1', { speakerId: 'person:bo' })], people: [person('person:me', 'Pat', { isOwner: true }), person('person:ana', 'Ana'), person('person:bo', 'Bo')] });
    expect((await send('/api/people/merge', { keepId: 'person:ana', mergedId: 'person:bo' })).status).toBe(200);
    expect(claims.get('claim:1')!.speakerId).toBe('person:ana');
    expect((await send('/api/people/merge', { keepId: 'person:ana', mergedId: 'person:me' })).status).toBe(409);
    expect((await send('/api/people/merge', { keepId: 'person:ana', mergedId: 'person:ana' })).status).toBe(400);
  });

  test('forgetting needs the id typed again, never forgets you, and records no name', async () => {
    const { send, people, recorded } = setup({ claims: [claim('claim:1')], people: [person('person:me', 'Pat', { isOwner: true }), person('person:ana', 'Ana')] });
    expect((await send('/api/people/person:ana/forget', { confirm: 'person:bo' })).status).toBe(400);
    const res = await send('/api/people/person:ana/forget', { confirm: 'person:ana' });
    expect(await res.json()).toMatchObject({ claimsRemoved: 1, person: { displayName: 'former participant' } });
    expect(JSON.stringify(recorded)).not.toMatch(/Ana/);
    expect((await send('/api/people/person:me/forget', { confirm: 'person:me' })).status).toBe(409);
    expect((await send('/api/people/person:ana', { displayName: 'Ana again' }, owner, 'PATCH')).status).toBe(409);
    expect(people.get('person:ana')!.status).toBe('forgotten');
  });
});
