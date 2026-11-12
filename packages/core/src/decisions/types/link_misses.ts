import { missLinkSnapshot } from '../../loop/snapshots.ts';
import { changedError, TargetChangedError } from '../record.ts';
import type { DecisionTypeHandler, HandlerContext } from './handler.ts';
import type { Decision, TargetSnapshot } from '../../types.ts';

/** The link a link_misses decision makes, from its snapshot (missLinkSnapshot). */
const ends = (d: Decision) => d.before[0].fields as { from: string; to: string };

async function now(c: HandlerContext, d: Decision): Promise<TargetSnapshot> {
  const { from, to } = ends(d);
  return missLinkSnapshot(from, to, (await c.store.decisions.missLinks(from)).some((l) => l.from === from && l.to === to));
}

/**
 * link_misses: (:Miss)-[:REPEATS]->(:Miss). Links have no compare-and-set write, so the link is compared just before;
 * linkMisses itself refuses a link that exists or a miss that is gone. Only the loop makes these links.
 */
export const linkMisses: DecisionTypeHandler = {
  snapshot: async (c, d) => [await now(c, d)],
  async apply(c, d) {
    const cur = await now(c, d);
    if (cur.fingerprint !== d.before[0].fingerprint) throw changedError(cur.id, d.before[0].fingerprint, cur);
    const { from, to } = ends(d);
    if (!(await c.store.decisions.linkMisses({ from, to, decisionId: d.id }))) throw new TargetChangedError(from, d.before[0].fingerprint, null);
  },
  async rollback(c, d, from) {
    const cur = await now(c, d);
    if (cur.fingerprint !== from[0].fingerprint) throw changedError(cur.id, from[0].fingerprint, cur);
    await c.store.decisions.unlinkMisses(ends(d));
  },
};
