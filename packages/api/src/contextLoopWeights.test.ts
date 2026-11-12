import type { ActivityInput, Lesson, ProjectThresholds } from '@fb/core';
import { expect, test } from 'vitest';
import { checkBeforeDone, getTaskContext, searchGraph, type ContextDeps } from './context.ts';

// The learning loop's serving writes: Lesson.servingWeight (rank_weight) and a project's own floors (tune_threshold).

const roots = [{ host: '/Users/j/Vibe', container: '/vibe' }];
const FILE = 'src/routes/orders.ts';
const lesson = (id: string, over: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'demo', title: `Title ${id}`, rule: `Rule ${id}`, appliesWhen: 'orders', scope: 'project', paths: [FILE],
  status: 'approved', source: 'postmortem', cause: 'requirement_unstated', missId: `miss:${id}`, createdAt: 't', decidedAt: 't', ...over,
});

/** A search that finds `hits` (by score, best first); the code map ties `tied` lessons to FILE. */
function deps(hits: { lesson: Lesson; score: number }[], o: { tied?: Lesson[]; judged?: string[][]; thresholds?: ProjectThresholds; activity?: ActivityInput[] } = {}): ContextDeps {
  return {
    roots,
    embed: async (texts: string[]) => texts.map(() => [1, 0]),
    k: { searchLessons: async () => hits, relatedMisses: async () => [], recordPreDoneCheck: async () => {} },
    codegraph: { lessonsForPaths: async () => (o.tied ?? []).map((l) => ({ lesson: l, paths: [FILE] })) },
    judge: async (_work: unknown, ls: { lesson: Lesson }[]) => { o.judged?.push(ls.map((h) => h.lesson.id)); return ls.map((h) => ({ lessonId: h.lesson.id, status: 'addressed' as const, why: 'done' })); },
    ...(o.thresholds && { facts: { searchFacts: async () => [], projectThresholds: async () => o.thresholds! } }),
    ...(o.activity && { activity: { record: async (a: ActivityInput) => { o.activity!.push(a); } } }),
  } as unknown as ContextDeps;
}
const ask = (d: ContextDeps) => getTaskContext({ files: [FILE], project: 'demo', task: 'order search' }, d);
const ids = (r: { lessons: { lesson: Lesson }[] }) => r.lessons.map((h) => h.lesson.id);

test('no weight anywhere: the order is the search order, as before', async () => {
  const hits = [0.9, 0.85, 0.8].map((s, i) => ({ lesson: lesson(`l${i}`), score: s }));
  expect(ids(await ask(deps(hits)))).toEqual(['l0', 'l1', 'l2']);
});

test('a weight breaks a near-tie among weighted file-tied lessons, never a clear lead', async () => {
  const hits = [
    { lesson: lesson('a'), score: 0.9 },
    { lesson: lesson('b', { servingWeight: 0.6 }), score: 0.81 },
    { lesson: lesson('c', { servingWeight: 1.4 }), score: 0.8 },
    { lesson: lesson('d', { servingWeight: 1.5 }), score: 0.7 },
  ];
  expect(ids(await ask(deps(hits)))).toEqual(['a', 'c', 'b', 'd']);
});

test('a weight never moves a lesson past an unweighted one, so it never changes what crosses the cut', async () => {
  const hits = Array.from({ length: 8 }, (_, i) => ({ lesson: lesson(`l${i}`, i === 7 ? { servingWeight: 1.5 } : {}), score: 0.9 - i * 0.002 }));
  const plain = ids(await ask(deps(hits.map((h) => ({ ...h, lesson: { ...h.lesson, servingWeight: undefined } })))));
  expect(plain).toEqual(['l0', 'l1', 'l2', 'l3', 'l4', 'l5']);
  expect(ids(await ask(deps(hits)))).toEqual(plain);
});

test('a weight never admits a lesson: untied, another project\'s, or no-miss stay out however heavy', async () => {
  const heavy = { servingWeight: 1.5 };
  const hits = [
    { lesson: lesson('tied'), score: 0.8 },
    { lesson: lesson('untied', { ...heavy, paths: ['src/other.ts'] }), score: 0.99 },
    { lesson: lesson('elsewhere', { ...heavy, projectKey: 'other' }), score: 0.99 },
    { lesson: lesson('nomiss', { ...heavy, checks: [{ name: 'no-miss' }] as unknown as Lesson['checks'] }), score: 0.99 },
  ];
  expect(ids(await ask(deps(hits)))).toEqual(['tied']);
  // Nor in search_graph: there the untied one is a search match by meaning (its score), after the tied one; another
  // project's or a no-miss lesson never.
  const s = await searchGraph({ project: 'demo', query: 'order search', files: [FILE] } as never, deps(hits));
  expect(s.markdown).toMatch(/lesson tied · relevance[\s\S]*lesson untied · match [\d.]+, by meaning: check it applies/);
  expect(s.markdown).not.toMatch(/lesson (elsewhere|nomiss)/);
});

test('code-map lessons the search did not find: ordered by weight among themselves, after the found ones', async () => {
  const found = { lesson: lesson('found'), score: 0.7 };
  const light = lesson('light', { servingWeight: 0.6 });
  const plain = lesson('plain');
  const heavy = lesson('heavy', { servingWeight: 1.4 });
  const r = await ask(deps([found], { tied: [found.lesson, light, plain, heavy] }));
  expect(ids(r)).toEqual(['found', 'heavy', 'plain', 'light']);
});

test('check_before_done judges the same weighted order, and nothing the weight did not already tie', async () => {
  const judged: string[][] = [];
  const hits = [
    { lesson: lesson('a'), score: 0.9 },
    { lesson: lesson('c', { servingWeight: 0.5 }), score: 0.89 },
    { lesson: lesson('b', { servingWeight: 1.5 }), score: 0.885 },
    { lesson: lesson('x', { servingWeight: 1.5, paths: ['src/other.ts'] }), score: 0.95 },
  ];
  await checkBeforeDone({ filesChanged: [FILE], project: 'demo', task: 'order search', summary: 'added search' }, deps(hits, { judged }));
  expect(judged).toEqual([['a', 'b', 'c']]);
});

test("a project's own floors replace the defaults for its facts, and get_task_context records what it served under them", async () => {
  const fact = (id: string, path: string, score: number) => ({ fact: { id, path, statement: `fact ${id}`, kind: 'convention', relevance: 0.9 } as never, score });
  const facts = [fact('f1', 'src/routes/orders.ts', 0.9), fact('f2', 'src/routes/items.ts', 0.765)];
  const run = async (thresholds?: ProjectThresholds) => {
    const activity: ActivityInput[] = [];
    const d = deps([{ lesson: lesson('a'), score: 0.9 }], { activity });
    d.facts = { searchFacts: async () => facts, ...(thresholds && { projectThresholds: async () => thresholds }) };
    const r = await ask(d);
    return { served: r.facts.map((h) => h.fact.id), details: activity[0].details as Record<string, unknown> };
  };
  const plain = await run();
  expect(plain.served).toEqual(['f1']);
  // f2 is under the default similarity floor (0.78) but within TUNE_MARGIN of it: recorded as what a lower floor adds.
  expect(plain.details.floors).toEqual({ similarity: 0.78, factRank: 0.8 });
  expect(plain.details.facts).toEqual([expect.objectContaining({ id: 'f1', score: 0.9, rankingScore: expect.any(Number) })]);
  expect(plain.details.factsBelow).toEqual([expect.objectContaining({ id: 'f2', path: 'src/routes/items.ts', score: 0.765 })]);
  const lowered = await run({ similarityFloor: 0.76, factRankFloor: 0.77 });
  expect(lowered.served).toEqual(['f1', 'f2']);
  expect(lowered.details.floors).toEqual({ similarity: 0.76, factRank: 0.77 });
  expect(lowered.details.factsBelow).toBeUndefined();
  // Defaults where the project has none of its own.
  expect((await run({ similarityFloor: null, factRankFloor: null })).served).toEqual(['f1']);
});

test('a named file\'s own fact, served whatever the floors, is never recorded as one a lower floor would add', async () => {
  const own = { id: 'f3', path: FILE, statement: 'fact f3', kind: 'convention', relevance: 0.9 } as never;
  const activity: ActivityInput[] = [];
  const d = deps([{ lesson: lesson('a'), score: 0.9 }], { activity });
  d.facts = { searchFacts: async () => [{ fact: own, score: 0.765 }], listFacts: async () => [own] } as never;
  const r = await ask(d);
  expect(r.fileFacts?.map((f) => f.id)).toEqual(['f3']);
  expect((activity[0].details as Record<string, unknown>).factsBelow).toBeUndefined();
});

test("search_graph says the project's own similarity floor", async () => {
  const d = deps([], { thresholds: { similarityFloor: 0.8, factRankFloor: null } });
  d.facts = { searchFacts: async () => [], projectThresholds: async () => ({ similarityFloor: 0.8, factRankFloor: null }) };
  const s = await searchGraph({ project: 'demo', query: 'order search' }, d);
  expect(s.markdown).toContain('similarity 0.800');
});

test('search_graph finds an approved lesson by its own words with no file named, as a search match; below the floor it says so', async () => {
  const hit = { lesson: lesson('scoped', { title: 'Routes read data only through db.scoped(orgId)', rule: 'Every route reads through db.scoped(orgId).' }), score: 0.91 };
  const s = await searchGraph({ project: 'demo', query: 'Routes read data only through db.scoped(orgId)' }, deps([hit]));
  expect(s.markdown).toMatch(/## Approved lessons\n- \*\*Routes read data only through db\.scoped\(orgId\)\*\*[^\n]*\n {2}- applies when: orders · lesson scoped · match 0\.91, by meaning: check it applies/);
  expect(s.markdown).not.toContain('No approved lesson');
  const far = await searchGraph({ project: 'demo', query: 'purple elephant' }, deps([{ ...hit, score: 0.4 }]));
  expect(far.markdown).toMatch(/No approved lesson is close enough to this query \(none at or above similarity 0\.\d{3}\)/);
  expect(far.markdown).not.toContain('lesson scoped');
});
