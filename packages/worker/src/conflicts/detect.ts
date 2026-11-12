import {
  CONFLICT_MIN_COSINE, CONFLICT_PAIRS_PER_SIDE, conflictKindOf, conflictPairKey, conflictPrefilter, citedVerdict, ModelOutputError, needsJudge, sameSource,
  scopesOverlap, type ConflictKind, type ConflictSideInfo, type JudgeVerdict, type LlmProvider, type PrefilterSignal,
} from '@fb/core';
import { IntakeBudgetSpent } from '../intake/budget.ts';
import { judgePair } from './judge.ts';

/**
 * Contradiction detection for one side (0.9.0 §5): its nearest neighbours that share its scope, the deterministic
 * pre-filters, then the judge for the pairs worth a model call, with the answer's citations checked and the time rules
 * applied. What follows is handed to a sink (the store's, or the eval's), so this file holds no storage.
 */

export type Neighbour = { side: ConflictSideInfo; cosine: number };

/** What detection produces: a conflict (kind, older side first for a supersession), a question, or a link. */
export type ConflictSink = {
  /** True when a conflict was opened (not already open, and not a dismissed pair unchanged since). */
  conflict(c: { kind: ConflictKind; a: ConflictSideInfo; b: ConflictSideInfo; signals: PrefilterSignal[]; judge: JudgeVerdict }): Promise<boolean>;
  /** A contradiction inside one source: a contradictory Question for its speakers. */
  question(a: ConflictSideInfo, b: ConflictSideInfo, judge: JudgeVerdict): Promise<void>;
  link(a: ConflictSideInfo, b: ConflictSideInfo, relation: 'refines' | 'same'): Promise<void>;
};

export type DetectDeps = {
  /** The side's nearest records (claims, facts, lessons), nearest first, with their cosine. */
  neighbours(side: ConflictSideInfo): Promise<Neighbour[]>;
  /** Two projects linked and confirmed (LinksStore). */
  linked(x: string, y: string): boolean;
  /** The judge, each call taken from CONFLICT_LLM_CALLS_PER_DAY; null: no judge (pairs are only pre-filtered). */
  llm: LlmProvider | null;
  /** Judged pairs by conflictPairKey: an unchanged pair is never judged twice. */
  memo: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
  sink: ConflictSink;
};

/** A round's counts. uncited: judge answers dropped for not citing both sides (judge_uncited). spent: the day's calls ran out. */
export type DetectTally = {
  sides: number; pairs: number; judged: number; uncited: number; unusable: number; memoised: number;
  conflicts: number; questions: number; links: number; spent: boolean;
};
export const emptyTally = (): DetectTally => ({ sides: 0, pairs: 0, judged: 0, uncited: 0, unusable: 0, memoised: 0, conflicts: 0, questions: 0, links: 0, spent: false });

/** The pairs a side goes on with: neighbours at or above CONFLICT_MIN_COSINE whose scopes overlap, at most five. */
export function candidatePairs(side: ConflictSideInfo, ns: Neighbour[], linked: DetectDeps['linked']): Neighbour[] {
  const seen = new Set<string>([`${side.ref.kind}:${side.ref.id}`]);
  const out: Neighbour[] = [];
  for (const n of [...ns].sort((x, y) => y.cosine - x.cosine)) {
    const key = `${n.side.ref.kind}:${n.side.ref.id}`;
    if (seen.has(key) || n.cosine < CONFLICT_MIN_COSINE || !scopesOverlap(side, n.side, linked)) continue;
    seen.add(key);
    out.push(n);
    if (out.length >= CONFLICT_PAIRS_PER_SIDE) break;
  }
  return out;
}

/**
 * Detect for one side, into `t`. Stops early (t.spent) when the day's judge calls are used: the pairs not judged are
 * not memoised, so a later round takes them up.
 */
export async function detectFor(side: ConflictSideInfo, d: DetectDeps, t: DetectTally): Promise<void> {
  t.sides++;
  for (const { side: other, cosine } of candidatePairs(side, await d.neighbours(side), d.linked)) {
    t.pairs++;
    const pf = conflictPrefilter({ text: side.text, assertedAt: side.assertedAt, about: side.about }, { text: other.text, assertedAt: other.assertedAt, about: other.about });
    if (pf.same) {
      await d.sink.link(side, other, 'same');
      t.links++;
      continue;
    }
    if (!needsJudge(pf, cosine) || !d.llm) continue;
    const key = conflictPairKey(side, other);
    if (await d.memo.get(key)) {
      t.memoised++;
      continue;
    }
    let answer: JudgeVerdict;
    try {
      answer = await judgePair(d.llm, side, other, pf.signals);
    } catch (err) {
      if (err instanceof IntakeBudgetSpent) {
        t.spent = true;
        return;
      }
      if (!(err instanceof ModelOutputError)) throw err;
      t.unusable++;
      continue;
    }
    t.judged++;
    const cited = citedVerdict(answer, side, other);
    const v = cited && sameButValuesDiffer(cited, pf.signals);
    if (!v) {
      t.uncited++;
      await d.memo.set(key, 'uncited');
      continue;
    }
    await act(side, other, pf.signals, v, d.sink, t);
    await d.memo.set(key, v.relation);
  }
}

const VALUE_FAMILIES = new Set(['number', 'date', 'version']);

/**
 * "Same" says both are about one thing and say it alike; when the pre-filter read different values out of them
 * (numbers in the same unit, dates, versions), both cannot hold: that is a contradiction the judge misread (a small
 * model takes "five minutes" for "120 seconds"). Any other answer is kept as it is.
 */
export function sameButValuesDiffer(v: JudgeVerdict, signals: PrefilterSignal[]): JudgeVerdict {
  const values = signals.filter((s) => VALUE_FAMILIES.has(s.family));
  if (v.relation !== 'same' || !values.length) return v;
  return { ...v, relation: 'contradicts', explanation: `${v.explanation} (the judge called them the same, but ${values.map((s) => s.why).join('; ')})`.trim() };
}

async function act(side: ConflictSideInfo, other: ConflictSideInfo, signals: PrefilterSignal[], v: JudgeVerdict, sink: ConflictSink, t: DetectTally) {
  if (v.relation === 'unrelated') return;
  if (v.relation !== 'contradicts') {
    await sink.link(side, other, v.relation);
    t.links++;
    return;
  }
  if (sameSource(side, other)) {
    await sink.question(side, other, v);
    t.questions++;
    return;
  }
  const k = conflictKindOf(side, other);
  // A supersession names the older side A and the newer B (the UI preselects B); A disagreement keeps the asking side as A.
  const [a, b] = k.kind === 'supersession' ? [k.older!, k.newer!] : [side, other];
  const judge = a === side ? v : { ...v, aQuote: v.bQuote, bQuote: v.aQuote };
  if (await sink.conflict({ kind: k.kind, a, b, signals: a === side ? signals : signals.map((s) => ({ ...s, a: s.b, b: s.a })), judge })) t.conflicts++;
}
