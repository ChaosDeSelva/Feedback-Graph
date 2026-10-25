import type { Cause, ContextItem, PostMortem } from '@fb/core';

/**
 * The shape of a post-mortem's lesson, made right after the model answers: a title that names the rule instead of
 * repeating it, a rule with no pull request or issue numbers (a number means nothing to the next agent; the code it
 * names does), and an appliesWhen that says when, not the rule again. What was repaired is returned for the log.
 */
type Lesson = PostMortem['lesson'];
export type Shaped = { lesson: Lesson; repaired: ('title' | 'rule' | 'appliesWhen')[] };

const REF = String.raw`(?:PRs?|pull requests?|issues?|MR)\s*#?\d+`;
const REFS: [RegExp, string][] = [
  // "(see PR #12)", "(#91)"
  [new RegExp(String.raw`\s*\((?:see |in |from |per )?(?:${REF}|#\d+)\)`, 'gi'), ''],
  // "As in PR #812, read ..." at the start
  [new RegExp(String.raw`^\s*(?:as|like) (?:in |seen in |done in )?${REF},?\s*`, 'i'), ''],
  // "..., as PR #14217 does"
  [new RegExp(String.raw`,?\s*\b(?:as|like) (?:in |seen in |done in )?${REF}(?: (?:did|does|shows|showed|do))?`, 'gi'), ''],
  // "in PR #12", "see issue 4"
  [new RegExp(String.raw`\b(?:in|from|per|see) ${REF}\b,?\s*`, 'gi'), ''],
  [new RegExp(String.raw`\b${REF}\b`, 'gi'), ''],
  // A bare "#123" (not a colour, an anchor or a path).
  [/(?<![\w/.#])#\d+\b/g, ''],
];

/** The text with pull request and issue numbers taken out, tidied back into a sentence. */
export function stripRefs(text: string): string {
  let s = text;
  for (const [re, by] of REFS) s = s.replace(re, by);
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/,(?=[.;:]|$)/g, '').replace(/^[\s,;:]+/, '').trim();
  return s && s !== text ? s[0].toUpperCase() + s.slice(1) : s;
}

/** For comparing: lower case, letters and digits only. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 2));

/** How much of `a`'s words are in `b` and back (Jaccard). */
function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

const TITLE_CHARS = 60;

/** The rule's first clause, clipped on a word to TITLE_CHARS. */
function firstClause(rule: string): string {
  const clause = rule.split(/[,;:(]| because | so that | unless /)[0].replace(/[.\s]+$/, '').trim();
  if (clause.length <= TITLE_CHARS) return clause;
  const cut = clause.slice(0, TITLE_CHARS + 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).trimEnd()}…`;
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

export function shapeLesson(lesson: Lesson, o: { taskTitle: string }): Shaped {
  const repaired: Shaped['repaired'] = [];
  let { title, appliesWhen } = lesson;
  const rule = stripRefs(lesson.rule);
  if (rule !== lesson.rule) repaired.push('rule');
  const bare = norm(stripRefs(title));
  if (!bare || bare === norm(rule) || (title.length > TITLE_CHARS && norm(rule).startsWith(bare))) {
    const clause = firstClause(rule);
    title = norm(clause) === norm(rule) && o.taskTitle.trim() ? o.taskTitle.trim().slice(0, TITLE_CHARS) : clause;
    repaired.push('title');
  }
  if (!appliesWhen.trim() || norm(appliesWhen) === norm(rule) || norm(appliesWhen) === norm(title) || overlap(appliesWhen, rule) >= 0.8) {
    appliesWhen = lesson.paths.length
      ? `When changing ${lesson.paths.slice(0, 3).join(', ')}`
      : `When working on ${lowerFirst(o.taskTitle.trim()) || 'this project'}`;
    repaired.push('appliesWhen');
  }
  return { lesson: repaired.length ? { ...lesson, title, rule, appliesWhen } : lesson, repaired };
}

/** A context item's file, without :line or ./ */
const fileOf = (ref: string) => ref.replace(/:\d+(-\d+)?$/, '').replace(/^\.\//, '');

/**
 * A review comment is on one file: the code the post-mortem cites stays in that file's directory (and below), so a
 * comment on the markdown pipeline is not explained by a Go service. Instruction files, docs and discussions stay.
 * No file, or one at the repository root: nothing to cap to.
 */
export function capToCommentDir(items: ContextItem[], commentPath: string | null): ContextItem[] {
  const slash = commentPath ? fileOf(commentPath).lastIndexOf('/') : -1;
  if (slash <= 0) return items;
  const dir = fileOf(commentPath!).slice(0, slash + 1);
  return items.filter((i) => i.kind !== 'code' || fileOf(i.ref).startsWith(dir));
}

/**
 * code_not_read: the post-mortem cites code that is in the repository and that the session never read (not
 * wasAvailable), so the information was there to find. It replaces context_missing ("nowhere it would look" is wrong
 * when the file was in the repository), and context_available_ignored when nothing it cites was available. Without
 * a way to check the repository the cause stands.
 */
export async function codeNotRead(cause: Cause, items: ContextItem[], exists: ((path: string) => Promise<boolean>) | undefined): Promise<Cause> {
  if (!exists) return cause;
  if (cause !== 'context_missing' && !(cause === 'context_available_ignored' && !items.some((i) => i.wasAvailable))) return cause;
  for (const i of items) if (i.kind === 'code' && !i.wasAvailable && (await exists(fileOf(i.ref)).catch(() => false))) return 'code_not_read';
  return cause;
}
