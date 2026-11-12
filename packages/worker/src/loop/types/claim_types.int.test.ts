import { beforeEach, expect, test } from 'vitest';
import {
  claimFingerprint, decisionExecutor, LOOP_ACTOR, LOOP_POLICY_VERSION, LOOP_TYPE_INFO, snapshotTarget,
  type Claim, type ClaimDraft, type ConflictSide, type Decision, type DecisionExecutor, type Store,
} from '@fb/core';
import { describeStores } from '@fb/core/testing';
import type { LoopCandidate, LoopType, LoopTypeContext } from '../plugin.ts';
import { acceptClaim } from './accept_claim.ts';
import { assignQuestion } from './assign_question.ts';
import { closeQuestion } from './close_question.ts';
import { linkClaims } from './link_claims.ts';
import { mergeClaims } from './merge_claims.ts';
import { proposeResolution } from './propose_resolution.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const embed = async (t: string[]) => t.map(() => vec(7));
const NOW = Date.parse('2026-11-12T12:00:00Z');

/**
 * Knowledge intake's loop types (0.9.1) on each backend: each finds its call on a real store, the executor applies it
 * (as the engine would, or as the owner's approval does for a tier P call), and a rollback restores every target.
 */
describeStores('claim loop types find, apply and roll back', (h) => {
  let s: Store;
  let x: DecisionExecutor;
  let seq = 0;
  beforeEach(() => {
    s = h.store;
    x = decisionExecutor(s, { embed });
  });

  const ctx = (): LoopTypeContext => ({
    now: NOW, store: s, entries: [], mode: 'auto', lessons: async () => [], signals: async () => null, inScope: () => true, holdout: 0,
    recall: async () => null, llm: null, log: () => {},
  });
  const propose = async (type: Decision['type'], c: LoopCandidate) => (await s.decisions.propose({
    type, projectKey: c.projectKey, targets: c.targets, before: c.before, after: c.after, evidence: c.evidence, features: c.features, score: 0.95,
    confidence: { p: 0.95, lower: 0.93, n: 25, band: 4 }, tier: LOOP_TYPE_INFO[type].tier, mode: LOOP_TYPE_INFO[type].tier === 'P' ? 'propose' : 'auto',
    rationale: c.rationale, model: 'deterministic', policyVersion: LOOP_POLICY_VERSION, status: 'proposed', ...(c.dependsOn && { dependsOn: c.dependsOn }),
  })).decision;
  const run = async (t: LoopType) => t.candidates(ctx());

  /** A source of `kind` in shop with these claims (proposed), said by `who`. */
  async function source(o: { origin?: string; kind?: 'transcript' | 'notes'; who?: string; claims: Partial<ClaimDraft>[]; questions?: { text: string; quote?: string }[] }) {
    const ref = `call-${++seq}.vtt`;
    const docId = await s.docs.upsertDoc({ projectKey: 'shop', source: 'intake', ref, title: ref, url: null }, [{ text: 'Ana: hello', embedding: vec(9) }]);
    await s.intake.upsertMeta({ docId, kind: o.kind ?? 'transcript', format: 'vtt', occurredAt: '2026-11-10', origin: o.origin ?? 'weekly sync', private: true, participants: [] });
    const person = (await s.intake.resolveAlias(o.who ?? 'Ana Example', { create: true }))!.person;
    if (person.status !== 'confirmed') await s.intake.updatePerson(person.id, { status: 'confirmed' });
    const { version } = (await s.intake.nextWindow(docId))!;
    await s.intake.saveWindow(docId, {
      window: 0, version,
      claims: o.claims.map((c) => ({
        type: 'decision', statement: 'x', quote: c.statement ?? 'x', speakerId: person.id, span: null, assertedAt: '2026-11-10T10:00:00.000Z', confidence: 0.9,
        scope: { area: null, files: [] }, about: 'retries', due: null, flags: [], embedding: vec(10 + seq), ...c,
      })),
      questions: (o.questions ?? []).map((q) => ({ text: q.text, kind: 'needs_owner', quote: q.quote ?? null, askedBy: null })),
    });
    return { docId, person, claims: (await s.intake.listClaims({ docId })).sort((a, b) => a.id.localeCompare(b.id)), questions: await s.intake.listQuestions({ docId }) };
  }
  /** Your claim decisions on `type`, as the review route records them. */
  async function decided(type: string, n: number, edited = 0) {
    for (let i = 0; i < n; i++) {
      await s.activity.record({
        kind: 'claim_decided', actor: 'you', projectKey: 'shop', subject: `accepted ${type} claim`, why: 'w', targets: [`claim:x${i}`],
        details: { status: 'accepted', type, changed: i < edited ? ['status', 'statement'] : ['status'] },
      });
    }
  }

  test('link_claims then merge_claims: the same statement from two calls is linked, the newer folded into the older, both undone by rollback', async () => {
    const a = await source({ claims: [{ statement: 'Retries wait thirty seconds before the next try.' }] });
    const b = await source({ who: 'Bo Example', claims: [{ statement: 'retries wait thirty seconds, before the next try' }] });
    const [older, newer] = [a.claims[0], b.claims[0]];
    const links = await run(linkClaims);
    expect(links.candidates).toHaveLength(1);
    const link = await x.apply(await propose('link_claims', links.candidates[0]), { by: LOOP_ACTOR });
    expect(await s.intake.links([newer.id])).toEqual([{ from: newer.id, to: { kind: 'claim', id: older.id }, rel: 'corroborates' }]);
    expect((await run(linkClaims)).candidates).toEqual([]);

    const merges = await run(mergeClaims);
    expect(merges.candidates).toHaveLength(1);
    expect(merges.candidates[0].targets).toEqual([{ kind: 'claim', id: newer.id, role: 'merged' }, { kind: 'claim', id: older.id, role: 'keeper' }]);
    const merge = await x.apply(await propose('merge_claims', merges.candidates[0]), { by: LOOP_ACTOR });
    expect(await s.intake.claim(newer.id)).toMatchObject({ status: 'superseded', decidedBy: LOOP_ACTOR });
    expect(await s.intake.claim(older.id)).toEqual(older);

    await x.rollback(merge, { by: 'you', cascade: 'apply' });
    expect(claimFingerprint((await s.intake.claim(newer.id))!)).toBe(claimFingerprint(newer));
    expect((await s.intake.claim(newer.id))!.status).toBe('proposed');
    await x.rollback(link, { by: 'you', cascade: 'apply' });
    expect(await s.intake.links([newer.id])).toEqual([]);
  });

  test('accept_claim: an exactly quoted decision by a confirmed person is accepted and its fact filed; never an agent\'s or an opinion; rollback undoes both', async () => {
    const own = await source({ claims: [{ statement: 'Invoices are sent at nine in the morning', confidence: 0.92 }, { type: 'opinion', statement: 'Nine is too early' }] });
    await source({ origin: 'agent:codex', kind: 'notes', claims: [{ statement: 'Invoices are retried hourly' }] });
    await source({ claims: [{ statement: 'Invoices are archived after a year', flags: ['statement-adds'] }] });
    await decided('decision', 19);
    expect((await run(acceptClaim)).candidates).toEqual([]);
    await decided('decision', 1);
    const r = await run(acceptClaim);
    expect(r.skipped).toMatchObject({ never_target: 2 });
    expect(r.candidates.map((c) => c.targets[0].id)).toEqual([own.claims.find((c) => c.type === 'decision')!.id]);
    const claim = own.claims.find((c) => c.type === 'decision')!;
    const factId = r.candidates[0].targets[1].id;

    const applied = await x.apply(await propose('accept_claim', r.candidates[0]), { by: LOOP_ACTOR });
    expect(applied.status).toBe('applied');
    expect(await s.intake.claim(claim.id)).toMatchObject({ status: 'accepted', decidedBy: LOOP_ACTOR, factId });
    expect(await s.facts.fact(factId)).toMatchObject({ statement: 'Invoices are sent at nine in the morning', kind: 'decision', origin: 'claim', current: true, path: `source:${own.docId}`, why: 'Ana Example, 2026-11-10 call' });

    await x.rollback(applied, { by: 'you', cascade: 'apply' });
    expect(claimFingerprint((await s.intake.claim(claim.id))!)).toBe(claimFingerprint(claim));
    expect((await s.facts.fact(factId))!.current).toBe(false);
    expect((await snapshotTarget(s, { kind: 'claim', id: claim.id })).fingerprint).toBe(applied.before[0].fingerprint);
  });

  test('propose_resolution: a probable supersession is suggested as B is true; approved, it settles the conflict as yours would, and a rollback reopens it', async () => {
    const { claims: [a, b] } = await source({ claims: [{ statement: 'Retries wait 30 seconds' }, { statement: 'Retries wait 60 seconds', assertedAt: '2026-11-11T10:00:00.000Z' }] });
    const side = (c: Claim): ConflictSide => ({ kind: 'claim', id: c.id, fingerprint: claimFingerprint(c), assertedAt: c.assertedAt });
    await s.intake.decideClaim(a.id, { status: 'accepted' }, { by: 'you' });
    await s.intake.decideClaim(b.id, { status: 'accepted' }, { by: 'you' });
    const { conflict } = await s.intake.openConflict({ kind: 'supersession', projectKey: 'shop', a: side(a), b: side(b), signals: [], judge: null });
    const r = await run(proposeResolution);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].rationale).toContain('B is true');
    const d = await propose('propose_resolution', r.candidates[0]);
    expect(d.tier).toBe('P');
    const applied = await x.apply(d, { by: 'you' });
    expect(await s.intake.conflict(conflict.id)).toMatchObject({ status: 'resolved', resolution: { choice: 'b' }, decisionId: d.id, resolvedBy: 'you' });
    expect((await s.intake.claim(a.id))!.status).toBe('superseded');
    expect((await s.intake.supersessions([a.id])).map((x) => x.to.id)).toEqual([b.id]);
    await x.rollback(applied, { by: 'you', cascade: 'apply' });
    expect(await s.intake.conflict(conflict.id)).toMatchObject({ status: 'open', resolution: null });
    expect((await s.intake.claim(a.id))!.status).toBe('accepted');
    expect(await s.intake.supersessions([a.id])).toEqual([]);
  });

  test('assign_question and close_question: suggested from accepted claims, applied on approval, rolled back to open', async () => {
    const src = await source({
      claims: [{ statement: 'The retry budget is five attempts', about: 'retry budget' }, { statement: 'The retry budget resets daily', about: 'retry budget' }],
      questions: [{ text: 'Who owns the retry budget?' }],
    });
    await source({ who: 'Bo Example', claims: [{ statement: 'The retry budget is shared', about: 'retry budget' }] });
    for (const c of (await s.intake.listClaims({ status: ['proposed'] }))) await s.intake.decideClaim(c.id, { status: 'accepted' }, { by: 'you' });
    const [q] = src.questions;
    const assign = await run(assignQuestion);
    expect(assign.candidates).toHaveLength(1);
    expect(assign.candidates[0].after[0].fields).toMatchObject({ status: 'assigned', assignee: src.person.id });
    const assigned = await x.apply(await propose('assign_question', assign.candidates[0]), { by: 'you' });
    expect(await s.intake.question(q.id)).toMatchObject({ status: 'assigned', assignee: src.person.id });
    await x.rollback(assigned, { by: 'you', cascade: 'apply' });
    expect(await s.intake.question(q.id)).toMatchObject({ status: 'open', assignee: null });

    const close = await run(closeQuestion);
    expect(close.candidates).toHaveLength(1);
    const answer = close.candidates[0].evidence[0].id;
    const closed = await x.apply(await propose('close_question', close.candidates[0]), { by: 'you' });
    expect(await s.intake.question(q.id)).toMatchObject({ status: 'answered', answerClaimId: answer });
    await x.rollback(closed, { by: 'you', cascade: 'apply' });
    expect(await s.intake.question(q.id)).toMatchObject({ status: 'open', answerClaimId: null });
  });
});
