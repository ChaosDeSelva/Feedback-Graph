import { claimLinkSnapshot, normalizeStatement, type Claim, type ClaimLink } from '@fb/core';
import { SKIP, skip, type LoopCandidate, type LoopType, type LoopTypeContext, type LoopTypeResult } from '../plugin.ts';
import { claimsOf, metasOf, neverTarget } from './claims.ts';

/** A statement this short normalised ("yes", "agreed") says too little to call two the same. */
const MIN_CHARS = 16;

const key = (c: Claim) => `${c.projectKey ?? ''}\u0000${c.type}\u0000${normalizeStatement(c.statement)}`;
const older = (a: Claim, b: Claim) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const linked = (ls: ClaimLink[], a: string, b: string) => ls.some((l) => l.rel === 'corroborates' && ((l.from === a && l.to.id === b) || (l.from === b && l.to.id === a)));

/**
 * link_claims (tier H, housekeeping): two claims from different sources that say the same thing (same project, same
 * type, the same statement once case, punctuation and spacing are ignored) are recorded as corroborating: the newer
 * (:Claim)-[:CORROBORATES]->(the older). Contradiction detection links the pairs it compares; this finds the proposed
 * ones it never compares (a claim waiting for review is only compared within its own source). Nothing agents see
 * changes; merge_claims then folds a proposed duplicate into what it repeats.
 */
export const linkClaims: LoopType = {
  type: 'link_claims',
  weights: { bias: 2, sameStatement: 1, crossSource: 1 },
  groups: { evidence: ['sameStatement'] },

  async candidates(ctx: LoopTypeContext): Promise<LoopTypeResult> {
    const skipped: Record<string, number> = {};
    const candidates: LoopCandidate[] = [];
    const claims = (await claimsOf(ctx, ['proposed', 'accepted'])).filter((c) => !c.docId.startsWith('answer:'));
    const metas = await metasOf(ctx, claims);
    const groups = new Map<string, Claim[]>();
    for (const c of claims) {
      if (normalizeStatement(c.statement).length < MIN_CHARS) continue;
      groups.set(key(c), [...(groups.get(key(c)) ?? []), c]);
    }
    const many = [...groups.values()].filter((g) => new Set(g.map((c) => c.docId)).size > 1);
    const links = many.length ? await ctx.store.intake.links(many.flat().map((c) => c.id)) : [];
    let scanned = 0;
    for (const group of many) {
      const [first, ...rest] = group.toSorted(older);
      for (const c of rest) {
        if (c.docId === first.docId) continue;
        scanned++;
        if (neverTarget(c, metas) || neverTarget(first, metas)) { skip(skipped, SKIP.neverTarget); continue; }
        if (!ctx.inScope(c.projectKey)) { skip(skipped, SKIP.outOfScope); continue; }
        if (linked(links, c.id, first.id)) { skip(skipped, SKIP.alreadyDecided); continue; }
        candidates.push(linkCandidate(c, first));
      }
    }
    return { candidates, scanned, skipped };
  },
};

/** The call linking `c` to the older claim `to` it repeats. */
export function linkCandidate(c: Claim, to: Claim): LoopCandidate {
  const link: ClaimLink = { from: c.id, to: { kind: 'claim', id: to.id }, rel: 'corroborates' };
  return {
    projectKey: c.projectKey,
    targets: [{ kind: 'claim', id: c.id, role: 'primary' }, { kind: 'claim', id: to.id, role: 'keeper' }],
    before: [claimLinkSnapshot(link, false)],
    after: [claimLinkSnapshot(link, true)],
    evidence: [
      { kind: 'claim', id: c.id, role: 'says the same', weight: 1, observedAt: c.createdAt },
      { kind: 'claim', id: to.id, role: 'said first', weight: 1, observedAt: to.createdAt },
    ],
    features: { sameStatement: 1, crossSource: 1 },
    subject: `link "${c.statement.slice(0, 60)}" to the same claim from another source`,
    rationale: `The ${c.status} ${c.type} claim ${c.id} says what ${to.id} (${to.status}, from another source) said first, word for word once case and punctuation are ignored. It is recorded as corroborating it; nothing agents are told changes.`,
  };
}
