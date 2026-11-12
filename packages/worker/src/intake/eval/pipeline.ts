import { CONFLICT_NEIGHBOURS, ollamaEmbed, type ConflictSideInfo, type LlmProvider } from '@fb/core';
import { detectFor, emptyTally, type Neighbour } from '../../conflicts/detect.ts';
import { extractSource } from '../extract.ts';
import type { IntakeSeeds } from './fixture.ts';
import type { EvalClaimSide, IntakeEvalPipeline } from './run.ts';
import type { PredictedConflict, PredictedQuestion, PredictedRelation } from './score.ts';

/**
 * The pipeline scripts/intake-eval.ts runs with --llm, store-free, with the deterministic parts real and only the
 * model swapped. extract: step 5's extraction (worker/src/intake/extract.ts). detect: conflicts/detect.ts at intake
 * (§5.6a): each claim, in the order the sources occurred, against the seeds and every claim before it, with nearest
 * neighbours from an in-memory index over Ollama embeddings (OLLAMA_URL, OLLAMA_EMBED_MODEL, as the worker's).
 */

export type Embed = (texts: string[]) => Promise<number[][]>;
const ollamaEmbedder = (env: NodeJS.ProcessEnv): Embed => (input) =>
  ollamaEmbed({ url: env.OLLAMA_URL || 'http://localhost:11434', model: env.OLLAMA_EMBED_MODEL || 'nomic-embed-text', input });

export function cosine(x: number[], y: number[]): number {
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < x.length; i++) {
    dot += x[i] * y[i];
    nx += x[i] * x[i];
    ny += y[i] * y[i];
  }
  return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
}

/** Seeds and claims as sides, by ref: a claim's id, a seed's `lesson:<id>` / `fact:<id>` (the fixture's refs). */
export function evalSides(claims: EvalClaimSide[], seeds: IntakeSeeds, owner: string): Map<string, ConflictSideInfo> {
  const sides = new Map<string, ConflictSideInfo>();
  for (const l of seeds.lessons) {
    sides.set(`lesson:${l.id}`, {
      ref: { kind: 'lesson', id: `lesson:${l.id}` }, projectKey: l.projectKey, text: l.rule, citable: [l.rule, l.title], about: l.title, area: null, files: l.paths,
      assertedAt: l.decidedAt ?? l.createdAt, speaker: null, owner: false, type: null, due: null, docId: null, fingerprint: 'seed',
    });
  }
  for (const f of seeds.facts) {
    sides.set(`fact:${f.id}`, {
      ref: { kind: 'fact', id: `fact:${f.id}` }, projectKey: f.projectKey, text: f.statement, citable: [f.statement], about: null, area: null, files: [f.path],
      assertedAt: f.createdAt, speaker: null, owner: f.origin === 'you', type: f.kind === 'decision' || f.kind === 'plan' ? f.kind : null, due: null, docId: null,
      fingerprint: 'seed',
    });
  }
  for (const c of claims) {
    const statement = c.statement || c.quote;
    sides.set(c.id, {
      ref: { kind: 'claim', id: c.id }, projectKey: c.projectKey, text: statement, citable: [c.quote, statement], about: c.about || null, area: c.area ?? null,
      files: c.files ?? [], assertedAt: c.assertedAt, speaker: c.speaker,
      // A claim with no speaker is from notes, which are the owner's (the fixture's rule, and the worker's).
      owner: c.speaker === null || c.speaker === owner, type: c.type, due: null, docId: c.source, fingerprint: 'claim',
    });
  }
  return sides;
}

type Detected = Awaited<ReturnType<NonNullable<IntakeEvalPipeline['detect']>>>;

/** Conflict detection over the fixture's claims and seeds, as the eval scores it. `embed` defaults to Ollama's. */
export async function detectOverFixture(input: { claims: EvalClaimSide[]; seeds: IntakeSeeds; owner: string }, llm: LlmProvider, embed: Embed = ollamaEmbedder(process.env)): Promise<Detected> {
  const sides = evalSides(input.claims, input.seeds, input.owner);
  const refs = [...sides.keys()];
  const embedded = refs.length ? await embed(refs.map((r) => sides.get(r)!.text)) : [];
  const vectors = new Map(refs.map((r, i) => [r, embedded[i]]));
  const claimById = new Map(input.claims.map((c) => [c.id, c]));
  const seedRefs = refs.filter((r) => !claimById.has(r));
  const out: Detected = { conflicts: [] as PredictedConflict[], relations: [] as PredictedRelation[], questions: [] as PredictedQuestion[], judge: { answers: 0, uncited: 0 } };
  const memo = new Map<string, string>();
  const tally = emptyTally();
  for (let i = 0; i < input.claims.length; i++) {
    const side = sides.get(input.claims[i].id)!;
    // What was known when this claim came in: the seeds and every claim before it; the k nearest of each kind.
    const known = [...seedRefs, ...input.claims.slice(0, i).map((c) => c.id)];
    const neighbours = async (): Promise<Neighbour[]> => {
      const v = vectors.get(side.ref.id)!;
      const scored = known.map((r) => ({ side: sides.get(r)!, cosine: cosine(v, vectors.get(r)!) }));
      return (['claim', 'fact', 'lesson'] as const).flatMap((k) => scored.filter((n) => n.side.ref.kind === k).sort((x, y) => y.cosine - x.cosine).slice(0, CONFLICT_NEIGHBOURS));
    };
    await detectFor(side, {
      neighbours, linked: () => false, llm,
      memo: { get: async (k) => memo.get(k) ?? null, set: async (k, v) => void memo.set(k, v) },
      sink: {
        conflict: async (c) => {
          out.conflicts.push({ a: c.a.ref.id, b: c.b.ref.id, kind: c.kind, newer: c.kind === 'supersession' ? c.b.ref.id : null });
          return true;
        },
        question: async (a) => {
          const c = claimById.get(a.ref.id)!;
          out.questions.push({ id: `${c.id}/contradictory`, source: c.source, kind: 'contradictory', askedBy: null, quote: c.quote, span: c.span });
        },
        link: async (a, b, relation) => void out.relations.push({ a: a.ref.id, b: b.ref.id, relation }),
      },
    }, tally);
    if (tally.spent) break;
  }
  out.judge = { answers: tally.judged, uncited: tally.uncited };
  return out;
}

export const intakeEvalPipeline: IntakeEvalPipeline = {
  async extract(source, llm) {
    const r = await extractSource({ title: source.id, kind: source.kind, format: source.format, occurredAt: source.occurredAt, text: source.text }, llm);
    return {
      claims: r.claims.map((c, i) => ({
        id: `c${i + 1}`, type: c.type, speaker: c.speaker, quote: c.quote, span: { start: c.span.start, end: c.span.end }, flags: c.flags,
        statement: c.statement, about: c.about, area: c.scope.area, files: c.scope.files,
      })),
      questions: r.questions.map((q, i) => ({ id: `q${i + 1}`, kind: q.kind, askedBy: q.askedBy, quote: q.quote, span: { start: q.span.start, end: q.span.end } })),
      dropped: r.dropped,
    };
  },
  detect: (input, llm) => detectOverFixture(input, llm),
};
