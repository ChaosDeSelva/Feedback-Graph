/**
 * Contradiction detection's pure rules (0.9.0 §5), shared by the worker's detector and the eval: which candidate pairs
 * share a scope, whether a judge's answer cites both sides, which kind of conflict a contradiction is (time rules),
 * and the memo key of a judged pair. No store, no model.
 */
import { createHash } from 'node:crypto';
import { quoteOccursIn } from '../intake/quote.ts';
import { mentionedPaths, pathAffinity } from '../relevance.ts';
import type { ClaimType, ConflictKind, IntakeRef } from '../types.ts';
import { normalizeStatement } from './prefilter.ts';

/** Nearest neighbours asked of each vector index for a side, at or above this cosine (far below a merge's 0.95: disagreeing statements share a topic, not wording). */
export const CONFLICT_MIN_COSINE = 0.72;
export const CONFLICT_NEIGHBOURS = 8;
/** Pairs per side that go on to the pre-filters, nearest first. */
export const CONFLICT_PAIRS_PER_SIDE = 5;

/**
 * One side of a possible conflict: an accepted or proposed claim, a current fact, or an approved lesson. text: what it
 * says (a claim's statement, a fact's statement, a lesson's rule). citable: the stored texts the judge may quote (a
 * claim's quote and statement, a fact's statement, a lesson's rule and title). speaker: the Person who said it; owner:
 * the owner said or wrote it. type: a claim's type, or a fact's kind when that is decision or plan. docId: a claim's
 * source. fingerprint: the record's decision fingerprint, so a changed side is judged again.
 */
export type ConflictSideInfo = {
  ref: IntakeRef; projectKey: string | null; text: string; citable: string[]; about: string | null; area: string | null; files: string[];
  assertedAt: string | null; speaker: string | null; owner: boolean; type: ClaimType | null; due: string | null; docId: string | null;
  fingerprint: string;
};

const STOP = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'and', 'or', 'but', 'we', 'our', 'us', 'you', 'they', 'it', 'its', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'with', 'which', 'what', 'that', 'this', 'these', 'those', 'will', 'would', 'should', 'must', 'can', 'could', 'may',
  'not', 'no', 'never', 'do', 'does', 'did', 'have', 'has', 'had', 'from', 'as', 'all', 'any', 'each', 'every', 'there', 'here', 'than', 'then',
  'so', 'if', 'when', 'after', 'before', 'about', 'into', 'over', 'out', 'up', 'down', 'more', 'less', 'most', 'some', 'same', 'other', 'only',
  'just', 'also', 'now', 'use', 'used', 'using', 'get', 'got', 'make', 'made', 'keep', 'keeping', 'going', 'one', 'two', 'three', 'decision',
  'plan', 'think', 'need', 'needs', 'won', 'don', 'isn', 'aren', 'let', 'lets', 'via', 'per', 'time', 'times',
]);
const stem = (w: string) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const words = (s: string) => normalizeStatement(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w) && !/^\d/.test(w)).map(stem);
/** camelCase, snake_case, dotted and kebab-case names: code-shaped, so a shared one is a shared subject. */
const codeNames = (s: string) => [...s.matchAll(/\b(?:[a-z]+[A-Z]\w*|\w+_\w+|[A-Za-z]\w*\.[A-Za-z]\w+(?:\.\w+)*)\b/g)].map((m) => m[0].toLowerCase());

/** What a side is about: its `about` words (else its text's), the paths and code-shaped names it mentions. */
export function subjectTokens(s: Pick<ConflictSideInfo, 'about' | 'text'>): Set<string> {
  return new Set([...words(s.about || s.text), ...mentionedPaths(s.text).map((p) => p.toLowerCase()), ...codeNames(s.text)]);
}

/** Both name files, and some file of one is in the folder, or the same service, of the other's (pathAffinity). */
function filesAffine(a: string[], b: string[]): boolean {
  return a.length > 0 && b.length > 0 && a.some((f) => pathAffinity(f, b) > 1);
}

/**
 * A pair is worth comparing only when their scopes overlap: the same project, a confirmed linked one, or either side
 * global (no project); and then the same files' service, the same area, or a shared subject (about, paths, code names).
 */
export function scopesOverlap(a: ConflictSideInfo, b: ConflictSideInfo, linked: (x: string, y: string) => boolean): boolean {
  const projects = a.projectKey === null || b.projectKey === null || a.projectKey === b.projectKey || linked(a.projectKey, b.projectKey);
  if (!projects) return false;
  if (filesAffine(a.files, b.files)) return true;
  if (a.area && b.area && normalizeStatement(a.area) === normalizeStatement(b.area)) return true;
  // One side's subject named by the other: its about (or text), paths and code names, in the other's about or text.
  const named = (x: ConflictSideInfo, y: ConflictSideInfo) => {
    const other = new Set([...subjectTokens(y), ...words(y.text)]);
    return [...subjectTokens(x)].some((t) => other.has(t));
  };
  return named(a, b) || named(b, a);
}

/** The judge's answer, as conflicts/judge.ts asks for it. */
export type JudgeVerdict = { relation: 'contradicts' | 'refines' | 'same' | 'unrelated'; aQuote: string; bQuote: string; explanation: string; confidence: number };

/**
 * The answer with its citations checked against both sides' stored text (quoteOccursIn), so a judgement rests on what
 * they say: aQuote from A and bQuote from B, or the two swapped (then put back in order). Null when it does not cite
 * both (judge_uncited). "unrelated" needs no citation: nothing follows from it.
 */
export function citedVerdict<V extends Pick<JudgeVerdict, 'relation' | 'aQuote' | 'bQuote'>>(v: V, a: Pick<ConflictSideInfo, 'citable'>, b: Pick<ConflictSideInfo, 'citable'>): V | null {
  if (v.relation === 'unrelated') return v;
  const inA = (q: string) => a.citable.some((t) => quoteOccursIn(q, t));
  const inB = (q: string) => b.citable.some((t) => quoteOccursIn(q, t));
  if (inA(v.aQuote) && inB(v.bQuote)) return v;
  return inB(v.aQuote) && inA(v.bQuote) ? { ...v, aQuote: v.bQuote, bQuote: v.aQuote } : null;
}

const time = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

/**
 * The time rules (§5.4) for a contradiction: `newer` the later side (null when either date is unknown or they tie).
 * A supersession: the newer side is a decision or plan said by the older side's speaker or by the owner, or the older
 * side is a plan whose date has passed by then. It is still a conflict for the owner to confirm; the UI preselects
 * the newer side. Anything else is a disagreement.
 */
export function conflictKindOf(a: ConflictSideInfo, b: ConflictSideInfo): { kind: ConflictKind; newer: ConflictSideInfo | null; older: ConflictSideInfo | null } {
  const [ta, tb] = [time(a.assertedAt), time(b.assertedAt)];
  if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) return { kind: 'disagreement', newer: null, older: null };
  const [older, newer] = ta < tb ? [a, b] : [b, a];
  const replaces = (newer.type === 'decision' || newer.type === 'plan') && ((!!newer.speaker && newer.speaker === older.speaker) || newer.owner);
  const due = time(older.due);
  const lapsed = older.type === 'plan' && !Number.isNaN(due) && due < time(newer.assertedAt);
  return { kind: replaces || lapsed ? 'supersession' : 'disagreement', newer, older };
}

/** Two claims from the same source: a contradiction there is a Question for its speakers, not a Conflict. */
export const sameSource = (a: ConflictSideInfo, b: ConflictSideInfo) => !!a.docId && a.docId === b.docId && a.ref.kind === 'claim' && b.ref.kind === 'claim';

/** The memo key of a judged pair (a cursor): either side changing (its fingerprint) makes a new key. */
export function conflictPairKey(a: Pick<ConflictSideInfo, 'ref' | 'fingerprint'>, b: Pick<ConflictSideInfo, 'ref' | 'fingerprint'>): string {
  const parts = [a, b].map((s) => `${s.ref.kind}:${s.ref.id}:${s.fingerprint}`).sort();
  return `conflict-pair:${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 40)}`;
}
