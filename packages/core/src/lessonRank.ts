import { codeTerms, GENERIC, lessonsFor } from './codegraph.ts';
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
    'when before after every sure instead rather than first last time page screen app flow bug project').split(' '),
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

/*
 * Calibrated on nomic-embed-text over a 30-lesson monorepo (testing/lessonCorpus.ts). For a task no lesson is about,
 * every lesson scores 0.35 to 0.6, far over SIMILARITY_FLOOR, and the best stands at most ~2.1 standard deviations above
 * the rest; a lesson that is about the task stands 3 to 4.7 above. No absolute number tells these apart, but how far a
 * lesson stands out from the project's other lessons for the same query does.
 */
/** How many lessons a search should return so the gate can see how the rest scored (it serves at most LESSON_K). */
export const LESSON_POOL = 40;
/**
 * Below this many hits there is no spread or median to measure: a lesson is followed on a named file, a shared topic
 * word, GLOBAL_CLOSE or (a project's own) PROJECT_CLOSE alone, and nothing is graded possibly related.
 */
const MIN_POOL = 8;
/**
 * Below this many hits a lesson is measured against the rest of them, not against all of them: over all n hits, one
 * lesson far above n-1 alike can stand at most sqrt(n-1) deviations out, so with 8 or 9 hits STANDS_OUT was out of
 * reach. Its deviations from the rest are put on the scale the bars were calibrated on (a pool of LESSON_POOL: onPoolScale).
 */
const SMALL_POOL = 16;
/**
 * A project's own lesson this close is followed without a shared word in a pool under SMALL_POOL, where how far it stands
 * out is a weak signal. On nomic-embed-text a task no lesson is about scores every lesson 0.35 to 0.6.
 */
export const PROJECT_CLOSE = 0.7;
/** Standard deviations above the other lessons at which a lesson is about the task without a shared word. */
const STANDS_OUT = 3;
/** ...and at which it is possibly related. Above what a nonsense task's best reached (2.1). */
const MAYBE_STANDS_OUT = 2.5;
/** A spread below this is noise (all lessons scored alike): z is measured against at least this. */
const MIN_SPREAD = 0.02;
/**
 * A lesson sharing a topic word with the task is followed when it is this close to the best lesson, or stands this many
 * deviations out (a second lesson on the task, a little behind the first); else it is possibly related.
 */
const NEAR_BEST = 0.08;
const TOPIC_STANDS_OUT = 2;
/** At most this many possibly related lessons: they are pointers, not rules. */
export const RELATED_K = 3;

export type GradedLessons<T> = {
  /** Served under "follow these": tied to a named file in the project where it was learned. */
  follow: T[];
  /** Served apart, as possibly related: on the task's topic but scored with the crowd, or standing out only a little. */
  related: T[];
};

/** File ties alone establish rules. Semantic matches remain bounded pointers to inspect. */
export function gradeLessons<T extends LessonHit>(hits: T[], task: string, opts: { files?: string[]; projectKey?: string | null } = {}): GradedLessons<T> {
  const tied = new Set(opts.files?.length ? lessonsFor(hits.map((h) => h.lesson), opts.files, [], opts.projectKey ?? null).map((m) => m.lesson.id) : []);
  const scores = hits.map((h) => h.score);
  const best = Math.max(...scores);
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const calibrated = hits.length >= MIN_POOL;
  const small = hits.length < SMALL_POOL;
  const z = (i: number) => {
    if (!calibrated) return 0;
    // A small pool: against the other hits, on the calibrated scale. A large one: against all of them, as calibrated.
    const pool = small ? scores.filter((_, j) => j !== i) : scores;
    const d = deviations(scores[i], pool);
    return small ? onPoolScale(d) : d;
  };
  const out: GradedLessons<T> = { follow: [], related: [] };
  hits.forEach((h, i) => {
    if (h.lesson.checks?.some((c) => c.name === 'no-miss')) return;
    if (tied.has(h.lesson.id) && (h.lesson.projectKey === opts.projectKey || h.lesson.origin === opts.projectKey)) {
      out.follow.push(h);
      return;
    }
    if (h.score < SIMILARITY_FLOOR) return;
    // The project's own allowances (standing out, a close own lesson) are for its own lessons only: a global one, or
    // another project's should a caller pass one in, is served only on its topic or at GLOBAL_CLOSE.
    const global = h.lesson.projectKey === null || (opts.projectKey != null && h.lesson.projectKey !== opts.projectKey);
    const topic = sharesTopic(task, h.lesson);
    const onTopic = topic && (!calibrated || h.score >= median);
    const zi = z(i);
    const close = !calibrated || h.score >= best - NEAR_BEST || zi >= TOPIC_STANDS_OUT;
    const projectClose = !global && small && h.score >= PROJECT_CLOSE;
    if (h.score >= GLOBAL_CLOSE || projectClose || (!global && zi >= STANDS_OUT) || (onTopic && close)) out.related.push(h);
    else if (onTopic || (!global && zi >= MAYBE_STANDS_OUT)) out.related.push(h);
  });
  out.related = out.related.slice(0, RELATED_K);
  return out;
}

/** How many (population) standard deviations `s` is above `pool`'s mean; a spread under MIN_SPREAD counts as MIN_SPREAD. */
function deviations(s: number, pool: number[]): number {
  const mean = pool.reduce((a, b) => a + b, 0) / (pool.length || 1);
  const spread = Math.max(MIN_SPREAD, Math.sqrt(pool.reduce((a, x) => a + (x - mean) ** 2, 0) / (pool.length || 1)));
  return (s - mean) / spread;
}

/**
 * `t` deviations above the rest of the hits, as the deviations above all of them it would be in a pool of LESSON_POOL
 * (one lesson standing out of N: sqrt((N-1)/N) t / sqrt(1 + t^2/N)): the scale STANDS_OUT and its kin were set on.
 */
function onPoolScale(t: number): number {
  const n = LESSON_POOL;
  return (Math.sqrt((n - 1) / n) * t) / Math.sqrt(1 + (t * t) / n);
}

/** The lessons to follow for `task` (gradeLessons), in the search's order: what is served as rules and judged at done. */
export function rankLessons<T extends LessonHit>(hits: T[], task: string, opts: { files?: string[]; projectKey?: string | null } = {}): T[] {
  return gradeLessons(hits, task, opts).follow;
}
