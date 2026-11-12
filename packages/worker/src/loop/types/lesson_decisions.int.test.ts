import { beforeAll, expect, test } from 'vitest';
import {
  decisionExecutor, lessonOutcome, lessonSnapshot, LOOP_ACTOR, LOOP_POLICY_VERSION, snapshotTarget, type Decision, type DecisionExecutor, type LessonDetail, type Store,
} from '@fb/core';
import { describeStores } from '@fb/core/testing';
import type { LoopCandidate } from '../plugin.ts';
import { approveCandidate } from './approve_lesson.ts';
import { narrowCandidate } from './narrow_scope.ts';
import { loopMiss } from '../testing/context.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const NOW = Date.parse('2026-11-11T12:00:00Z');

/**
 * approve_lesson and narrow_scope through the executors on each backend (the generic handler: both are lesson field
 * writes): what a candidate's `after` says is what is written, and a rollback restores `before` to the letter.
 */
describeStores('approve_lesson and narrow_scope apply and roll back', (h) => {
  let s: Store;
  let x: DecisionExecutor;
  beforeAll(() => {
    s = h.store;
    x = decisionExecutor(s);
  });

  const stored = async (id: string, o: { projectKey?: string | null; scope?: 'project' | 'global'; paths?: string[] } = {}) => {
    await s.knowledge.upsertLesson({
      id, projectKey: o.projectKey === undefined ? 'demo' : o.projectKey, title: `title ${id}`, rule: `rule ${id}`, appliesWhen: 'editing the API',
      scope: o.scope ?? 'project', paths: o.paths ?? ['src/api.ts'], status: 'proposed', source: 'postmortem', embedding: vec(1),
    });
    return detailOf(id);
  };
  const detailOf = async (id: string): Promise<LessonDetail> => {
    const d = (await s.knowledge.lessonDetail(id))!;
    return { ...d, miss: { id: 'miss:f', missed: 'm', cause: 'verification_gap', causeExplanation: 'c' }, feedback: { id: 'f', text: 't', status: 'addressed', sessionId: 's-f', ts: '2026-11-01T00:00:00.000Z' } };
  };
  /** The decision the engine would store for this call. */
  const propose = async (type: Decision['type'], c: LoopCandidate) => (await s.decisions.propose({
    type, projectKey: c.projectKey, targets: c.targets, before: c.before, after: c.after, evidence: c.evidence, features: c.features,
    score: 0.95, confidence: { p: 0.95, lower: 0.92, n: 25, band: 4 }, tier: 'A', mode: 'auto', rationale: c.rationale, model: 'deterministic',
    policyVersion: LOOP_POLICY_VERSION, status: 'proposed',
  })).decision;
  const lesson = async (id: string) => (await s.knowledge.lessonDetail(id))!.lesson;
  const approveOf = (d: LessonDetail) => approveCandidate(d, {
    candidate: { id: 'f', turnUuid: 't', sessionId: 's-f', projectKey: 'demo', source: 'claude', classification: {} as never, status: 'confirmed', createdAt: 't', decidedAt: 't', note: null, decidedBy: 'you' },
    quality: { decided: 12, rate: 0.75 }, repeats: [loopMiss('miss:r')], replay: null, now: NOW,
  });

  test('approve: the loop approves a proposed lesson (not as yours); your rollback makes it proposed and undecided again', async () => {
    const d = await stored('lesson:ap1');
    const dec = await propose('approve_lesson', approveOf(d));
    const applied = await x.apply(dec, { by: LOOP_ACTOR });
    expect(applied.status).toBe('applied');
    const now = await lesson('lesson:ap1');
    expect(now).toMatchObject({ status: 'approved', decidedAt: new Date(NOW).toISOString(), decidedBy: LOOP_ACTOR, decisionNote: 'approved by the learning loop: its miss repeats' });
    // The loop's approval is not the owner's: it does not count as "approved as written" or teach the writer.
    expect(lessonOutcome(now)).toBeNull();

    await x.rollback(applied, { by: 'you', reason: 'wording', cascade: 'apply' });
    expect(await lesson('lesson:ap1')).toMatchObject({ status: 'proposed', decidedAt: null, decidedBy: null, decisionNote: null });
    expect((await snapshotTarget(s, { kind: 'lesson', id: 'lesson:ap1' })).fingerprint).toBe(dec.before[0].fingerprint);
  });

  test('approve: a lesson you had sent back to proposed gets your decision back exactly: time, who and note', async () => {
    await stored('lesson:ap2');
    await s.knowledge.updateLesson('lesson:ap2', { status: 'proposed' }, { by: 'you', note: 'not yet: say which endpoint' });
    const d = await detailOf('lesson:ap2');
    const before = lessonSnapshot(d.lesson);
    expect(before.fields).toMatchObject({ status: 'proposed', decidedBy: 'you', decisionNote: 'not yet: say which endpoint', decidedAt: expect.any(String) });
    const applied = await x.apply(await propose('approve_lesson', approveOf(d)), { by: LOOP_ACTOR });
    await x.rollback(applied, { by: 'you', cascade: 'apply' });
    expect(lessonSnapshot(await lesson('lesson:ap2'))).toEqual(before);
  });

  test('approve: you edited the lesson after the loop approved it: the rollback refuses and writes nothing', async () => {
    const d = await stored('lesson:ap3');
    const applied = await x.apply(await propose('approve_lesson', approveOf(d)), { by: LOOP_ACTOR });
    await s.knowledge.updateLesson('lesson:ap3', { rule: 'your words' }, { by: 'you' });
    await expect(x.rollback(applied, { by: 'you', cascade: 'apply' })).rejects.toThrow('changed since');
    expect(await lesson('lesson:ap3')).toMatchObject({ status: 'approved', rule: 'your words', decidedBy: LOOP_ACTOR });
  });

  test('narrow: a global lesson becomes demo\'s with the fix files as paths, so another project is no longer served it; rollback serves it everywhere again', async () => {
    const d = await stored('lesson:n1', { projectKey: null, scope: 'global', paths: [] });
    await s.knowledge.updateLesson('lesson:n1', { status: 'approved' }, { by: 'you' });
    const before = await detailOf('lesson:n1');
    const served = async (projectKey: string) => (await s.knowledge.searchLessons({ embedding: vec(1), projectKey, k: 10, status: 'approved' })).some((h) => h.lesson.id === 'lesson:n1');
    expect(await served('other')).toBe(true);
    expect(d.lesson.projectKey).toBeNull();

    const dec = await propose('narrow_scope', narrowCandidate(before, { toProject: 'demo', paths: ['src/fix.ts'], files: ['src/fix.ts'], verdicts: 6 }));
    const applied = await x.apply(dec, { by: LOOP_ACTOR });
    expect(await lesson('lesson:n1')).toMatchObject({ projectKey: 'demo', scope: 'project', paths: ['src/fix.ts'], status: 'approved', decidedBy: 'you' });
    expect(await served('other')).toBe(false);
    expect(await served('demo')).toBe(true);

    await x.rollback(applied, { by: 'you', cascade: 'apply' });
    expect(lessonSnapshot(await lesson('lesson:n1'))).toEqual(dec.before[0]);
    expect(await served('other')).toBe(true);
  });

  test('narrow: paths added to a project lesson and taken away again', async () => {
    const d = await stored('lesson:n2', { paths: [] });
    const dec = await propose('narrow_scope', narrowCandidate(d, { toProject: null, paths: ['src/m/**'], files: ['src/m/a.ts', 'src/m/b.ts'], verdicts: 0 }));
    const applied = await x.apply(dec, { by: LOOP_ACTOR });
    expect((await lesson('lesson:n2')).paths).toEqual(['src/m/**']);
    await x.rollback(applied, { by: 'you', cascade: 'apply' });
    expect(lessonSnapshot(await lesson('lesson:n2'))).toEqual(dec.before[0]);
  });
});
