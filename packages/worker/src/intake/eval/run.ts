import type { LlmProvider } from '@fb/core';
import type { EvalSource, IntakeFixture, IntakeSeeds } from './fixture.ts';
import type { PhaseCost, PredictedClaim, PredictedConflict, PredictedQuestion, PredictedRelation, PredictedRun } from './score.ts';

/**
 * Running the intake pipeline over the fixture for scripts/intake-eval.ts: every source extracted, then conflicts
 * detected over all the claims and the seeds, with each phase's model calls counted and timed.
 */

/** A source as the pipeline receives it: the fixture's metadata and the file's text. */
export type EvalSourceInput = Omit<EvalSource, 'file'> & { text: string };
/** What extraction said a claim says, beyond its quote: conflict detection compares statements and subjects. */
export type EvalClaimText = { statement?: string; about?: string; area?: string | null; files?: string[] };
/** A kept claim with what conflict detection needs: its project, and when it was asserted (its source's occurredAt). */
export type EvalClaimSide = PredictedClaim & EvalClaimText & { projectKey: string | null; assertedAt: string };

/**
 * What the eval needs from the pipeline, implemented in ./pipeline.ts, store-free, with
 * the deterministic parts real and only the model swapped.
 *
 * Step 5 (worker/src/intake/extract.ts) provides `extract`: parse, redact, pseudonymise speakers (S1, S2...), window,
 * one `askJson` per window and the cross-window questions call, quote validation, the injection filters and the
 * statement-adds flag, then the handles mapped back to names. It returns only what validation kept, with spans as
 * offsets into `source.text` (utterance offset + charStart; the fixture holds nothing redaction changes), and the
 * drops by reason (`unquoted`, `injection`, ...) as it counts them in Activity.
 *
 * Step 7 (worker/src/conflicts/) provides `detect`: candidates (k nearest by embedding, CONFLICT_MIN_COSINE, scope
 * overlap), core/src/conflicts/prefilter.ts, the judge with the citation check, time awareness and the outcomes. Sides
 * are the kept claims and the seeds; refer to a seed as `lesson:<id>` / `fact:<id>`. Detection at intake (§5.6a) runs
 * each claim against what is already known, so a claim is judged against the seeds and every claim from an earlier
 * source; a pair inside one source becomes a contradictory Question, returned in `questions`. Embeddings come from
 * the implementation's own embedder (Ollama, as the worker's), not the judge's model.
 */
export interface IntakeEvalPipeline {
  extract(source: EvalSourceInput, llm: LlmProvider): Promise<{
    claims: (Omit<PredictedClaim, 'source'> & EvalClaimText)[];
    questions: Omit<PredictedQuestion, 'source'>[];
    dropped: Record<string, number>;
  }>;
  /** Null: the run detects nothing (no conflicts, relations or judge calls). */
  detect: ((input: { claims: EvalClaimSide[]; seeds: IntakeSeeds; owner: string }, llm: LlmProvider) => Promise<{
    conflicts: PredictedConflict[];
    relations: PredictedRelation[];
    /** Contradictory Questions for pairs inside one source, with spans as `extract` gives them. */
    questions: PredictedQuestion[];
    /** Judge answers received, and those discarded as `judge_uncited`. */
    judge: { answers: number; uncited: number };
  }>) | null;
}

/** A provider that counts its calls and the seconds they take into `cost`, failed calls included. */
export function meteredProvider(llm: LlmProvider, cost: PhaseCost, now: () => number = () => performance.now()): LlmProvider {
  return {
    ...llm,
    async json(task) {
      cost.calls++;
      const t0 = now();
      try {
        return await llm.json(task);
      } finally {
        cost.seconds += (now() - t0) / 1000;
      }
    },
  };
}

/**
 * The whole fixture through the pipeline with one model, sources in the order they occurred (so detection at intake
 * sees the earlier ones). Claim and question ids are prefixed with their source, so they are unique across the run.
 */
export async function runIntakeEval(f: IntakeFixture, pipeline: IntakeEvalPipeline, llm: LlmProvider, o: { now?: () => number; log?: (m: string) => void } = {}): Promise<PredictedRun> {
  const cost = { extract: { calls: 0, seconds: 0 }, judge: { calls: 0, seconds: 0 } };
  const extractLlm = meteredProvider(llm, cost.extract, o.now);
  const judgeLlm = meteredProvider(llm, cost.judge, o.now);
  const sources = [...f.expected.sources].sort((x, y) => x.occurredAt.localeCompare(y.occurredAt) || x.id.localeCompare(y.id));
  const claims: EvalClaimSide[] = [];
  const questions: PredictedQuestion[] = [];
  const dropped: Record<string, number> = {};
  for (const s of sources) {
    o.log?.(`extracting ${s.id} (${s.file})`);
    const { file: _file, ...meta } = s;
    const r = await pipeline.extract({ ...meta, text: f.texts.get(s.id)! }, extractLlm);
    claims.push(...r.claims.map((c) => ({ ...c, id: `${s.id}/${c.id}`, source: s.id, projectKey: s.projectKey, assertedAt: s.occurredAt })));
    questions.push(...r.questions.map((q) => ({ ...q, id: `${s.id}/${q.id}`, source: s.id })));
    for (const [k, v] of Object.entries(r.dropped)) dropped[k] = (dropped[k] ?? 0) + v;
  }
  if (pipeline.detect) o.log?.(`detecting conflicts over ${claims.length} claims`);
  const d = pipeline.detect
    ? await pipeline.detect({ claims, seeds: f.expected.seeds, owner: f.expected.owner }, judgeLlm)
    : { conflicts: [], relations: [], questions: [], judge: { answers: 0, uncited: 0 } };
  return {
    model: llm.id,
    claims: claims.map(({ projectKey: _p, assertedAt: _a, statement: _s, about: _b, area: _r, files: _f, ...c }) => c),
    questions: [...questions, ...d.questions],
    conflicts: d.conflicts,
    relations: d.relations,
    dropped,
    judge: d.judge,
    cost,
  };
}
