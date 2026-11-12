import { absentSnapshot, claimSnapshot, factSnapshot, LOOP_ACTOR, type Claim, type FactKind, type IntakeMeta, type TargetSnapshot } from '@fb/core';
import { SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { decidedAlready } from './approve_lesson.ts';
import { claimFactOf, claimQuality, claimsOf, metasOf, neverTarget, type ClaimQuality } from './claims.ts';
import { plannedFactId } from './record_fact.ts';

/** The extraction must be this sure of the claim. */
export const ACCEPT_MIN_CONFIDENCE = 0.8;
/** Your as-written accept rate on claims of the type must be at least this, over at least ACCEPT_MIN_DECIDED of your decisions. */
export const ACCEPT_MIN_RATE = 0.7;
export const ACCEPT_MIN_DECIDED = 20;
/** Only these: an opinion is never the loop's to accept, and a plan or commitment stays yours to judge. */
const TYPES: Claim['type'][] = ['fact', 'decision'];
/** The fact kind a claim of each type files as (a plain fact as a convention, as the review route's default). */
const KIND: Record<'fact' | 'decision', FactKind> = { fact: 'convention', decision: 'decision' };

/**
 * accept_claim (tier A, τ 0.92): a proposed fact or decision claim is accepted, and its fact (origin claim) filed as the
 * review route files it, so agents are given it. Floors (never lowered): no flag (the quote matched the source exactly
 * and the statement adds nothing to it), not from a source an agent submitted, a known speaker (a person you
 * confirmed), confidence ≥ ACCEPT_MIN_CONFIDENCE, no open conflict on it, a project to file it under, and your
 * as-written accept rate on claims of its type ≥ 70% over ≥ 20 of your decisions. Never an opinion, never anything an
 * agent submitted, never settling a conflict. Rolling it back makes the claim proposed again and closes the fact.
 */
export const acceptClaim: LoopType = {
  type: 'accept_claim',
  weights: { bias: -2, confidenceAbove: 2, asWrittenAbove: 3, ownerDecisions: 2 },
  groups: { evidence: ['confidenceAbove', 'asWrittenAbove'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    const claims = (await claimsOf(ctx, ['proposed'], { type: TYPES })).filter((c) => !c.docId.startsWith('answer:'));
    if (!claims.length) return { candidates, scanned: 0, skipped };
    const [metas, quality, open, people] = await Promise.all([
      metasOf(ctx, claims), claimQuality(ctx), ctx.store.intake.conflictsFor(claims.map((c) => c.id)), ctx.store.intake.people({ status: ['confirmed'] }),
    ]);
    const disputed = new Set(open.flatMap((k) => [k.a.id, k.b.id]));
    const known = new Set(people.map((p) => p.id));
    for (const c of claims) {
      const meta = metas.get(c.docId) ?? null;
      if (neverTarget(c, metas)) { skip(skipped, SKIP.neverTarget); continue; }
      if (!ctx.inScope(c.projectKey)) { skip(skipped, SKIP.outOfScope); continue; }
      const q = quality.get(c.type);
      const below = !meta || c.projectKey === null || c.confidence < ACCEPT_MIN_CONFIDENCE || !c.speakerId || !known.has(c.speakerId) || disputed.has(c.id)
        || !q || q.decided < ACCEPT_MIN_DECIDED || q.rate < ACCEPT_MIN_RATE;
      if (below) { skip(skipped, SKIP.belowFloor); continue; }
      if (await decidedAlready(ctx, 'accept_claim', c.id)) { skip(skipped, SKIP.alreadyDecided); continue; }
      candidates.push(acceptCandidate(c, meta, q, await claimFactOf(ctx, c, meta), ctx.now));
    }
    return { candidates, scanned: claims.length, skipped };
  },
};

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The call accepting `c` and filing its fact under a planned id. */
export function acceptCandidate(c: Claim, meta: IntakeMeta, q: ClaimQuality, f: { path: string; why: string; relevance: number }, now: number): LoopCandidate {
  const factId = plannedFactId(`accept_claim:${c.id}`);
  const kind = KIND[c.type as 'fact' | 'decision'];
  const fact = factSnapshot({ id: factId, projectKey: c.projectKey!, kind, statement: c.statement, path: f.path, lines: null, why: f.why, relevance: f.relevance, relevanceBy: LOOP_ACTOR as never, current: true });
  const created: TargetSnapshot = { ...fact, fields: { ...fact.fields, origin: 'claim' } };
  const after: Claim = { ...c, status: 'accepted', decidedBy: LOOP_ACTOR, decidedAt: new Date(now).toISOString(), factId };
  return {
    projectKey: c.projectKey,
    targets: [{ kind: 'claim', id: c.id, role: 'primary' }, { kind: 'fact', id: factId, role: 'created' }],
    before: [claimSnapshot(c), absentSnapshot({ kind: 'fact', id: factId })],
    after: [claimSnapshot(after), created],
    evidence: [
      { kind: 'claim', id: c.id, role: 'exact quote, known speaker', weight: round3(c.confidence), observedAt: c.createdAt },
      { kind: 'activity', id: `claim-quality:${c.type}`, role: 'your as-written rate', weight: round3(q.rate), observedAt: new Date(now).toISOString() },
    ],
    features: {
      confidence: round3(c.confidence),
      confidenceAbove: round3((c.confidence - ACCEPT_MIN_CONFIDENCE) / (1 - ACCEPT_MIN_CONFIDENCE)),
      asWrittenRate: round3(q.rate),
      asWrittenAbove: round3((q.rate - ACCEPT_MIN_RATE) / (1 - ACCEPT_MIN_RATE)),
      ownerDecisions: Math.min(q.decided, 40) / 40,
    },
    subject: `accept ${c.type} claim "${c.statement.slice(0, 80)}"`,
    rationale: `${meta.kind === 'transcript' ? 'Said in a call' : 'Written in notes'} (${f.why}) and quoted exactly, by a person you confirmed, with confidence ${round3(c.confidence)} and no open conflict; you accepted ${Math.round(q.rate * 100)}% of your last ${q.decided} ${c.type} claims as written. Accepting it files it as a project ${kind} fact, so agents are given it.`,
  };
}
