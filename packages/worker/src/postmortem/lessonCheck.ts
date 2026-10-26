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
export const SCOPE_WORDS = new Set(['task', 'project', 'global', 'context_missing', 'context_available_ignored', 'code_not_read', 'requirement_unstated', 'verification_gap', 'implementation_error']);
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

export const imperative = (s: string) => IMPERATIVE_LEAD.test(s) || IMPERATIVE_WORD.test(s);

/** The rule says how the code is rather than what to do (it may belong in the project facts). */
export function statesAFact(rule: string): boolean {
  const aware = AWARE.exec(rule);
  const core = aware ? aware[1] : rule;
  if (imperative(core)) return false;
  return !!aware || DECLARATIVE.test(core);
}
/**
 * The words of a rule that name nothing in particular: process verbs ("check", "verify", "follow", "consult"), their
 * objects ("patterns", "feedback", "edge cases", "the full sequence") and fillers. Stems (see stem()).
 */
const PROCESS_VERBS = new Set([
  'check', 'verify', 'validate', 'ensure', 'confirm', 'test', 'review', 'consult', 'follow', 'consider', 'prioritize', 'prioritise',
  'treat', 'apply', 'profile', 'look', 'search', 'read', 'understand', 'analyze', 'analyse', 'investigate', 'double-check', 'cross-reference',
  'maintain', 'monitor', 'make', 'be', 'pay', 'respect', 'adhere', 'honor', 'honour', 'think', 'plan', 'document', 'communicate', 'ask',
  'clarify', 'implement', 'handle', 'address', 'incorporate', 'assess', 'evaluate', 'inspect', 'examine', 'audit', 'keep', 'use', 'avoid',
  'mark', 'run', 'write', 'add', 'update', 'reuse', 'align', 'match', 'mirror', 'stick', 'compare',
]);
const GENERIC_WORDS = new Set([
  ...PROCESS_VERBS,
  'always', 'never', 'sure', 'careful', 'carefully', 'thorough', 'thoroughly', 'properly', 'correctly', 'fully', 'explicitly', 'explicit',
  'mandatory', 'required', 'requirement', 'existing', 'exist', 'new', 'full', 'entire', 'complete', 'all', 'any', 'every', 'each', 'other',
  'relevant', 'related', 'similar', 'appropriate', 'necessary', 'possible', 'potential', 'important', 'common', 'general', 'specific',
  'pattern', 'convention', 'standard', 'guideline', 'practice', 'best', 'approach', 'consistency', 'consistent', 'quality', 'style', 'stylistic',
  'formatting', 'feedback', 'comment', 'pr', 'prs', 'pull', 'request', 'reviewer', 'nit', 'nitpick', 'suggestion', 'instruction', 'doc',
  'docs', 'documentation', 'code', 'codebase', 'change', 'functionality', 'feature', 'task', 'work', 'project', 'repo', 'repository', 'file',
  'edge', 'case', 'scenario', 'concurrency', 'performance', 'security', 'error', 'issue', 'problem', 'bug', 'behavior', 'behaviour', 'logic',
  'flow', 'process', 'step', 'sequence', 'detail', 'context', 'user', 'developer', 'team', 'expectation', 'intent', 'scope', 'impact', 'side',
  'effect', 'result', 'output', 'input', 'assumption', 'decision', 'rule', 'lesson', 'thing', 'way', 'part', 'when', 'before', 'after',
  'during', 'complete', 'completion', 'done', 'finished', 'final', 'time', 'first', 'again', 'also', 'correct', 'correctness', 'accurate',
  'accuracy', 'attention', 'mind', 'aware', 'account', 'priority', 'blocking', 'non-blocking', 'minor', 'major', 'critical',
]);
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'from', 'into', 'onto', 'as', 'and', 'or', 'but', 'is', 'are',
  'be', 'it', 'its', 'this', 'that', 'these', 'those', 'than', 'then', 'there', 'so', 'if', 'not', 'no', 'do', 'don', 't', 'does', 'must',
  'should', 'can', 'could', 'will', 'would', 'may', 'might', 'need', 'needs', 'have', 'has', 'what', 'which', 'who', 'how', 'why', 'where',
  'what', 'them', 'they', 'their', 'you', 'your', 'we', 'our', 'any', 'even', 'only', 'just', 'too', 'very', 'more', 'most', 'less',
]);
/** Acronyms that name a kind of thing, not a thing. */
const GENERIC_ACRONYMS = new Set(['PR', 'PRS', 'MR', 'CI', 'QA', 'UI', 'UX', 'TODO', 'LGTM', 'API']);

/** A word reduced for the vocabulary: lower case, no plural, no -ing/-ed. */
function stem(word: string): string {
  const w = word.toLowerCase();
  if (GENERIC_WORDS.has(w) || STOP_WORDS.has(w)) return w;
  for (const [end, by] of [['ies', 'y'], ['ing', ''], ['ed', ''], ['es', ''], ['s', '']] as const) {
    if (w.length > end.length + 3 && w.endsWith(end)) {
      const s = w.slice(0, -end.length) + by;
      if (GENERIC_WORDS.has(s) || GENERIC_WORDS.has(`${s}e`)) return GENERIC_WORDS.has(s) ? s : `${s}e`;
    }
  }
  return w;
}

/** A token that names something: a path, a file, a dotted, snake or camel name, a call, a flag, a number, a CONSTANT. */
function concrete(token: string): boolean {
  if (/[/`]|\w\.\w|\w_\w|\b[a-z]+[A-Z]|\w\(\)|^--?\w|\d/.test(token)) return true;
  return /^[A-Z][A-Z0-9_]+$/.test(token) && !GENERIC_ACRONYMS.has(token);
}

const tokens = (text: string) => text.split(/[\s,;:()"']+/).map((t) => t.replace(/^[.!?]+|[.!?]+$/g, '')).filter(Boolean);

/**
 * generic: the rule names no file, symbol, API, value, command or behaviour of its own, only process verbs and their
 * objects ("check for existing patterns", "test concurrency edge cases", "verify the full sequence"). A future agent
 * cannot check a change against it.
 */
export function isGeneric(rule: string): boolean {
  const words = tokens(rule);
  if (!words.length || words.some(concrete)) return false;
  const content = words.map(stem).filter((w) => !STOP_WORDS.has(w));
  const specific = content.filter((w) => !GENERIC_WORDS.has(w));
  return specific.length < 2 && content.some((w) => PROCESS_VERBS.has(w));
}

/** A file a clause names: a path with a folder, or a name with an extension. */
const FILE = /^[\w.@-]*\/[\w./*@-]+$|^[\w-]+\.[a-z]{1,5}$/;
const CLAUSE_LEAD = new RegExp(`^(?:(?:never|always|do not|don'?t)\\s+\\w+|(?:${DO})\\b)`, 'i');
const ALSO = /^(?:also|additionally|separately|in addition|and also)\b,?\s*/i;

/**
 * bundled: two independent instructions in one rule, about different files or subjects ("X in a.ts; also Y in b.go"):
 * two misses, so the owner can split them. Only clauses that start with a verb count; two about different files, or a
 * second one starting with "also" about different names.
 */
export function bundledClauses(rule: string): [string, string] | null {
  const clauses = rule.split(/;\s+|\.\s+(?=[A-Z])/).map((c) => c.trim().replace(/[.]+$/, '')).filter(Boolean);
  const parts = clauses
    .map((c) => {
      const also = ALSO.test(c);
      const body = c.replace(ALSO, '');
      const toks = tokens(body);
      return { text: c, also, imperative: CLAUSE_LEAD.test(body), files: new Set(toks.filter((t) => FILE.test(t))), names: new Set(toks.filter(concrete)) };
    })
    .filter((p) => p.imperative);
  const disjoint = (a: Set<string>, b: Set<string>) => a.size > 0 && b.size > 0 && ![...a].some((x) => b.has(x));
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const [a, b] = [parts[i], parts[j]];
      if (disjoint(a.files, b.files) || (b.also && disjoint(a.names, b.names))) return [a.text, b.text];
    }
  }
  return null;
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
  // generic says more than platitude (which only reads the "Always verify ..." shape), so it stands in for it.
  if (isGeneric(lesson.rule)) flags.push({ name: 'generic', why: 'names no file, function, value or command, only what to do in general: say what to check, where' });
  else if ((PLATITUDE.test(lesson.title) || PLATITUDE.test(lesson.rule)) && !IDENTIFIER.test(lesson.rule)) flags.push({ name: 'platitude', why: 'a general rule that names nothing in the code; say what to check, where' });
  const bundled = bundledClauses(lesson.rule);
  if (bundled) flags.push({ name: 'bundled', why: `two separate instructions in one rule ("${bundled[0]}" and "${bundled[1]}"): split it into two lessons` });
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
