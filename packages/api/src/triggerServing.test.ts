import { shownProjects, type ActivityInput, type Lesson, type LessonFilter, type LessonTriggers, type RelatedMiss } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { checkBeforeDone, getTaskContext, makeJudge, type ContextDeps } from './context.ts';

// Lessons reach the work by their triggers (core lessonTriggers.ts) beside the embedding: a task's files and words, or a
// change's diff, fire them however far the search ranked them. Past misses reach it only with a file in common or when
// close (missAdmitted).

const roots = [{ host: '/Users/j/Vibe', container: '/vibe' }];
const none: LessonTriggers = { paths: [], patterns: [], symbols: [] };
const lesson = (id: string, triggers: LessonTriggers | null, over: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'demo', origin: 'demo', title: `Lesson ${id}`, rule: `Rule of ${id}`, appliesWhen: 'when it applies', scope: 'project', paths: [],
  status: 'approved', source: 'postmortem', cause: 'requirement_unstated', missId: `miss:${id}`, createdAt: 't', decidedAt: 't', triggers, ...over,
});
const query = lesson('lq', { ...none, paths: ['db/**/*.sql'], patterns: ['CREATE\\s+(UNIQUE\\s+)?INDEX'] }, { title: 'Show EXPLAIN evidence', rule: 'Every query or index change carries EXPLAIN ANALYZE before and after' });
const loop = lesson('ll', { ...none, symbols: ['asyncio.to_thread', 'FlushBatch'] }, { title: 'Keep blocking calls off the loop' });
const miss = (missId: string, missed: string, score: number): RelatedMiss => ({ missId, missed, cause: 'requirement_unstated', feedbackText: 'no', sessionId: `s-${missId}`, ts: '2026-10-01T10:00:00Z', score });

function deps(o: { lessons?: Lesson[]; listed?: (f: LessonFilter) => void; misses?: RelatedMiss[]; over?: Partial<ContextDeps> } = {}) {
  const recorded: ActivityInput[] = [];
  const judged: string[][] = [];
  const d: ContextDeps = {
    roots,
    embed: async (texts) => texts.map(() => [1, 0]),
    k: {
      searchLessons: async () => [],
      relatedMisses: async () => o.misses ?? [],
      missesNaming: async () => [],
      recordPreDoneCheck: async () => {},
      createManualFeedback: async () => 'manual:1',
      listLessons: async (f) => { o.listed?.(f); return f.status === 'approved' ? o.lessons ?? [] : []; },
    },
    judge: async (_w, hits) => { judged.push(hits.map((h) => h.lesson.id)); return hits.map((h) => ({ lessonId: h.lesson.id, status: 'not_addressed' as const, applies: true, why: 'no EXPLAIN in the PR', evidence: [] })); },
    activity: { record: async (a) => { recorded.push(a); } },
    ...o.over,
  };
  return { d, recorded, judged };
}

const SQL_DIFF = [
  'diff --git a/db/migrations/0042_edge.sql b/db/migrations/0042_edge.sql',
  '--- /dev/null',
  '+++ b/db/migrations/0042_edge.sql',
  '@@ -0,0 +1 @@',
  '+create index graph_edge_departed on graph_edge (departed_at);',
].join('\n');

describe('get_task_context serves the lessons whose triggers fire', () => {
  test('on a named file and on the task\'s words, each saying which trigger fired; the activity entry records it', async () => {
    const { d, recorded } = deps({ lessons: [query, loop] });
    const r = await getTaskContext({ project: 'demo', task: 'move the FlushBatch commit off the event loop', files: ['db/migrations/0042_edge.sql'] }, d);
    // A name the task uses is more specific than a glob, so it comes first.
    expect(r.lessons.map((h) => h.lesson.id)).toEqual(['ll', 'lq']);
    expect(r.markdown).toContain('## Approved lessons (follow these)');
    expect(r.markdown).toContain('lesson lq · why served: trigger path `db/**/*.sql` matched db/migrations/0042_edge.sql');
    expect(r.markdown).toContain('lesson ll · why served: trigger symbol `FlushBatch` is in the task');
    const served = recorded.find((a) => a.kind === 'context_served')!.details as { lessons: { id: string; trigger?: unknown }[] };
    expect(served.lessons.find((l) => l.id === 'lq')!.trigger).toEqual({ kind: 'path', trigger: 'db/**/*.sql', on: 'db/migrations/0042_edge.sql' });
  });

  test('nothing fires: nothing served; lessons with no triggers, of another project or that found no miss are never matched', async () => {
    const other = lesson('lo', { ...none, symbols: ['FlushBatch'] }, { projectKey: 'api', origin: 'api' });
    const noMiss = lesson('ln', { ...none, symbols: ['FlushBatch'] }, { checks: [{ name: 'no-miss', why: 'none' }] });
    const listed: LessonFilter[] = [];
    const { d } = deps({ lessons: [lesson('lx', null), lesson('le', none), other, noMiss], listed: (f) => listed.push(f) });
    const r = await getTaskContext({ project: 'demo', task: 'commit the FlushBatch' }, d);
    expect(r.lessons).toEqual([]);
    expect(listed[0]).toMatchObject({ projectKey: 'demo', status: 'approved', limit: 1000 });
    // With a project selection, only lessons learned in the shown projects are read.
    const shownListed: LessonFilter[] = [];
    const shown = deps({ lessons: [loop], listed: (f) => shownListed.push(f), over: { shown: () => shownProjects({ tracked: ['demo'], initialized: true }, { excludeProjects: [] }) } });
    expect((await getTaskContext({ project: 'demo', task: 'commit the FlushBatch' }, shown.d)).lessons.map((h) => h.lesson.id)).toEqual(['ll']);
    expect(shownListed[0]).toMatchObject({ projectKeys: ['demo'] });
    // A store without listLessons has no pool to match.
    const bare = deps();
    delete (bare.d.k as Partial<ContextDeps['k']>).listLessons;
    expect((await getTaskContext({ project: 'demo', task: 'commit the FlushBatch' }, bare.d)).lessons).toEqual([]);
  });

  test('a lesson already tied to a named file says its trigger too; at most six more come from triggers alone', async () => {
    const tied = lesson('lt', { ...none, symbols: ['FlushBatch'] }, { paths: ['src/sync/storage.py'] });
    const many = Array.from({ length: 8 }, (_, i) => lesson(`m${i}`, { ...none, symbols: ['FlushBatch'] }));
    const { d } = deps({ lessons: [tied, ...many], over: { codegraph: { lessonsForPaths: async () => [{ lesson: tied, paths: ['src/sync/storage.py'] }] } } });
    const r = await getTaskContext({ project: 'demo', task: 'commit the FlushBatch', files: ['src/sync/storage.py'] }, d);
    expect(r.lessons.map((h) => h.lesson.id)).toEqual(['lt', 'm0', 'm1', 'm2', 'm3', 'm4', 'm5']);
    expect(r.markdown).toContain('lesson lt · touches src/sync/storage.py · why served: trigger symbol `FlushBatch` is in the task');
  });

  test('brief mode serves them too, with the trigger', async () => {
    const { d, recorded } = deps({ lessons: [loop] });
    const r = await getTaskContext({ project: 'demo', task: 'use asyncio.to_thread for the batch', brief: true, files: ['src/sync/storage.py'] }, d);
    expect(r.markdown).toContain('lesson ll · why served: trigger symbol `asyncio.to_thread` is in the task');
    expect((recorded[0].details as { lessons: { trigger?: unknown }[] }).lessons[0].trigger).toMatchObject({ kind: 'symbol' });
  });

  test('a folder that is only under a root (global lessons only) gets no project lessons by trigger', async () => {
    const { d } = deps({ lessons: [loop], over: { inScope: async () => false, servesGlobal: async () => true } });
    const r = await getTaskContext({ cwd: '/Users/j/Vibe/demo', task: 'use asyncio.to_thread' }, d);
    expect(r.lessons).toEqual([]);
  });
});

describe('check_before_done judges the lessons whose triggers fire on the change', () => {
  test('a pattern on an added line of the diff: judged, and the judge is told why it was chosen', async () => {
    let prompt = '';
    const judge = makeJudge({ id: 'fake', agentic: false, json: async (t) => { prompt = t.user; return { verdicts: [{ lessonId: 'L1', status: 'not_addressed', applies: true, why: 'no EXPLAIN', evidence: ['+create index graph_edge_departed on graph_edge (departed_at);'] }] }; } });
    const { d } = deps({ lessons: [lesson('lq', { ...none, patterns: ['CREATE\\s+INDEX'] })], over: { judge } });
    const r = await checkBeforeDone({ project: 'demo', task: 'add departure columns', summary: 'added an index', diff: SQL_DIFF }, d);
    expect(r.gaps.map((g) => g.lessonId)).toEqual(['lq']);
    expect(prompt).toContain('selected because its trigger pattern `CREATE\\s+INDEX` matched an added line in db/migrations/0042_edge.sql');
  });

  test('a secret file in the diff fires no trigger, so its name never reaches the judge (sweep 4 NEW-3)', async () => {
    const secret = (header: string, path: string) => [header, `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1,2 @@', ' A=1', '+HOOK=sendError(x)'].join('\n');
    const diff = [
      secret('diff --git a/config/prod.env b/config/prod.env', 'config/prod.env'),
      secret('diff --git "a/caf\\303\\251/.env" "b/caf\\303\\251/.env"', 'café/.env'),
    ].join('\n');
    const { d, judged } = deps({ lessons: [lesson('ls', { ...none, symbols: ['sendError'] }), lesson('lp', { ...none, paths: ['config/*.env', '**/.env'] })] });
    const r = await checkBeforeDone({ project: 'demo', task: 'wire the hook', summary: 's', diff }, d);
    expect(judged).toEqual([]);
    expect(r.markdown).not.toMatch(/prod\.env|café/);
    // The same line in an ordinary file fires.
    await checkBeforeDone({ project: 'demo', task: 'wire the hook', summary: 's', diff: secret('diff --git a/src/hook.ts b/src/hook.ts', 'src/hook.ts') }, d);
    expect(judged).toEqual([['ls']]);
  });

  test('a path trigger fires on a file the diff changes that files_changed left out', async () => {
    const { d, judged } = deps({ lessons: [query] });
    await checkBeforeDone({ project: 'demo', task: 'edges', summary: 's', diff: SQL_DIFF, filesChanged: ['src/x.ts'] }, d);
    expect(judged).toEqual([['lq']]);
  });

  test('a lesson judged only because its trigger fired on other files: its verdict is recorded trigger-only, so the learning loop does not count it', async () => {
    const tied = lesson('lt', none, { paths: ['db/migrations/0042_edge.sql'] });
    const { d, recorded } = deps({ lessons: [query, tied], over: { codegraph: { lessonsForPaths: async () => [{ lesson: tied, paths: ['db/migrations/0042_edge.sql'] }] } as never } });
    await checkBeforeDone({ project: 'demo', task: 'edges', summary: 's', diff: SQL_DIFF, filesChanged: ['db/migrations/0042_edge.sql'] }, d);
    const verdicts = recorded.find((a) => a.kind === 'predone_check')!.details!.verdicts as { lessonId: string; triggerOnly?: true }[];
    expect(verdicts.map((v) => [v.lessonId, v.triggerOnly ?? false])).toEqual([['lt', false], ['lq', true]]);
  });

  test('lessons tied to the changed file but ranked below the top six are not trigger-only: their own-path trigger brought them back', async () => {
    const charge = 'src/payments/charge.ts';
    const tied = Array.from({ length: 8 }, (_, i) => lesson(`w0${i + 1}`, { ...none, paths: ['src/payments/*.ts', charge] }, { paths: [charge] }));
    const viaMiss = lesson('wm', { ...none, paths: ['src/payments/*.ts'] });
    const { d, recorded } = deps({ lessons: [...tied, viaMiss], over: { codegraph: { lessonsForPaths: async () => [...tied, viaMiss].map((l) => ({ lesson: l, paths: [charge] })) } } });
    await checkBeforeDone({ project: 'demo', task: 'charge in cents', summary: 's', filesChanged: [charge] }, d);
    const verdicts = recorded.find((a) => a.kind === 'predone_check')!.details!.verdicts as { lessonId: string; triggerOnly?: true }[];
    expect(verdicts.map((v) => v.lessonId)).toEqual(expect.arrayContaining(['w07', 'w08', 'wm']));
    expect(verdicts.filter((v) => v.triggerOnly)).toEqual([]);
  });

  test('no diff given: the repository\'s diff is read once, for the triggers and the judge alike', async () => {
    let reads = 0;
    const { d, judged } = deps({ lessons: [loop], over: { repoDiff: async () => { reads++; return { text: SQL_DIFF.replace('create index', 'asyncio.to_thread(batch.commit) #'), files: ['db/migrations/0042_edge.sql'] }; } } });
    await checkBeforeDone({ project: 'demo', task: 'edges', summary: 's', filesChanged: ['db/migrations/0042_edge.sql'] }, d);
    expect(judged).toEqual([['ll']]);
    expect(reads).toBe(1);
  });

  test('only path triggers: the repository\'s diff is not read for them; a failing read is no diff', async () => {
    let reads = 0;
    const { d, judged } = deps({ lessons: [lesson('lp', { ...none, paths: ['db/**'] })], over: { repoDiff: async () => { reads++; throw new Error('git failed'); } } });
    await checkBeforeDone({ project: 'demo', task: 'edges', summary: 's', filesChanged: ['db/migrations/0042_edge.sql'] }, d);
    expect(judged).toEqual([['lp']]);
    // Read once, by the judge (and failing there, it is judged from the summary).
    expect(reads).toBe(1);
    const lines = deps({ lessons: [loop], over: { repoDiff: async () => { throw new Error('git failed'); } } });
    const r = await checkBeforeDone({ project: 'demo', task: 'edges', summary: 's', filesChanged: ['db/migrations/0042_edge.sql'] }, lines.d);
    expect(lines.judged).toEqual([]);
    expect(r.markdown).toMatch(/No past lessons apply/);
  });

  test('nothing fires: no lesson is judged', async () => {
    const { d, judged } = deps({ lessons: [loop] });
    await checkBeforeDone({ project: 'demo', task: 'edges', summary: 's', diff: SQL_DIFF }, d);
    expect(judged).toEqual([]);
  });
});

describe('a past miss is served or judged only with a file in common or when close', () => {
  test('get_task_context: a miss below the bar is left out without a shared file, kept with one; the bar is configurable', async () => {
    const far = miss('far', 'left a client checked out in src/db/pool.ts', 0.84);
    expect((await getTaskContext({ project: 'demo', task: 'tune the pool' }, deps({ misses: [far] }).d)).misses).toEqual([]);
    expect((await getTaskContext({ project: 'demo', task: 'tune the pool', files: ['src/db/pool.ts'] }, deps({ misses: [far] }).d)).misses.map((m) => m.missId)).toEqual(['far']);
    expect((await getTaskContext({ project: 'demo', task: 'tune the pool' }, deps({ misses: [far], over: { missClose: 0.8 } }).d)).misses.map((m) => m.missId)).toEqual(['far']);
    expect((await getTaskContext({ project: 'demo', task: 'tune the pool' }, deps({ misses: [{ ...far, score: 0.86 }] }).d)).misses.map((m) => m.missId)).toEqual(['far']);
  });

  test('check_before_done: a topical miss below the bar is not judged; one above it is', async () => {
    const pool = (score: number) => [miss('pool', 'the pool leaked clients on error', score)];
    const low = deps({ misses: pool(0.84) });
    const r = await checkBeforeDone({ project: 'demo', task: 'pool leaked clients', summary: 'fixed the pool' }, low.d);
    expect(low.judged).toEqual([]);
    expect(r.markdown).toMatch(/No confirmed miss resembles this work/);
    const high = deps({ misses: pool(0.9) });
    await checkBeforeDone({ project: 'demo', task: 'pool leaked clients', summary: 'fixed the pool' }, high.d);
    expect(high.judged).toEqual([['pool']]);
  });

  test('a linked project\'s miss needs the bar too (it shares no file with this project)', async () => {
    const link = { id: 'link:api|demo', a: 'api', b: 'demo', relation: 'same_product' as const, note: '', status: 'confirmed' as const, source: 'you' as const, score: 0, evidence: [], createdAt: 't', updatedAt: 't', decidedBy: 'you' };
    const run = async (score: number) => {
      const { d } = deps({ over: { links: { listLinks: async () => [link] } } });
      d.k.relatedMisses = async (q) => (q.projectKey === 'api' ? [miss('ma', 'broke the v1 response shape', score)] : []);
      return (await getTaskContext({ project: 'demo', task: 'change the response' }, d)).linked.flatMap((x) => x.misses.map((m) => m.missId));
    };
    expect(await run(0.8)).toEqual([]);
    expect(await run(0.9)).toEqual(['ma']);
  });

  test('an embedder calibrated below the default floor sets the miss bar to that floor unless one is configured', async () => {
    const lexical = miss('lex', 'migration omitted', 0.2);
    expect((await getTaskContext({ project: 'demo', task: 'migrations' }, deps({ misses: [lexical], over: { similarityFloor: 0.05 } }).d)).misses.map((m) => m.missId)).toEqual(['lex']);
    expect((await getTaskContext({ project: 'demo', task: 'migrations' }, deps({ misses: [lexical], over: { similarityFloor: 0.05, missClose: 0.5 } }).d)).misses).toEqual([]);
    // An out-of-range setting is not a bar.
    expect((await getTaskContext({ project: 'demo', task: 'migrations' }, deps({ misses: [{ ...lexical, score: 0.86 }], over: { missClose: 7 } }).d)).misses.map((m) => m.missId)).toEqual(['lex']);
  });
});
