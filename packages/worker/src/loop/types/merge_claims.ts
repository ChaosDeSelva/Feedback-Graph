import { claimSnapshot, LOOP_ACTOR, type Claim } from '@fb/core';
import { markedDistinct, SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { decidedAlready } from './approve_lesson.ts';
import { claimsOf, metasOf, neverTarget } from './claims.ts';

const older = (a: Claim, b: Claim) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const live = (c: Claim) => c.status === 'proposed' || c.status === 'accepted';

/**
 * merge_claims (tier H, housekeeping): a proposed claim that corroborates another (a CORROBORATES link: the judge or
 * link_claims found they say the same) is folded into it, so you review it once: it becomes superseded, and the link
 * keeps what it repeats. Floors: both are live (proposed or accepted), of the same type and project; the duplicate is
 * proposed, was never a fact, and no open conflict names it. The keeper is the accepted one, else the older. Nothing
 * agents are told changes (a proposed claim is never served). Rolling it back makes the duplicate proposed again.
 */
export const mergeClaims: LoopType = {
  type: 'merge_claims',
  weights: { bias: 2, keeperAccepted: 0.5, sameSource: -0.5 },
  groups: { evidence: ['keeperAccepted'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    const proposed = (await claimsOf(ctx, ['proposed'])).filter((c) => !c.docId.startsWith('answer:'));
    const links = proposed.length ? (await ctx.store.intake.links(proposed.map((c) => c.id))).filter((l) => l.rel === 'corroborates' && l.to.kind === 'claim') : [];
    const ends = new Map<string, Claim>(proposed.map((c) => [c.id, c]));
    const missing = [...new Set(links.flatMap((l) => [l.from, l.to.id]))].filter((id) => !ends.has(id));
    if (missing.length) for (const c of await ctx.store.intake.listClaims({ ids: missing, limit: missing.length })) ends.set(c.id, c);
    const metas = await metasOf(ctx, [...ends.values()]);
    const open = links.length ? await ctx.store.intake.conflictsFor(proposed.map((c) => c.id)) : [];
    const disputed = new Set(open.flatMap((k) => [k.a.id, k.b.id]));
    const merged = new Set<string>();
    for (const l of links) {
      const x = ends.get(l.from);
      const y = ends.get(l.to.id);
      if (!x || !y || !live(x) || !live(y) || x.type !== y.type || x.projectKey !== y.projectKey) { skip(skipped, SKIP.belowFloor); continue; }
      // The duplicate is the proposed one; of two proposed, the newer.
      const [keeper, dup] = x.status === 'accepted' ? [x, y] : y.status === 'accepted' ? [y, x] : [x, y].toSorted(older);
      if (dup.status !== 'proposed' || dup.factId || merged.has(dup.id) || merged.has(keeper.id)) { skip(skipped, SKIP.belowFloor); continue; }
      if (neverTarget(dup, metas) || neverTarget(keeper, metas)) { skip(skipped, SKIP.neverTarget); continue; }
      if (!ctx.inScope(dup.projectKey)) { skip(skipped, SKIP.outOfScope); continue; }
      if (disputed.has(dup.id)) { skip(skipped, SKIP.belowFloor); continue; }
      if (await markedDistinct(ctx.store, dup.id, keeper.id)) { skip(skipped, SKIP.distinct); continue; }
      if (await decidedAlready(ctx, 'merge_claims', dup.id)) { skip(skipped, SKIP.alreadyDecided); continue; }
      merged.add(dup.id);
      candidates.push(mergeClaimCandidate(dup, keeper, ctx.now));
    }
    return { candidates, scanned: links.length, skipped };
  },
};

/** The call folding the proposed `dup` into `keeper`. */
export function mergeClaimCandidate(dup: Claim, keeper: Claim, now: number): LoopCandidate {
  const after: Claim = { ...dup, status: 'superseded', decidedBy: LOOP_ACTOR, decidedAt: new Date(now).toISOString() };
  return {
    projectKey: dup.projectKey,
    targets: [{ kind: 'claim', id: dup.id, role: 'merged' }, { kind: 'claim', id: keeper.id, role: 'keeper' }],
    before: [claimSnapshot(dup), claimSnapshot(keeper)],
    after: [claimSnapshot(after), claimSnapshot(keeper)],
    evidence: [
      { kind: 'claim', id: dup.id, role: 'corroborates', weight: 1, observedAt: dup.createdAt },
      { kind: 'claim', id: keeper.id, role: 'kept claim', weight: 1, observedAt: keeper.createdAt },
    ],
    features: { keeperAccepted: keeper.status === 'accepted' ? 1 : 0, sameSource: dup.docId === keeper.docId ? 1 : 0 },
    subject: `merge "${dup.statement.slice(0, 60)}" into the claim it repeats`,
    rationale: `The proposed ${dup.type} claim ${dup.id} says the same as the ${keeper.status} claim ${keeper.id}, so it is folded into it: you review one claim instead of two. It is marked superseded and keeps its link to ${keeper.id}; nothing agents are told changes.`,
  };
}
