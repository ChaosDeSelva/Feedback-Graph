import { isSelfReview, type HumanTurn, type LessonCheck, type PostMortem } from '@fb/core';
import { junkPathReason } from './paths.ts';

/**
 * A cheap check on a proposed lesson before the owner sees it: is it scoped and falsifiable, or has one comment been
 * turned into a rule for everything? It narrows only what is clearly wrong (a path outside the repository, a universal
 * rule drawn from one nit, a rule field holding the scope word) and flags the rest; the owner still approves every lesson.
 * The flags are stored on the lesson (`checks`) and shown as chips on the Lessons page.
 */

export type LessonFlag = LessonCheck;

/** The why of a looks-like-a-fact the post-mortem model said itself: a re-check cannot work it out again, so keeps it. */
export const MODEL_FACT_WHY = 'the post-mortem model said it states how the code is rather than what to do: it may belong in the project facts';

/** What the post-mortem model said about its own lesson, when it said it. */
export type ModelSays = { about?: 'work' | 'process'; factLike?: boolean };

const UNIVERSAL = /\b(always|never|every|all|any|mandatory|must|regardless)\b/i;
/**
 * A nit or optional remark, by its marker: at the start of the comment or in a tag ("nit:", "Minor:", "**nit**",
 * "(optional)", "[nit]"), or said outright ("non-blocking", "nitpick"). A severity label such as LOW is not a nit, and
 * "typo" or "optional" in the body is just a word.
 */
const NIT = /^\W{0,4}(nit|nitpick|minor|optional|cosmetic|non-blocking)\b|[([*_]{1,2}\s*(nit|nitpick|minor|optional|cosmetic)\s*[)\]*_]{1,2}|\bnit:|\bnitpick|\bnon-blocking\b|\bnot a blocker\b/i;
/** A rule about how to treat feedback or reviewers rather than about the work. */
const META = [
  /\b(treat|ignore|prioriti[sz]e|defer to|obey|disregard|incorporate|consult)\b[^.]{0,60}\b(feedback|review(er)?s?|nitpicks?|comments?|suggestions?)\b/i,
  /\b(feedback|review(er)?s?|nitpicks?|comments?)\b[^.]{0,60}\b(as mandatory|must be followed)\b/i,
  /\b(feedback|review(er)?s?|comments?|nitpicks?|suggestions?)\b[^.]{0,80}\b(relevan|pertain|scope\b|current (task|pr|pull request|feature)|applies to)/i,
  /^\s*(scope|verify|filter|check)\b[^.]{0,20}\bfeedback\b/i,
];
/** "Always verify ...", "Never assume ...": the shape of a platitude, unless it names something in the code. */
const PLATITUDE = /^\s*(always|never|make sure to|be sure to)\s+(verify|validate|check|test|ensure|consider|review|confirm|double-check|assume|prioriti[sz]e|cross-reference|maintain|monitor)\b/i;
/** Something from the code: a path, a dotted or snake/camel-case name, a call, a backticked span, a CONSTANT. */
const IDENTIFIER = /`[^`]+`|\w+\/\w+|\w+\.\w+|\w+_\w+|\b[a-z]+[A-Z]\w*|\b\w+\(\)|\b[A-Z]{2,}[A-Z0-9_]*\b/;
/** Words a small model puts in the rule field instead of a rule. */
const SCOPE_WORDS = new Set(['task', 'project', 'global', 'context_missing', 'context_available_ignored', 'code_not_read', 'requirement_unstated', 'verification_gap', 'implementation_error']);
/** The verbs a rule starts with, at the start of the rule or of a clause ("When X, ensure Y"). */
const DO = 'do|don\'?t|use|avoid|prefer|keep|make|check|ensure|add|remove|read|write|call|pass|set|run|test|assert|lock|validate|verify|carry|label|flag|document|return|reuse|filter|derive|split|resolve|guard|cover|update|fix|rename|move|wait|retry|stop|skip|treat|mark|include|exclude|handle|configure|register|define|declare|put|place|import|export|scope|limit|log|send|store|load|cache|escape|sanitize|redact|sort|close|release|clear|delete|create|replace|look|search|ask|confirm|compare|measure|wrap|catch|throw|raise|emit|parse|normalize|trim|clamp';
const IMPERATIVE_LEAD = new RegExp(`(^|[,;:]|\\bthen|\\bso)\\s*(${DO})\\b`, 'i');
/**
 * A modal or a rule word anywhere. "never" and "always" only before a verb in its base form: "the web app never sees
 * it" describes the code. ("before", "until", "not in" are not rule words: "migrations run before the server starts".)
 */
const IMPERATIVE_WORD = /\b(must|should|need to|has to|have to|do not|don'?t|make sure|instead of|rather than)\b|\b(never|always)\b(?!\s+[a-z]*[^s\W]s\b)/i;
/** "Remember that ...", "Be aware that ...": a fact dressed as an instruction. */
const AWARE = /^\s*(?:(?:always|when [^,]{1,80},|if [^,]{1,80},)\s*)?(?:remember|note|be aware|keep in mind|bear in mind|understand|recogni[sz]e|know|be mindful|take into account)\b(?:\s+(?:that|of))?\s+(.+)$/i;
/** A declarative sentence about the codebase: "<subject> is / defaults to / lives under / uses ...". */
const DECLARATIVE = /\b(is|are|was|were|defaults? to|lags?|uses|reads|returns|carries|holds|stores|runs|has|have|pins?|caps?|counts?|lives?|resides?|sits|shares?|relies on|depends on|expects|contains|exposes|requires|owns|wraps|calls|sends|emits|loads|writes|located|configured|defined|declared|registered|handled|implemented|built with)\b/i;

const imperative = (s: string) => IMPERATIVE_LEAD.test(s) || IMPERATIVE_WORD.test(s);

/** The rule says how the code is rather than what to do (it may belong in the project facts). */
export function statesAFact(rule: string): boolean {
  const aware = AWARE.exec(rule);
  const core = aware ? aware[1] : rule;
  if (imperative(core)) return false;
  return !!aware || DECLARATIVE.test(core);
}
/** A comment that carries no new pushback: an approval summary, a findings status table, an echo of another review. */
const NOT_PUSHBACK = [
  /^\W{0,4}(approving|approved|lgtm|looks good)\b/i,
  /\bdetails inline\b|\bsee inline\b/i,
  /\bsame conclusions? as\b|\bagree with the (first|other|previous) review/i,
];

/**
 * The model saying the session it was shown did other work than the comment is about: the "WRONG SESSION:" marker the
 * prompt asks for, or the same thing in its own words ("the feedback pertains to a different PR"). Read from the
 * post-mortem as it is made, and from a stored miss when a lesson is re-checked.
 */
const WRONG_SESSION = [
  /^\s*WRONG SESSION:/i,
  /\b(pertains?|relates?|belongs?|refers?|applies) to (a |an )?(different|another|other|unrelated|separate)\b/i,
  /\b(different|another|unrelated|separate) (pull request|PR|feature|task|branch|session)\b/i,
];
export const saysWrongSession = (pm: { missed: string; causeExplanation: string }) =>
  WRONG_SESSION.some((re) => re.test(pm.causeExplanation ?? '') || re.test(pm.missed ?? ''));

function statusTable(text: string): boolean {
  const rows = text.split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l));
  return rows.length >= 3 && rows.length >= text.trim().split('\n').length - 1 && /\b(fixed|resolved|addressed|done|open|wontfix|won't fix)\b/i.test(text);
}

export function checkLesson(lesson: PostMortem['lesson'], feedback: HumanTurn, model: ModelSays = {}): { lesson: PostMortem['lesson']; flags: LessonFlag[] } {
  const flags: LessonFlag[] = [];
  let out = lesson;
  const paths = lesson.paths.filter((p) => !p.startsWith('~') && !p.includes(':'));
  if (paths.length !== lesson.paths.length) {
    flags.push({ name: 'non-repo-path', why: `dropped ${lesson.paths.filter((p) => !paths.includes(p)).join(', ')}: not a repository path` });
    out = { ...out, paths };
  }
  if (SCOPE_WORDS.has(lesson.rule.trim().toLowerCase()) && lesson.title.trim()) {
    flags.push({ name: 'broken-rule', why: `the rule field held "${lesson.rule.trim()}"; the title is used as the rule` });
    out = { ...out, rule: lesson.title.trim() };
  }
  // An APPROVED review is not a nit: it can carry the one real finding of the review (its markers still count).
  const nit = NIT.test(feedback.text.trim());
  if (nit && out.scope !== 'task' && UNIVERSAL.test(out.rule)) {
    flags.push({ name: 'universal-from-nit', why: `a ${out.scope}-wide rule from one minor comment; narrowed to the task` });
    out = { ...out, scope: 'task' };
  }
  return { lesson: out, flags: [...flags, ...textFlags(out, feedback, model)] };
}

/** The flags that only read the lesson's text and the comment (nothing is changed). */
function textFlags(lesson: PostMortem['lesson'], feedback: HumanTurn, model: ModelSays): LessonFlag[] {
  const flags: LessonFlag[] = [];
  const text = `${lesson.title}. ${lesson.rule}`;
  if (META.some((re) => re.test(text)) || model.about === 'process') flags.push({ name: 'meta-lesson', why: 'about how to treat feedback, not about the work' });
  if ((PLATITUDE.test(lesson.title) || PLATITUDE.test(lesson.rule)) && !IDENTIFIER.test(lesson.rule)) flags.push({ name: 'platitude', why: 'a general rule that names nothing in the code; say what to check, where' });
  if (model.factLike) flags.push({ name: 'looks-like-a-fact', why: MODEL_FACT_WHY });
  else if (statesAFact(lesson.rule)) flags.push({ name: 'looks-like-a-fact', why: 'states how the code is rather than what to do: it may belong in the project facts' });
  const comment = feedback.text.trim();
  if (NOT_PUSHBACK.some((re) => re.test(comment)) || statusTable(comment)) flags.push({ name: 'not-pushback', why: 'the comment is an approval, a status table or an echo of another review, not new pushback' });
  if (feedback.external && isSelfReview(feedback.external)) flags.push({ name: 'self-review', why: "an agent reviewing its own pull request under the author's account" });
  return flags;
}

/**
 * The checks on a lesson already stored (proposed before the checks were kept): flags only, the lesson is left as it
 * is, so the owner decides on what they see. A path that could not be a lesson's path is flagged, not dropped.
 */
export function recheckLesson(lesson: PostMortem['lesson'], feedbackText: string): LessonFlag[] {
  const bad = lesson.paths.map((p) => [p, junkPathReason(p)] as const).filter(([, why]) => why);
  const flags: LessonFlag[] = bad.length ? [{ name: 'bad-path', why: bad.map(([p, why]) => `${p}: ${why}`).join('; ') }] : [];
  const turn: HumanTurn = { uuid: '', sessionId: '', ts: '', index: 0, text: feedbackText, precedingAssistantText: '', precedingToolCalls: [] };
  const checked = checkLesson({ ...lesson, paths: lesson.paths.filter((p) => !junkPathReason(p)) }, turn);
  return [
    ...flags,
    ...checked.flags.map((f) =>
      f.name === 'universal-from-nit' ? { ...f, why: `a ${lesson.scope}-wide rule from one minor comment; consider narrowing it to the task` }
      : f.name === 'broken-rule' ? { ...f, why: `the rule field holds "${lesson.rule.trim()}"; the title reads like the rule` }
      : f,
    ),
  ];
}
