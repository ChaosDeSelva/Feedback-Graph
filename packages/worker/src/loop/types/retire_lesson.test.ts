import { describe, expect, test } from 'vitest';
import { lessonFingerprint, LOOP_ACTOR, type Lesson, type LessonSignals } from '@fb/core';
import { fakeContext } from '../testing/context.ts';
import { score } from '../policy.ts';
import { RETIRE, retireCandidate, retireFloors, retireLesson } from './retire_lesson.ts';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const lesson = (id: string, o: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'demo', title: `title ${id}`, rule: `rule ${id}`, appliesWhen: 'editing', scope: 'project', paths: ['src/a.ts'],
  status: 'approved', source: 'postmortem', cause: null, missId: null, createdAt: daysAgo(100), decidedAt: daysAgo(90), decidedBy: 'you', checks: [], ...o,
});
type Counts = LessonSignals['counts'];
const ZERO: Counts = {
  served: 0, sessionsServed: 0, addressed: 0, notAddressed: 0, notApplicable: 0, cannotTell: 0, gapsFixed: 0, repeatServed: 0,
  repeatUnserved: 0, ownerPushbackAfter: 0, agentNotApplicable: 0, agentWrong: 0, ownerEdits: 0, ownerRejects: 0,
};
/** Just over every floor: served 15, judged 8 with 7 not applicable (87.5%). */
const signals = (id: string, c: Partial<Counts> = {}, lastOwnerTouch: string | null = null): LessonSignals => ({
  lessonId: id, counts: { ...ZERO, served: 15, notApplicable: 7, cannotTell: 1, ...c }, lastServed: daysAgo(1), lastOwnerTouch, updatedAt: daysAgo(0),
});

describe('retireFloors: each floor on both sides', () => {
  const l = lesson('lesson:a');
  test('at every floor: retire', () => expect(retireFloors(l, signals(l.id), NOW)).toBe(true));
  test.each<[string, Partial<Lesson>, Partial<Counts>]>([
    ['approved under 60 days', { decidedAt: daysAgo(59.9) }, {}],
    ['never decided', { decidedAt: null }, {}],
    ['served 14', {}, { served: 14 }],
    ['judged 7', {}, { cannotTell: 0 }],
    ['one gap caught', {}, { notAddressed: 1, notApplicable: 8 }],
    ['one gap fixed', {}, { gapsFixed: 1 }],
    ['not applicable under 80%', {}, { notApplicable: 7, cannotTell: 2 }],
    ['its miss repeated where it was served', {}, { repeatServed: 1 }],
    ['its miss repeated elsewhere', {}, { repeatUnserved: 1 }],
  ])('%s: no call', (_, lo, c) => expect(retireFloors(lesson('lesson:a', lo), signals('lesson:a', c), NOW)).toBe(false));
  test('exactly 60 days and exactly 80%: a call', () =>
    expect(retireFloors(lesson('lesson:a', { decidedAt: daysAgo(60) }), signals('lesson:a', { notApplicable: 8, addressed: 2, cannotTell: 0 }), NOW)).toBe(true));
  test('no signals yet: no call', () => expect(retireFloors(l, null, NOW)).toBe(false));
});

describe('retireCandidate', () => {
  test('revoked by the loop with a note; before and after fingerprints; features', () => {
    const l = lesson('lesson:a');
    const c = retireCandidate(l, signals(l.id), NOW);
    expect(c.targets).toEqual([{ kind: 'lesson', id: 'lesson:a', role: 'primary' }]);
    expect(c.before[0].fingerprint).toBe(lessonFingerprint(l));
    expect(c.after[0].fields).toMatchObject({ status: 'revoked', decidedAt: '2026-11-11T12:00:00.000Z', decidedBy: LOOP_ACTOR, decisionNote: expect.stringContaining('retired by the learning loop') });
    expect(c.after[0].fingerprint).toBe(lessonFingerprint({ ...l, status: 'revoked', decidedAt: '2026-11-11T12:00:00.000Z', decidedBy: LOOP_ACTOR, decisionNote: c.after[0].fields.decisionNote as string }));
    expect(c.features).toEqual({ notApplicableShare: 0.875, notApplicableAbove: 0.375, servedMore: 0, judgedMore: 0, olderMore: 0.25 });
    expect(c.evidence).toEqual([{ kind: 'lesson', id: 'lesson:a', role: 'served, never helped', weight: 0.875, observedAt: expect.any(String) }]);
    expect(c.rationale).toContain('Approved 90 days ago');
    expect(c.proposeOnly).toBeUndefined();
  });
  test('more evidence scores higher', () => {
    const l = lesson('lesson:a');
    const weak = retireCandidate(l, signals(l.id), NOW);
    const strong = retireCandidate(lesson('lesson:a', { decidedAt: daysAgo(400) }), signals(l.id, { served: 80, notApplicable: 40, cannotTell: 0 }), NOW);
    expect(strong.features).toMatchObject({ notApplicableAbove: 1, servedMore: 1, judgedMore: 1, olderMore: 1 });
    expect(score(retireLesson, strong.features)).toBeGreaterThan(score(retireLesson, weak.features));
  });
});

describe('retireLesson.candidates', () => {
  // The round's lessons (LoopTypeContext.lessons), of every status.
  const run = (lessons: Lesson[], sig: Record<string, LessonSignals>, inScope?: (k: string | null) => boolean) =>
    ({ r: retireLesson.candidates(fakeContext({ now: NOW, signals: sig, inScope, lessons })) });
  test('approved lessons only; one past every floor is a call, the others are counted', async () => {
    const lessons = [lesson('lesson:a'), lesson('lesson:b'), lesson('lesson:c'), lesson('lesson:p', { status: 'proposed' })];
    const { r } = run(lessons, { 'lesson:a': signals('lesson:a'), 'lesson:b': signals('lesson:b', { gapsFixed: 1 }), 'lesson:p': signals('lesson:p') });
    const out = await r;
    expect(out.candidates.map((c) => c.targets[0].id)).toEqual(['lesson:a']);
    expect(out).toMatchObject({ scanned: 3, skipped: { below_floor: 2 } });
  });
  test(`never: written by you, demo, a run's, may hold a secret, out of scope; the owner's touch within ${RETIRE.ownerQuietDays} days`, async () => {
    const lessons = [
      lesson('lesson:m', { source: 'manual' }), lesson('lesson:demo', { source: 'demo' }), lesson('lesson:s', { sandbox: true }),
      lesson('lesson:sec', { checks: [{ name: 'may-hold-secret', why: 'x' }] }), lesson('lesson:far', { projectKey: 'far' }),
      lesson('lesson:t'), lesson('lesson:old'),
    ];
    const sig = Object.fromEntries(lessons.map((l) => [l.id, signals(l.id)]));
    sig['lesson:t'] = signals('lesson:t', {}, daysAgo(29));
    sig['lesson:old'] = signals('lesson:old', {}, daysAgo(31));
    const out = await run(lessons, sig, (k) => k !== 'far').r;
    expect(out.candidates.map((c) => c.targets[0].id)).toEqual(['lesson:old']);
    expect(out.skipped).toEqual({ never_target: 4, out_of_scope: 1, owner_touched: 1 });
  });
});
