import type { DecisionType } from '../../types.ts';
import { genericHandler } from './generic.ts';
import type { DecisionTypeHandler } from './handler.ts';
import { linkMisses } from './link_misses.ts';
import { mergeDuplicates } from './merge_duplicates.ts';
import { rejectLesson } from './reject_lesson.ts';
import { retireLesson } from './retire_lesson.ts';
import { tuneThreshold } from './tune_threshold.ts';
import { recordFact } from './record_fact.ts';
import { rewordLesson } from './reword_lesson.ts';
import { resolveConflict } from './resolve_conflict.ts';
import { linkClaims } from './link_claims.ts';
import { proposeResolution } from './propose_resolution.ts';
import { questionHandler } from './question.ts';
import { updatePaths } from './update_paths.ts';

export type * from './handler.ts';

/**
 * The handlers with their own target write, by decision type. A type not listed uses genericHandler (lesson fields,
 * fact relevance and new facts, Inbox items): add `types/<type>.ts` with one named export and one line here only when
 * it needs more.
 */
export const DECISION_HANDLERS: Partial<Record<DecisionType, DecisionTypeHandler>> = {
  link_misses: linkMisses,
  merge_duplicates: mergeDuplicates,
  retire_lesson: retireLesson,
  reject_lesson: rejectLesson,
  tune_threshold: tuneThreshold,
  reword_lesson: rewordLesson,
  record_fact: recordFact,
  resolve_conflict: resolveConflict,
  // A removed source's claims rejected and their facts closed: the same claim and fact moves, with no conflict.
  remove_source: resolveConflict,
  // Knowledge intake's loop types (0.9.1): a claim accepted (its fact made) or merged moves claims and facts as a
  // resolution does; a suggested resolution is the owner's resolution once approved.
  accept_claim: resolveConflict,
  merge_claims: resolveConflict,
  propose_resolution: proposeResolution,
  link_claims: linkClaims,
  assign_question: questionHandler,
  close_question: questionHandler,
  update_paths: updatePaths,
};

export const handlerFor = (type: DecisionType): DecisionTypeHandler => DECISION_HANDLERS[type] ?? genericHandler;
