import { claimFingerprint, decisionExecutor, type Claim, type ConflictSide, type OperatorVerb, type Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { beforeAll, expect, test } from 'vitest';
import { createApp } from './app.ts';

/** The Conflicts routes over a real store and the real executor, on each backend: resolve, then undo through the Decisions route. */

const OWNER = 'conflict-int-owner-token-0123456789abcdef';
const AGENT = 'conflict-int-agent-token-0123456789abcdef';
const OPERATOR = 'conflict-int-operator-token-0123456789abc';
const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const embed = async (t: string[]) => t.map(() => vec(3));

describeStores('conflicts api', (h) => {
  let store: Store;
  beforeAll(() => {
    store = h.store;
  });
  const app = (allow: OperatorVerb[] = []) => createApp(store.graph, {
    auth: { ownerToken: OWNER, token: AGENT, operator: { token: OPERATOR, allow } },
    intakeReview: { intake: store.intake, facts: store.facts, embed, activity: store.activity, conflicts: { store, exec: decisionExecutor(store, { embed }) } },
    loop: {
      decisions: store.decisions, cursors: store.docs, activity: store.activity, lessonDetail: (id) => store.knowledge.lessonDetail(id),
      config: { mode: null, disabled: false, llm: null, llmCallsPerDay: 40, autoPerDay: 5, autoPerProject: 2, syncHoldDays: 7, holdout: 0.2, types: null },
      exec: decisionExecutor(store, { embed }),
    },
  });
  const owner = { authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true', 'content-type': 'application/json' };
  const post = (a: ReturnType<typeof app>, path: string, body: unknown, headers: Record<string, string> = owner) => a.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const get = (a: ReturnType<typeof app>, path: string, headers: Record<string, string> = owner) => a.request(path, { headers });

  let seq = 0;
  const disputed = async () => {
    const ref = `api-call-${++seq}.vtt`;
    const docId = await store.docs.upsertDoc({ projectKey: 'shop', source: 'intake', ref, title: ref, url: null }, [{ text: 'Ana: retries wait 30 seconds', embedding: vec(9) }]);
    await store.intake.upsertMeta({ docId, kind: 'transcript', format: 'vtt', occurredAt: '2026-11-10', origin: 'weekly sync', private: true, participants: [] });
    const ana = (await store.intake.resolveAlias(`Ana ${seq}`, { create: true }))!.person;
    const { version } = (await store.intake.nextWindow(docId))!;
    const draft = (statement: string, axis: number) => ({
      type: 'decision' as const, statement, quote: statement, speakerId: ana.id, span: null, assertedAt: '2026-11-10T10:00:00.000Z', confidence: 0.9,
      scope: { area: null, files: [] }, about: 'retries', due: null, flags: [], embedding: vec(axis),
    });
    await store.intake.saveWindow(docId, { window: 0, version, claims: [draft('Retries wait 30 seconds', 10), draft('Retries wait 60 seconds', 11)], questions: [] });
    const [a, b] = (await store.intake.listClaims({ docId })).sort((x, y) => x.id.localeCompare(y.id));
    const s = (c: Claim): ConflictSide => ({ kind: 'claim', id: c.id, fingerprint: claimFingerprint(c), assertedAt: c.assertedAt });
    const { conflict } = await store.intake.openConflict({ kind: 'disagreement', projectKey: 'shop', a: s(a), b: s(b), signals: [], judge: null });
    return { a, b, conflict, ana };
  };

  test('list and detail show both sides with who said them; resolve is a decision by you, and rolling it back reopens it', async () => {
    const x = app();
    const { a, b, conflict, ana } = await disputed();
    const listed = await (await get(x, '/api/conflicts?status=open&project=shop')).json();
    const row = listed.find((k: { id: string }) => k.id === conflict.id);
    expect(row.sides.a).toMatchObject({ id: a.id, text: 'Retries wait 30 seconds', quote: 'Retries wait 30 seconds', speaker: { displayName: ana.displayName }, source: { origin: 'weekly sync' }, agentsSee: false });

    expect((await post(x, `/api/conflicts/${encodeURIComponent(conflict.id)}/resolve`, { choice: 'a', expect: 'stale' })).status).toBe(409);
    expect((await post(x, `/api/conflicts/${encodeURIComponent(conflict.id)}/resolve`, { choice: 'both' })).status).toBe(400);
    const res = await post(x, `/api/conflicts/${encodeURIComponent(conflict.id)}/resolve`, { choice: 'a', note: 'the newer config', expect: row.fingerprint });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.decision).toMatchObject({ type: 'resolve_conflict', author: 'owner', status: 'applied', decidedBy: 'you' });
    expect(out.conflict).toMatchObject({ status: 'resolved', resolution: { choice: 'a', note: 'the newer config' }, sides: { b: { status: 'superseded' } } });
    expect((await store.intake.claim(b.id))!.status).toBe('superseded');
    const [entry] = await store.activity.list({ kind: 'conflict_resolved', target: conflict.id, limit: 1 });
    expect(entry).toMatchObject({ actor: 'you', details: { decisionId: out.decision.id, choice: 'a', author: 'owner' } });
    // Resolving it again is refused while it is resolved.
    expect((await post(x, `/api/conflicts/${encodeURIComponent(conflict.id)}/resolve`, { choice: 'b' })).status).toBe(409);

    const detail = await (await get(x, `/api/conflicts/${encodeURIComponent(conflict.id)}`)).json();
    expect(detail.decision).toMatchObject({ id: out.decision.id, status: 'applied' });
    const back = await post(x, `/api/decisions/${encodeURIComponent(out.decision.id)}/rollback`, { expect: 'applied', cascade: 'apply' });
    expect(back.status).toBe(200);
    expect(await store.intake.claim(b.id)).toEqual(b);
    expect(await store.intake.conflict(conflict.id)).toMatchObject({ status: 'open', resolution: null });
  });

  test('the agent credential reads no conflict; the operator token resolves only with conflict_decide', async () => {
    const { conflict } = await disputed();
    const agent = { authorization: `Bearer ${AGENT}` };
    expect((await get(app(), '/api/conflicts', agent)).status).toBe(403);
    expect((await get(app(), `/api/conflicts/${encodeURIComponent(conflict.id)}`, agent)).status).toBe(403);
    const operator = { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json' };
    const path = `/api/conflicts/${encodeURIComponent(conflict.id)}/resolve`;
    expect((await post(app(), path, { choice: 'none', reason: 'scope' }, operator)).status).toBe(403);
    const allowed = await post(app(['conflict_decide']), path, { choice: 'none', reason: 'scope' }, operator);
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).decision.decidedBy).toMatch(/^operator/);
  });
});
