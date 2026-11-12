import { claimFingerprint, conflictFingerprint, type ClaimDraft, type ConflictSide, type Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { beforeEach, expect, test } from 'vitest';
import { createApp } from './app.ts';

/**
 * Knowledge intake in an export bundle, on each backend: decided claims, settled conflicts and the people who said them
 * go out (quotes only when asked, never a source's text); imported into an empty store they come back with their
 * statuses, an accepted claim's fact made again; importing the same bundle twice adds nothing.
 */

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const embed = async (t: string[]) => t.map(() => vec(4));
const OWNER = 'portable-int-owner-token-0123456789abcdef';
const TRANSCRIPT = 'Ana: retries wait thirty seconds, we agreed';

const owner = { authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' };

describeStores('intake export and import', (h) => {
  let store: Store;
  beforeEach(() => {
    store = h.store;
  });
  const app = () => createApp(store.graph, {
    auth: { ownerToken: OWNER },
    portability: store.portability, embed, portableIntake: store.intake,
    importer: {
      knowledge: store.knowledge, facts: store.facts, embed, activity: store.activity, portability: store.portability, excluded: [],
      intake: { store: store.intake, facts: store.facts, lesson: async (id) => (await store.knowledge.lessonDetail(id))?.lesson ?? null },
    },
  });

  async function seed() {
    const docId = await store.docs.upsertDoc({ projectKey: 'shop', source: 'intake', ref: 'sync.vtt', title: 'weekly sync', url: null }, [{ text: TRANSCRIPT, embedding: vec(9) }]);
    await store.intake.upsertMeta({ docId, kind: 'transcript', format: 'vtt', occurredAt: '2026-11-10', origin: 'weekly sync', private: true, participants: [] });
    const owner = await store.intake.ensureOwner('Jo Owner');
    const ana = (await store.intake.resolveAlias('Ana Example', { create: true }))!.person;
    const { version } = (await store.intake.nextWindow(docId))!;
    const draft = (type: ClaimDraft['type'], statement: string, speakerId: string, quote: string): ClaimDraft => ({
      type, statement, quote, speakerId, span: null, assertedAt: '2026-11-10T10:00:00.000Z', confidence: 0.9, scope: { area: null, files: ['src/retry.ts'] }, about: 'retries', due: null, flags: [], embedding: vec(5),
    });
    await store.intake.saveWindow(docId, {
      window: 0, version, questions: [{ text: 'Who owns retries?', kind: 'needs_owner', quote: null, askedBy: null }],
      claims: [
        draft('decision', 'Retries wait 30 seconds', ana.id, 'retries wait thirty seconds'),
        draft('decision', 'Retries wait 60 seconds', owner.id, 'sixty seconds'),
        draft('opinion', 'Retries are too slow', ana.id, 'too slow'),
        draft('plan', 'Retries move to a queue', ana.id, 'move to a queue'),
      ],
    });
    const claims = await store.intake.listClaims({ docId });
    const by = (st: string) => claims.find((c) => c.statement === st)!;
    const fact = await store.facts.addOwnerFact('shop', { kind: 'decision', statement: 'Retries wait 30 seconds', path: 'src/retry.ts', lines: null, confidence: 1, why: 'Ana Example, 2026-11-10 call', relevance: 0.8, embedding: vec(5) }, 'you', null, { origin: 'claim' });
    const won = (await store.intake.decideClaim((await store.intake.decideClaim(by('Retries wait 30 seconds').id, { status: 'accepted' }, { by: 'you' }))!.id, { factId: fact.id }, { by: 'you' }))!;
    const lost = (await store.intake.decideClaim(by('Retries wait 60 seconds').id, { status: 'accepted' }, { by: 'you' }))!;
    await store.intake.decideClaim(by('Retries are too slow').id, { status: 'accepted' }, { by: 'you' });
    const side = (c: typeof won): ConflictSide => ({ kind: 'claim', id: c.id, fingerprint: claimFingerprint(c), assertedAt: c.assertedAt });
    const { conflict } = await store.intake.openConflict({ kind: 'disagreement', projectKey: 'shop', a: side(won), b: side(lost), signals: [], judge: null });
    // The owner chose A: B superseded (as the resolve_conflict handler writes it).
    const superseded = { status: 'superseded' as const, statement: lost.statement, type: lost.type, scope: lost.scope, decidedBy: 'you', decidedAt: '2026-11-11T09:00:00.000Z', factId: null };
    await store.intake.writeSnapshots([
      { kind: 'claim', id: lost.id, expect: claimFingerprint(lost), fields: superseded },
      { kind: 'conflict', id: conflict.id, expect: conflictFingerprint(conflict), fields: { status: 'resolved', resolution: { choice: 'a', note: 'the config says 30', reason: null, createdFactId: null }, resolvedBy: 'you', resolvedAt: '2026-11-11T09:00:00.000Z', decisionId: null } },
    ], { supersede: [{ from: { kind: 'claim', id: lost.id }, to: { kind: 'claim', id: won.id }, conflictId: conflict.id }] });
    return { won, lost, conflict, ana, owner };
  }

  test('export: decided claims (no quote unless asked), settled conflicts and people; never a source\'s text, a question or an unreviewed claim', async () => {
    const s = await seed();
    const bundle = await (await app().request('/api/export?project=shop', { headers: owner })).json();
    expect(bundle.claims.map((c: { statement: string; status: string }) => [c.statement, c.status]).sort()).toEqual([
      ['Retries are too slow', 'accepted'], ['Retries wait 30 seconds', 'accepted'], ['Retries wait 60 seconds', 'superseded'],
    ]);
    expect(bundle.claims.find((c: { id: string }) => c.id === s.won.id)).toMatchObject({ speaker: 'Ana Example', speakerId: s.ana.id, type: 'decision' });
    expect(bundle.claims.every((c: object) => !('quote' in c))).toBe(true);
    expect(bundle.conflicts).toEqual([expect.objectContaining({ id: s.conflict.id, status: 'resolved', resolution: { choice: 'a', note: 'the config says 30', reason: null } })]);
    expect(bundle.people.map((p: { displayName: string }) => p.displayName).sort()).toEqual(['Ana Example', 'Jo Owner']);
    const text = JSON.stringify(bundle);
    for (const never of [TRANSCRIPT, 'Who owns retries?', 'Retries move to a queue', 'thirty seconds']) expect(text).not.toContain(never);
    // Claim facts are marked as such, so an import makes them with their claim, not as plain facts.
    expect(bundle.facts.filter((f: { claim?: object }) => f.claim)).toHaveLength(1);
    const quoted = await (await app().request('/api/export?project=shop&quotes=1', { headers: owner })).json();
    expect(quoted.claims.find((c: { id: string }) => c.id === s.won.id).quote).toBe('retries wait thirty seconds');
    expect(JSON.stringify(quoted)).not.toContain(TRANSCRIPT);
  });

  test('round trip into an empty store keeps statuses and makes the accepted claim\'s fact again; a second import adds nothing', async () => {
    const s = await seed();
    const bundle = await (await app().request('/api/export?project=shop&quotes=1', { headers: owner })).text();
    await h.probe.wipe();
    const post = () => app().request('/api/import', { method: 'POST', headers: { ...owner, 'content-type': 'application/json' }, body: bundle });
    const first = await (await post()).json();
    expect(first).toMatchObject({ claims: { added: 3, facts: 1, existing: 0, skipped: 0 }, conflicts: { added: 1, existing: 0, skipped: 0 }, people: { added: 1, matched: 1 } });
    const won = (await store.intake.claim(s.won.id))!;
    expect(won).toMatchObject({ status: 'accepted', statement: 'Retries wait 30 seconds', quote: 'retries wait thirty seconds', decidedBy: 'import' });
    expect(await store.facts.fact(won.factId!)).toMatchObject({ statement: 'Retries wait 30 seconds', origin: 'claim', current: true, kind: 'decision' });
    expect((await store.intake.person(won.speakerId!))).toMatchObject({ displayName: 'Ana Example', status: 'confirmed' });
    expect((await store.intake.claim(s.lost.id))).toMatchObject({ status: 'superseded', factId: null });
    expect((await store.intake.people()).find((p) => p.isOwner)!.id).toBe((await store.intake.claim(s.lost.id))!.speakerId);
    expect(await store.intake.conflict(s.conflict.id)).toMatchObject({ status: 'resolved', resolution: { choice: 'a', note: 'the config says 30' }, resolvedBy: 'import' });
    expect((await store.intake.supersessions([s.lost.id])).map((x) => x.to.id)).toEqual([s.won.id]);
    // The claim's fact is not imported a second time as a plain fact.
    expect((await store.facts.listFacts({ projectKey: 'shop' })).filter((f) => f.statement === 'Retries wait 30 seconds')).toHaveLength(1);

    const second = await (await post()).json();
    expect(second).toMatchObject({ claims: { added: 0, facts: 0, existing: 3 }, conflicts: { added: 0, existing: 1 }, people: { added: 0, matched: 2 } });
    expect((await store.intake.listClaims({ limit: 50 })).length).toBe(3);
    expect((await store.facts.listFacts({ projectKey: 'shop' })).length).toBe(1);
  });
});
