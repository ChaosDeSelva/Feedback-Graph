import { describe, expect, test } from 'vitest';
import { lessonFingerprint, LOOP_ACTOR, type Lesson, type LessonFilter, type LessonSignals, type SimilarLesson } from '@fb/core';
import { fakeContext } from '../testing/context.ts';
import { score } from '../policy.ts';
import { mergeCandidate, mergeDuplicates, mergeProposeOnly } from './merge_duplicates.ts';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const lesson = (id: string, o: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'demo', title: `title ${id}`, rule: `rule ${id}`, appliesWhen: 'editing', scope: 'project', paths: ['src/a.ts'],
  status: 'proposed', source: 'postmortem', cause: null, missId: null, createdAt: '2026-10-01T00:00:00.000Z', decidedAt: null, checks: [], ...o,
});
const dupOf = (of: string) => ({ checks: [{ name: 'duplicate-of' as const, why: 'repeats', of }] });
const signals = (id: string, lastOwnerTouch: string | null): LessonSignals => ({
  lessonId: id, counts: {} as LessonSignals['counts'], lastServed: null, lastOwnerTouch, updatedAt: '2026-11-10T00:00:00.000Z',
});

function ctx(lessons: Lesson[], near: Record<string, SimilarLesson[]>, o: Parameters<typeof fakeContext>[0] = {}) {
  const filters: LessonFilter[] = [];
  const c = fakeContext({
    now: NOW,
    lessons: [],
    ...o,
    store: {
      ...o.store,
      knowledge: {
        listLessons: async (f: LessonFilter) => { filters.push(f); return lessons.filter((l) => (l.checks ?? []).some((k) => k.name === f.flag)); },
        lessonDetail: async (id: string) => { const l = lessons.find((x) => x.id === id); return l ? { lesson: l, miss: null, feedback: null, contextItems: [] } as never : null; },
        similarLessons: async (id: string) => near[id] ?? [],
      },
    },
  });
  return { c, filters };
}
const sim = (id: string, cosine: number, status: Lesson['status'] = 'approved'): SimilarLesson => ({ id, cosine, status, createdAt: '2026-09-01T00:00:00.000Z' });

describe('mergeCandidate', () => {
  test('a proposed duplicate merges into its keeper: union of paths, superseded by the loop, features and evidence', () => {
    const keeper = lesson('lesson:k', { status: 'approved', decidedAt: '2026-09-01T00:00:00.000Z', decidedBy: 'you' });
    const dup = lesson('lesson:d', { paths: ['src/a.ts', 'src/b.ts'] });
    const c = mergeCandidate(dup, keeper, 0.96, NOW);
    expect(c.targets).toEqual([{ kind: 'lesson', id: 'lesson:k', role: 'keeper' }, { kind: 'lesson', id: 'lesson:d', role: 'merged' }]);
    expect(c.before.map((b) => b.fingerprint)).toEqual([lessonFingerprint(keeper), lessonFingerprint(dup)]);
    expect(c.after[0].fields).toMatchObject({ paths: ['src/a.ts', 'src/b.ts'], status: 'approved', decidedBy: 'you' });
    expect(c.after[0].fingerprint).toBe(lessonFingerprint({ ...keeper, paths: ['src/a.ts', 'src/b.ts'] }));
    expect(c.after[1].fields).toMatchObject({ status: 'superseded', decidedAt: '2026-11-11T12:00:00.000Z', decidedBy: LOOP_ACTOR, decisionNote: 'merged into lesson:k, which says the same' });
    expect(c.features).toEqual({ cosine: 0.96, cosineAbove: 0.5, dupProposed: 1, pathsWithin: 0, sameProject: 1 });
    expect(c.evidence.map((e) => `${e.kind}:${e.id}:${e.role}`)).toEqual(['check:lesson:d:duplicate-of', 'lesson:lesson:k:kept lesson']);
    expect(c.proposeOnly).toBeUndefined();
    expect(c.rationale).toContain('also takes its files src/b.ts');
    expect(c.projectKey).toBe('demo');
  });
  test('paths already within the keeper: the keeper is unchanged; many new files are summarised', () => {
    const keeper = lesson('lesson:k');
    expect(mergeCandidate(lesson('lesson:d'), keeper, 0.93, NOW).after[0]).toEqual(mergeCandidate(lesson('lesson:d'), keeper, 0.93, NOW).before[0]);
    const many = mergeCandidate(lesson('lesson:d', { paths: ['a', 'b', 'c', 'd', 'e'] }), keeper, 0.93, NOW);
    expect(many.rationale).toContain('a, b, c and 2 more');
  });
  test('a closer, contained, proposed duplicate scores higher', () => {
    const k = lesson('lesson:k', { status: 'approved' });
    const strong = mergeCandidate(lesson('lesson:d'), k, 0.99, NOW);
    const weak = mergeCandidate(lesson('lesson:d', { status: 'approved', paths: ['x'] }), k, 0.92, NOW);
    expect(score(mergeDuplicates, strong.features)).toBeGreaterThan(score(mergeDuplicates, weak.features));
  });
});

describe('mergeProposeOnly: the auto rule', () => {
  const k = lesson('lesson:k', { status: 'approved', paths: ['src/a.ts', 'src/b.ts'] });
  test('a proposed duplicate of the same project: auto', () => expect(mergeProposeOnly(lesson('lesson:d'), k, 0.92, false)).toBeNull());
  test('both approved, cosine ≥ .95, paths within: auto', () => expect(mergeProposeOnly(lesson('lesson:d', { status: 'approved' }), k, 0.95, false)).toBeNull());
  test('both approved under .95: proposed', () => expect(mergeProposeOnly(lesson('lesson:d', { status: 'approved' }), k, 0.949, false)).toContain('cosine'));
  test('both approved, the duplicate names other files: proposed', () =>
    expect(mergeProposeOnly(lesson('lesson:d', { status: 'approved', paths: ['src/c.ts'] }), k, 0.97, false)).toContain('files'));
  test('an approved duplicate of a proposed keeper: proposed', () =>
    expect(mergeProposeOnly(lesson('lesson:d', { status: 'approved' }), lesson('lesson:k'), 0.99, false)).toContain('is not'));
  test('another project: proposed, and it counts against the score', () => {
    const c = mergeCandidate(lesson('lesson:d', { projectKey: 'other' }), k, 0.99, NOW);
    expect(c.features.sameProject).toBe(0);
    expect(c.proposeOnly).toContain('different projects');
  });
  test('another project: the reason', () => expect(mergeProposeOnly(lesson('lesson:d', { projectKey: 'other' }), k, 0.99, false)).toContain('different projects'));
  test('touched by the owner: proposed', () => expect(mergeProposeOnly(lesson('lesson:d'), k, 0.99, true)).toContain('14 days'));
});

describe('mergeDuplicates.candidates', () => {
  test('reads only flagged lessons, measures the cosine again, and makes one call per flagged duplicate', async () => {
    const lessons = [lesson('lesson:k', { status: 'approved' }), lesson('lesson:d', dupOf('lesson:k'))];
    const { c, filters } = ctx(lessons, { 'lesson:d': [sim('lesson:k', 0.97)] });
    const r = await mergeDuplicates.candidates(c);
    expect(filters).toEqual([{ flag: 'duplicate-of', limit: 10_000 }]);
    expect(r.candidates.map((x) => x.targets.map((t) => t.id))).toEqual([['lesson:k', 'lesson:d']]);
    expect(r).toMatchObject({ scanned: 1, skipped: {} });
  });
  test('floors: no `of`, itself, a missing or dead keeper, the cosine now under .92 or not near at all', async () => {
    const lessons = [
      lesson('lesson:k'), lesson('lesson:gone-k', { status: 'rejected' }),
      lesson('lesson:1', { checks: [{ name: 'duplicate-of', why: 'x' }] }),
      lesson('lesson:2', dupOf('lesson:2')),
      lesson('lesson:3', dupOf('lesson:none')),
      lesson('lesson:4', dupOf('lesson:gone-k')),
      lesson('lesson:5', dupOf('lesson:k')),
      lesson('lesson:6', dupOf('lesson:k')),
      lesson('lesson:done', { ...dupOf('lesson:k'), status: 'superseded' }),
    ];
    const r = await mergeDuplicates.candidates(ctx(lessons, { 'lesson:5': [sim('lesson:k', 0.91)] }).c);
    expect(r.candidates).toEqual([]);
    expect(r).toMatchObject({ scanned: 6, skipped: { below_floor: 6 } });
  });
  test('a store without similarLessons: nothing measured, nothing merged', async () => {
    const c = fakeContext({ store: { knowledge: {
      listLessons: async () => [lesson('lesson:d', dupOf('lesson:k'))],
      lessonDetail: async () => ({ lesson: lesson('lesson:k') }) as never,
    } } });
    expect((await mergeDuplicates.candidates(c)).skipped).toEqual({ below_floor: 1 });
  });
  test('never: a manual, demo, run or secret-flagged lesson at either end; a project out of scope at either end', async () => {
    const lessons = [
      lesson('lesson:k'), lesson('lesson:manual-k', { source: 'manual' }), lesson('lesson:far-k', { projectKey: 'far' }),
      lesson('lesson:1', { ...dupOf('lesson:k'), source: 'manual' }),
      lesson('lesson:2', { ...dupOf('lesson:k'), run: 'r1' }),
      lesson('lesson:3', dupOf('lesson:manual-k')),
      lesson('lesson:4', { ...dupOf('lesson:k'), projectKey: 'far' }),
      lesson('lesson:5', dupOf('lesson:far-k')),
    ];
    const r = await mergeDuplicates.candidates(ctx(lessons, {}, { inScope: (k) => k !== 'far' }).c);
    expect(r.candidates).toEqual([]);
    expect(r.skipped).toEqual({ never_target: 3, out_of_scope: 2 });
  });
  test('the owner touched the duplicate or the keeper within 14 days: proposed only; earlier: auto', async () => {
    const lessons = [lesson('lesson:k'), lesson('lesson:d', dupOf('lesson:k'))];
    const near = { 'lesson:d': [sim('lesson:k', 0.97)] };
    for (const id of ['lesson:d', 'lesson:k']) {
      const r = await mergeDuplicates.candidates(ctx(lessons, near, { signals: { [id]: signals(id, '2026-11-01T00:00:00.000Z') } }).c);
      expect(r.candidates[0].proposeOnly).toContain('14 days');
    }
    const old = await mergeDuplicates.candidates(ctx(lessons, near, { signals: { 'lesson:d': signals('lesson:d', '2026-10-01T00:00:00.000Z') } }).c);
    expect(old.candidates[0].proposeOnly).toBeUndefined();
  });
  test('nothing flagged: nothing read further', async () => {
    expect(await mergeDuplicates.candidates(ctx([lesson('lesson:a')], {}).c)).toEqual({ candidates: [], scanned: 0, skipped: {} });
  });
});

describe('never merge and the near-duplicate band (0.9.1)', () => {
  const judge = (answer: unknown) => {
    const p = { id: 'ollama:gemma4', agentic: false, calls: 0, json: async () => { p.calls++; return answer; } };
    return p as unknown as import('@fb/core').LlmProvider & { calls: number };
  };
  /** Two live lessons of one project whose cosine is `cos`, as the round's lessons. */
  function band(cos: number, o: { a?: Partial<Lesson>; b?: Partial<Lesson>; llm?: unknown; memo?: Record<string, string>; distinct?: boolean } = {}) {
    const a = lesson('lesson:a', { status: 'approved', createdAt: '2026-09-01T00:00:00.000Z', ...o.a });
    const b = lesson('lesson:b', o.b);
    const { c } = ctx([a, b], { 'lesson:a': [sim('lesson:b', cos, 'proposed')], 'lesson:b': [sim('lesson:a', cos)] }, {
      lessons: [a, b], memo: o.memo,
      store: { decisions: { distinctPairs: async () => (o.distinct ? [{ a: 'lesson:a', b: 'lesson:b', by: 'you', at: 't', reason: 'r', decisionId: null }] : []), forTarget: async () => [] } },
    });
    const llm = o.llm === undefined ? null : judge(o.llm);
    return { c: { ...c, llm }, llm, a, b };
  }

  test('a flagged duplicate you said is not the same is never merged again', async () => {
    const keeper = lesson('lesson:k', { status: 'approved' });
    const dup = lesson('lesson:d', dupOf('lesson:k'));
    const { c } = ctx([keeper, dup], { 'lesson:d': [sim('lesson:k', 0.97)] }, {
      store: { decisions: { distinctPairs: async () => [{ a: 'lesson:d', b: 'lesson:k', by: 'you', at: 't', reason: 'r', decisionId: 'dec:1' }], forTarget: async () => [] } },
    });
    const r = await mergeDuplicates.candidates(c);
    expect(r.candidates).toEqual([]);
    expect(r.skipped).toMatchObject({ distinct: 1 });
  });

  test('the judge says yes: a merge proposed for you, never applied on its own, with the model named and its answer remembered', async () => {
    const { c, llm } = band(0.88, { llm: { same: 'yes', why: 'both say use the gateway' } });
    const r = await mergeDuplicates.candidates(c);
    expect(llm!.calls).toBe(1);
    expect(r.candidates).toHaveLength(1);
    const call = r.candidates[0];
    expect(call.targets).toEqual([{ kind: 'lesson', id: 'lesson:a', role: 'keeper' }, { kind: 'lesson', id: 'lesson:b', role: 'merged' }]);
    expect(call.proposeOnly).toMatch(/a near duplicate \(cosine 0\.88/);
    expect(call.model).toBe('ollama:gemma4');
    expect(call.rationale).toContain('both say use the gateway');
    expect(JSON.parse(r.remember!['near:lesson:a|lesson:b'])).toMatchObject({ same: true });
  });

  test('no is dropped; unsure is proposed; an answer remembered for the same lessons is not asked again; under the band nothing is looked at', async () => {
    const no = band(0.88, { llm: { same: 'no', why: 'different services' } });
    expect((await mergeDuplicates.candidates(no.c)).skipped).toMatchObject({ judged_different: 1 });
    const unsure = band(0.88, { llm: { same: 'unsure', why: '' } });
    expect((await mergeDuplicates.candidates(unsure.c)).candidates[0].proposeOnly).toContain('the judge was unsure');
    const first = await mergeDuplicates.candidates(band(0.88, { llm: { same: 'no', why: 'x' } }).c);
    const again = band(0.88, { llm: { same: 'yes', why: 'y' }, memo: first.remember });
    expect((await mergeDuplicates.candidates(again.c)).candidates).toEqual([]);
    expect(again.llm!.calls).toBe(0);
    const low = band(0.84, { llm: { same: 'yes', why: 'y' } });
    expect((await mergeDuplicates.candidates(low.c)).candidates).toEqual([]);
    expect(low.llm!.calls).toBe(0);
  });

  test('the same words need no model; without a model the band waits; a pair marked distinct is never judged', async () => {
    const same = band(0.9, { b: { title: 'title lesson:a', rule: 'Rule lesson:a.' } });
    expect((await mergeDuplicates.candidates(same.c)).candidates[0].rationale).toContain('they say the same in the same words');
    expect((await mergeDuplicates.candidates(band(0.9).c)).skipped).toMatchObject({ no_judge: 1 });
    const distinct = band(0.9, { llm: { same: 'yes', why: 'y' }, distinct: true });
    expect((await mergeDuplicates.candidates(distinct.c)).skipped).toMatchObject({ distinct: 1 });
    expect(distinct.llm!.calls).toBe(0);
  });
});
