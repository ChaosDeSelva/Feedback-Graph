import type { Decision, ProjectThresholds, TargetSnapshot } from '../../types.ts';
import type { DecisionTypeHandler } from './handler.ts';

const projectOf = (d: Decision) => d.targets[0].id;
const floors = (s: TargetSnapshot) => s.fields as ProjectThresholds;

/**
 * tune_threshold: a project's own SIMILARITY_FLOOR / FACT_RANK_FLOOR (thresholdsSnapshot, which snapshotTarget reads),
 * written with the `from` fingerprint as `expect` in the store's transaction. Always the owner's call (tier P).
 */
export const tuneThreshold: DecisionTypeHandler = {
  apply: (c, d) => c.store.facts.setProjectThresholds(projectOf(d), floors(d.after[0]), { expect: d.before[0].fingerprint }),
  rollback: (c, d, from) => c.store.facts.setProjectThresholds(projectOf(d), floors(d.before[0]), { expect: from[0].fingerprint }),
};
