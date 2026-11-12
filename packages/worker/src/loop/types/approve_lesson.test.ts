import { describe, expect, test } from 'vitest';
import { indexMatches, LESSON_CHECKS_VERSION, LOOP_ACTOR, lessonSnapshot, pathIndex, pathMatches, type Candidate, type CandidateDetail, type Decision, type Lesson, type LessonDetail, type LessonSignals, type LlmProvider, type LoopMiss } from '@fb/core';
import { activity, axis, fakeContext, loopMiss, observedAs } from '../testing/context.ts';
import { detail, lesson } from '../testing/lessons.ts';
import { LoopBudgetSpent } from '../budget.ts';
import { score } from '../policy.ts';
import type { LoopTypeContext } from '../plugin.ts';
import { approveCandidate, approveLesson, namedLessons, ownerQuality, pathsResolve, QUALITY_MIN_DECIDED, repeatsOf, replayWork } from './approve_lesson.ts';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const DIFF = '@@ -1,2 +1,2 @@\n context\n-old()\n+console.log(x)';

const candidate = (id: string, o: Partial<Candidate> = {}): Candidate => ({
  id, turnUuid: `t-${id}`, sessionId: `s-${id}`, projectKey: 'demo', source: 'claude', classification: {} as Candidate['classification'], status: 'confirmed',
  createdAt: '2026-10-31T00:00:00.000Z', decidedAt: '2026-10-31T01:00:00.000Z', note: null, decidedBy: 'you', ...o,
});
const turn = (o: Partial<CandidateDetail['turn']> = {}): CandidateDetail['turn'] =>
  ({ uuid: 't', sessionId: 's', ts: '2026-10-31T00:00:00.000Z', index: 3, text: 'no, not like that', precedingAssistantText: 'I added logging', precedingToolCalls: [], ...o });
const inbox = (c: Candidate, t: Partial<CandidateDetail['turn']> = {}): CandidateDetail =>
  ({ candidate: c, turn: turn(t), before: [turn({ text: 'add the feature' })], after: [], commits: [], postmortem: null });
const ext = (diffHunk: string | null) => ({ source: 'github', kind: 'review_comment', author: 'r', url: 'u', thread: 'th', title: 'PR title', threadUrl: 'tu', path: 'src/a.ts', line: 1, diffHunk, branch: null, createdAt: 't', linkedSessionIds: [], description: 'the description' }) as unknown as Candidate['external'];
/** Ten of your decisions in demo, `asWritten` of them approved as written. */
const decided = (asWritten: number, o: Partial<Lesson> = {}) => Array.from({ length: QUALITY_MIN_DECIDED }, (_, i) => lesson(`lesson:d${i}`, {
  status: i < asWritten ? 'approved' : 'rejected', decidedAt: '2026-11-05T00:00:00.000Z', decidedBy: 'you', ...o,
}));

type World = {
  details?: LessonDetail[]; inbox?: Record<string, CandidateDetail>; decided?: Lesson[]; files?: string[] | null; misses?: LoopMiss[];
  links?: { from: string; to: string; decisionId: string; createdAt: string }[]; decisions?: Record<string, Pick<Decision, 'type' | 'status'>[]>;
  signals?: Record<string, LessonSignals>; llm?: LlmProvider | null; entries?: ReturnType<typeof activity>[];
};
const reads: string[] = [];
function world(w: World = {}): LoopTypeContext {
  const ds = w.details ?? [detail(lesson('lesson:f1'))];
  const ctx = fakeContext({
    now: NOW,
    entries: w.entries ?? ds.map((d) => activity('postmortem_done', { targets: [d.feedback?.id ?? 'x', `miss:${d.lesson.id.slice(7)}`, d.lesson.id] })),
    misses: w.misses ?? [loopMiss('miss:f1', { embedding: axis(0) })],
    links: w.links ?? [],
    signals: w.signals,
    store: {
      knowledge: {
        lessonDetail: async (id: string) => { reads.push(id); return ds.find((d) => d.lesson.id === id) ?? null; },
        listLessons: async (f: { status?: string }) => (w.decided ?? decided(8)).filter((l) => l.status === f.status),
      },
      graph: { candidateDetail: async (id: string) => (w.inbox ?? { f1: inbox(candidate('f1')) })[id] ?? null },
      codegraph: { codeMap: async () => (w.files === null ? null : { files: (w.files ?? ['src/a.ts']).map((path) => ({ path })), outside: [{ path: 'src/out.ts' }] }) as never },
      decisions: { forTarget: async (id: string) => (w.decisions?.[id] ?? []) as Decision[] },
    },
  });
  return { ...ctx, llm: w.llm === undefined ? null : w.llm };
}
/** A repeat of miss:f1 (same cause, shared file, cosine 1). */
const repeat = loopMiss('miss:r1', { embedding: axis(0), createdAt: '2026-10-01T00:00:00.000Z' });

function judge(answer: unknown | ((n: number) => unknown)): LlmProvider & { calls: number } {
  const p = { id: 'ollama:gemma4', agentic: false, calls: 0, json: async () => { p.calls++; const a = typeof answer === 'function' ? (answer as (n: number) => unknown)(p.calls) : answer; if (a instanceof Error) throw a; return a; } };
  return p;
}
const flags = { applies: true, status: 'not_addressed', why: 'adds a console call', evidence: ['+console.log(x)'] };
const reviewed = { f1: inbox(candidate('f1', { source: 'github' }), { external: ext(DIFF)! }) };

describe('approveLesson.candidates: a proposed lesson that clears every floor', () => {
  test('its miss repeats: a call to approve it, as the loop, from proposed and undecided', async () => {
    const r = await approveLesson.candidates(world({ misses: [loopMiss('miss:f1', { embedding: axis(0) }), repeat] }));
    expect(r.skipped).toEqual({});
    expect(r.scanned).toBe(1);
    const [c] = r.candidates;
    expect(c.targets).toEqual([{ kind: 'lesson', id: 'lesson:f1', role: 'primary' }]);
    expect(c.before[0].fields).toMatchObject({ status: 'proposed', decidedAt: null, decidedBy: null, decisionNote: null });
    expect(c.after[0].fields).toMatchObject({ status: 'approved', decidedAt: new Date(NOW).toISOString(), decidedBy: LOOP_ACTOR, decisionNote: 'approved by the learning loop: its miss repeats' });
    expect(c.before[0]).toEqual(lessonSnapshot(lesson('lesson:f1')));
    expect(c.evidence.map((e) => `${e.kind}:${e.id}:${e.role}`)).toEqual(['candidate:f1:confirmed by you', 'miss:miss:f1:lesson miss', 'miss:miss:r1:repeated miss']);
    expect(c.features).toEqual({ asWrittenRate: 0.8, asWrittenAbove: 0.5, ownerDecisions: 0.25, repeats: 1 / 3, replayFlagged: 0 });
    expect(c.model).toBeUndefined();
    expect(c.proposeOnly).toBeUndefined();
    expect(c.rationale).toContain('80% of the last 10 lessons in demo');
    expect(c.rationale).toContain('its miss repeats 1 other miss.');
  });
  test('a loop link counts as a repeat too, from either end', async () => {
    const link = { from: 'miss:far', to: 'miss:f1', decisionId: 'dec:x', createdAt: 't' };
    const r = await approveLesson.candidates(world({ misses: [loopMiss('miss:f1', { embedding: axis(0) }), loopMiss('miss:far', { embedding: axis(4) }), loopMiss('miss:out', { embedding: axis(5) })], links: [link] }));
    expect(r.candidates[0].evidence.at(-1)!.id).toBe('miss:far');
  });
  test('no repeat but a synced review comment whose diff the replay judge flags: approved, with the model named', async () => {
    const llm = judge(flags);
    const r = await approveLesson.candidates(world({ inbox: reviewed, llm }));
    expect(llm.calls).toBe(1);
    const [c] = r.candidates;
    expect(c.features.replayFlagged).toBe(1);
    expect(c.model).toBe('ollama:gemma4');
    expect(c.evidence.at(-1)).toMatchObject({ kind: 'lesson', id: 'lesson:f1', role: 'replay judge flags the original diff' });
    expect(c.rationale).toContain('the replay judge, given the work you pushed back on, flags it: adds a console call');
    expect(c.after[0].fields.decisionNote).toBe('approved by the learning loop: the replay judge flags the original diff');
  });
  test('a repeat makes the judge unnecessary: no model call is spent', async () => {
    const llm = judge(flags);
    await approveLesson.candidates(world({ inbox: reviewed, llm, misses: [loopMiss('miss:f1', { embedding: axis(0) }), repeat] }));
    expect(llm.calls).toBe(0);
  });
  test('more evidence scores higher', () => {
    const d = detail(lesson('lesson:f1'));
    const base = { candidate: candidate('f1'), replay: null, now: NOW };
    const weak = approveCandidate(d, { ...base, quality: { decided: 10, rate: 0.6 }, repeats: [repeat] });
    const strong = approveCandidate(d, { ...base, quality: { decided: 40, rate: 1 }, repeats: [repeat, repeat, repeat, repeat] });
    expect(score(approveLesson, strong.features)).toBeGreaterThan(score(approveLesson, weak.features));
    expect(strong.features.repeats).toBe(1);
    expect(strong.rationale).toContain('repeats 4 other misses');
  });
});

describe('approveLesson.candidates: each floor', () => {
  const run = async (w: World) => approveLesson.candidates(world({ misses: [loopMiss('miss:f1', { embedding: axis(0) }), repeat], ...w }));
  test('only proposed post-mortem lessons are looked at', async () => {
    for (const l of [lesson('lesson:f1', { status: 'approved' }), lesson('lesson:f1', { source: 'memory' })]) {
      expect(await run({ details: [detail(l)] })).toEqual({ candidates: [], scanned: 0, skipped: {} });
    }
    expect(await run({ details: [] })).toEqual({ candidates: [], scanned: 0, skipped: {} });
  });
  test('any lesson check flag, checks never made or made by an older version: below the floor', async () => {
    for (const o of [{ checks: [{ name: 'contradicts-evidence' as const, why: 'x' }] }, { checks: [{ name: 'platitude' as const, why: 'x' }] }, { checks: null }, { checksVersion: LESSON_CHECKS_VERSION - 1 }, { checksVersion: null }]) {
      expect((await run({ details: [detail(lesson('lesson:f1', o))] })).skipped).toEqual({ below_floor: 1 });
    }
  });
  test('never: written by you, the demo, a run, may hold a secret, an Inbox item from a run', async () => {
    for (const o of [{ source: 'postmortem' as const, run: 'r1' }, { checks: [{ name: 'may-hold-secret' as const, why: 'x' }] }]) {
      expect((await run({ details: [detail(lesson('lesson:f1', o))] })).skipped).toEqual({ never_target: 1 });
    }
    expect((await run({ inbox: { f1: inbox(candidate('f1', { sandbox: true })) } })).skipped).toEqual({ never_target: 1 });
  });
  test('a project out of scope', async () => {
    const ctx = world({ misses: [loopMiss('miss:f1', { embedding: axis(0) }), repeat] });
    expect((await approveLesson.candidates({ ...ctx, inScope: () => false })).skipped).toEqual({ out_of_scope: 1 });
  });
  test('a call of this type still standing on it: already decided; one rolled back or rejected does not count', async () => {
    expect((await run({ decisions: { 'lesson:f1': [{ type: 'approve_lesson', status: 'proposed' }] } })).skipped).toEqual({ already_decided: 1 });
    expect((await run({ decisions: { 'lesson:f1': [{ type: 'approve_lesson', status: 'rolled_back' }, { type: 'narrow_scope', status: 'applied' }] } })).candidates).toHaveLength(1);
  });
  test('no miss, no feedback, no project at all, no Inbox item: below the floor', async () => {
    for (const d of [detail(lesson('lesson:f1'), { miss: null }), detail(lesson('lesson:f1'), { feedback: null }), detail(lesson('lesson:f1', { projectKey: null, origin: null }))]) {
      expect((await run({ details: [d] })).skipped).toEqual({ below_floor: 1 });
    }
    expect((await run({ inbox: {} })).skipped).toEqual({ below_floor: 1 });
  });
  test('the Inbox item must be one you confirmed: pending, rejected or confirmed by an operator is not', async () => {
    for (const o of [{ status: 'pending' as const }, { status: 'rejected' as const }, { decidedBy: 'operator:bot' }]) {
      expect((await run({ inbox: { f1: inbox(candidate('f1', o)) } })).skipped).toEqual({ below_floor: 1 });
    }
    expect((await run({ inbox: { f1: inbox(candidate('f1', { decidedBy: null })) } })).candidates).toHaveLength(1);
  });
  test('your as-written rate: 60% over 10 decisions passes; 50%, or nine decisions, does not', async () => {
    expect((await run({ decided: decided(6) })).candidates).toHaveLength(1);
    expect((await run({ decided: decided(5) })).skipped).toEqual({ below_floor: 1 });
    expect((await run({ decided: decided(9).slice(1) })).skipped).toEqual({ below_floor: 1 });
  });
  test('an operator\'s decisions, and decisions older than 90 days, do not count toward the rate', async () => {
    expect((await run({ decided: decided(10, { decidedBy: 'operator:bot' }) })).skipped).toEqual({ below_floor: 1 });
    expect((await run({ decided: decided(10, { decidedAt: '2026-07-01T00:00:00.000Z' }) })).skipped).toEqual({ below_floor: 1 });
  });
  test('paths: each must resolve to a mapped file; none, a junk path, an unmapped path or no code map: below the floor', async () => {
    expect((await run({ details: [detail(lesson('lesson:f1', { paths: ['src/out.ts', 'src/**'] }))] })).candidates).toHaveLength(1);
    for (const paths of [[], ['CLAUDE.md'], ['src/gone.ts']]) {
      expect((await run({ details: [detail(lesson('lesson:f1', { paths }))] })).skipped).toEqual({ below_floor: 1 });
    }
    expect((await run({ files: null })).skipped).toEqual({ below_floor: 1 });
  });
  test('no repeat and no diff to replay (feedback in a session): below the floor, no model call', async () => {
    const llm = judge(flags);
    expect((await approveLesson.candidates(world({ llm }))).skipped).toEqual({ below_floor: 1 });
    expect(llm.calls).toBe(0);
  });
  test('a held-out lesson: skipped before the replay judge, which is never asked', async () => {
    const llm = judge(flags);
    expect((await approveLesson.candidates({ ...world({ inbox: reviewed, llm }), holdout: 1 })).skipped).toEqual({ holdout: 1 });
    expect(llm.calls).toBe(0);
  });
  test('no repeat, a diff, but no model: no_judge', async () => {
    expect((await approveLesson.candidates(world({ inbox: reviewed }))).skipped).toEqual({ no_judge: 1 });
  });
  test('the judge does not flag it, or flags it with a line the diff does not have: below the floor', async () => {
    for (const a of [{ ...flags, status: 'addressed' }, { ...flags, applies: false }, { ...flags, evidence: ['+made up'] }]) {
      expect((await approveLesson.candidates(world({ inbox: reviewed, llm: judge(a) }))).skipped).toEqual({ below_floor: 1 });
    }
  });
  test('the judge fails: judge_failed, logged; over the day\'s budget: LoopBudgetSpent propagates', async () => {
    const logs: unknown[] = [];
    const ctx = { ...world({ inbox: reviewed, llm: judge(new Error('provider down')) }), log: (m: string, x?: object) => logs.push([m, x]) };
    expect((await approveLesson.candidates(ctx)).skipped).toEqual({ judge_failed: 1 });
    expect(logs).toEqual([['approve_lesson: the replay judge gave no usable answer', { lessonId: 'lesson:f1', error: 'provider down' }]]);
    await expect(approveLesson.candidates(world({ inbox: reviewed, llm: judge(new LoopBudgetSpent(40)) }))).rejects.toBeInstanceOf(LoopBudgetSpent);
  });
});

describe('approveLesson.candidates: proposed at most', () => {
  const misses = [loopMiss('miss:f1', { embedding: axis(0) }), repeat];
  test('you touched it within 14 days', async () => {
    const s: LessonSignals = { lessonId: 'lesson:f1', counts: {} as LessonSignals['counts'], lastServed: null, lastOwnerTouch: '2026-11-05T00:00:00.000Z', updatedAt: 't' };
    expect((await approveLesson.candidates(world({ misses, signals: { 'lesson:f1': s } }))).candidates[0].proposeOnly).toBe('owner_touched');
  });
  test('a global lesson: its origin\'s rate counts, and it is proposed only', async () => {
    const r = await approveLesson.candidates(world({ misses, details: [detail(lesson('lesson:f1', { projectKey: null, scope: 'global' }))] }));
    expect(r.candidates[0].proposeOnly).toBe('a global lesson');
    expect(r.candidates[0].rationale).toContain('lessons in demo');
  });
  test('a lesson learned from a GitHub or Linear comment: whoever can comment wrote its source, so it is proposed only (sweep 6, N1)', async () => {
    const fromReview = detail(lesson('lesson:f1'), { feedback: { ...detail(lesson('lesson:f1')).feedback!, external: { author: 'r', source: 'github' } as never } });
    for (const d of [fromReview, detail(lesson('lesson:f1', { from: 'linear' })), detail(lesson('lesson:f1', { from: 'github' }))]) {
      expect((await approveLesson.candidates(world({ misses, details: [d] }))).candidates[0].proposeOnly).toBe('its miss came from a GitHub or Linear comment');
    }
    expect((await approveLesson.candidates(world({ misses, details: [detail(lesson('lesson:f1', { from: 'session' }))] }))).candidates[0].proposeOnly).toBeUndefined();
  });
});

describe('the parts', () => {
  test('recheck: an observed approval, nothing new naming it, keeps its call while its floors hold; the replay judge is never asked again', async () => {
    const [byJudge] = (await approveLesson.candidates(world({ inbox: reviewed, llm: judge(flags) }))).candidates;
    const observed = [observedAs('approve_lesson', byJudge)];
    const llm = judge(new Error('asked'));
    const again = await approveLesson.recheck!({ ...world({ inbox: reviewed, entries: [], decisions: { 'lesson:f1': observed } }), llm }, observed);
    expect(llm.calls).toBe(0);
    expect(again[0]).toMatchObject({ targets: byJudge.targets, before: byJudge.before, after: byJudge.after, evidence: byJudge.evidence, model: 'ollama:gemma4' });
    // Below a floor now (your rate fell), or the lesson decided since: no longer holds.
    expect(await approveLesson.recheck!(world({ inbox: reviewed, entries: [], decided: decided(5) }), observed)).toEqual(['no_longer_holds']);
    expect(await approveLesson.recheck!(world({ entries: [], details: [detail(lesson('lesson:f1', { status: 'approved' }))] }), observed)).toEqual(['no_longer_holds']);
    // One that rested on a repeat needs the repeat still.
    const [byRepeat] = (await approveLesson.candidates(world({ misses: [loopMiss('miss:f1', { embedding: axis(0) }), repeat] }))).candidates;
    expect(await approveLesson.recheck!(world({ entries: [] }), [observedAs('approve_lesson', byRepeat)])).toEqual(['no_longer_holds']);
  });
  test('namedLessons: lessons by id and by their miss, once each, sorted', () => {
    const ctx = fakeContext({ entries: [activity('lesson_decided', { targets: ['lesson:b'] }), activity('decision_applied', { targets: ['dec:1', 'miss:a', 'miss:b'] })] });
    expect(namedLessons(ctx)).toEqual(['lesson:a', 'lesson:b']);
  });
  test('nothing new: nothing read', async () => {
    reads.length = 0;
    expect(await approveLesson.candidates(world({ entries: [] }))).toEqual({ candidates: [], scanned: 0, skipped: {} });
    expect(reads).toEqual([]);
  });
  test('ownerQuality: no decisions is a rate of 0', async () => {
    expect(await ownerQuality(world({ decided: [] }), 'demo')).toEqual({ decided: 0, rate: 0 });
  });
  test('pathsResolve', () => {
    expect(pathsResolve(['src/lib'], pathIndex(['src/lib/a.ts']))).toBe(true);
    expect(pathsResolve(['src'], pathIndex(['src/a.ts']))).toBe(false);
    expect(pathsResolve(['src/a.ts'], null)).toBe(false);
  });
  test('pathsResolve over the index answers as pathMatches over every file: plain paths, folders, globs, names anywhere', () => {
    const files = ['src/lib/a.ts', 'src/lib/deep/b.test.ts', 'docs/readme.md', 'pkg/x/src/lib/c.ts', 'top.ts'];
    const index = pathIndex(files);
    for (const p of ['src/lib', 'src/lib/', './src/lib/a.ts', 'src/lib/a', 'src/li', 'src/lib/deep', 'docs/readme.md', '**/*.test.ts', 'src/*/a.ts', 'src/*.ts', '*.md', 'c.ts', 'nope/x.ts', 'top.ts', 'pkg/x']) {
      expect(indexMatches(index, p), p).toBe(files.some((f) => pathMatches(p, f)));
    }
  });
  test('pathsResolve over a 100,000-file map stays a lookup per path', () => {
    const index = pathIndex(Array.from({ length: 100_000 }, (_, i) => `src/m${i % 200}/f${i}.ts`));
    const cpu = process.cpuUsage();
    for (let i = 0; i < 1000; i++) pathsResolve([`src/m${i % 200}/missing${i}.ts`, 'src/m3'], index);
    // CPU time: scanning every file per path took ~25 ms each (25 s for these 1,000).
    const used = process.cpuUsage(cpu);
    expect((used.user + used.system) / 1000).toBeLessThan(500);
  });
  test('repeatsOf: a miss that is gone, one without an embedding, and neighbours that are never targets or of another project', async () => {
    expect(await repeatsOf(world({ misses: [] }), 'miss:f1')).toEqual([]);
    expect(await repeatsOf(world({ misses: [loopMiss('miss:f1', { embedding: null }), repeat] }), 'miss:f1')).toEqual([]);
    const ctx = world({ misses: [loopMiss('miss:f1', { embedding: axis(0) }), loopMiss('miss:run', { run: 'r', createdAt: '2026-10-01T00:00:00.000Z' }), loopMiss('miss:x', { projectKey: 'other' })] });
    const near = { ...ctx, store: { ...ctx.store, knowledge: { ...ctx.store.knowledge, relatedMisses: async () => [{ missId: 'miss:run' }, { missId: 'miss:x' }, { missId: 'miss:f1' }] } } } as unknown as LoopTypeContext;
    expect(await repeatsOf(near, 'miss:f1')).toEqual([]);
  });
  test('replayWork: the comment\'s title and description as the task, else the turn before; null without a diff', () => {
    expect(replayWork(inbox(candidate('f1'), { external: ext(DIFF)! }))).toEqual({ task: 'PR title\n\nthe description', summary: 'I added logging', diff: DIFF });
    const bare = { ...ext(DIFF)!, title: '', description: null };
    expect(replayWork({ ...inbox(candidate('f1', { external: bare })) })!.task).toBe('add the feature');
    expect(replayWork({ ...inbox(candidate('f1', { external: bare })), before: [] })!.task).toBe('');
    expect(replayWork(inbox(candidate('f1'), { external: ext(null)! }))).toBeNull();
  });
});

describe('approveCandidate: the details', () => {
  test('an Inbox item with no decision time is dated by its creation; many paths are summed up', () => {
    const d = detail(lesson('lesson:f1', { paths: ['a/1.ts', 'a/2.ts', 'a/3.ts', 'a/4.ts', 'a/5.ts'] }));
    const c = approveCandidate(d, { candidate: candidate('f1', { decidedAt: null }), quality: { decided: 10, rate: 0.7 }, repeats: [repeat], replay: null, now: NOW });
    expect(c.evidence[0].observedAt).toBe('2026-10-31T00:00:00.000Z');
    expect(c.rationale).toContain('a/1.ts, a/2.ts, a/3.ts and 2 more');
  });
  test('repeatsOf: a link from the lesson\'s own miss', async () => {
    const link = { from: 'miss:f1', to: 'miss:far', decisionId: 'dec:x', createdAt: 't' };
    const ctx = world({ misses: [loopMiss('miss:f1', { embedding: axis(0) }), loopMiss('miss:far', { embedding: axis(4) })], links: [link] });
    expect((await repeatsOf(ctx, 'miss:f1')).map((m) => m.id)).toEqual(['miss:far']);
  });
});
