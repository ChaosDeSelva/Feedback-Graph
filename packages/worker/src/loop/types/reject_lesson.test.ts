import { describe, expect, test } from 'vitest';
import { lessonFingerprint, LOOP_ACTOR, type Lesson, type LessonCheck, type LessonSignals } from '@fb/core';
import { fakeContext } from '../testing/context.ts';
import { score } from '../policy.ts';
import { BLOCKING_CHECKS, blocking, rejectCandidate, rejectLesson } from './reject_lesson.ts';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const check = (name: LessonCheck['name']): LessonCheck => ({ name, why: `why ${name}` });
const lesson = (id: string, o: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'demo', title: `title ${id}`, rule: `rule ${id}`, appliesWhen: 'editing', scope: 'project', paths: ['src/a.ts'],
  status: 'proposed', source: 'postmortem', cause: null, missId: null, createdAt: daysAgo(15), decidedAt: null, checks: [check('platitude')], ...o,
});
const touched = (id: string, at: string): LessonSignals => ({ lessonId: id, counts: {} as LessonSignals['counts'], lastServed: null, lastOwnerTouch: at, updatedAt: at });

describe('blocking', () => {
  test('each blocking check counts, once; other checks do not', () => {
    for (const name of BLOCKING_CHECKS) expect(blocking(lesson('l', { checks: [check(name)] }))).toEqual([name]);
    expect(blocking(lesson('l', { checks: [check('needs-path'), check('generic'), check('generic'), check('bundled')] }))).toEqual(['generic']);
    expect(blocking(lesson('l', { checks: null }))).toEqual([]);
  });
});

describe('rejectCandidate', () => {
  test('rejected by the loop, naming the checks; snapshots and features', () => {
    const l = lesson('lesson:a', { checks: [check('no-miss'), check('generic')] });
    const c = rejectCandidate(l, NOW);
    expect(c.before[0].fingerprint).toBe(lessonFingerprint(l));
    const note = 'rejected by the learning loop: no-miss, generic';
    expect(c.after[0].fields).toMatchObject({ status: 'rejected', decidedAt: '2026-11-11T12:00:00.000Z', decidedBy: LOOP_ACTOR, decisionNote: note });
    expect(c.after[0].fingerprint).toBe(lessonFingerprint({ ...l, status: 'rejected', decidedAt: '2026-11-11T12:00:00.000Z', decidedBy: LOOP_ACTOR, decisionNote: note }));
    expect(c.evidence.map((e) => e.role)).toEqual(['check no-miss', 'check generic']);
    expect(c.features).toEqual({ strongCheck: 1, checks: 0.667, waited: 0.5 });
    expect(c.rationale).toContain('no-miss: why no-miss; generic: why generic');
    expect(c.proposeOnly).toBeUndefined();
  });
  test('proposeOnly is carried into the call and its rationale; a stronger case scores higher; created in the future reads as 0 days', () => {
    const p = rejectCandidate(lesson('lesson:a'), NOW, 'you edited this lesson');
    expect(p.proposeOnly).toBe('you edited this lesson');
    expect(p.rationale).toContain('Proposed only: you edited this lesson.');
    const weak = rejectCandidate(lesson('lesson:a', { createdAt: daysAgo(-1) }), NOW);
    expect(weak.features.waited).toBe(0);
    const strong = rejectCandidate(lesson('lesson:a', { createdAt: daysAgo(60), checks: ['no-miss', 'self-review', 'platitude', 'generic'].map((n) => check(n as LessonCheck['name'])) }), NOW);
    expect(strong.features).toEqual({ strongCheck: 1, checks: 1, waited: 1 });
    expect(score(rejectLesson, strong.features)).toBeGreaterThan(score(rejectLesson, weak.features));
  });
});

describe('rejectLesson.candidates', () => {
  // The round's lessons (LoopTypeContext.lessons), of every status.
  const run = async (lessons: Lesson[], o: Parameters<typeof fakeContext>[0] = {}) => ({ r: await rejectLesson.candidates(fakeContext({ now: NOW, ...o, lessons })) });
  test('proposed lessons only; one with a blocking check is a call, one without is below the floor', async () => {
    const { r } = await run([lesson('lesson:a'), lesson('lesson:b', { checks: [check('needs-path')] }), lesson('lesson:done', { status: 'approved' })]);
    expect(r.candidates.map((c) => c.targets[0].id)).toEqual(['lesson:a']);
    expect(r).toMatchObject({ scanned: 2, skipped: { below_floor: 1 } });
  });
  test('never: written by you, demo, a run, may hold a secret, out of scope', async () => {
    const { r } = await run([
      lesson('lesson:m', { source: 'manual' }), lesson('lesson:d', { source: 'demo' }), lesson('lesson:r', { run: 'r1' }),
      lesson('lesson:s', { checks: [check('platitude'), check('may-hold-secret')] }), lesson('lesson:far', { projectKey: 'far' }),
    ], { inScope: (k) => k !== 'far' });
    expect(r.candidates).toEqual([]);
    expect(r.skipped).toEqual({ never_target: 4, out_of_scope: 1 });
  });
  test('edited by you while proposed, or touched within 14 days: proposed only; touched earlier: auto', async () => {
    const { r } = await run(
      [lesson('lesson:e', { proposedAs: { title: 't', rule: 'r', appliesWhen: 'a', scope: 'project', paths: [] } }), lesson('lesson:t'), lesson('lesson:o')],
      { signals: { 'lesson:t': touched('lesson:t', daysAgo(3)), 'lesson:o': touched('lesson:o', daysAgo(20)) } },
    );
    expect(r.candidates.map((c) => [c.targets[0].id, c.proposeOnly ?? null])).toEqual([
      ['lesson:e', 'you edited this lesson'], ['lesson:t', 'you changed this lesson in the last 14 days'], ['lesson:o', null],
    ]);
  });
});
