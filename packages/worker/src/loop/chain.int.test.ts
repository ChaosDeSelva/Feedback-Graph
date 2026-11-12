import { beforeAll, expect, test } from 'vitest';
import { decisionExecutor, LESSON_SIGNAL_COUNTS, lessonFingerprint, lessonSnapshot, LOOP_TYPE_INFO, loopExecutor, seedLoopSettings, writeLoopSettings, type Decision, type Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { labelUntouched } from './calibrate.ts';
import { checkBreaker, runLoopRound, type LoopEngineDeps } from './engine.ts';
import { rankWeight } from './types/rank_weight.ts';
import { retireLesson } from './types/retire_lesson.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const zero = () => Object.fromEntries(LESSON_SIGNAL_COUNTS.map((k) => [k, 0])) as Record<(typeof LESSON_SIGNAL_COUNTS)[number], number>;
const DAY = 86_400_000;

/** Real engine rounds over real lesson types on each backend: one lesson changed by the loop more than once. */
describeStores('learning loop decisions on one lesson, round after round', (h) => {
  let store: Store;
  beforeAll(() => { store = h.store; });
  const deps = (now: () => number, types = [retireLesson, rankWeight]): LoopEngineDeps => ({
    store, cursors: store.docs, tokenless: false, inScope: () => true, executor: loopExecutor(store), llm: null, now, log: () => {}, types,
    config: { mode: null, disabled: false, llm: null, llmCallsPerDay: 40, autoPerDay: 5, autoPerProject: 2, syncHoldDays: 7, holdout: 0, types: null },
  });
  async function lesson(id: string) {
    await store.knowledge.upsertLesson({ id, projectKey: 'demo', title: `t ${id}`, rule: 'r', appliesWhen: 'a', scope: 'project', paths: ['src/a.ts'], status: 'proposed', source: 'postmortem', embedding: vec(3) });
    await store.knowledge.updateLesson(id, { status: 'approved' }, { by: 'you' });
  }
  /** A pre-done check that judged the lesson not applicable: what rank_weight's candidates read. */
  const check = (id: string) => store.activity.record({
    kind: 'predone_check', actor: 'agent', projectKey: 'demo', subject: 'c', why: 'w', targets: ['sess-1', id], details: { verdicts: [{ lessonId: id, status: 'not_applicable' }] },
  });
  const served = (id: string) => store.activity.record({
    kind: 'context_served', actor: 'agent', projectKey: 'demo', subject: 's', why: 'w', targets: ['sess-1', id], details: { lessons: [{ id }] },
  });
  const weight = async (id: string) => (await store.knowledge.lessonDetail(id))!.lesson.servingWeight;

  test('a later decision on a lesson an applied one changed depends on it, and rolling back the earlier undoes both, newest first', async () => {
    await writeLoopSettings(store.docs, seedLoopSettings({ mode: 'auto' }));
    await lesson('lesson:ch');
    const original = (await store.knowledge.lessonDetail('lesson:ch'))!.lesson;
    await store.decisions.upsertSignals([{ lessonId: 'lesson:ch', counts: { ...zero(), served: 13, notApplicable: 9 }, lastServed: null, lastOwnerTouch: null }]);
    await served('lesson:ch');
    await check('lesson:ch');
    let t = Date.now() + 91 * DAY;
    await runLoopRound(deps(() => t));
    const [rw] = await store.decisions.list({ type: 'rank_weight' });
    expect(rw.status).toBe('applied');
    await served('lesson:ch');
    await check('lesson:ch');
    t += 60_000;
    await runLoopRound(deps(() => t));
    const [rt] = await store.decisions.list({ type: 'retire_lesson' });
    expect(rt).toMatchObject({ status: 'applied', dependsOn: [rw.id] });

    const x = decisionExecutor(store);
    expect(((await x.rollback(rw, { by: 'you', cascade: 'preview' })) as { cascade: Decision[] }).cascade.map((d) => d.id)).toEqual([rt.id]);
    const rolled = (await x.rollback(rw, { by: 'you', cascade: 'apply' })) as Decision;
    expect(rolled).toMatchObject({ status: 'rolled_back', rollback: { cascade: [rt.id] } });
    expect((await store.decisions.get(rt.id))!.status).toBe('rolled_back');
    expect(lessonFingerprint((await store.knowledge.lessonDetail('lesson:ch'))!.lesson)).toBe(lessonFingerprint(original));
  });

  test('rank_weight steps a lesson round after round toward where its verdicts put it, each step depending on the one before', async () => {
    await writeLoopSettings(store.docs, seedLoopSettings({ mode: 'auto' }));
    await lesson('lesson:rw');
    // 0 of 30 decisive verdicts helped: the weight belongs near 0.55.
    await store.decisions.upsertSignals([{ lessonId: 'lesson:rw', counts: { ...zero(), served: 30, notApplicable: 30 }, lastServed: null, lastOwnerTouch: null }]);
    let t = Date.now() + 15 * DAY;
    for (let i = 0; i < 3; i++) {
      await check('lesson:rw');
      t += 60_000;
      await runLoopRound(deps(() => t, [rankWeight]));
    }
    expect(await weight('lesson:rw')).toBe(0.7);
    const steps = (await store.decisions.list({ type: 'rank_weight' })).reverse();
    expect(steps.map((d) => d.status)).toEqual(['applied', 'applied', 'applied']);
    expect(steps.map((d) => d.dependsOn)).toEqual([[], [steps[0].id], [steps[1].id]]);
  });

  test('a weight back at a value it stepped from steps that way again: 0.9, 1.0, 0.9, 1.0, each step a new decision on the one before', async () => {
    await writeLoopSettings(store.docs, seedLoopSettings({ mode: 'auto' }));
    await lesson('lesson:osc');
    let t = Date.now() + 15 * DAY;
    const step = async (status: 'not_applicable' | 'addressed') => {
      await store.decisions.upsertSignals([{ lessonId: 'lesson:osc', counts: { ...zero(), served: 60, [status === 'addressed' ? 'addressed' : 'notApplicable']: 60 }, lastServed: null, lastOwnerTouch: null }]);
      await store.activity.record({ kind: 'predone_check', actor: 'agent', projectKey: 'demo', subject: 'c', why: 'w', targets: ['sess-1', 'lesson:osc'], details: { verdicts: [{ lessonId: 'lesson:osc', status }] } });
      t += 60_000;
      await runLoopRound(deps(() => t, [rankWeight]));
      return weight('lesson:osc');
    };
    const weights = [];
    for (const v of ['not_applicable', 'addressed', 'not_applicable', 'addressed'] as const) weights.push(await step(v));
    expect(weights).toEqual([0.9, 1, 0.9, 1]);
    const steps = (await store.decisions.list({ type: 'rank_weight' })).reverse();
    expect(steps.map((d) => d.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
    // Each on the step before; the last also on the first, which left the weight at 0.9 as well.
    steps.slice(1).forEach((d, i) => expect(d.dependsOn).toContain(steps[i].id));
    expect(new Set(steps.map((d) => d.id)).size).toBe(4);
  });

  test('the breaker counts a cascade once, against its root\'s type: one owner rollback of a chain of three steps does not trip it', async () => {
    await writeLoopSettings(store.docs, seedLoopSettings({ mode: 'auto' }));
    await lesson('lesson:brk');
    await store.decisions.upsertSignals([{ lessonId: 'lesson:brk', counts: { ...zero(), served: 60, notApplicable: 60 }, lastServed: null, lastOwnerTouch: null }]);
    let t = Date.now() + 15 * DAY;
    for (let i = 0; i < 3; i++) {
      await check('lesson:brk');
      t += 60_000;
      await runLoopRound(deps(() => t, [rankWeight]));
    }
    const steps = await store.decisions.list({ type: 'rank_weight', order: 'applied' });
    expect(steps).toHaveLength(3);
    await decisionExecutor(store).rollback(steps.at(-1)!, { by: 'you', cascade: 'apply', reason: 'wrong_evidence' });
    expect((await store.decisions.list({ type: 'rank_weight', status: ['rolled_back'] }))).toHaveLength(3);
    expect(await checkBreaker({ store, cursors: store.docs }, 'rank_weight', Date.now())).toMatchObject({ tripped: false });
  });

  test('dependents a cascade undid are not counted against their own type: two reword roots rolled back trip reword_lesson, not rank_weight', async () => {
    await writeLoopSettings(store.docs, seedLoopSettings({ mode: 'auto' }));
    const x = decisionExecutor(store);
    const roots: Decision[] = [];
    let t = Date.now() + 15 * DAY;
    for (const id of ['lesson:r1', 'lesson:r2']) {
      await lesson(id);
      const l = (await store.knowledge.lessonDetail(id))!.lesson;
      const { decision } = await store.decisions.propose({
        type: 'reword_lesson', projectKey: 'demo', targets: [{ kind: 'lesson', id, role: 'primary' }], before: [lessonSnapshot(l)], after: [lessonSnapshot({ ...l, rule: 'loop words' })],
        evidence: [{ kind: 'lesson', id, role: 'x', weight: 1, observedAt: 't' }], features: {}, score: 0.95, confidence: { p: 0.95, lower: 0.9, n: 25, band: 4 },
        tier: 'A', mode: 'auto', rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'proposed',
      });
      roots.push(await x.apply(decision, { by: 'loop:1' }));
      // rank_weight steps the reworded lesson: its decision depends on the rewrite.
      await store.decisions.upsertSignals([{ lessonId: id, counts: { ...zero(), served: 60, notApplicable: 60 }, lastServed: null, lastOwnerTouch: null }]);
      await check(id);
      t += 60_000;
      await runLoopRound(deps(() => t, [rankWeight]));
      expect((await store.decisions.list({ type: 'rank_weight', targets: [id] }))[0].dependsOn).toEqual([decision.id]);
    }
    for (const r of roots) await x.rollback(r, { by: 'you', cascade: 'apply' });
    expect(await store.decisions.list({ type: 'rank_weight', status: ['rolled_back'] })).toHaveLength(2);
    expect(await checkBreaker({ store, cursors: store.docs }, 'rank_weight', Date.now())).toMatchObject({ tripped: false });
    expect(await checkBreaker({ store, cursors: store.docs }, 'reword_lesson', Date.now())).toMatchObject({ tripped: true, reason: '2 rollbacks in 7 days' });
  });

  test('an observed step whose lesson the owner edited since: expired, and the step made again on the lesson as it is now', async () => {
    await writeLoopSettings(store.docs, seedLoopSettings({ mode: 'observe' }));
    await lesson('lesson:ex');
    await store.decisions.upsertSignals([{ lessonId: 'lesson:ex', counts: { ...zero(), served: 30, notApplicable: 30 }, lastServed: null, lastOwnerTouch: null }]);
    await check('lesson:ex');
    let t = Date.now() + 15 * DAY;
    await runLoopRound(deps(() => t, [rankWeight]));
    const [observed] = await store.decisions.list({ type: 'rank_weight' });
    expect(observed.status).toBe('observed');
    await store.knowledge.updateLesson('lesson:ex', { rule: 'r, fixed' }, { by: 'you' });
    await writeLoopSettings(store.docs, seedLoopSettings({ mode: 'auto' }));
    await check('lesson:ex');
    t += 60_000;
    const { round } = await runLoopRound(deps(() => t, [rankWeight]));
    expect(round?.decisions.applied).toBe(1);
    expect((await store.decisions.get(observed.id))!.status).toBe('expired');
    expect(await weight('lesson:ex')).toBe(0.9);
    expect((await store.knowledge.lessonDetail('lesson:ex'))!.lesson.rule).toBe('r, fixed');
  });

  test('a loop decision whose lesson the owner rewrote since is overridden and labelled negative, never kept', async () => {
    await lesson('lesson:own');
    const l = (await store.knowledge.lessonDetail('lesson:own'))!.lesson;
    const { decision } = await store.decisions.propose({
      type: 'reword_lesson', projectKey: 'demo', targets: [{ kind: 'lesson', id: l.id, role: 'primary' }], before: [lessonSnapshot(l)],
      after: [lessonSnapshot({ ...l, rule: 'loop words' })], evidence: [{ kind: 'lesson', id: l.id, role: 'x', weight: 1, observedAt: 't' }],
      features: {}, score: 0.95, confidence: { p: 0.95, lower: 0.9, n: 25, band: 4 }, tier: 'A', mode: 'auto', rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'proposed',
    });
    const x = loopExecutor(store);
    expect((await x.apply(decision, { by: 'loop:1', syncHoldUntil: new Date(Date.now() + 7 * DAY).toISOString() })).status).toBe('applied');
    expect(await x.changed((await store.decisions.get(decision.id))!)).toBeNull();
    await store.knowledge.updateLesson(l.id, { rule: 'the owner\'s own words' }, { by: 'you' });
    const served = async () => ({ lastServed: new Date(Date.now() + 15 * DAY).toISOString() });
    const out = await labelUntouched({ decisions: store.decisions, activity: store.activity, signals: served, changed: (d) => x.changed(d), now: Date.now() + 16 * DAY });
    expect(out).toEqual({ kept: 0, overridden: 1 });
    expect((await store.decisions.get(decision.id))!.status).toBe('overridden');
    const { prior } = LOOP_TYPE_INFO.reword_lesson;
    expect(await store.decisions.calibration('reword_lesson', 1)).toEqual([expect.objectContaining({ alpha: prior.alpha, beta: prior.beta + 1, n: 1 })]);
    expect((await store.activity.list({ target: decision.id, limit: 5 }))[0]).toMatchObject({ kind: 'decision_made', actor: 'loop:1', details: { status: 'overridden' } });
  });
});
