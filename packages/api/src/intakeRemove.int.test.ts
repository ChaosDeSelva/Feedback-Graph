import { decisionExecutor, setRedactionArchivePurger, type ArchiveSelector, type Decision, type Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

/**
 * Removing a source (0.9.0 §7) on either store: keep=facts takes its text (and its archived original) and leaves what you
 * accepted; keep=none also closes their facts, as a remove_source decision that rolls back, and leaves no claim of it and
 * no person only it named.
 */
const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const OWNER = 'owner-test-token-01234567890123456789';
const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const send = { method: 'DELETE', headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' } };

describeStores('removing an intake source', (h) => {
  let store: Store;
  beforeAll(() => {
    store = h.store;
  });
  afterEach(() => setRedactionArchivePurger(undefined));

  const app = () => createApp(repo, {
    auth: { ownerToken: OWNER },
    embed: async (t) => t.map(() => vec(1)),
    projectDirs: async () => [{ key: 'shop', name: 'shop', repoPath: '/vibe/shop' }],
    docs: store.docs,
    activity: store.activity,
    intake: { store: store.intake, archive: false, decide: { store, exec: decisionExecutor(store) } },
  });
  /** A source with one claim accepted into a fact and one still proposed. */
  const source = async (participants: string[] = []) => {
    const docId = await store.docs.upsertDoc({ projectKey: 'shop', source: 'intake', ref: 'sync.vtt', title: 'weekly sync', url: null }, [{ text: 'Ana: retries wait 30 seconds', embedding: vec(9) }]);
    await store.intake.upsertMeta({ docId, kind: 'transcript', format: 'vtt', occurredAt: '2026-11-10', origin: null, private: true, participants });
    const { version } = (await store.intake.nextWindow(docId))!;
    const draft = (statement: string) => ({
      type: 'decision' as const, statement, quote: statement, speakerId: null, span: null, assertedAt: null, confidence: 0.9,
      scope: { area: null, files: ['src/retry.ts'] }, about: 'retries', due: null, flags: [], embedding: vec(1),
    });
    await store.intake.saveWindow(docId, { window: 0, version, claims: [draft('Retries wait 30 seconds'), draft('Retries are logged')], questions: [] });
    const [kept] = (await store.intake.listClaims({ docId })).filter((c) => c.statement === 'Retries wait 30 seconds');
    await store.intake.decideClaim(kept.id, { status: 'accepted' }, { by: 'you' });
    const fact = await store.facts.addOwnerFact('shop', { kind: 'decision', statement: kept.statement, path: 'src/retry.ts', lines: null, confidence: 1, why: 'Ana, 2026-11-10 call', embedding: vec(2) }, 'you', null, { origin: 'claim' });
    await store.intake.decideClaim(kept.id, { factId: fact.id }, { by: 'you' });
    return { docId, claimId: kept.id, factId: fact.id };
  };
  const path = (id: string, keep: string) => `/api/intake/sources/${encodeURIComponent(id)}?keep=${keep}`;

  test('keep=facts: the text, chunks, undecided claims and archived original go; the accepted claim stays a fact', async () => {
    const purged: ArchiveSelector[] = [];
    setRedactionArchivePurger(async (s) => { purged.push(...s); });
    const { docId, claimId, factId } = await source();
    const res = await app().request(path(docId, 'facts'), send);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: { claim: 1, question: 0, people: 0, facts: 0, keep: 'facts' }, decision: null });
    expect(purged).toContainEqual({ kind: 'doc', id: docId });
    expect(await store.docs.docText(docId)).toBeNull();
    expect((await store.intake.claim(claimId))?.status).toBe('accepted');
    expect((await store.facts.fact(factId))?.current).toBe(true);
  });

  test('keep=none: every claim and the people only it named go; their facts close as a remove_source decision that rolls back', async () => {
    const ana = (await store.intake.resolveAlias('Test Person A', { create: true }))!.person;
    const { docId, claimId, factId } = await source([ana.id]);
    const [other] = (await store.intake.listClaims({ docId })).filter((c) => c.id !== claimId);
    await store.intake.decideClaim(other.id, { status: 'rejected' }, { by: 'you' });
    await store.activity.record({ kind: 'claim_decided', actor: 'you', projectKey: 'shop', subject: 'accepted decision claim "Retries wait 30 seconds"', why: 'w', details: {}, targets: [claimId, factId] });
    const res = await app().request(path(docId, 'none'), send);
    expect(res.status).toBe(200);
    const body = await res.json() as { removed: object; decision: Decision };
    expect(body.removed).toEqual({ claim: 2, question: 0, people: 1, facts: 1, keep: 'none' });
    expect(body.decision).toMatchObject({ type: 'remove_source', author: 'owner', status: 'applied', tier: 'P', targets: [{ kind: 'fact', id: factId }] });
    expect(await store.intake.listClaims({ docId })).toEqual([]);
    expect(await store.intake.claim(claimId)).toBeNull();
    expect(await store.intake.person(ana.id)).toBeNull();
    expect((await store.facts.fact(factId))?.current).toBe(false);
    expect(await store.docs.docText(docId)).toBeNull();
    expect((await store.activity.list({ kind: 'doc_removed', limit: 1 }))[0]).toMatchObject({ details: { keep: 'none', decisionId: body.decision.id, factsClosed: 1 } });
    expect(JSON.stringify(await store.activity.list({ kind: 'claim_decided', limit: 10 }))).not.toContain('Retries wait 30 seconds');

    const back = await decisionExecutor(store).rollback((await store.decisions.get(body.decision.id))!, { by: 'you', cascade: 'apply' }) as Decision;
    expect(back.status).toBe('rolled_back');
    expect((await store.facts.fact(factId))?.current).toBe(true);
  });
});
