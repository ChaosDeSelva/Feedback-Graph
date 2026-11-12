import { ACME_LESSONS, ACME_TASKS, cosine } from '@fb/core/testing/lessons';
import type { Lesson, LessonHit } from '@fb/core';
import { getTaskContext, searchGraph, type ContextDeps } from './context.ts';

/**
 * Retrieval on the labelled acme corpus (core testing/lessonCorpus.ts: ACME_LESSONS and ACME_TASKS), with any
 * embedder: each task through the serving path (get_task_context, search_graph) and through the bare vector ranking, scored
 * by precision and recall@k against the lessons that apply. Its job is to calibrate the similarity thresholds
 * (core thresholds.ts): scripts/retrieval-eval.ts runs it on the real nomic-embed-text. Scores are in the stores' unit,
 * (1 + cos) / 2, as every floor is.
 */

export type EvalEmbed = (texts: string[]) => Promise<number[][]>;
/** precision and recall of one returned set (null: nothing applies, so recall has no meaning). */
export type PR = { precision: number | null; recall: number | null; returned: number };
export type TaskScore = {
  task: string; applies: string[];
  /** The top lessons by score (store units), best first. */
  top: { id: string; score: number }[];
  atK: Record<number, PR>;
  /** Lessons at or above the serve-by-meaning floor. */
  aboveFloor: PR & { ids: string[] };
  served: { getTaskContext: PR & { ids: string[] }; searchGraph: PR & { ids: string[] } };
  /** The lowest score of a lesson that applies, and the highest of one that does not. */
  lowestApplies: number | null; highestOther: number;
};
export type RetrievalReport = {
  model: string; floor: number; k: number[]; tasks: TaskScore[];
  overall: { atK: Record<number, PR>; aboveFloor: PR; getTaskContext: PR; searchGraph: PR; nonsenseServed: number };
  /** Every applying lesson's score, and every other lesson's in a task's top 5: where a floor would separate them. */
  separation: { applies: number[]; others: number[] };
};

const ROOTS = [{ host: '/Users/j/Vibe', container: '/vibe' }];
const storeScore = (cos: number) => (1 + cos) / 2;
const lessonText = (l: Lesson) => `${l.title}\n${l.rule}\nApplies when: ${l.appliesWhen}`;

export function pr(returned: string[], applies: string[]): PR {
  const hit = returned.filter((id) => applies.includes(id)).length;
  return { precision: returned.length ? hit / returned.length : null, recall: applies.length ? hit / applies.length : null, returned: returned.length };
}
const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const meanPR = (xs: PR[]): PR => ({ precision: mean(xs.map((x) => x.precision)), recall: mean(xs.map((x) => x.recall)), returned: xs.reduce((a, x) => a + x.returned, 0) });

/** search_graph lists a lesson as "... · lesson <id> · ...": the lessons it served. */
const servedIn = (md: string) => [...new Set([...md.matchAll(/· lesson (\S+) ·/g)].map((m) => m[1]))];

export async function runRetrievalEval(embed: EvalEmbed, o: { model: string; floor: number; k?: number[] }): Promise<RetrievalReport> {
  const k = o.k ?? [1, 3, 5];
  const vectors = await embed(ACME_LESSONS.map(lessonText));
  const tasks: TaskScore[] = [];
  const separation = { applies: [] as number[], others: [] as number[] };
  for (const t of ACME_TASKS) {
    const [q] = await embed([t.task]);
    const ranked: LessonHit[] = ACME_LESSONS.map((lesson, i) => ({ lesson, score: storeScore(cosine(q, vectors[i])) })).sort((a, b) => b.score - a.score);
    let last = q;
    const deps = {
      roots: ROOTS, exists: () => true, similarityFloor: o.floor,
      embed: async (texts: string[]) => { const v = await embed(texts); last = v[0]; return v; },
      k: {
        searchLessons: async (s: { k: number }) => ACME_LESSONS.map((lesson, i) => ({ lesson, score: storeScore(cosine(last, vectors[i])) })).sort((a, b) => b.score - a.score).slice(0, s.k),
        relatedMisses: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'manual:1',
      },
      judge: async () => [], activity: { record: async () => {} },
    } as unknown as ContextDeps;
    const ctx = await getTaskContext({ cwd: '/Users/j/Vibe/acme', task: t.task, ...(t.files && { files: t.files }) }, deps);
    const sg = await searchGraph({ cwd: '/Users/j/Vibe/acme', query: t.task }, deps);
    const gtc = ctx.lessons.map((h) => h.lesson.id);
    const sgIds = servedIn(sg.markdown);
    const above = ranked.filter((h) => h.score >= o.floor).map((h) => h.lesson.id);
    const ids = ranked.map((h) => h.lesson.id);
    for (const h of ranked) if (t.applies.includes(h.lesson.id)) separation.applies.push(h.score);
    for (const h of ranked.slice(0, 5)) if (!t.applies.includes(h.lesson.id)) separation.others.push(h.score);
    const applying = ranked.filter((h) => t.applies.includes(h.lesson.id)).map((h) => h.score);
    tasks.push({
      task: t.task, applies: t.applies, top: ranked.slice(0, 5).map((h) => ({ id: h.lesson.id, score: Math.round(h.score * 1000) / 1000 })),
      atK: Object.fromEntries(k.map((n) => [n, pr(ids.slice(0, n), t.applies)])),
      aboveFloor: { ...pr(above, t.applies), ids: above },
      served: { getTaskContext: { ...pr(gtc, t.applies), ids: gtc }, searchGraph: { ...pr(sgIds, t.applies), ids: sgIds } },
      lowestApplies: applying.length ? Math.min(...applying) : null,
      highestOther: Math.max(...ranked.filter((h) => !t.applies.includes(h.lesson.id)).map((h) => h.score)),
    });
  }
  const nonsense = tasks.filter((t) => !t.applies.length);
  return {
    model: o.model, floor: o.floor, k, tasks, separation,
    overall: {
      atK: Object.fromEntries(k.map((n) => [n, meanPR(tasks.filter((t) => t.applies.length).map((t) => t.atK[n]))])),
      aboveFloor: meanPR(tasks.map((t) => t.aboveFloor)),
      getTaskContext: meanPR(tasks.map((t) => t.served.getTaskContext)),
      searchGraph: meanPR(tasks.map((t) => t.served.searchGraph)),
      nonsenseServed: nonsense.reduce((n, t) => n + t.served.searchGraph.returned + t.served.getTaskContext.returned, 0),
    },
  };
}

const f = (x: number | null) => (x === null ? '  -  ' : x.toFixed(2));
const line = (name: string, p: PR) => `${name.padEnd(28)} P ${f(p.precision)}  R ${f(p.recall)}  (${p.returned} returned)`;

/** The report as text: per task, then overall, then where a floor would separate applying lessons from the rest. */
export function formatRetrievalReport(r: RetrievalReport): string {
  const out = [`Retrieval eval: ${r.model}, serve-by-meaning floor ${r.floor} (store score, (1+cos)/2)`, ''];
  for (const t of r.tasks) {
    out.push(`- ${t.task}`, `  applies: ${t.applies.join(', ') || '(none)'}`, `  top: ${t.top.map((h) => `${h.id} ${h.score.toFixed(3)}`).join(', ')}`);
    out.push(`  ${r.k.map((n) => `@${n} P ${f(t.atK[n].precision)} R ${f(t.atK[n].recall)}`).join(' | ')} | above floor: ${t.aboveFloor.ids.join(', ') || '(none)'}`);
    out.push(`  get_task_context: ${t.served.getTaskContext.ids.join(', ') || '(none)'} | search_graph: ${t.served.searchGraph.ids.join(', ') || '(none)'}`);
  }
  out.push('', 'Overall (precision over tasks that returned something, recall over tasks with an applying lesson):');
  for (const n of r.k) out.push(line(`vector ranking @${n}`, r.overall.atK[n]));
  out.push(line('at or above the floor', r.overall.aboveFloor), line('get_task_context served', r.overall.getTaskContext), line('search_graph served', r.overall.searchGraph));
  out.push(`nonsense tasks served: ${r.overall.nonsenseServed} lessons`);
  const lo = Math.min(...r.separation.applies);
  const hiOthers = [...r.separation.others].sort((a, b) => b - a);
  const above = (x: number) => hiOthers.filter((s) => s >= x).length;
  out.push('', `Separation: applying lessons score ${lo.toFixed(3)} to ${Math.max(...r.separation.applies).toFixed(3)}; the top-5 non-applying ones ${Math.min(...hiOthers).toFixed(3)} to ${hiOthers[0].toFixed(3)}.`);
  for (const x of [0.75, 0.78, 0.8, 0.82, 0.85]) out.push(`  floor ${x.toFixed(2)}: keeps ${r.separation.applies.filter((s) => s >= x).length}/${r.separation.applies.length} applying, lets in ${above(x)} non-applying (top 5)`);
  return out.join('\n');
}
