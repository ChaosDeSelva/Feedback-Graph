import type { Decision } from '../../types.ts';
import type { DecisionTypeHandler } from './handler.ts';
import { writeLessonTargets } from './lessonWrites.ts';

/** The SUPERSEDES edge the merge makes: its keeper over its merged duplicate. */
const link = (d: Decision) => [{ keeper: d.targets.find((t) => t.role === 'keeper')!.id, merged: d.targets.find((t) => t.role === 'merged')!.id }];

/**
 * merge_duplicates: the keeper takes the union of paths and the duplicate is superseded into it (status superseded,
 * validTo, (keeper)-[:SUPERSEDES]->(duplicate)), both lessons and the edge in one transaction, each lesson compared
 * with its snapshot. The rollback restores both lessons as they were (the duplicate's status and decision, validTo
 * cleared) and removes the SUPERSEDES edge the merge made.
 */
export const mergeDuplicates: DecisionTypeHandler = {
  apply: (c, d) => writeLessonTargets(c, d, d.before, d.after, { supersede: link(d) }),
  rollback: (c, d, from) => writeLessonTargets(c, d, from, d.before, { unsupersede: link(d) }),
};
