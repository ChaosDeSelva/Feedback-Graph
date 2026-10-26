import { codeTerms, GENERIC } from './codegraph.ts';
import type { LessonHit } from './graph/knowledge.ts';
import { SIMILARITY_FLOOR } from './relevance.ts';
import type { Lesson } from './types.ts';

/**
 * How close a global lesson must be to a task to be served on similarity alone, with no word of the task in it. An
 * embedding scores two unrelated sentences of the same register well above SIMILARITY_FLOOR (a data-retention lesson
 * scored 0.77 for "add pagination to the members list"), so for a lesson learned elsewhere that is no evidence.
 */
export const GLOBAL_CLOSE = 0.85;

/** Words a task and a lesson share without sharing a topic: what is done, not what it is done to. */
const NOT_A_TOPIC = new Set(
  ('fix change changing update remove delete write move rename refactor support allow ensure check run keep never always ' +
    'when before after every sure instead rather than first last time page').split(' '),
);
/** Two folded terms name one topic: the same, or (both long) the same first six letters (paginate, pagination). */
const SAME_STEM = 6;
const sameTopic = (a: string, b: string) => a === b || (a.length >= SAME_STEM && b.length >= SAME_STEM && a.slice(0, SAME_STEM) === b.slice(0, SAME_STEM));
/** At most this many topic words per side: a long task or lesson is still compared in bounded time. */
const TOPIC_MAX = 200;
const topics = (text: string) => codeTerms(text, TOPIC_MAX).filter((t) => !GENERIC.has(t) && !NOT_A_TOPIC.has(t));

/** Whether the task names something the lesson is about: a topical word of its title, rule, when it applies, or its paths. */
export function sharesTopic(task: string, l: Pick<Lesson, 'title' | 'rule' | 'appliesWhen' | 'paths'>): boolean {
  const want = topics(task);
  if (!want.length) return false;
  const have = topics([l.title, l.rule, l.appliesWhen, ...l.paths].join(' '));
  return want.some((w) => have.some((h) => sameTopic(w, h)));
}

/**
 * The lessons a search found that are worth serving for `task`, in the search's order: none under SIMILARITY_FLOOR,
 * and a global lesson only when it shares a topic with the task (sharesTopic) or is very close to it (GLOBAL_CLOSE).
 * A project's own lessons were learned on its code, so similarity is enough for them.
 */
export function rankLessons<T extends LessonHit>(hits: T[], task: string): T[] {
  return hits.filter((h) => h.score >= SIMILARITY_FLOOR && (h.lesson.projectKey !== null || h.score >= GLOBAL_CLOSE || sharesTopic(task, h.lesson)));
}
