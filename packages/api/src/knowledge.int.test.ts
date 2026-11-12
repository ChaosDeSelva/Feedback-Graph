import { claimFingerprint, type Claim, type ClaimDraft, type ConflictSide, type Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { beforeEach, expect, test } from 'vitest';
import { createApp } from './app.ts';
import { knowledgeMarkdown, lookUp, type KnowledgeDeps } from './knowledge.ts';

/** The look-up over a real store, on each backend: what the owner reads, what an agent reads, and the [disputed] state. */

const OWNER = 'knowledge-int-owner-token-0123456789abcdef';
const AGENT = 'knowledge-int-agent-token-0123456789abcdef';
/** Everything about retries lies on one axis, so the query finds it; the rest lies elsewhere. */
const vec = (axis: number, tilt = 0) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : i === 700 ? tilt : 0));
const RETRY = 5;

describeStores('knowledge look-up', (h) => {
  let store: Store;
  let deps: KnowledgeDeps;
  let decided: Claim;
  let opinion: Claim;
  let proposed: Claim;
  let conflictId: string;
  // The store is wiped before each test: the same records are made again for each.
  beforeEach(async () => {
    store = h.store;
    deps = { intake: store.intake, facts: store.facts, lessons: store.knowledge, embed: async (t) => t.map(() => vec(RETRY)) };
    const docId = await store.docs.upsertDoc({ projectKey: 'shop', source: 'intake', ref: 'sync-1.vtt', title: 'weekly sync', url: null }, [{ text: 'Ana: retries wait 30 seconds', embedding: vec(9) }]);
    await store.intake.upsertMeta({ docId, kind: 'transcript', format: 'vtt', occurredAt: '2026-11-10', origin: 'weekly sync', private: true, participants: [] });
    const ana = (await store.intake.resolveAlias('Ana Example', { create: true }))!.person;
    const bo = (await store.intake.resolveAlias('Bo Example', { create: true }))!.person;
    const { version } = (await store.intake.nextWindow(docId))!;
    const draft = (type: ClaimDraft['type'], statement: string, speakerId: string, tilt: number, quote = statement): ClaimDraft => ({
      type, statement, quote, speakerId, span: null, assertedAt: '2026-11-10T10:00:00.000Z', confidence: 0.9, scope: { area: null, files: [] }, about: 'retries',
      due: null, flags: [], embedding: vec(RETRY, tilt),
    });
    await store.intake.saveWindow(docId, {
      window: 0, version, questions: [{ text: 'Who owns the retry budget?', kind: 'needs_owner', quote: 'someone should own retries', askedBy: bo.id }],
      claims: [
        draft('decision', 'Retries wait 30 seconds', ana.id, 0.1, 'we said thirty seconds for retries'),
        draft('opinion', 'Retries are too slow today', bo.id, 0.2),
        draft('plan', 'Retries move to a queue next month', bo.id, 0.3),
        { ...draft('fact', 'The invoice service sends e-mail', ana.id, 0), embedding: vec(40) },
      ],
    });
    const claims = await store.intake.listClaims({ docId });
    const by = (s: string) => claims.find((c) => c.statement === s)!;
    // The owner accepted the decision (its fact made, as the review route does) and the opinion; the plan waits.
    const fact = await store.facts.addOwnerFact('shop', { kind: 'decision', statement: 'Retries wait 30 seconds', path: `source:${docId}`, lines: null, confidence: 1, why: 'Ana, 2026-11-10 call', relevance: 0.8, embedding: vec(RETRY, 0.1) }, 'you', null, { origin: 'claim' });
    decided = (await store.intake.decideClaim(by('Retries wait 30 seconds').id, { status: 'accepted' }, { by: 'you' }))!;
    decided = (await store.intake.decideClaim(decided.id, { factId: fact.id }, { by: 'you' }))!;
    opinion = (await store.intake.decideClaim(by('Retries are too slow today').id, { status: 'accepted' }, { by: 'you' }))!;
    proposed = by('Retries move to a queue next month');
    // A code fact on retries disagrees with the decision: an open conflict.
    await store.facts.addOwnerFact('shop', { kind: 'convention', statement: 'Retries wait 60 seconds (config/retry.ts)', path: 'config/retry.ts', lines: null, confidence: 1, why: 'read from the code', relevance: 0.8, embedding: vec(RETRY, 0.15) }, 'you');
    const [codeFact] = (await store.facts.searchFacts({ embedding: vec(RETRY, 0.15), projectKey: 'shop', k: 5 })).filter((x) => x.fact.path === 'config/retry.ts');
    const side = (c: Claim): ConflictSide => ({ kind: 'claim', id: c.id, fingerprint: claimFingerprint(c), assertedAt: c.assertedAt });
    const { conflict } = await store.intake.openConflict({
      kind: 'disagreement', projectKey: 'shop', a: side(decided), b: { kind: 'fact', id: codeFact.fact.id, fingerprint: 'f', assertedAt: codeFact.fact.createdAt }, signals: [],
      judge: { relation: 'contradicts', aQuote: '30 seconds', bQuote: '60 seconds', explanation: 'the waits differ', confidence: 0.9, model: null },
    });
    conflictId = conflict.id;
  });

  test('the owner reads accepted and unreviewed claims with who said them and their quotes, open questions, and the conflict with both sides', async () => {
    const a = await lookUp({ q: 'how long do retries wait', projectKeys: ['shop'], owner: true }, deps);
    const ids = a.items.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([decided.id, opinion.id, proposed.id]));
    // The accepted decision's fact is listed once, as the claim.
    expect(a.items.filter((i) => i.text === 'Retries wait 30 seconds')).toHaveLength(1);
    expect(a.items.some((i) => i.text === 'The invoice service sends e-mail')).toBe(false);
    const d = a.items.find((i) => i.id === decided.id)!;
    expect(d).toMatchObject({ kind: 'claim', group: 'decisions', status: 'accepted', who: { name: 'Ana Example' }, quote: 'we said thirty seconds for retries', disputed: [conflictId], source: { kind: 'call', occurredAt: '2026-11-10' } });
    expect(a.items.find((i) => i.id === proposed.id)).toMatchObject({ group: 'plans', unreviewed: true });
    expect(a.items.find((i) => i.kind === 'question')).toMatchObject({ text: 'Who owns the retry budget?', who: { name: 'Bo Example' } });
    expect(a.items.find((i) => i.kind === 'fact')).toMatchObject({ text: 'Retries wait 60 seconds (config/retry.ts)', disputed: [conflictId] });
    expect(a.conflicts).toEqual([expect.objectContaining({ id: conflictId, a: expect.objectContaining({ text: 'Retries wait 30 seconds', who: expect.objectContaining({ name: 'Ana Example' }) }), b: expect.objectContaining({ text: 'Retries wait 60 seconds (config/retry.ts)' }), explanation: 'the waits differ' })]);
    expect(a.people.map((p) => p.name)).toEqual(expect.arrayContaining(['Ana Example', 'Bo Example']));
    expect(a.timeline.map((t) => t.id)).toEqual(expect.arrayContaining([decided.id]));
    // Only what one person said; only some kinds.
    expect((await lookUp({ q: 'retries', projectKeys: ['shop'], owner: true, person: decided.speakerId! }, deps)).items.map((i) => i.id)).toEqual([decided.id]);
    expect((await lookUp({ q: 'retries', projectKeys: ['shop'], owner: true, groups: ['opinions'] }, deps)).items.map((i) => i.id)).toEqual([opinion.id]);
    expect((await lookUp({ q: 'retries', projectKeys: ['shop'], owner: true, since: '2099-01-01' }, deps)).items).toEqual([]);
  });

  test('an agent reads accepted knowledge only: no opinion, no unreviewed claim, no quote, no open question', async () => {
    const a = await lookUp({ q: 'how long do retries wait', projectKeys: ['shop'], owner: false }, deps);
    expect(a.items.map((i) => i.id)).not.toEqual(expect.arrayContaining([opinion.id]));
    expect(a.items.some((i) => i.id === proposed.id || i.kind === 'question' || i.quote !== null)).toBe(false);
    expect(a.items.find((i) => i.id === decided.id)).toMatchObject({ disputed: [conflictId], who: { name: 'Ana Example' } });
    expect(a.conflicts[0].explanation).toBeNull();
    const md = knowledgeMarkdown(a, { agent: true });
    expect(md).toContain('## Decisions');
    expect(md).toContain(`[disputed: ${conflictId}]`);
    expect(md).toContain('## Unresolved');
    expect(md).not.toContain('thirty seconds');
    expect(md).not.toContain('too slow');
  });

  test('GET /api/knowledge is the owner\'s: the agent credential is refused; md is the look-up in words', async () => {
    const app = createApp(store.graph, { auth: { ownerToken: OWNER, token: AGENT }, lookUp: deps });
    const owner = { authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true' };
    expect((await app.request('/api/knowledge?q=retries&project=shop', { headers: { authorization: `Bearer ${AGENT}` } })).status).toBe(403);
    expect((await app.request('/api/knowledge?project=shop', { headers: owner })).status).toBe(400);
    expect((await app.request('/api/knowledge?q=retries&kinds=rumours', { headers: owner })).status).toBe(400);
    const res = await app.request('/api/knowledge?q=retries&project=shop&kinds=decisions,plans', { headers: owner });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { group: string }) => i.group).every((g: string) => g === 'decisions' || g === 'plans')).toBe(true);
    const md = await (await app.request('/api/knowledge?q=retries&project=shop&format=md', { headers: owner })).text();
    expect(md).toContain('said: "we said thirty seconds for retries"');
    expect(md).toContain('[unreviewed]');
  });
});
