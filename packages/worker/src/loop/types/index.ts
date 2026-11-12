import type { LoopType } from '../plugin.ts';
import { approveLesson } from './approve_lesson.ts';
import { linkMisses } from './link_misses.ts';
import { mergeDuplicates } from './merge_duplicates.ts';
import { narrowScope } from './narrow_scope.ts';
import { rankWeight } from './rank_weight.ts';
import { recordFact } from './record_fact.ts';
import { rejectLesson } from './reject_lesson.ts';
import { retireLesson } from './retire_lesson.ts';
import { rewordLesson } from './reword_lesson.ts';
import { triageInbox } from './triage_inbox.ts';
import { tuneThreshold } from './tune_threshold.ts';

/** Every decision type the engine runs, in the order it runs them. Add a type here once its file exists. */
export const LOOP_TYPES: readonly LoopType[] = [
  linkMisses, mergeDuplicates, retireLesson, rejectLesson, rankWeight, tuneThreshold, narrowScope, approveLesson, rewordLesson, recordFact, triageInbox,
];
