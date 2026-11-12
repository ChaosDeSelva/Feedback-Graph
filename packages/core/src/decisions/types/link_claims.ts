import { claimLinkSnapshot } from '../../loop/snapshots.ts';
import type { ClaimLink, Decision, TargetSnapshot } from '../../types.ts';
import { changedError, TargetChangedError } from '../record.ts';
import type { DecisionTypeHandler, HandlerContext } from './handler.ts';

/** The link a link_claims decision makes, from its snapshot (claimLinkSnapshot). */
const linkOf = (d: Decision): ClaimLink => {
  const f = d.before[0].fields as ClaimLink;
  return { from: f.from, to: f.to, rel: f.rel };
};

async function now(c: HandlerContext, d: Decision): Promise<TargetSnapshot> {
  const l = linkOf(d);
  const there = (await c.store.intake.links([l.from])).some((x) => x.from === l.from && x.to.kind === l.to.kind && x.to.id === l.to.id && x.rel === l.rel);
  return claimLinkSnapshot(l, there);
}

/**
 * link_claims: (:Claim)-[:CORROBORATES|REFINES]->(claim, fact or lesson). Links have no compare-and-set write, so the
 * link is compared just before; addLinks itself skips a link that exists or whose ends are gone (nothing added: the
 * target changed). Rolling back removes exactly that link.
 */
export const linkClaims: DecisionTypeHandler = {
  snapshot: async (c, d) => [await now(c, d)],
  async apply(c, d) {
    const cur = await now(c, d);
    if (cur.fingerprint !== d.before[0].fingerprint) throw changedError(cur.id, d.before[0].fingerprint, cur);
    if (!(await c.store.intake.addLinks([linkOf(d)]))) throw new TargetChangedError(cur.id, d.before[0].fingerprint, null);
  },
  async rollback(c, d, from) {
    const cur = await now(c, d);
    if (cur.fingerprint !== from[0].fingerprint) throw changedError(cur.id, from[0].fingerprint, cur);
    await c.store.intake.removeLinks([linkOf(d)]);
  },
};
