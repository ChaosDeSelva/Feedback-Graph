import type { Lesson, LessonDraft, LessonOutcome, LessonQuality, LessonQualityReport } from './types.ts';

/** The parts of a lesson its writer controls. */
export const draftOf = (l: LessonDraft): LessonDraft => ({ title: l.title, rule: l.rule, appliesWhen: l.appliesWhen, scope: l.scope, paths: [...l.paths] });

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
/** The same words, scope and paths (whitespace and path order aside). */
export const sameDraft = (a: LessonDraft, b: LessonDraft) =>
  norm(a.title) === norm(b.title) && norm(a.rule) === norm(b.rule) && norm(a.appliesWhen) === norm(b.appliesWhen) && a.scope === b.scope &&
  [...a.paths].sort().join('\n') === [...b.paths].sort().join('\n');

/**
 * Whether a decision recorded as made `by` is on the owner's authority: 'you' (the UI), an agent with the operator token
 * (the owner gave it the verb), or not recorded (decided before decidedBy was, when only the owner decided). Such a
 * decision marks the lesson as the owner's (decidedByYou), so a memory re-import never overrides it. Anything else is a
 * machine's: the post-mortem's "no miss" rejection, the session re-match, a detector. What the owner's decisions say
 * about the writer (lessonOutcome: quality numbers, the post-mortem's examples) counts only ownDecision.
 */
export function ownerDecided(by: string | null | undefined): boolean {
  return by == null || by === 'you' || by === 'operator' || by.startsWith('operator:');
}

/** An agent holding the operator token decided it: on the owner's authority, but not the owner's judgement. */
export const operatorDecided = (by: string | null | undefined): boolean => by === 'operator' || !!by?.startsWith('operator:');

/** The owner's own decision: the UI's, or one recorded before decidedBy was (only the owner decided then). */
export const ownDecision = (by: string | null | undefined): boolean => by == null || by === 'you';

/** SQL for ownerDecided over a decided_by column (store-postgres). */
export const OWNER_DECIDED_SQL = (col: string) => `(${col} IS NULL OR ${col} = 'you' OR ${col} = 'operator' OR ${col} LIKE 'operator:%')`;

/** How a post-mortem lesson was decided, whoever decided it: null when undecided, superseded or not the writer's. */
function decidedAs(l: Lesson): LessonOutcome | null {
  if (l.source !== 'postmortem' || l.sandbox || !l.decidedAt) return null;
  if (l.status === 'rejected') return 'rejected';
  if (l.status !== 'approved') return null;
  return l.proposedAs && !sameDraft(l.proposedAs, l) ? 'edited' : 'as_written';
}

/**
 * How the owner decided this lesson, or null when it is not the owner's own decision on a post-mortem lesson: undecided,
 * superseded, withdrawn with its feedback (no decision time), decided by an agent with the operator token or by a
 * machine (ownDecision), from a memory file, by hand, the demo corpus, or a sandbox run (a tester's run must not teach
 * the writer).
 */
export function lessonOutcome(l: Lesson): LessonOutcome | null {
  return ownDecision(l.decidedBy) ? decidedAs(l) : null;
}

/**
 * The writer's version to keep when this patch edits a proposed lesson: its words, paths or scope change and no earlier
 * version is kept yet. Null: nothing to keep (an approved lesson's edit is not the writer's mistake, and the first draft
 * is the one that teaches).
 */
export function editedDraft(current: Lesson, patch: Partial<LessonDraft> & { status?: unknown }): LessonDraft | null {
  if (current.status !== 'proposed' || current.proposedAs) return null;
  const next = { ...draftOf(current), ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && Object.hasOwn(draftOf(current), k))) } as LessonDraft;
  return sameDraft(next, current) ? null : draftOf(current);
}

/**
 * Of these lessons, those the owner decided within the last `days` days, by outcome; those an agent with the operator
 * token decided are counted apart (byOperator), never as the owner's.
 */
export function lessonQuality(lessons: Lesson[], days: number, now = new Date()): LessonQuality {
  const since = now.getTime() - days * 86_400_000;
  const q: LessonQuality = { days, asWritten: 0, edited: 0, rejected: 0, decided: 0, byOperator: 0 };
  for (const l of lessons) {
    const o = decidedAs(l);
    if (!o || Date.parse(l.decidedAt!) < since) continue;
    if (operatorDecided(l.decidedBy)) q.byOperator++;
    else if (ownDecision(l.decidedBy)) {
      q[o === 'as_written' ? 'asWritten' : o]++;
      q.decided++;
    }
  }
  return q;
}

/** The windows LessonQualityReport counts, in days. */
export const LESSON_QUALITY_DAYS = [30, 90] as const;

/** LessonQualityReport of these decided lessons (decidedLessons from LESSON_QUALITY_DAYS' longest window back). */
export function lessonQualityReport(lessons: Lesson[], o: { capped?: boolean; now?: Date } = {}): LessonQualityReport {
  const windows = (ls: Lesson[]) => LESSON_QUALITY_DAYS.map((d) => lessonQuality(ls, d, o.now));
  const by = new Map<string, Lesson[]>();
  for (const l of lessons) {
    const key = l.projectKey ?? l.origin;
    if (key && decidedAs(l) && (ownDecision(l.decidedBy) || operatorDecided(l.decidedBy))) by.set(key, [...(by.get(key) ?? []), l]);
  }
  return { windows: windows(lessons), projects: Object.fromEntries([...by].map(([k, ls]) => [k, windows(ls)])), ...(o.capped && { capped: true as const }) };
}
