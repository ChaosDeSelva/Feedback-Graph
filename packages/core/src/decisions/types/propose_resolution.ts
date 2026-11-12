import type { Decision } from '../../types.ts';
import type { DecisionTypeHandler } from './handler.ts';
import { resolveConflict } from './resolve_conflict.ts';

/**
 * propose_resolution: the learning loop's suggested resolution of a conflict, written exactly as the owner's
 * resolve_conflict once the owner approves it (tier P: never applied on its own). The conflict records this decision
 * as the one that settled it and the owner who approved it as its resolver (neither is fingerprinted, so a rollback
 * still compares the snapshots).
 */
const settledBy = (d: Decision, by: string): Decision => ({
  ...d,
  after: d.after.map((a) => (a.kind === 'conflict' ? { ...a, fields: { ...a.fields, decisionId: d.id, resolvedBy: by } } : a)),
});

export const proposeResolution: DecisionTypeHandler = {
  apply: (c, d) => resolveConflict.apply(c, settledBy(d, c.by)),
  rollback: resolveConflict.rollback,
};
