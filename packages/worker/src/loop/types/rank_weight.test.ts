import { describe, expect, test } from 'vitest';
import { lessonFingerprint, lessonSnapshot, LESSON_SIGNAL_COUNTS, type Lesson, type LessonSignals } from '@fb/core';
import { activity, fakeContext, observedAs } from '../testing/context.ts';
import { score } from '../policy.ts';
import { wilson } from '@fb/core';
import { RANK_JUDGED_MIN, rankWeight, targetWeight, weightCandidate } from './rank_weight.ts';

const lesson = (id: string, o: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'demo', title: `Title ${id}`, rule: 'rule', appliesWhen: 'w', scope: 'project', paths: ['src/a.ts'], status: 'approved',
  source: 'postmortem', cause: 'verification_gap', missId: null, createdAt: '2026-09-01T00:00:00.000Z', decidedAt: '2026-09-01T00:00:00.000Z', ...o,
});
const signals = (lessonId: string, c: Partial<LessonSignals['counts']> = {}, o: Partial<LessonSignals> = {}): LessonSignals => ({
  lessonId, counts: { ...(Object.fromEntries(LESSON_SIGNAL_COUNTS.map((k) => [k, 0])) as LessonSignals['counts']), ...c },
  lastServed: null, lastOwnerTouch: null, updatedAt: '2026-11-10T00:00:00.000Z', ...o,
});
const checked = (...lessonIds: string[]) => activity('predone_check', { details: { verdicts: lessonIds.map((lessonId) => ({ lessonId, status: 'addressed' })) } });
const ctxFor = (lessons: Lesson[], sig: Record<string, LessonSignals>, entries = [checked(...lessons.map((l) => l.id))], o: Parameters<typeof fakeContext>[0] = {}) =>
  fakeContext({
    entries, signals: sig, ...o,
    store: { knowledge: { lessonDetail: async (id: string) => { const l = lessons.find((x) => x.id === id); return l ? { lesson: l } as never : null; } } },
  });

describe('wilson and targetWeight', () => {
  test('the interval narrows with n and holds p', () => {
    const small = wilson(4, 5);
    const big = wilson(80, 100);
    expect(small.lower).toBeLessThan(big.lower);
    expect(small.upper).toBeGreaterThan(big.upper);
    expect(big.lower).toBeLessThan(0.8);
    expect(big.upper).toBeGreaterThan(0.8);
    expect(wilson(0, 5).lower).toBe(0);
    expect(wilson(5, 5).upper).toBe(1);
  });
  test('helpful (addressed, a gap caught) above .5 at the lower bound: above 1; not applicable below .5 at the upper: under 1; between: 1', () => {
    expect(targetWeight(signals('l', { addressed: 10, notAddressed: 10 }).counts).target).toBeGreaterThan(1.3);
    expect(targetWeight(signals('l', { notApplicable: 20 }).counts).target).toBeLessThan(0.7);
    expect(targetWeight(signals('l', { addressed: 5, notApplicable: 5 }).counts).target).toBe(1);
    // cannot_tell is no evidence either way.
    expect(targetWeight(signals('l', { cannotTell: 50 }).counts)).toMatchObject({ judged: 0, target: 1 });
  });
});

describe('weightCandidate: the floor and the step', () => {
  test(`under ${RANK_JUDGED_MIN} decisive verdicts: no call`, () => {
    expect(weightCandidate(lesson('l'), signals('l', { addressed: RANK_JUDGED_MIN - 1, cannotTell: 10 }))).toBeNull();
    expect(weightCandidate(lesson('l'), signals('l', { addressed: RANK_JUDGED_MIN }))).not.toBeNull();
  });
  test('helpful: one step up, with the whole lesson snapshotted before and after', () => {
    const l = lesson('l');
    const c = weightCandidate(l, signals('l', { addressed: 12, notAddressed: 3, gapsFixed: 5 }))!;
    expect(c.targets).toEqual([{ kind: 'lesson', id: 'l', role: 'primary' }]);
    expect(c.before).toEqual([lessonSnapshot(l)]);
    expect(c.after).toEqual([lessonSnapshot({ ...l, servingWeight: 1.1 })]);
    expect(c.after[0].fields.servingWeight).toBe(1.1);
    expect(c.after[0].fingerprint).toBe(lessonFingerprint({ ...l, servingWeight: 1.1 }));
    expect(c.evidence.map((e) => e.role)).toEqual(['serving weight 1.0 -> 1.1']);
    expect(c.features).toMatchObject({ judged: 15 / 20, gapsFixed: 1 });
    expect(c.rationale).toContain('15 of 15 decisive verdicts');
    expect(c.rationale).toContain('helpful even at the lower bound');
    expect(c.subject).toContain('1.0 -> 1.1');
  });
  test('not applicable: one step down from where it is; at the bottom, no call', () => {
    const c = weightCandidate(lesson('l', { servingWeight: 0.8 }), signals('l', { notApplicable: 30 }))!;
    expect(c.after[0].fields.servingWeight).toBe(0.7);
    expect(c.rationale).toContain('not helpful even at the upper bound');
    expect(weightCandidate(lesson('l', { servingWeight: 0.5 }), signals('l', { notApplicable: 300 }))).toBeNull();
  });
  test('steps add up exactly, and stop at 1.5', () => {
    const c = weightCandidate(lesson('l', { servingWeight: 1.2 }), signals('l', { addressed: 400 }))!;
    expect(c.after[0].fields.servingWeight).toBe(1.3);
    expect(weightCandidate(lesson('l', { servingWeight: 1.4 }), signals('l', { addressed: 400 }))!.after[0].fields.servingWeight).toBe(1.5);
    expect(weightCandidate(lesson('l', { servingWeight: 1.5 }), signals('l', { addressed: 400 }))).toBeNull();
  });
  test('evidence turned mixed: back toward 1', () => {
    const c = weightCandidate(lesson('l', { servingWeight: 1.3 }), signals('l', { addressed: 10, notApplicable: 10 }))!;
    expect(c.after[0].fields.servingWeight).toBe(1.2);
    expect(c.rationale).toContain('goes back toward 1');
  });
  test('at its target already: no call', () => {
    expect(weightCandidate(lesson('l'), signals('l', { addressed: 5, notApplicable: 5 }))).toBeNull();
  });
  test('stronger evidence scores higher', () => {
    const weak = weightCandidate(lesson('l'), signals('l', { addressed: 6 }))!;
    const strong = weightCandidate(lesson('l'), signals('l', { addressed: 40, gapsFixed: 3 }))!;
    expect(score(rankWeight, strong.features)).toBeGreaterThan(score(rankWeight, weak.features));
  });
  test('a global lesson acts in the project it was learned in', () => {
    expect(weightCandidate(lesson('l', { projectKey: null, origin: 'demo' }), signals('l', { addressed: 9 }))!.projectKey).toBe('demo');
    expect(weightCandidate(lesson('l', { projectKey: null }), signals('l', { addressed: 9 }))!.projectKey).toBeNull();
  });
});

describe('rankWeight.candidates', () => {
  test('the lessons the round\'s checks judged, once each; misses named as verdicts are not lessons', async () => {
    const ls = [lesson('lesson:a'), lesson('lesson:b')];
    const ctx = ctxFor(ls, { 'lesson:a': signals('lesson:a', { addressed: 9 }), 'lesson:b': signals('lesson:b', { addressed: 2 }) },
      [checked('lesson:a', 'lesson:b', 'miss:x'), checked('lesson:a'), activity('predone_check', { details: {} }), activity('context_served')]);
    const r = await rankWeight.candidates(ctx);
    expect(r.candidates.map((c) => c.targets[0].id)).toEqual(['lesson:a']);
    expect(r.scanned).toBe(2);
    expect(r.skipped).toEqual({ below_floor: 1 });
  });
  test('a lesson judged only through its trigger on other files is not weighed for it', async () => {
    const ls = [lesson('lesson:a')];
    const ctx = ctxFor(ls, { 'lesson:a': signals('lesson:a', { addressed: 9 }) },
      [activity('predone_check', { details: { verdicts: [{ lessonId: 'lesson:a', status: 'not_applicable', triggerOnly: true }] }, targets: ['lesson:a'] })]);
    expect((await rankWeight.candidates(ctx)).scanned).toBe(0);
  });
  test('never: gone, not approved, written by you, demo, a run, may hold a secret; out of scope; no signals yet', async () => {
    const ls = [
      lesson('lesson:proposed', { status: 'proposed' }), lesson('lesson:manual', { source: 'manual' }), lesson('lesson:demo', { source: 'demo' }),
      lesson('lesson:run', { run: 'r1' }), lesson('lesson:secret', { checks: [{ name: 'may-hold-secret' }] as Lesson['checks'] }),
      lesson('lesson:other', { projectKey: 'other' }), lesson('lesson:quiet'),
    ];
    const ctx = ctxFor(ls, {}, [checked(...ls.map((l) => l.id), 'lesson:gone')], { inScope: (k) => k === 'demo' });
    const r = await rankWeight.candidates(ctx);
    expect(r.candidates).toEqual([]);
    expect(r.skipped).toEqual({ below_floor: 3, never_target: 4, out_of_scope: 1 });
  });
  test('the owner touched it in the last 14 days: proposed at most', async () => {
    const touched = signals('lesson:a', { addressed: 9 }, { lastOwnerTouch: '2026-11-05T00:00:00.000Z' });
    const r = await rankWeight.candidates(ctxFor([lesson('lesson:a')], { 'lesson:a': touched }));
    expect(r.candidates[0].proposeOnly).toMatch(/14 days/);
    const old = signals('lesson:a', { addressed: 9 }, { lastOwnerTouch: '2026-09-01T00:00:00.000Z' });
    expect((await rankWeight.candidates(ctxFor([lesson('lesson:a')], { 'lesson:a': old }))).candidates[0].proposeOnly).toBeUndefined();
  });
  test('a global lesson is in scope by the project it was learned in, or (none) always', async () => {
    const ls = [lesson('lesson:g', { projectKey: null, origin: 'other' }), lesson('lesson:h', { projectKey: null })];
    const r = await rankWeight.candidates(ctxFor(ls, { 'lesson:h': signals('lesson:h', { addressed: 9 }) }, undefined, { inScope: (k) => k !== 'other' }));
    expect(r.candidates.map((c) => c.targets[0].id)).toEqual(['lesson:h']);
    expect(r.skipped).toEqual({ out_of_scope: 1 });
  });
  test('recheck: an observed step, with no check judging the lesson this round, is weighed again as its signals are now', async () => {
    const sig: Record<string, LessonSignals> = { 'lesson:a': signals('lesson:a', { addressed: 10 }), 'lesson:b': signals('lesson:b', { addressed: 10 }) };
    const was = [lesson('lesson:a'), lesson('lesson:b')];
    const observed = was.map((l) => observedAs('rank_weight', weightCandidate(l, sig[l.id])!));
    const now = [lesson('lesson:a'), lesson('lesson:b', { status: 'revoked' })];
    const r = await rankWeight.recheck!(ctxFor(now, { ...sig, 'lesson:a': signals('lesson:a', { addressed: 12 }) }, []), observed);
    expect(r[0]).toMatchObject({ targets: observed[0].targets, before: observed[0].before, after: observed[0].after });
    expect(r[1]).toBe('no_longer_holds');
  });
  test('nothing new: nothing read', async () => {
    expect(await rankWeight.candidates(fakeContext())).toEqual({ candidates: [], scanned: 0, skipped: {} });
  });
});
