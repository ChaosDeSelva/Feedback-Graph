import { normalizeStatement, proportion, type Proportion } from '@fb/core';
import { z } from 'zod';
import { CLAIM_TYPES, CONFLICT_KINDS, isSeedRef, QUESTION_KINDS, type ClaimType, type ConflictKind, type ExpectedContradiction, type IntakeFixture, type QuestionKind, type Span } from './fixture.ts';

/**
 * Scoring an intake run against the fixture (scripts/intake-eval.ts): claims and questions matched to the expected
 * ones by span, planted contradictions found, false conflicts, supersession, the judge's uncited answers, and cost.
 */

/** A claim the pipeline kept (validation passed). `span`: offsets into the source text as stored, like the fixture's. */
export type PredictedClaim = { id: string; source: string; type: ClaimType; speaker: string | null; quote: string; span: Span; flags?: string[] };
export type PredictedQuestion = { id: string; source: string; kind: QuestionKind; askedBy: string | null; quote: string; span: Span };
/** A side: a predicted claim's id, or a seed as `lesson:<id>` / `fact:<id>` (the fixture's seed ids). */
export type SideRef = string;
/** A Conflict the pipeline opened. `newer`: for a supersession, the side it preselects as true. */
export type PredictedConflict = { a: SideRef; b: SideRef; kind: ConflictKind; newer?: SideRef | null };
export type PredictedRelation = { a: SideRef; b: SideRef; relation: 'refines' | 'same' };
export type PhaseCost = { calls: number; seconds: number };

/** What one run of the pipeline produced over the whole fixture, with what it cost. */
export type PredictedRun = {
  /** The model spec, e.g. `ollama:gemma4`. */
  model: string;
  claims: PredictedClaim[];
  questions: PredictedQuestion[];
  conflicts: PredictedConflict[];
  relations: PredictedRelation[];
  /** Statements the pipeline dropped, by reason (unquoted, injection, ...), as Activity counts them. */
  dropped: Record<string, number>;
  /** Judge answers, and those discarded for not citing both sides (`judge_uncited`). */
  judge: { answers: number; uncited: number };
  cost: { extract: PhaseCost; judge: PhaseCost };
};

const SpanShape = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() });
const Cost = z.object({ calls: z.number().int().nonnegative(), seconds: z.number().nonnegative() });
const RunShape = z.object({
  model: z.string(),
  claims: z.array(z.object({ id: z.string(), source: z.string(), type: z.enum(CLAIM_TYPES), speaker: z.string().nullable(), quote: z.string(), span: SpanShape, flags: z.array(z.string()).optional() })),
  questions: z.array(z.object({ id: z.string(), source: z.string(), kind: z.enum(QUESTION_KINDS), askedBy: z.string().nullable(), quote: z.string(), span: SpanShape })),
  conflicts: z.array(z.object({ a: z.string(), b: z.string(), kind: z.enum(CONFLICT_KINDS), newer: z.string().nullable().optional() })),
  relations: z.array(z.object({ a: z.string(), b: z.string(), relation: z.enum(['refines', 'same']) })),
  dropped: z.record(z.number()),
  judge: z.object({ answers: z.number().int().nonnegative(), uncited: z.number().int().nonnegative() }),
  cost: z.object({ extract: Cost, judge: Cost }),
});

/** Saved runs (scripts/intake-eval.ts --score): one run, a list of them, or the script's own --json output. */
export function parsePredictedRuns(json: unknown): PredictedRun[] {
  const runs = Array.isArray(json) ? json : json && typeof json === 'object' && 'runs' in json ? (json as { runs: unknown }).runs : [json];
  return z.array(RunShape).min(1).parse(runs);
}

/** A predicted span matches an expected one when it covers at least this much of it... */
export const MIN_EXPECTED_COVER = 0.5;
/** ...and is not mostly other text (a whole paragraph quoted for one sentence). */
export const MIN_PREDICTED_COVER = 0.25;
/** The release bar with gemma4 (§10). */
export const RELEASE_BAR = { conflictRecall: 0.8, falseConflictsPerSource: 1, fabricatedKept: 0 } as const;

const overlap = (x: Span, y: Span) => Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
const len = (s: Span) => s.end - s.start;
export function spanMatches(expected: Span, predicted: Span): boolean {
  const o = overlap(expected, predicted);
  return o >= MIN_EXPECTED_COVER * len(expected) && o >= MIN_PREDICTED_COVER * len(predicted);
}
const iou = (x: Span, y: Span) => overlap(x, y) / (len(x) + len(y) - overlap(x, y));

/**
 * One-to-one matching within each source: the closest pairs (by intersection over union) first, so a prediction is
 * credited to one expected item at most. Returns predicted id -> expected id.
 */
function matchBySpan<E extends { id: string; source: string }, P extends { id: string; source: string; span: Span }>(
  expected: E[], predicted: P[], spansOf: (e: E) => Span[],
): Map<string, string> {
  const pairs: { e: string; p: string; score: number }[] = [];
  for (const e of expected) {
    for (const p of predicted) {
      if (p.source !== e.source) continue;
      const fits = spansOf(e).filter((s) => spanMatches(s, p.span));
      if (fits.length) pairs.push({ e: e.id, p: p.id, score: Math.max(...fits.map((s) => iou(s, p.span))) });
    }
  }
  pairs.sort((x, y) => y.score - x.score || x.e.localeCompare(y.e) || x.p.localeCompare(y.p));
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const { e, p } of pairs) {
    if (out.has(p) || used.has(e)) continue;
    out.set(p, e);
    used.add(e);
  }
  return out;
}

export type MatchCounts = { expected: number; predicted: number; matched: number; precision: Proportion; recall: Proportion };
/**
 * Precision and recall over required items: a prediction matched to an optional item counts neither way, and an
 * unmatched optional item is not missed.
 */
function counts(requiredIds: Set<string>, optionalIds: Set<string>, predictedIds: string[], match: Map<string, string>): MatchCounts {
  const tp = predictedIds.filter((p) => requiredIds.has(match.get(p) ?? '')).length;
  const fp = predictedIds.filter((p) => !match.has(p)).length;
  return {
    expected: requiredIds.size, predicted: predictedIds.filter((p) => !optionalIds.has(match.get(p) ?? '')).length, matched: tp,
    precision: proportion(tp, tp + fp), recall: proportion(tp, requiredIds.size),
  };
}

const sameName = (x: string | null, y: string | null, owner: string) => {
  const n = (s: string | null) => (s === null || s.trim().toLowerCase() === owner.trim().toLowerCase() ? null : s.trim().toLowerCase());
  return n(x) === n(y);
};

export type ClaimScore = MatchCounts & { type: Proportion; speaker: Proportion };
export type QuestionScore = MatchCounts & { kind: Proportion };
export type ContradictionResult = {
  id: string; family: ExpectedContradiction['family']; expect: ExpectedContradiction['expect'];
  /** For a planted conflict: a Conflict on this pair was opened. For none or question: one was (wrongly). */
  conflict: ConflictKind | null;
  /** The planted conflict's kind (and, for a supersession, its newer side) came out right. Null when not applicable. */
  kindRight: boolean | null;
  relation: PredictedRelation['relation'] | null;
};
export type FalseConflict = { conflict: PredictedConflict; why: 'planted-none' | 'in-source' | 'unmatched-side' | 'unplanted'; source: string };
export type FabricatedClaim = { claim: string; source: string; why: 'not-in-source' | 'unknown-speaker' | 'must-drop'; detail: string };

export type IntakeScore = {
  model: string;
  sources: number;
  claims: ClaimScore & { bySource: (MatchCounts & { source: string })[] };
  questions: QuestionScore;
  contradictions: ContradictionResult[];
  conflictRecall: Proportion;
  falseConflicts: FalseConflict[];
  /** The most false conflicts charged to any one source (each to the newer claim side's source). */
  maxFalseConflictsPerSource: number;
  supersessionAccuracy: Proportion;
  fabricatedKept: FabricatedClaim[];
  dropped: Record<string, number>;
  judgeUncited: Proportion;
  cost: PredictedRun['cost'] & { calls: number; seconds: number };
  bar: { conflictRecall: boolean; falseConflictsPerSource: boolean; fabricatedKept: boolean; pass: boolean };
};

const pairKey = (x: string, y: string) => [x, y].sort().join(' | ');

/** Score one run against the fixture. */
export function scoreIntakeRun(f: IntakeFixture, run: PredictedRun): IntakeScore {
  const e = f.expected;
  const owner = e.owner;
  const sourceOf = new Map(e.sources.map((s) => [s.id, s]));

  // Claims.
  const claimMatch = matchBySpan(e.claims, run.claims, (c) => [c.span]);
  const required = (xs: { id: string; optional?: boolean }[]) => new Set(xs.filter((x) => !x.optional).map((x) => x.id));
  const optional = (xs: { id: string; optional?: boolean }[]) => new Set(xs.filter((x) => x.optional).map((x) => x.id));
  const requiredClaims = required(e.claims);
  const claimTotals = counts(requiredClaims, optional(e.claims), run.claims.map((c) => c.id), claimMatch);
  const expectedClaim = new Map(e.claims.map((c) => [c.id, c]));
  const matchedClaims = run.claims.filter((c) => requiredClaims.has(claimMatch.get(c.id) ?? ''));
  const typeRight = matchedClaims.filter((c) => expectedClaim.get(claimMatch.get(c.id)!)!.type === c.type).length;
  const speakerRight = matchedClaims.filter((c) => sameName(expectedClaim.get(claimMatch.get(c.id)!)!.speaker, c.speaker, owner)).length;
  const bySource = e.sources.map((s) => ({
    source: s.id,
    ...counts(required(e.claims.filter((c) => c.source === s.id)), optional(e.claims.filter((c) => c.source === s.id)), run.claims.filter((c) => c.source === s.id).map((c) => c.id), claimMatch),
  }));

  // Questions.
  const questionMatch = matchBySpan(e.questions, run.questions, (q) => q.quotes.map((x) => x.span));
  const requiredQuestions = required(e.questions);
  const questionTotals = counts(requiredQuestions, optional(e.questions), run.questions.map((q) => q.id), questionMatch);
  const expectedQuestion = new Map(e.questions.map((q) => [q.id, q]));
  const matchedQuestions = run.questions.filter((q) => requiredQuestions.has(questionMatch.get(q.id) ?? ''));
  const kindRight = matchedQuestions.filter((q) => expectedQuestion.get(questionMatch.get(q.id)!)!.kind === q.kind).length;

  // Conflicts: each side as the fixture names it.
  const asExpected = (ref: SideRef): string | null => (isSeedRef(ref) ? ref : claimMatch.get(ref) ?? null);
  const predictedClaim = new Map(run.claims.map((c) => [c.id, c]));
  const planted = new Map(e.contradictions.map((c) => [pairKey(c.a, c.b), c]));
  const found = new Map<string, PredictedConflict>();
  const falseConflicts: FalseConflict[] = [];
  /** A false conflict is charged to the source whose intake found it: the newer claim side's. */
  const chargedTo = (c: PredictedConflict) => {
    const sides = [c.a, c.b].map((r) => predictedClaim.get(r)?.source).filter((s): s is string => !!s && sourceOf.has(s));
    sides.sort((x, y) => sourceOf.get(y)!.occurredAt.localeCompare(sourceOf.get(x)!.occurredAt));
    return sides[0] ?? '(seeds)';
  };
  for (const c of run.conflicts) {
    const [a, b] = [asExpected(c.a), asExpected(c.b)];
    const p = a && b ? planted.get(pairKey(a, b)) : undefined;
    if (p && (p.expect === 'disagreement' || p.expect === 'supersession')) {
      // The same pair opened twice is one finding (openConflict is idempotent on the pair).
      if (!found.has(p.id)) found.set(p.id, c);
      continue;
    }
    const sa = predictedClaim.get(c.a)?.source;
    const why: FalseConflict['why'] = !a || !b ? 'unmatched-side' : p?.expect === 'none' ? 'planted-none' : p?.expect === 'question' || (sa && sa === predictedClaim.get(c.b)?.source) ? 'in-source' : 'unplanted';
    falseConflicts.push({ conflict: c, why, source: chargedTo(c) });
  }
  const relationOn = (x: string, y: string) => run.relations.find((r) => {
    const [a, b] = [asExpected(r.a), asExpected(r.b)];
    return a && b && pairKey(a, b) === pairKey(x, y);
  })?.relation ?? null;

  const contradictions: ContradictionResult[] = e.contradictions.map((p) => {
    const positive = p.expect === 'disagreement' || p.expect === 'supersession';
    const c = positive ? found.get(p.id) : run.conflicts.find((x) => {
      const [a, b] = [asExpected(x.a), asExpected(x.b)];
      return a && b && pairKey(a, b) === pairKey(p.a, p.b);
    });
    let kindRight: boolean | null = null;
    if (positive && c) {
      kindRight = c.kind === p.expect;
      if (kindRight && p.expect === 'supersession') kindRight = !!c.newer && asExpected(c.newer) === (p.newer === 'a' ? p.a : p.b);
    }
    return { id: p.id, family: p.family, expect: p.expect, conflict: c?.kind ?? null, kindRight, relation: relationOn(p.a, p.b) };
  });
  const positives = contradictions.filter((c) => c.expect === 'disagreement' || c.expect === 'supersession');
  const hits = positives.filter((c) => c.conflict);

  const perSource = new Map<string, number>();
  for (const x of falseConflicts) perSource.set(x.source, (perSource.get(x.source) ?? 0) + 1);
  const maxFalse = Math.max(0, ...perSource.values());

  // Kept claims that should not exist: a quote not in its source, a speaker not in it, or a planted drop.
  const fabricated: FabricatedClaim[] = [];
  for (const c of run.claims) {
    const text = f.texts.get(c.source);
    const src = sourceOf.get(c.source);
    if (text === undefined || !src) {
      fabricated.push({ claim: c.id, source: c.source, why: 'not-in-source', detail: `unknown source ${c.source}` });
      continue;
    }
    if (!normalizeStatement(text).includes(normalizeStatement(c.quote))) {
      fabricated.push({ claim: c.id, source: c.source, why: 'not-in-source', detail: c.quote });
      continue;
    }
    const drop = e.mustDrop.find((d) => d.source === c.source && overlap(d.span, c.span) >= 0.5 * Math.min(len(d.span), len(c.span)));
    if (drop) {
      fabricated.push({ claim: c.id, source: c.source, why: 'must-drop', detail: `${drop.id} (${drop.reason})` });
      continue;
    }
    if (c.speaker !== null && !sameName(c.speaker, null, owner) && !src.participants.some((p) => sameName(p, c.speaker, owner))) {
      fabricated.push({ claim: c.id, source: c.source, why: 'unknown-speaker', detail: c.speaker });
    }
  }

  const conflictRecall = proportion(hits.length, positives.length);
  const calls = run.cost.extract.calls + run.cost.judge.calls;
  const seconds = run.cost.extract.seconds + run.cost.judge.seconds;
  const bar = {
    conflictRecall: conflictRecall.rate >= RELEASE_BAR.conflictRecall,
    falseConflictsPerSource: maxFalse <= RELEASE_BAR.falseConflictsPerSource,
    fabricatedKept: fabricated.length <= RELEASE_BAR.fabricatedKept,
  };
  return {
    model: run.model,
    sources: e.sources.length,
    claims: { ...claimTotals, type: proportion(typeRight, matchedClaims.length), speaker: proportion(speakerRight, matchedClaims.length), bySource },
    questions: { ...questionTotals, kind: proportion(kindRight, matchedQuestions.length) },
    contradictions,
    conflictRecall,
    falseConflicts,
    maxFalseConflictsPerSource: maxFalse,
    supersessionAccuracy: proportion(hits.filter((c) => c.kindRight).length, hits.length),
    fabricatedKept: fabricated,
    dropped: run.dropped,
    judgeUncited: proportion(run.judge.uncited, run.judge.answers),
    cost: { ...run.cost, calls, seconds },
    bar: { ...bar, pass: bar.conflictRecall && bar.falseConflictsPerSource && bar.fabricatedKept },
  };
}

const pct = (p: Proportion) => (p.n ? `${Math.round(p.rate * 100)}% [${Math.round(p.ciLow * 100)}–${Math.round(p.ciHigh * 100)}] ${p.k}/${p.n}` : '–');
const secs = (s: number) => `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
const yes = (b: boolean) => (b ? 'pass' : 'FAIL');

/** One run's score as Markdown: the release bar first, then claims, questions, contradictions and cost. */
export function formatIntakeReport(s: IntakeScore): string {
  const lines = [
    `# Intake eval: ${s.model}`, '',
    `${s.sources} sources · ${s.cost.calls} model calls · ${secs(s.cost.seconds)} · release bar: ${s.bar.pass ? 'pass' : 'FAIL'}`, '',
    '## Release bar', '',
    '| check | value | bar | result |', '|---|---|---|---|',
    `| planted-conflict recall | ${pct(s.conflictRecall)} | ≥ ${RELEASE_BAR.conflictRecall * 100}% | ${yes(s.bar.conflictRecall)} |`,
    `| false conflicts, most in one source | ${s.maxFalseConflictsPerSource} (${s.falseConflicts.length} in all) | ≤ ${RELEASE_BAR.falseConflictsPerSource} | ${yes(s.bar.falseConflictsPerSource)} |`,
    `| fabricated or must-drop claims kept | ${s.fabricatedKept.length} | ${RELEASE_BAR.fabricatedKept} | ${yes(s.bar.fabricatedKept)} |`, '',
    '## Claims (span-matched)', '',
    `Precision ${pct(s.claims.precision)} · recall ${pct(s.claims.recall)} · type right ${pct(s.claims.type)} · speaker right ${pct(s.claims.speaker)}`, '',
    '| source | expected | predicted | matched | precision | recall |', '|---|---|---|---|---|---|',
    ...s.claims.bySource.map((b) => `| ${b.source} | ${b.expected} | ${b.predicted} | ${b.matched} | ${pct(b.precision)} | ${pct(b.recall)} |`), '',
    '## Questions (span-matched)', '',
    `Precision ${pct(s.questions.precision)} · recall ${pct(s.questions.recall)} · kind right ${pct(s.questions.kind)}`, '',
    '## Planted contradictions', '',
    `Conflict recall ${pct(s.conflictRecall)} · supersession accuracy ${pct(s.supersessionAccuracy)}`, '',
    '| id | family | expected | conflict opened | kind right | relation |', '|---|---|---|---|---|---|',
    ...s.contradictions.map((c) => `| ${c.id} | ${c.family ?? '–'} | ${c.expect} | ${c.conflict ?? 'no'} | ${c.kindRight === null ? '–' : c.kindRight ? 'yes' : 'no'} | ${c.relation ?? '–'} |`), '',
  ];
  if (s.falseConflicts.length) {
    lines.push('## False conflicts', '', '| sides | kind | why | charged to |', '|---|---|---|---|');
    lines.push(...s.falseConflicts.map((x) => `| ${x.conflict.a} / ${x.conflict.b} | ${x.conflict.kind} | ${x.why} | ${x.source} |`), '');
  }
  if (s.fabricatedKept.length) {
    lines.push('## Kept claims that should have been dropped', '', '| claim | source | why | detail |', '|---|---|---|---|');
    lines.push(...s.fabricatedKept.map((x) => `| ${x.claim} | ${x.source} | ${x.why} | ${x.detail.replace(/\|/g, '\\|')} |`), '');
  }
  const dropped = Object.entries(s.dropped).sort(([x], [y]) => x.localeCompare(y));
  lines.push(
    '## Cost', '',
    '| phase | calls | seconds |', '|---|---|---|',
    `| extract | ${s.cost.extract.calls} | ${secs(s.cost.extract.seconds)} |`,
    `| judge | ${s.cost.judge.calls} | ${secs(s.cost.judge.seconds)} |`, '',
    `judge_uncited: ${pct(s.judgeUncited)} · dropped: ${dropped.length ? dropped.map(([k, v]) => `${k} ${v}`).join(', ') : 'none'}`, '',
  );
  return lines.join('\n');
}
