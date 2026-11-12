// Browser-safe: no node imports (the UI shows and edits triggers).
import { cleanLessonPath, pathMatches } from './codegraph.ts';
import { isSecretPath } from './secrets.ts';
import { compileLinear, globWildcards, LinearMatcher, type MatchBudget } from './linearMatch.ts';
import type { Lesson, LessonTriggers } from './types.ts';

/**
 * A lesson's triggers (LessonTriggers): what in a later change shows it applies, beside its embedding. The embedding
 * of a task title ranks the lesson a change needs about 14th of 40 (0.7.6 value sweep): a rule about "every query or
 * index change" is not close in words to "add departure columns to graph_edge". A trigger says it in the change's own
 * terms (a kind of file, a line the diff adds, a name it uses), taken from the lesson's words and the code its feedback
 * quoted, and kept only when it matches the miss it was learned from and is not an everyday word.
 */

export type TriggerKind = 'path' | 'pattern' | 'symbol';

/** At most this many of each kind, each at most MAX_TRIGGER_CHARS long. */
export const MAX_TRIGGERS = 8;
export const MAX_TRIGGER_CHARS = 200;
/**
 * A path glob matching more than this share of a repository's files names no kind of file (`**\/*.ts` in a TypeScript
 * repository): it would serve the lesson to most changes. Judged only with the repository's file list at hand.
 */
export const PATH_SHARE_MAX = 0.2;
/** A repository this small cannot tell a broad glob from a narrow one by share. */
const PATH_SHARE_MIN_FILES = 50;
/** Added lines are matched up to this many characters (a minified line is not read whole). */
const MAX_LINE_CHARS = 2000;
export const MAX_ADDED_LINES = 50_000;
const MIN_SYMBOL_CHARS = 4;

/**
 * The version of the rules deriveTriggers follows, stored with the triggers it derived. Raise it when they change: the
 * worker derives the triggers of every lesson derived by an older version again (never the owner's).
 * 1: before it was stored. 2: only the lesson's own paths, the files its fix edited and the code-shaped names of its rule
 * (never the post-mortem's context items, the feedback's quotes or the files of a review it was not on); no glob for a
 * kind of file anywhere (broadGlob) unless the rule says it of every such file; `/**` only on a folder the repository
 * has; no pattern from an example snippet.
 */
export const TRIGGER_DERIVATION_VERSION = 2;

export const emptyTriggers = (): LessonTriggers => ({ paths: [], patterns: [], symbols: [] });
export const hasTriggers = (t: LessonTriggers | null | undefined): t is LessonTriggers => !!t && t.paths.length + t.patterns.length + t.symbols.length > 0;

/**
 * Words too common in code and in prose to show anything applies: a pattern or symbol that is (or matches) one of
 * them is not a trigger. Kinds of thing every change has (query, index, test, error, config), not names.
 */
const COMMON_WORDS = (
  'a an and are as at be by do for from if in is it of on or the this that to with not no all any each every new old ' +
  'add added change changed changes code file files line lines data value values type types name names user users ' +
  'query queries index indexes test tests error errors config configs setting settings request response client server ' +
  'model models table tables column columns field fields key keys id ids log logs message messages event events ' +
  'handler service services api route routes schema check update create delete remove get set list map item items ' +
  'string number boolean object array class function method module package import export return const let var def ' +
  'func async await true false null none self this new main app run build deploy docs doc readme comment comments ' +
  'feature task fix bug issue pr review time date count size limit page result results state store cache path url ' +
  'org org_id team project projects env default version status option options flag flags'
).split(/\s+/);
const COMMON = new Set(COMMON_WORDS);

/**
 * Lines every change has: a pattern that matches one of them (or a common word, or an empty line) would fire on
 * almost any diff.
 */
const ORDINARY_LINES = [
  ...COMMON_WORDS,
  'import { useState } from "react";', "import x from './y';", 'return null;', 'const value = await fetch(url);', 'export default function App() {',
  '}', '  });', 'def handler(self, request):', 'func (s *Server) Run(ctx context.Context) error {', 'if err != nil {', '\treturn err',
  '  name: app', '# a comment', '// a comment', 'package main', 'from typing import Any', '<div className="row">', 'console.log(error);',
  'logger.info("done")', 'expect(result).toBe(true);', 'it("works", async () => {', 'describe("thing", () => {', 'for i in range(10):',
  '"version": "1.0.0",', '- item', '| a | b |',
];

/**
 * A pattern as matched: case-insensitive, in time linear in the line (linearMatch.ts). Null when it is not a regular
 * expression, or uses what the linear matcher does not run (lookaround, a backreference): such a pattern never fires.
 */
export function compilePattern(src: string): LinearMatcher | null {
  const m = compileLinear(src);
  return m instanceof LinearMatcher ? m : null;
}

/** A path glob's wildcards at most (after runs are merged): each one more a path is tried against. */
export const MAX_GLOB_WILDCARDS = 6;
/**
 * The matching work one change may cost all lessons' patterns together (linearMatch.ts MatchBudget: about one unit a
 * character): a few seconds at worst. Every pattern is linear, but 50,000 added lines times hundreds of lessons is not
 * small; past it the remaining patterns do not fire.
 */
export const MATCH_BUDGET = 200_000_000;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const symbolCache = new Map<string, RegExp>();
/** A symbol as a whole token: not inside a longer name (`to_thread` is not in `to_threads`). Case-sensitive. */
function symbolRe(sym: string): RegExp {
  let re = symbolCache.get(sym);
  if (!re) {
    re = new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(sym)}(?![A-Za-z0-9_$])`);
    if (symbolCache.size > 5000) symbolCache.clear();
    symbolCache.set(sym, re);
  }
  return re;
}

/**
 * Why a trigger cannot stand as written, by its shape alone (what the owner's edit is held to): too long, a pattern
 * that does not compile or matches an empty line, a symbol with spaces, a path outside the repository. Null: it can.
 */
export function triggerShapeProblem(kind: TriggerKind, raw: string): string | null {
  const v = raw.trim();
  if (!v) return 'empty';
  if (v.length > MAX_TRIGGER_CHARS) return `longer than ${MAX_TRIGGER_CHARS} characters`;
  if (kind === 'path') {
    if (!cleanLessonPath(v) || v.includes('://')) return 'not a repository path or glob';
    return globWildcards(v) > MAX_GLOB_WILDCARDS ? `more than ${MAX_GLOB_WILDCARDS} wildcards` : null;
  }
  if (kind === 'symbol') return /\s/.test(v) ? 'a symbol is one name, not a phrase' : null;
  const re = compileLinear(v);
  if (!re) return 'not a valid regular expression';
  if (!(re instanceof LinearMatcher)) return `not supported in a trigger (${re.message}): triggers are matched in linear time`;
  return re.test('') ? 'it matches an empty line, so every change' : null;
}

/** The triggers whose shape stands (triggerShapeProblem), trimmed: what leaves the install or is read from a bundle. */
export function shapedTriggers(t: LessonTriggers): LessonTriggers {
  const out = emptyTriggers();
  for (const [kind, key] of KINDS) out[key] = t[key].map((v) => v.trim()).filter((v) => !triggerShapeProblem(kind, v));
  return out;
}

/**
 * A token shaped like code rather than prose: snake_case, a dotted.name, camelCase, a CONSTANT or SQL KEYWORD, a --flag,
 * a call(, a $var or ${var}, a path/part, a kebab-case-key of three parts. A trigger with none ("Exports", "enabled",
 * ".*log.*response.*body", "count query", "6017") is a word or a phrase from the feedback, and fires on any line that
 * happens to say it.
 */
const CODE_TOKEN = /[A-Za-z0-9]_[A-Za-z0-9]|[A-Za-z0-9]\.[A-Za-z_$]|[a-z][A-Z]|\b[A-Z][A-Z0-9]{2,}\b|(?:^|[\s(])--?[A-Za-z]|\w\(|\$\{?\w|\w\/\w|\w-\w+-\w/;
/** A pattern's literal text: its character classes and repetitions taken out, its escapes undone. */
const literalOf = (pattern: string) => pattern.replace(/\\[sSdDwWbB]/g, ' ').replace(/\\(.)/g, '$1').replace(/\.[*+?]|[*+?]/g, ' ');

/**
 * A glob for a kind of file anywhere rather than a place: repo-wide (`**\/*.sql`, `**\/migrations/**`) or with no
 * folder (`*.sql`). It fires on every such change in the repository (an audit found one on 17 of 65 lessons).
 */
export const broadGlob = (raw: string) => {
  const v = raw.trim();
  return v.startsWith('**/') || (!v.includes('/') && /[*?[{]/.test(v));
};

/** The path triggers that are broad globs (broadGlob): flagged for the owner (broad-trigger). */
export const broadTriggerPaths = (t: LessonTriggers | null | undefined) => (t?.paths ?? []).filter(broadGlob);

/**
 * Why a trigger names nothing specific (an everyday word, a glob for every file or for a kind of file anywhere,
 * ordinary code), or null. broad: a broad glob (broadGlob) is allowed, because the lesson says it of every such file.
 */
export function genericTrigger(kind: TriggerKind, raw: string, repoFiles?: string[] | null, o: { broad?: boolean } = {}): string | null {
  const v = raw.trim();
  const shape = triggerShapeProblem(kind, v);
  if (shape) return shape;
  if (kind === 'symbol') {
    if (v.replace(/[^A-Za-z0-9]/g, '').length < MIN_SYMBOL_CHARS) return 'too short to be a name';
    if (COMMON.has(v.toLowerCase())) return 'an everyday word, not a name';
    // An acronym (JSON, YAML, AUTH) is a word in capitals, in prose and code alike.
    if (/^[A-Z]{2,4}$/.test(v)) return 'an acronym, not a name';
    return CODE_TOKEN.test(v) ? null : 'a word, not a name from the code';
  }
  if (kind === 'pattern') {
    const re = compilePattern(v)!;
    const hit = ORDINARY_LINES.find((line) => re.test(line));
    if (hit !== undefined) return `it matches ordinary code ("${hit}")`;
    return CODE_TOKEN.test(literalOf(v)) ? null : 'only words, no name from the code';
  }
  if (/^[*?/.]*$/.test(v.replace(/\*\*\//g, ''))) return 'a glob for every file';
  if (repoFiles && repoFiles.length >= PATH_SHARE_MIN_FILES) {
    const share = repoFiles.filter((f) => pathMatches(v, f)).length / repoFiles.length;
    if (share > PATH_SHARE_MAX) return `it matches ${Math.round(share * 100)}% of the repository's files`;
  }
  if (!o.broad && broadGlob(v)) return 'a kind of file anywhere in the repository, not a place: anchor it in a folder';
  return null;
}

/** The miss a lesson was learned from, as triggers are checked against it. */
export type TriggerEvidence = {
  /** Its files: the comment's file, the session's edits, the repository files its text names, the lesson's paths. */
  files: string[];
  /** Its text: the feedback (with the code it quotes), what was done, the diff lines, the excerpts the post-mortem cited. */
  text: string;
  /** The repository's files, to judge how broad a glob is; unset or null: by shape only. */
  repoFiles?: string[] | null;
};

export type DroppedTrigger = { kind: TriggerKind; value: string; why: string };

const KINDS: [TriggerKind, keyof LessonTriggers][] = [['path', 'paths'], ['pattern', 'patterns'], ['symbol', 'symbols']];
const lines = (text: string) => text.split('\n').map((l) => l.slice(0, MAX_LINE_CHARS));

/**
 * The proposed triggers that stand: each specific (genericTrigger) and matching the miss it was learned from, a path
 * glob one of its files, a pattern a line of its text, a symbol a token of it. A trigger its own miss would not fire
 * on would not fire on the next one either. What was dropped says why, for the log.
 */
export function validateTriggers(proposed: Partial<LessonTriggers> | null | undefined, ev: TriggerEvidence): { triggers: LessonTriggers; dropped: DroppedTrigger[] } {
  const out = emptyTriggers();
  const dropped: DroppedTrigger[] = [];
  const text = lines(ev.text);
  for (const [kind, key] of KINDS) {
    for (const raw of proposed?.[key] ?? []) {
      if (typeof raw !== 'string') continue;
      let v = kind === 'path' ? (cleanLessonPath(raw.trim()) ?? raw.trim()).replace(/\/+$/, '') : raw.trim();
      // A model often writes a pattern as the code itself ("MESSAGES[reason]"): read as a regular expression it would not
      // match that code, so a pattern the miss holds only as written is kept as that literal text.
      if (kind === 'pattern' && !text.some((l) => compilePattern(v)?.test(l)) && text.some((l) => l.includes(v))) v = escapeRe(v);
      if (!v || out[key].includes(v)) continue;
      const why = genericTrigger(kind, v, ev.repoFiles)
        ?? (out[key].length >= MAX_TRIGGERS ? `more than ${MAX_TRIGGERS}` : null)
        ?? (kind === 'path'
          // A secret file is never part of a change's view (its name is not sent to the judge): a glob only it matches never fires.
          ? (ev.files.some((f) => !isSecretPath(f) && pathMatches(v, f)) ? null : 'matches none of the files of the miss')
          : kind === 'pattern'
            ? (text.some((l) => compilePattern(v)!.test(l)) ? null : 'matches no line of the miss')
            : (symbolRe(v).test(ev.text) ? null : 'not named in the miss'));
      if (why) dropped.push({ kind, value: v, why });
      else out[key].push(v);
    }
  }
  return { triggers: out, dropped };
}

/**
 * Kinds of file a rule or its feedback names in words, and the globs they are. General terms of the trade, not one
 * repository's layout; a word inside a path ("docs/qa", "capture-manifest") is not the word.
 */
export const FILE_KINDS: { says: RegExp; globs: string[] }[] = [
  { says: /\bSQL\b|\.sql\b/, globs: ['**/*.sql'] },
  { says: /\bmigrations?\b/i, globs: ['**/migrations/**'] },
  { says: /\bDockerfiles?\b/i, globs: ['**/Dockerfile*'] },
  { says: /\bTerraform\b|\.tf\b/i, globs: ['**/*.tf'] },
  { says: /\b(?:Kubernetes|k8s|manifests?|Helm)\b/i, globs: ['**/*.yaml', '**/*.yml'] },
  { says: /\bGitHub (?:Actions|workflows?)\b|\.github\/workflows\b/i, globs: ['.github/workflows/**'] },
  // Not "documentation" or "documenting": they name what is written (docstrings, tool descriptions) as often as files.
  { says: /\b(?:docs?|README|markdown)\b/i, globs: ['**/*.md'] },
  { says: /\bprotobuf\b|\.proto\b/i, globs: ['**/*.proto'] },
  { says: /\bshell scripts?\b/i, globs: ['**/*.sh'] },
  { says: /_test\.go\b/, globs: ['**/*_test.go'] },
];
/** A word as a word: not inside a path, a file name or a kebab-case name. */
const asWord = (re: RegExp) => new RegExp(`(?<![\\w/.-])(?:${re.source})(?![\\w/-])`, re.flags);

/** A name in prose or code: dotted, slashed or kebab parts, maybe a call. */
const NAME = /(?:^|[^\w$.\/-])(--?[a-z][\w-]*|[A-Za-z_$][\w$]*(?:[.\-/:][A-Za-z_$][\w$]*)*)(\()?/g;
/** A file name or path (it has an extension): what path triggers are for. */
const FILE_LIKE = /\.[a-z]{1,5}$/i;
/**
 * A name outside backticks that only code writes: a call, camelCase from a lowercase start, snake_case or a
 * CONSTANT_NAME, a dotted member, a --flag or a $var. A capitalised or all-caps word (GitHub, TypeScript, PostgreSQL,
 * EXPLAIN, FIXME) is as often a product, a proper name or a word in capitals, and fires on any line that mentions it.
 */
const CODE_SHAPED = /^[a-z][a-z0-9]*[A-Z][a-z]|[A-Za-z0-9]_[A-Za-z0-9]|[\w$]\.[A-Za-z_$]|^--?[a-z]|^\$/;

export type DeriveInput = {
  /** The lesson's own words: its rule and when it applies. */
  rule: string;
  appliesWhen: string;
  /**
   * The lesson's own files: its paths, the file of the comment it came from and the files its fix edited. Never the
   * post-mortem's context items, nor the files of a review the comment was not on.
   */
  files: string[];
  /** The repository's files: a glob matching more than PATH_SHARE_MAX of them is no trigger, and a folder is one of them. Null: not judged, and no folder is widened. */
  repoFiles?: string[] | null;
};

/** An example in a rule ("(e.g. ...)", a fenced block, a backticked phrase): what a change might look like, not a name it will use. */
const withoutExamples = (rule: string) => rule
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`([^`\n]*)`/g, (span, inner: string) => (/\s/.test(inner.trim()) ? ' ' : span))
  .replace(/\((?:e\.g\.|i\.e\.|for example|for instance|such as|like)(?:[^()]|\([^()]*\))*\)/gi, ' ');

/** The kinds of file the rule says it of every such file of ("every SQL change", "each Dockerfile"): their globs may be broad. */
const everyOf = (k: (typeof FILE_KINDS)[number], rule: string) =>
  new RegExp(`\\b(?:[Ee]very|[Aa]ll|[Aa]ny|[Ee]ach)\\s+(?:[\\w./-]+\\s+){0,3}?${asWord(k.says).source}`, k.says.flags).test(rule);

/**
 * Triggers worked out with no model, from the lesson alone: its files widened to their folder and extension
 * (`api/orders.ts` gives `api/*.ts`; a file with no extension is itself; a folder the repository has gives `folder/**`);
 * the kinds of file the rule says it of every such file of (FILE_KINDS: broad globs, flagged for the owner as
 * broad-trigger); and the names shaped like code the rule uses outside its examples (a backticked name; else CODE_SHAPED
 * names and calls). Each is held to genericTrigger; the model's proposals only add to these (mergeTriggers).
 */
export function deriveTriggers(o: DeriveInput): LessonTriggers {
  const out = emptyTriggers();
  const add = (kind: TriggerKind, key: keyof LessonTriggers, v: string, broad = false) => {
    // `[REDACTED]` is where redaction took a value out, not a name the next change will use.
    if (kind !== 'path' && v.includes('REDACTED')) return;
    if (out[key].length < MAX_TRIGGERS && !out[key].includes(v) && !genericTrigger(kind, v, o.repoFiles, { broad })) out[key].push(v);
  };
  for (const f of o.files) {
    const clean = cleanLessonPath(f)?.replace(/\/+$/, '');
    // A secret file's folder and extension (`config/*.env`) would only ever fire on secret files.
    if (!clean || isSecretPath(clean)) continue;
    const parts = clean.split('/');
    const dir = parts.slice(0, -1).join('/');
    const ext = /\.([A-Za-z0-9]{1,6})$/.exec(clean)?.[1];
    const folder = !!o.repoFiles?.some((x) => x.startsWith(`${clean}/`));
    if (ext && dir) add('path', 'paths', `${dir}/*.${ext}`);
    // A folder of one or two parts is a service's root in a monorepo, not the area the miss was in.
    else if (folder) { if (parts.length >= 3) add('path', 'paths', `${clean}/**`); }
    // A file with no extension (a Dockerfile, a Makefile) in a folder: that file.
    else if (!ext && dir && o.repoFiles?.includes(clean)) add('path', 'paths', clean);
  }
  for (const k of FILE_KINDS) if (everyOf(k, o.rule)) for (const g of k.globs) add('path', 'paths', g, true);
  const rule = withoutExamples(o.rule);
  for (const [, span] of rule.matchAll(/`([^`\s]{3,80})`/g)) if (!FILE_LIKE.test(span)) add('symbol', 'symbols', span);
  for (const [, name, call] of rule.matchAll(NAME)) {
    const v = name.replace(/[.:/-]+$/, '');
    if (v.includes('/') || FILE_LIKE.test(v) || !(call || CODE_SHAPED.test(v))) continue;
    add('symbol', 'symbols', v);
  }
  return out;
}

/** The derived triggers, then the model's (each already checked), once each and at most MAX_TRIGGERS of a kind. */
export function mergeTriggers(first: LessonTriggers, then: LessonTriggers): LessonTriggers {
  const out = emptyTriggers();
  for (const [, key] of KINDS) out[key] = [...new Set([...first[key], ...then[key]])].slice(0, MAX_TRIGGERS);
  return out;
}

/** One added line of a diff and the file it is in. */
export type AddedLine = { path: string; text: string };

/** The lines a unified diff adds, each with its file (from `diff --git` and `+++` headers). */
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let path = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      path = / b\/(.+)$/.exec(line)?.[1] ?? '';
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p !== '/dev/null') path = p.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('+') && out.length < MAX_ADDED_LINES) out.push({ path, text: line.slice(1, 1 + MAX_LINE_CHARS) });
  }
  return out;
}

/** The files a unified diff changes (its `diff --git` and `+++` headers), once each. */
export function diffFiles(diff: string): string[] {
  const out = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/\S+ b\/(\S+)$|^\+\+\+ b\/(\S+)$/gm)) out.add(m[1] ?? m[2]);
  return [...out];
}

/** What a change offers its triggers: the files named or changed, the lines its diff adds, the task's own words. */
export type ChangeView = { files: string[]; added?: AddedLine[]; text?: string };

/** The trigger that fired and where: a file, an added line's file, or the task (on: null). */
export type TriggerHit = { kind: TriggerKind; trigger: string; on: string | null };

/**
 * The first of the triggers that fires on the change: a path glob on a named or changed file, then a pattern or symbol
 * on an added line, then on the task's words. Null: none does (or there are none).
 */
export function matchTriggers(t: LessonTriggers | null | undefined, c: ChangeView, budget: MatchBudget = { left: MATCH_BUDGET }): TriggerHit | null {
  if (!hasTriggers(t)) return null;
  for (const p of t.paths) {
    const f = c.files.find((x) => pathMatches(p, x));
    if (f) return { kind: 'path', trigger: p, on: f };
  }
  // A symbol is an escaped literal between lookarounds: linear in V8 as it is.
  type Test = { test: (s: string, b?: MatchBudget) => boolean };
  const tests: [TriggerKind, string, Test | null][] = [
    ...t.patterns.map((p): [TriggerKind, string, Test | null] => ['pattern', p, compilePattern(p)]),
    ...t.symbols.map((s): [TriggerKind, string, Test | null] => ['symbol', s, symbolRe(s)]),
  ];
  for (const [kind, trigger, re] of tests) {
    const line = re && c.added?.find((l) => re.test(l.text, budget));
    if (line) return { kind, trigger, on: line.path || '(a file the diff does not name)' };
  }
  // The task's words are prose: a pattern (case-insensitive) or a word-like name there is a word they share with the
  // lesson, not the change using it. Only a name shaped like code (CODE_SHAPED, or with a camelCase hump: FlushBatch) fires on them.
  const words = c.text ?? '';
  const codeName = (s: string) => CODE_SHAPED.test(s) || /[a-z][A-Z]/.test(s);
  for (const [kind, trigger, re] of tests) if (kind === 'symbol' && codeName(trigger) && re && words && re.test(words, budget)) return { kind, trigger, on: null };
  return null;
}

/** "why served" for an agent: which trigger fired, and on what. */
export function triggerWhy(h: TriggerHit): string {
  const t = `trigger ${h.kind} \`${h.trigger.replace(/`/g, "'")}\``;
  if (h.kind === 'path') return `${t} matched ${h.on}`;
  return h.on === null ? `${t} is in the task` : `${t} matched an added line in ${h.on}`;
}

/** The lessons whose triggers fire on the change, each with its hit, in the order given. */
export function triggered<T extends { lesson: Pick<Lesson, 'triggers'> }>(items: T[], c: ChangeView, budget: MatchBudget = { left: MATCH_BUDGET }): (T & { trigger: TriggerHit })[] {
  return items.flatMap((x) => {
    const hit = matchTriggers(x.lesson.triggers, c, budget);
    return hit ? [{ ...x, trigger: hit }] : [];
  });
}

/**
 * How specific a hit is: 0, a name or line the change uses; 1, a glob anchored in a folder; 2, a kind of file anywhere
 * (`**\/*.sql`), which fires on every change of that kind.
 */
export const hitRank = (h: TriggerHit) => (h.kind !== 'path' ? 0 : h.trigger.startsWith('**/') ? 2 : 1);
/** Of the lessons served by a kind of file alone, at most this many: on the dev set they were right one time in four. */
export const KIND_ONLY_K = 3;

/** The fired lessons to serve, most specific hit first (stable), at most `k`, of them at most KIND_ONLY_K by a kind of file. */
export function servedTriggered<T extends { trigger: TriggerHit }>(fired: T[], k: number): T[] {
  let kinds = 0;
  return [...fired].sort((a, b) => hitRank(a.trigger) - hitRank(b.trigger)).filter((x) => hitRank(x.trigger) < 2 || ++kinds <= KIND_ONLY_K).slice(0, k);
}
