// Browser-safe: no node imports (lessonTriggers.ts uses it, and the UI imports that).

/**
 * Lesson-trigger patterns and path globs matched in time linear in the text, whatever the pattern: a lesson's
 * triggers run synchronously in the api on every get_task_context and check_before_done, and a backtracking engine
 * (V8's) takes exponential or polynomial time on shapes such as `((\w)+)+X`, `\w*\w*\w*X`, `(SELECT|select)+\s`,
 * `.*log.*response.*body` or `src/*a*a*a*b` (sweep 4, S1). Patterns are a subset of JavaScript regular expressions
 * (characters, escapes, classes, `.`, groups, `|`, `? * + {m,n}`, `^ $ \b \B`; no lookaround or backreference),
 * compiled to a Thompson NFA and run as a lazily built, bounded DFA (the RE2 approach): one step per character.
 */

type CharTest = (c: number) => boolean;
type Node =
  | { t: 'char'; test: CharTest; lit?: string }
  | { t: 'cat'; xs: Node[] }
  | { t: 'alt'; xs: Node[] }
  | { t: 'rep'; x: Node; min: number; max: number }
  | { t: 'assert'; k: Assert };
type Assert = 'bol' | 'eol' | 'wb' | 'nwb';

/** Why a pattern is outside the subset this matcher runs (a valid JavaScript regular expression may still be). */
export class UnsupportedPattern extends Error {}

/** NFA states at most: a counted repeat is expanded into copies, so `(a{50}){50}` is refused rather than built. */
const MAX_STATES = 2000;
/** DFA states kept per pattern; past it the cache starts over (memory stays bounded, matching stays linear). */
const MAX_DSTATES = 1000;

const isWordCode = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isSpaceCode = (c: number) =>
  c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
const isLineEnd = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
const anyChar: CharTest = (c) => !isLineEnd(c);

/** The case variants of a character a case-insensitive match accepts. */
function caseVariants(c: number): number[] {
  const s = String.fromCharCode(c);
  const out = new Set([c]);
  for (const v of [s.toUpperCase(), s.toLowerCase()]) {
    // As JavaScript's non-unicode `i`: a single character, and never a non-ASCII one folding into ASCII.
    if (v.length === 1 && !(c >= 128 && v.charCodeAt(0) < 128)) out.add(v.charCodeAt(0));
  }
  return [...out];
}
const folded = (test: CharTest): CharTest => (c) => caseVariants(c).some(test);

/** A pattern's syntax tree, or UnsupportedPattern. Assumes it is a valid JavaScript regular expression. */
function parseRegex(src: string, ignoreCase: boolean): Node {
  let i = 0;
  const lit = (ch: string): Node => {
    const c = ch.charCodeAt(0);
    const vs = ignoreCase ? caseVariants(c) : [c];
    return { t: 'char', test: (x) => vs.includes(x), lit: ch };
  };
  const classEscape = (e: string): CharTest | null => {
    switch (e) {
      case 'd': return (c) => c >= 48 && c <= 57;
      case 'D': return (c) => !(c >= 48 && c <= 57);
      case 'w': return isWordCode;
      case 'W': return (c) => !isWordCode(c);
      case 's': return isSpaceCode;
      case 'S': return (c) => !isSpaceCode(c);
      default: return null;
    }
  };
  /** A single escaped character (after the backslash), as its code. */
  const escapedChar = (inClass: boolean): number => {
    const e = src[i++];
    if (e === undefined) throw new UnsupportedPattern('ends in a backslash');
    if (/[1-9]/.test(e) && !inClass) throw new UnsupportedPattern('a backreference');
    // JavaScript reads `\01`, `[\1]` and `[\8]` as legacy octal escapes or digits, by rules this matcher does not keep.
    if ((e === '0' && /[0-9]/.test(src[i] ?? '')) || /[1-9]/.test(e)) throw new UnsupportedPattern('a legacy octal escape');
    if (e === 'k' && src[i] === '<') throw new UnsupportedPattern('a backreference');
    if (e === 'c' || e === 'p' || e === 'P') throw new UnsupportedPattern(`\\${e}`);
    const hex = (n: number) => {
      const h = src.slice(i, i + n);
      if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(h)) return null;
      i += n;
      return parseInt(h, 16);
    };
    switch (e) {
      case 'n': return 10;
      case 'r': return 13;
      case 't': return 9;
      case 'v': return 11;
      case 'f': return 12;
      case '0': return 0;
      case 'b': return 8; // only reached in a class: a backspace there
      case 'x': return hex(2) ?? 'x'.charCodeAt(0);
      case 'u': return hex(4) ?? 'u'.charCodeAt(0);
      default: return e.charCodeAt(0);
    }
  };
  const parseClass = (): Node => {
    const neg = src[i] === '^';
    if (neg) i++;
    const parts: CharTest[] = [];
    while (i < src.length && src[i] !== ']') {
      let lo: number;
      if (src[i] === '\\') {
        i++;
        const cls = classEscape(src[i]);
        if (cls) {
          i++;
          parts.push(cls);
          continue;
        }
        lo = escapedChar(true);
      } else lo = src.charCodeAt(i++);
      if (src[i] === '-' && src[i + 1] !== undefined && src[i + 1] !== ']') {
        i++;
        let hi: number;
        if (src[i] === '\\') {
          i++;
          if (classEscape(src[i])) {
            // `[a-\d]`: the dash is a character (non-unicode JavaScript).
            const cls = classEscape(src[i++])!;
            parts.push((c) => c === lo || c === 45, cls);
            continue;
          }
          hi = escapedChar(true);
        } else hi = src.charCodeAt(i++);
        const l = lo;
        parts.push((c) => c >= l && c <= hi);
      } else {
        const l = lo;
        parts.push((c) => c === l);
      }
    }
    if (src[i] !== ']') throw new UnsupportedPattern('an unclosed class');
    i++;
    const any: CharTest = (c) => parts.some((p) => p(c));
    const inSet = ignoreCase ? folded(any) : any;
    return { t: 'char', test: neg ? (c) => !inSet(c) : inSet };
  };
  const parseAtom = (): Node | null => {
    const ch = src[i];
    if (ch === '(') {
      i++;
      if (src[i] === '?') {
        if (src[i + 1] === ':') i += 2;
        else if (src[i + 1] === '<' && src[i + 2] !== '=' && src[i + 2] !== '!') {
          const end = src.indexOf('>', i);
          if (end < 0) throw new UnsupportedPattern('an unclosed group name');
          i = end + 1;
        } else throw new UnsupportedPattern('a lookaround');
      }
      const inner = parseAlt();
      if (src[i] !== ')') throw new UnsupportedPattern('an unclosed group');
      i++;
      return inner;
    }
    if (ch === '[') {
      i++;
      return parseClass();
    }
    if (ch === '.') {
      i++;
      return { t: 'char', test: anyChar };
    }
    if (ch === '^') {
      i++;
      return { t: 'assert', k: 'bol' };
    }
    if (ch === '$') {
      i++;
      return { t: 'assert', k: 'eol' };
    }
    if (ch === '\\') {
      i++;
      const e = src[i];
      if (e === 'b' || e === 'B') {
        i++;
        return { t: 'assert', k: e === 'b' ? 'wb' : 'nwb' };
      }
      const cls = classEscape(e);
      if (cls) {
        i++;
        return { t: 'char', test: cls };
      }
      return lit(String.fromCharCode(escapedChar(false)));
    }
    i++;
    return lit(ch);
  };
  const quantifier = (): [number, number] | null => {
    const ch = src[i];
    if (ch === '*') return (i++, [0, Infinity]);
    if (ch === '+') return (i++, [1, Infinity]);
    if (ch === '?') return (i++, [0, 1]);
    if (ch === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (!m) return null; // a literal `{` (non-unicode JavaScript)
      i += m[0].length;
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      return [min, max];
    }
    return null;
  };
  const parseCat = (): Node => {
    const xs: Node[] = [];
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      let atom = parseAtom()!;
      let q = quantifier();
      while (q) {
        if (src[i] === '?') i++; // lazy: the same for whether there is a match
        if (atom.t === 'assert') throw new UnsupportedPattern('a repeated assertion');
        if (q[0] > MAX_STATES || (q[1] !== Infinity && q[1] > MAX_STATES)) throw new UnsupportedPattern('too complex to match');
        atom = { t: 'rep', x: atom, min: q[0], max: q[1] };
        q = quantifier();
      }
      xs.push(atom);
    }
    return { t: 'cat', xs };
  };
  function parseAlt(): Node {
    const xs = [parseCat()];
    while (src[i] === '|') {
      i++;
      xs.push(parseCat());
    }
    return xs.length === 1 ? xs[0] : { t: 'alt', xs };
  }
  const root = parseAlt();
  if (i !== src.length) throw new UnsupportedPattern('an unmatched parenthesis');
  return root;
}

/**
 * A glob's syntax tree, anchored at both ends: `*` within one folder, `?` one character of it, `**` across folders
 * and `**\/` none or more whole folders, with runs of wildcards merged (globTokens).
 */
function parseGlob(glob: string): Node {
  const notSlash: CharTest = (c) => c !== 47 && !isLineEnd(c);
  const anyRun = (): Node => ({ t: 'rep', x: { t: 'char', test: anyChar }, min: 0, max: Infinity });
  const xs: Node[] = [{ t: 'assert', k: 'bol' }];
  for (const tok of globTokens(glob)) {
    if (tok === '**/') xs.push({ t: 'rep', x: { t: 'cat', xs: [anyRun(), { t: 'char', test: (x) => x === 47, lit: '/' }] }, min: 0, max: 1 });
    else if (tok === '**') xs.push(anyRun());
    else if (tok === '*') xs.push({ t: 'rep', x: { t: 'char', test: notSlash }, min: 0, max: Infinity });
    else if (tok === '?') xs.push({ t: 'char', test: notSlash });
    else {
      const code = tok.charCodeAt(0);
      xs.push({ t: 'char', test: (x) => x === code, lit: tok });
    }
  }
  xs.push({ t: 'assert', k: 'eol' });
  return { t: 'cat', xs };
}

/**
 * A glob's tokens (`**\/`, `**`, `*`, `?` or one character), with adjacent wildcards that say the same as one merged
 * into it: `**` beside `*`, `**` or `**\/` is `**`; `*` beside `*` is `*`; `**\/` beside `**\/` is `**\/`.
 */
function globTokens(glob: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < glob.length; i++) {
    let tok = glob[i];
    if (tok === '*' && glob[i + 1] === '*') {
      tok = glob[i + 2] === '/' ? '**/' : '**';
      i += tok.length - 1;
    }
    const prev = out[out.length - 1];
    const stars = (t: string | undefined) => t === '*' || t === '**' || t === '**/';
    if (stars(tok) && stars(prev)) {
      if (prev === '**/' && tok === '*') out.push(tok);
      else if (prev === '*' && tok === '**/') out.push(tok);
      else out[out.length - 1] = prev === tok ? tok : '**';
    } else out.push(tok);
  }
  return out;
}

// NFA, as parallel arrays. CHAR: tests[s] on the next character, then out[s]. SPLIT: out[s] and out1[s]. ASSERT:
// asserts[s] at the position, then out[s]. MATCH: the pattern has matched.
const CHAR = 0;
const SPLIT = 1;
const ASSERT = 2;
const MATCH = 3;

type DState = { set: Int32Array; key: string; wordBefore: boolean; atStart: boolean; gen: number; ascii: (DState | null | undefined)[]; other: Map<number, DState | null>; atEnd?: boolean };

/** The work a set of matches may do, in characters stepped plus NFA states visited; shared by every test it is passed to. */
export type MatchBudget = { left: number; exhausted?: boolean };

export class LinearMatcher {
  private op: number[] = [];
  private out: number[] = [];
  private out1: number[] = [];
  private tests: (CharTest | null)[] = [];
  private asserts: (Assert | null)[] = [];
  private start = 0;
  /** Every top-level path starts with `^`: no match starts after the first character. */
  private anchored: boolean;
  /** A literal every match contains (case-folded when ignoreCase), checked first with a plain substring search. */
  private required: RegExp | null;
  /** The whole pattern is that literal: the substring search is the answer. */
  private exact: boolean;
  private dstates = new Map<string, DState>();
  private gen = 0;
  private mark: Int32Array;
  private stamp = 0;

  constructor(root: Node, ignoreCase: boolean) {
    this.start = this.compile(root, this.add(MATCH, -1, -1, null, null));
    this.mark = new Int32Array(this.op.length);
    this.anchored = startsAnchored(root);
    const r = requiredLiteral(root);
    const lit = r.best;
    this.exact = r.exact !== null && !r.asserts && r.exact.length > 0;
    this.required = lit.length >= 2 || (this.exact && lit.length > 0) ? new RegExp(lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ignoreCase ? 'i' : '') : null;
  }

  get states(): number {
    return this.op.length;
  }

  private add(op: number, out: number, out1: number, test: CharTest | null, a: Assert | null): number {
    if (this.op.length >= MAX_STATES) throw new UnsupportedPattern('too complex to match');
    this.op.push(op);
    this.out.push(out);
    this.out1.push(out1);
    this.tests.push(test);
    this.asserts.push(a);
    return this.op.length - 1;
  }

  /** The start state of `n` followed by `next` (built back to front). */
  private compile(n: Node, next: number): number {
    switch (n.t) {
      case 'char': return this.add(CHAR, next, -1, n.test, null);
      case 'assert': return this.add(ASSERT, next, -1, null, n.k);
      case 'cat': {
        let s = next;
        for (let k = n.xs.length - 1; k >= 0; k--) s = this.compile(n.xs[k], s);
        return s;
      }
      case 'alt': {
        let s = this.compile(n.xs[n.xs.length - 1], next);
        for (let k = n.xs.length - 2; k >= 0; k--) s = this.add(SPLIT, this.compile(n.xs[k], next), s, null, null);
        return s;
      }
      case 'rep': {
        let tail: number;
        if (n.max === Infinity) {
          tail = this.add(SPLIT, -1, next, null, null);
          this.out[tail] = this.compile(n.x, tail);
        } else {
          tail = next;
          for (let k = 0; k < n.max - n.min; k++) tail = this.add(SPLIT, this.compile(n.x, tail), next, null, null);
        }
        for (let k = 0; k < n.min; k++) tail = this.compile(n.x, tail);
        return tail;
      }
    }
  }

  /**
   * The states reachable from `from` (and from the start, unless anchored past the first character) without reading a
   * character, at a position between `wordBefore` and the next character (`next`, -1 at the end). Null: MATCH is one.
   */
  private closure(from: Int32Array, atStart: boolean, wordBefore: boolean, next: number): number[] | null {
    const stamp = ++this.stamp;
    if (stamp === 0x7fffffff) {
      this.mark.fill(0);
      this.stamp = 1;
    }
    const s = this.stamp;
    const out: number[] = [];
    const stack: number[] = [];
    const seeds = this.anchored && !atStart ? from : [...from, this.start];
    for (const x of seeds) stack.push(x);
    const wordAfter = next >= 0 && isWordCode(next);
    while (stack.length) {
      const x = stack.pop()!;
      if (this.mark[x] === s) continue;
      this.mark[x] = s;
      switch (this.op[x]) {
        case MATCH: return null;
        case CHAR: out.push(x); break;
        case SPLIT: stack.push(this.out1[x], this.out[x]); break;
        case ASSERT: {
          const a = this.asserts[x];
          const ok = a === 'bol' ? atStart : a === 'eol' ? next < 0 : a === 'wb' ? wordBefore !== wordAfter : wordBefore === wordAfter;
          if (ok) stack.push(this.out[x]);
          break;
        }
      }
    }
    return out;
  }

  private intern(set: number[], wordBefore: boolean, atStart: boolean): DState {
    const sorted = Int32Array.from(new Set(set)).sort();
    const key = `${atStart ? 1 : 0}${wordBefore ? 1 : 0}:${sorted.join(',')}`;
    let d = this.dstates.get(key);
    if (!d) {
      if (this.dstates.size >= MAX_DSTATES) {
        this.dstates = new Map();
        this.gen++;
      }
      d = { set: sorted, key, wordBefore, atStart, gen: this.gen, ascii: [], other: new Map() };
      this.dstates.set(key, d);
    }
    return d;
  }

  /** The state after reading `c` from `d`, or null: a match ended before `c`. Cost: what it added to `budget`. */
  private step(d: DState, c: number, budget: MatchBudget | undefined): DState | null {
    const cached = d.gen === this.gen ? (c < 128 ? d.ascii[c] : d.other.get(c)) : undefined;
    if (cached !== undefined) return cached;
    const cl = this.closure(d.set, d.atStart, d.wordBefore, c);
    if (budget) budget.left -= this.op.length;
    let next: DState | null = null;
    if (cl) {
      const moved: number[] = [];
      for (const x of cl) if (this.tests[x]!(c)) moved.push(this.out[x]);
      next = this.intern(moved, isWordCode(c), false);
    }
    if (d.gen === this.gen) {
      if (c < 128) d.ascii[c] = next;
      else d.other.set(c, next);
    }
    return next;
  }

  /**
   * Whether the pattern matches somewhere in `s`. A `budget` is charged for the work; once it is spent the answer is
   * false (and `exhausted` set) without reading further.
   */
  test(s: string, budget?: MatchBudget): boolean {
    if (budget && budget.left <= 0) {
      budget.exhausted = true;
      return false;
    }
    if (this.required && !this.required.test(s)) return false;
    if (this.exact) return true;
    let d: DState | null = this.intern([], false, true);
    for (let k = 0; k < s.length; k++) {
      d = this.step(d, s.charCodeAt(k), budget);
      if (!d) return true;
      if (this.anchored && !d.set.length) return false;
      if (budget && --budget.left <= 0) {
        budget.exhausted = true;
        return false;
      }
    }
    if (d.atEnd === undefined) d.atEnd = this.closure(d.set, d.atStart, d.wordBefore, -1) === null;
    return d.atEnd;
  }
}

function startsAnchored(n: Node): boolean {
  if (n.t === 'assert') return n.k === 'bol';
  if (n.t === 'cat') return n.xs.length > 0 && startsAnchored(n.xs[0]);
  if (n.t === 'alt') return n.xs.every(startsAnchored);
  return false;
}

/** exact: the text the node always matches (null: it varies); best: the longest text every match contains. */
function requiredLiteral(n: Node): { exact: string | null; best: string; asserts: boolean } {
  switch (n.t) {
    case 'char': return n.lit !== undefined ? { exact: n.lit, best: n.lit, asserts: false } : { exact: null, best: '', asserts: false };
    case 'assert': return { exact: '', best: '', asserts: true };
    case 'alt': return { exact: null, best: '', asserts: true };
    case 'rep': {
      const r = requiredLiteral(n.x);
      return { exact: n.min === n.max && r.exact !== null ? r.exact.repeat(n.min) : null, best: n.min > 0 ? r.best : '', asserts: true };
    }
    case 'cat': {
      let run: string | null = '';
      let best = '';
      let all: string | null = '';
      let asserts = false;
      for (const x of n.xs) {
        const r = requiredLiteral(x);
        asserts ||= r.asserts;
        if (r.best.length > best.length) best = r.best;
        if (r.exact !== null) {
          run = (run ?? '') + r.exact;
          if (all !== null) all += r.exact;
        } else {
          run = '';
          all = null;
        }
        if (run.length > best.length) best = run;
      }
      return { exact: all, best, asserts };
    }
  }
}

const regexCache = new Map<string, LinearMatcher | UnsupportedPattern>();
const globCache = new Map<string, LinearMatcher>();
const CACHE_MAX = 5000;

/**
 * A pattern compiled case-insensitively to a linear-time matcher; UnsupportedPattern when it uses what the matcher
 * does not run (lookaround, a backreference) or is too large; null when it is not a regular expression at all.
 */
export function compileLinear(src: string): LinearMatcher | UnsupportedPattern | null {
  const hit = regexCache.get(src);
  if (hit) return hit;
  try {
    // Only compiled, never run: JavaScript's own syntax check, so what it refuses stays "not a regular expression".
    new RegExp(src, 'i');
  } catch {
    return null;
  }
  let m: LinearMatcher | UnsupportedPattern;
  try {
    m = new LinearMatcher(parseRegex(src, true), true);
  } catch (e) {
    if (!(e instanceof UnsupportedPattern)) throw e;
    m = e;
  }
  if (regexCache.size >= CACHE_MAX) regexCache.clear();
  regexCache.set(src, m);
  return m;
}

/** A glob (codegraph.ts pathMatches' syntax) as a linear-time matcher of a whole path. */
export function compileGlob(glob: string): LinearMatcher {
  let m = globCache.get(glob);
  if (!m) {
    m = new LinearMatcher(parseGlob(glob), false);
    if (globCache.size >= CACHE_MAX) globCache.clear();
    globCache.set(glob, m);
  }
  return m;
}

/** A glob's wildcards after collapsing runs (`*`, `**`, `**\/` and `?` count one each). */
export const globWildcards = (glob: string) => globTokens(glob).filter((t) => t === '*' || t === '**' || t === '**/' || t === '?').length;
