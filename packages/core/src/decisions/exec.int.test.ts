import { beforeAll, expect, test, vi } from 'vitest';
import { isSuppressed, parseSuppression, suppressionKey } from '../loop/state.ts';
import type { Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { LessonInput } from '../graph/knowledge.ts';
import type { Classification, Decision, DecisionInput, DecisionTarget, Lesson, LessonStatus, ParsedSession, TargetSnapshot } from '../types.ts';
import { APPLY_LEASE_RENEW_MS, applyDecision, handlerContext, RECONCILE_AFTER_MS } from './apply.ts';
import { genericHandler, moveTargets } from './types/generic.ts';
import { missLinkSnapshot, thresholdsSnapshot } from '../loop/snapshots.ts';
import { dependenciesOf } from './cascade.ts';
import { decisionExecutor, loopExecutor, type DecisionExecutor } from './executor.ts';
import { ABSENT, DecisionStateError, TargetChangedError, UnsupportedTargetError } from './record.ts';
import { linkMisses as linkMissesHandler } from './types/link_misses.ts';
import { CascadeBlockedError, redoDecision } from './rollback.ts';
import { absentSnapshot, candidateSnapshot, factSnapshot, lessonSnapshot, snapshotTarget, snapshotTargets } from './snapshot.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const T0 = '2026-11-01T00:00:00.000Z';
const embed = async (texts: string[]) => texts.map((_, i) => vec(100 + i));

/** A seeded generator (mulberry32), so a failing history can be replayed. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Past the reconcile grace: what a later start-up pass or loop round sees. */
const later = () => Date.now() + 3 * 60_000;

describeStores('decision executors', (h) => {
  let s: Store;
  let x: DecisionExecutor;
  beforeAll(() => {
    s = h.store;
    x = decisionExecutor(s, { embed });
  });

  const lesson = async (id: string, over: Partial<LessonInput> = {}) => {
    await s.knowledge.upsertLesson({
      id, projectKey: 'demo', title: `title ${id}`, rule: `rule ${id}`, appliesWhen: 'editing the API', scope: 'project',
      paths: ['src/api.ts'], status: 'proposed', source: 'memory', embedding: vec(1), ...over,
    });
    return (await s.knowledge.lessonDetail(id))!.lesson;
  };
  const getLesson = async (id: string) => (await s.knowledge.lessonDetail(id))!.lesson;
  const fp = async (t: Pick<DecisionTarget, 'kind' | 'id'>) => (await snapshotTarget(s, t)).fingerprint;
  let evidenceSeq = 0;
  const input = (type: Decision['type'], targets: DecisionTarget[], before: TargetSnapshot[], after: TargetSnapshot[], over: Partial<DecisionInput> = {}): DecisionInput => ({
    type, projectKey: 'demo', targets, before, after,
    evidence: [{ kind: 'lesson', id: `ev:${++evidenceSeq}`, role: 'because', weight: 1, observedAt: T0 }],
    features: {}, score: 0.9, confidence: { p: 0.9, lower: 0.8, n: 0, band: 4 }, tier: 'H', mode: 'auto',
    rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'proposed', ...over,
  });
  const propose = async (...a: Parameters<typeof input>) => (await s.decisions.propose(input(...a))).decision;
  /** A decision changing one lesson by `patch`, planned as the engine plans it. */
  const lessonDecision = async (l: Lesson, patch: Partial<Lesson>, type: Decision['type'] = 'approve_lesson', over: Partial<DecisionInput> = {}) =>
    propose(type, [{ kind: 'lesson', id: l.id, role: 'primary' }], [lessonSnapshot(l)], [lessonSnapshot({ ...l, ...patch })], over);
  const approve = { status: 'approved' as const, decidedAt: T0, decidedBy: 'loop:1', decisionNote: 'the loop approved it' };

  test('apply writes after over before as the planned decision says, and rollback restores before to the letter', async () => {
    const l = await lesson('lesson:a');
    const d = await lessonDecision(l, approve);
    const applied = await x.apply(d, { by: 'loop:1' });
    expect(applied).toMatchObject({ status: 'applied', decidedBy: 'loop:1', appliedAt: expect.any(String), decidedAt: expect.any(String) });
    expect(applied.after).toEqual(d.after);
    expect(await getLesson('lesson:a')).toMatchObject({ status: 'approved', decidedAt: T0, decidedBy: 'loop:1', decisionNote: 'the loop approved it' });

    const back = await x.rollback(applied, { by: 'you', reason: 'wording', note: 'not yet', cascade: 'apply' }) as Decision;
    expect(back).toMatchObject({ status: 'rolled_back', decidedBy: 'you', rollback: { by: 'you', reason: 'wording', note: 'not yet', cascade: [] } });
    // A lesson the loop approved is proposed and undecided again.
    expect(await getLesson('lesson:a')).toMatchObject({ status: 'proposed', decidedAt: null, decidedBy: null, decisionNote: null });
    expect(await fp({ kind: 'lesson', id: 'lesson:a' })).toBe(d.before[0].fingerprint);
    // The call is suppressed. The executor writes no calibration label or penalty: the engine folds the owner's
    // rollback from Activity (worker loop/calibrate.ts), so it is counted once.
    expect(await s.decisions.calibration('approve_lesson', 1)).toEqual([]);
    expect(await s.docs.getCursor('loop-penalty:approve_lesson')).toBeNull();
    const sup = parseSuppression(await s.docs.getCursor(suppressionKey('approve_lesson', d.targets)));
    expect(isSuppressed(sup, 1, Date.now())).toBe(true);
    expect(isSuppressed(sup, 2, Date.now())).toBe(false);

    // A second rollback, or an apply of a rolled-back decision, is refused.
    await expect(x.rollback(back, { by: 'you', cascade: 'apply' })).rejects.toBeInstanceOf(DecisionStateError);
    await expect(x.apply(back, { by: 'you' })).rejects.toThrow(/is rolled_back, not proposed or observed/);
    await expect(x.apply({ ...d, id: 'dec:none' }, { by: 'you' })).rejects.toThrow('no decision dec:none');
  });

  test('redo applies a rolled-back decision again only while its targets are as before, and lifts its suppression', async () => {
    const l = await lesson('lesson:redo');
    const d = await lessonDecision(l, approve);
    await x.rollback(await x.apply(d, { by: 'loop:1' }), { by: 'operator:bot', cascade: 'apply' });
    const again = await x.redo(d, { by: 'you' });
    expect(again).toMatchObject({ status: 'applied', decidedBy: 'you' });
    expect(await s.docs.getCursor(suppressionKey('approve_lesson', d.targets))).toBeNull();
    await expect(x.redo(again, { by: 'you' })).rejects.toBeInstanceOf(DecisionStateError);
    await x.rollback(again, { by: 'you', cascade: 'apply' });
    // Another redo won the race to proposed.
    const racing = { ...s, decisions: Object.assign(Object.create(s.decisions), { markStatus: async () => false }) } as Store;
    await expect(redoDecision(racing, d, { by: 'you' })).rejects.toThrow(/is rolled_back, not rolled_back/);
    await x.redo(d, { by: 'you' });

    await x.rollback(again, { by: 'you', cascade: 'apply' });
    await s.knowledge.updateLesson('lesson:redo', { rule: 'the owner rewrote it' }, { by: 'you' });
    await expect(x.redo(d, { by: 'you' })).rejects.toBeInstanceOf(TargetChangedError);
    expect((await s.decisions.get(d.id))!.status).toBe('rolled_back');
  });

  test('a target changed since the decision was made: apply writes nothing and the decision expires', async () => {
    const l = await lesson('lesson:stale');
    const d = await lessonDecision(l, approve);
    await s.knowledge.updateLesson('lesson:stale', { title: 'the owner retitled it' }, { by: 'you' });
    const err = await x.apply(d, { by: 'loop:1' }).catch((e) => e);
    expect(err).toBeInstanceOf(TargetChangedError);
    expect(err).toMatchObject({ targetId: 'lesson:stale', expected: d.before[0].fingerprint, actual: await fp({ kind: 'lesson', id: 'lesson:stale' }) });
    expect((await s.decisions.get(d.id))!.status).toBe('overridden');
    expect((await getLesson('lesson:stale')).status).toBe('proposed');
    // Restore anyway is for what was applied: an overridden proposal changed nothing.
    await expect(x.rollback((await s.decisions.get(d.id))!, { by: 'you', cascade: 'apply', restoreAnyway: true })).rejects.toThrow(new DecisionStateError(d.id, 'overridden', '', 'and it was never applied, so there is nothing to restore'));

    // Gone is changed too.
    const gone = await propose('approve_lesson', [{ kind: 'lesson', id: 'lesson:never', role: 'primary' }], [lessonSnapshot({ ...l, id: 'lesson:never' })], [lessonSnapshot({ ...l, id: 'lesson:never', ...approve })]);
    await expect(x.apply(gone, { by: 'loop:1' })).rejects.toMatchObject({ name: 'TargetChangedError', actual: null });
  });

  test('a write that fails for another reason puts the decision back where it was', async () => {
    const l = await lesson('lesson:obs');
    const o = await lessonDecision(l, approve, 'approve_lesson', { status: 'observed' });
    const failing = { ...s, knowledge: Object.assign(Object.create(s.knowledge), { writeLessonSnapshots: async () => { throw new Error('disk full'); } }) } as Store;
    await expect(applyDecision(failing, o, { by: 'you' })).rejects.toThrow('disk full');
    expect((await s.decisions.get(o.id))!.status).toBe('observed');
    // Creating a lesson is not something the generic write does (reword_lesson's own handler does, for a split)...
    const ctx = handlerContext(s, {}, 'you');
    const d = await propose('approve_lesson', [{ kind: 'lesson', id: 'lesson:new', role: 'created' }, { kind: 'lesson', id: l.id, role: 'primary' }],
      [absentSnapshot({ kind: 'lesson', id: 'lesson:new' }), lessonSnapshot(l)], [lessonSnapshot({ ...l, id: 'lesson:new' }), lessonSnapshot(l)], { status: 'observed' });
    await expect(genericHandler.apply(ctx, d)).rejects.toThrow('cannot create lesson lesson:new');
    // ...nor removing one.
    const r = await propose('approve_lesson', [{ kind: 'lesson', id: l.id, role: 'primary' }], [lessonSnapshot(l)], [absentSnapshot({ kind: 'lesson', id: l.id })]);
    await expect(genericHandler.apply(ctx, r)).rejects.toBeInstanceOf(UnsupportedTargetError);
    expect(await getLesson(l.id)).toMatchObject({ status: l.status });
    // A decision that lost the race to markApplying.
    const p = await lessonDecision(l, approve);
    const racing = { ...s, decisions: Object.assign(Object.create(s.decisions), { markApplying: async () => false }) } as Store;
    await expect(applyDecision(racing, p, { by: 'you' })).rejects.toThrow(/is proposed, not proposed or observed/);
    // A target changed between the check and the write (the store's own compare-and-set): overridden, nothing written.
    const changing = { ...s, knowledge: Object.assign(Object.create(s.knowledge), { writeLessonSnapshots: async () => { throw new TargetChangedError(l.id, 'a', 'b'); } }) } as Store;
    await expect(applyDecision(changing, p, { by: 'you' })).rejects.toBeInstanceOf(TargetChangedError);
    expect((await s.decisions.get(p.id))!.status).toBe('overridden');
  });

  test('the owner changed an applied target: rollback refuses without marking it, previews it as blocked, and Restore anyway writes before', async () => {
    const l = await lesson('lesson:own');
    const d = await x.apply(await lessonDecision(l, approve), { by: 'loop:1' });
    await s.knowledge.updateLesson('lesson:own', { rule: 'the owner fixed the rule' }, { by: 'you' });
    expect(await x.rollback(d, { by: 'you', cascade: 'preview' })).toEqual({ cascade: [], blocked: [{ id: d.id, reason: 'lesson lesson:own changed since it was applied' }], own: { targetId: 'lesson:own', expected: d.after[0].fingerprint, actual: expect.any(String) } });
    const err = await x.rollback(d, { by: 'you', cascade: 'apply' }).catch((e) => e);
    expect(err).toBeInstanceOf(TargetChangedError);
    expect(err).toMatchObject({ targetId: 'lesson:own', expected: d.after[0].fingerprint });
    expect((await s.decisions.get(d.id))!.status).toBe('applied'); // the caller marks it overridden
    await s.decisions.markStatus(d.id, { status: 'overridden', from: ['applied'] });
    const over = (await s.decisions.get(d.id))!;
    expect(await x.rollback(over, { by: 'you', cascade: 'preview', restoreAnyway: true })).toEqual({ cascade: [], blocked: [], own: null });
    const restored = await x.rollback(over, { by: 'you', cascade: 'apply', restoreAnyway: true, reason: 'nonsense' }) as Decision;
    expect(restored).toMatchObject({ status: 'rolled_back', rollback: { reason: null } });
    expect(await fp({ kind: 'lesson', id: 'lesson:own' })).toBe(d.before[0].fingerprint);
    await expect(x.rollback(restored, { by: 'you', cascade: 'apply', restoreAnyway: true })).rejects.toBeInstanceOf(DecisionStateError);
  });

  test('merge: the keeper takes both paths and supersedes the duplicate; rollback un-supersedes it and drops the edge', async () => {
    const keeper = await lesson('lesson:keep', { paths: ['src/a.ts'], status: 'approved' });
    const dup = await lesson('lesson:dup', { paths: ['src/b.ts'] });
    const targets: DecisionTarget[] = [{ kind: 'lesson', id: keeper.id, role: 'keeper' }, { kind: 'lesson', id: dup.id, role: 'merged' }];
    const d = await propose('merge_duplicates', targets, [lessonSnapshot(keeper), lessonSnapshot(dup)],
      [lessonSnapshot({ ...keeper, paths: ['src/a.ts', 'src/b.ts'] }), lessonSnapshot({ ...dup, status: 'superseded', decidedAt: T0, decidedBy: 'loop:1', decisionNote: 'merged into lesson:keep' })]);
    const applied = await x.apply(d, { by: 'loop:1' });
    expect((await s.knowledge.lessonDetail(keeper.id))!.supersedes).toEqual([dup.id]);
    expect((await getLesson(keeper.id)).paths).toEqual(['src/a.ts', 'src/b.ts']);
    const validTo = async () => { const r = (await h.probe.rows('Lesson')).find((x) => x.id === dup.id)!; return r.validTo ?? r.valid_to ?? null; };
    expect(await validTo()).not.toBeNull();
    // The keeper's paths changed: checked again. The duplicate's words did not: its checks stand.
    await x.rollback(applied, { by: 'you', cascade: 'apply' });
    expect((await s.knowledge.lessonDetail(keeper.id))!.supersedes).toEqual([]);
    expect(await snapshotTargets(s, targets)).toEqual(d.before);
    expect(await validTo()).toBeNull();
  });

  test('merge whose keeper is unchanged (the duplicate\'s paths already its own) still supersedes the duplicate with the edge', async () => {
    const keeper = await lesson('lesson:k2', { paths: ['src/a.ts', 'src/b.ts'], status: 'approved' });
    const dup = await lesson('lesson:d2', { paths: ['src/b.ts'] });
    const targets: DecisionTarget[] = [{ kind: 'lesson', id: keeper.id, role: 'keeper' }, { kind: 'lesson', id: dup.id, role: 'merged' }];
    const d = await propose('merge_duplicates', targets, [lessonSnapshot(keeper), lessonSnapshot(dup)],
      [lessonSnapshot(keeper), lessonSnapshot({ ...dup, status: 'superseded', decidedAt: T0, decidedBy: 'loop:1', decisionNote: 'merged' })]);
    const applied = await x.apply(d, { by: 'loop:1' });
    expect((await s.knowledge.lessonDetail(keeper.id))!.supersedes).toEqual([dup.id]);
    expect((await getLesson(dup.id)).status).toBe('superseded');
    await x.rollback(applied, { by: 'you', cascade: 'apply' });
    expect((await s.knowledge.lessonDetail(keeper.id))!.supersedes).toEqual([]);
    expect(await snapshotTargets(s, targets)).toEqual(d.before);
  });

  test('reword: new words are written with a new vector and checked again', async () => {
    const l = await lesson('lesson:words');
    await s.knowledge.setLessonChecks(l.id, []);
    const seen: string[] = [];
    const ex = decisionExecutor(s, { embed: async (t) => { seen.push(...t); return t.map(() => vec(5)); } });
    await ex.apply(await lessonDecision(l, { rule: 'Call the API through the gateway', title: `title ${l.id}`, scope: 'global', projectKey: null }, 'reword_lesson'), { by: 'loop:1' });
    expect(seen).toEqual([`title lesson:words\nCall the API through the gateway\nApplies when: editing the API`]);
    expect(await getLesson(l.id)).toMatchObject({ rule: 'Call the API through the gateway', scope: 'global', projectKey: null, checksVersion: 0 });
    // Narrowing to a project files it there.
    const g = await getLesson(l.id);
    await ex.apply(await lessonDecision(g, { scope: 'project', projectKey: 'shop' }, 'narrow_scope'), { by: 'loop:1' });
    expect(await getLesson(l.id)).toMatchObject({ projectKey: 'shop', scope: 'project' });
    expect(seen).toHaveLength(1);
  });

  test('record_fact: the fact is added under its planned id and the lesson rejected; rollback closes the fact; redo reopens it', async () => {
    const l = await lesson('lesson:fact', { status: 'approved' });
    const factId = 'fact:loop:1';
    const planned = factSnapshot({ id: factId, projectKey: 'demo', kind: 'convention', statement: l.rule, path: 'src/api.ts', lines: null, why: 'from the lesson', relevance: 0.6, relevanceBy: 'you', current: true });
    const targets: DecisionTarget[] = [{ kind: 'lesson', id: l.id, role: 'primary' }, { kind: 'fact', id: factId, role: 'created' }];
    const d = await propose('record_fact', targets, [lessonSnapshot(l), absentSnapshot({ kind: 'fact', id: factId })],
      [lessonSnapshot({ ...l, status: 'rejected', decidedAt: T0, decidedBy: 'loop:1', decisionNote: 'converted to a fact' }), planned]);
    // No embedder: nothing is written and the decision waits again.
    await expect(loopExecutor(s).apply(d, { by: 'loop:1', syncHoldUntil: null })).rejects.toThrow('cannot create without an embedder fact fact:loop:1');
    expect((await s.decisions.get(d.id))!.status).toBe('proposed');

    const applied = await x.apply(d, { by: 'loop:1' });
    expect(applied.after).toEqual(d.after);
    expect(await s.facts.fact(factId)).toMatchObject({ statement: l.rule, current: true, origin: 'loop', relevance: 0.6, relevanceBy: 'you' });
    expect(await x.snapshot('fact', factId)).toEqual(planned);
    await x.rollback(applied, { by: 'you', cascade: 'apply' });
    expect(await s.facts.fact(factId)).toMatchObject({ current: false });
    expect(await x.snapshot('fact', factId)).toBeNull();
    expect(await snapshotTargets(s, targets)).toEqual(d.before.map((b) => (b.kind === 'fact' ? { ...b, fields: expect.any(Object) } : b)));
    await x.redo(d, { by: 'you' });
    expect(await s.facts.fact(factId)).toMatchObject({ current: true, relevance: 0.6 });
    expect((await getLesson(l.id)).status).toBe('rejected');
  });

  test('fact relevance: written and restored with the fact compared first; a fact a scan closed since is changed', async () => {
    await s.facts.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h1', summary: '' }, [{ kind: 'convention', statement: 'one', path: 'src/a.ts', lines: null, confidence: 0.9, why: 'w', embedding: vec(2) }], 'ollama:x');
    const [f] = await s.facts.listFacts({ projectKey: 'demo' });
    const before = await snapshotTarget(s, { kind: 'fact', id: f.id });
    expect(before.fields).toMatchObject({ relevance: null, relevanceBy: null, current: true });
    const targets: DecisionTarget[] = [{ kind: 'fact', id: f.id, role: 'primary' }];
    const after = factSnapshot({ ...(before.fields as Parameters<typeof factSnapshot>[0]), id: f.id, relevance: 0.8, relevanceBy: 'model' });
    const d = await x.apply(await propose('rank_weight', targets, [before], [after]), { by: 'loop:1' });
    expect(await s.facts.fact(f.id)).toMatchObject({ relevance: 0.8, relevanceBy: 'model' });
    await x.rollback(d, { by: 'you', cascade: 'apply' });
    expect(await s.facts.fact(f.id)).toMatchObject({ relevance: null, relevanceBy: null });

    const d2 = await x.apply(await propose('rank_weight', targets, [before], [after]), { by: 'loop:1' });
    await s.facts.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h2', summary: '' }, [], 'ollama:x');
    await expect(x.rollback(d2, { by: 'you', cascade: 'apply' })).rejects.toMatchObject({ name: 'TargetChangedError', actual: null });
    // The store refuses a stale write itself too, whatever the executor checked.
    await expect(s.facts.writeFactSnapshots([{ id: f.id, expect: after.fingerprint, fields: { relevance: 0.1, relevanceBy: 'model', current: true } }])).rejects.toMatchObject({ name: 'TargetChangedError', actual: ABSENT });
    await expect(s.facts.writeFactSnapshots([{ id: 'fact:gone', expect: after.fingerprint, fields: { relevance: 0.1, relevanceBy: 'model', current: true } }])).rejects.toMatchObject({ actual: null });
    await s.facts.writeFactSnapshots([]);
  });

  test('link_misses: the link is made and removed; a link changed since, or a miss gone, is a changed target', async () => {
    for (const [i, id] of ['miss:a', 'miss:b'].entries()) await h.probe.seedEmbedded({ kind: 'Miss', id, missed: id, causeExplanation: 'c', embedding: vec(i) });
    const targets: DecisionTarget[] = [{ kind: 'miss', id: 'miss:a', role: 'primary' }, { kind: 'miss', id: 'miss:b', role: 'keeper' }];
    const plan = () => propose('link_misses', targets, [missLinkSnapshot('miss:a', 'miss:b', false)], [missLinkSnapshot('miss:a', 'miss:b', true)]);
    const d = await x.apply(await plan(), { by: 'loop:1' });
    expect(d.after).toEqual([missLinkSnapshot('miss:a', 'miss:b', true)]);
    expect(await s.decisions.missLinks('miss:b')).toEqual([expect.objectContaining({ from: 'miss:a', to: 'miss:b', decisionId: d.id })]);
    expect(await x.current(d)).toEqual(d.after);
    await x.rollback(d, { by: 'you', cascade: 'apply' });
    expect(await s.decisions.missLinks('miss:a')).toEqual([]);

    const d2 = await x.apply(await plan(), { by: 'loop:1' });
    await s.decisions.unlinkMisses({ from: 'miss:a', to: 'miss:b' });
    await expect(x.rollback(d2, { by: 'you', cascade: 'apply' })).rejects.toBeInstanceOf(TargetChangedError);
    // The handler compares again just before it writes (a link made, or the decision rolled back, in between).
    const ctx = { store: s, deps: {}, by: 'you' };
    await s.decisions.linkMisses({ from: 'miss:a', to: 'miss:b', decisionId: 'dec:other' });
    await expect(linkMissesHandler.apply(ctx, d2)).rejects.toBeInstanceOf(TargetChangedError);
    await expect(linkMissesHandler.rollback(ctx, d2, [missLinkSnapshot('miss:a', 'miss:b', false)])).rejects.toBeInstanceOf(TargetChangedError);
    // A miss gone: the link cannot be made.
    const gone = await propose('link_misses', [{ kind: 'miss', id: 'miss:a', role: 'primary' }, { kind: 'miss', id: 'miss:none', role: 'keeper' }],
      [missLinkSnapshot('miss:a', 'miss:none', false)], [missLinkSnapshot('miss:a', 'miss:none', true)]);
    expect(await loopExecutor(s).apply(gone, { by: 'loop:1', syncHoldUntil: null })).toEqual({ status: 'changed', reason: 'miss:a changed since the decision\'s snapshot' });
    expect((await s.decisions.get(gone.id))!.status).toBe('overridden');
    expect(await loopExecutor(s).apply(gone, { by: 'loop:1', syncHoldUntil: null })).toEqual({ status: 'lost' });
    const ok = await propose('link_misses', [{ kind: 'miss', id: 'miss:b', role: 'primary' }, { kind: 'miss', id: 'miss:a', role: 'keeper' }],
      [missLinkSnapshot('miss:b', 'miss:a', false)], [missLinkSnapshot('miss:b', 'miss:a', true)]);
    expect(await loopExecutor(s).apply(ok, { by: 'loop:1', syncHoldUntil: '2026-12-01T00:00:00.000Z' })).toEqual({ status: 'applied', decision: expect.objectContaining({ id: ok.id, status: 'applied', syncHoldUntil: '2026-12-01T00:00:00.000Z' }) });
  });

  test('triage: an Inbox item is decided and reopened; once a post-mortem tried it, it cannot be reopened', async () => {
    const turns = [0, 1, 2].map((i) => ({ uuid: `s1-t${i}`, sessionId: 's1', ts: `2026-10-01T10:0${i}:00Z`, index: i, text: `turn ${i}`, precedingAssistantText: '', precedingToolCalls: [] }));
    const session: ParsedSession = { sessionId: 's1', sourceFile: 'f', cwd: '/w/demo', gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[2].ts, turns, toolCalls: [] };
    await s.graph.upsertSession({ key: 'demo', name: 'demo', repoPath: '/w/demo' }, session, []);
    const pushback: Classification = { label: 'pushback', confidence: 0.9, summary: 's', signals: [] };
    await s.graph.saveClassification('s1-t1', pushback, true);
    const targets: DecisionTarget[] = [{ kind: 'candidate', id: 's1-t1', role: 'primary' }];
    const before = await snapshotTargets(s, targets);
    expect(before[0].fields).toEqual({ status: 'pending', note: null, decidedBy: null });
    const reject = await x.apply(await propose('triage_inbox', targets, before, [candidateSnapshot({ id: 's1-t1', status: 'rejected', note: 'not pushback', decidedBy: 'you' })], { tier: 'P' }), { by: 'you' });
    expect((await s.graph.candidateDetail('s1-t1'))!.candidate).toMatchObject({ status: 'rejected', note: 'not pushback', decidedBy: 'you' });
    await x.rollback(reject, { by: 'you', cascade: 'apply' });
    expect(await snapshotTargets(s, targets)).toEqual(before);

    const confirm = await x.apply(await propose('triage_inbox', targets, before, [candidateSnapshot({ id: 's1-t1', status: 'confirmed', note: null, decidedBy: null })], { tier: 'P' }), { by: 'you' });
    await s.knowledge.recordPostmortemFailure('s1-t1', 'model down');
    await expect(x.rollback(confirm, { by: 'you', cascade: 'apply' })).rejects.toBeInstanceOf(TargetChangedError);
    expect((await s.graph.candidateDetail('s1-t1'))!.candidate.status).toBe('confirmed');
    expect(await x.snapshot('candidate', 'nope')).toBeNull();
  });

  test('cascade: later decisions built on this one are undone first, newest first, all or nothing', async () => {
    const l = await lesson('lesson:c');
    const d1 = await x.apply(await lessonDecision(l, approve), { by: 'loop:1' });
    const l1 = await getLesson(l.id);
    const deps = await dependenciesOf(s, [lessonSnapshot(l1)]);
    expect(deps).toEqual([d1.id]);
    expect(await dependenciesOf(s, [absentSnapshot({ kind: 'lesson', id: l.id }), lessonSnapshot(l)])).toEqual([]);
    const d2 = await x.apply(await lessonDecision(l1, { paths: ['src/api.ts', 'src/gw.ts'] }, 'narrow_scope', { dependsOn: deps }), { by: 'loop:1' });
    const l2 = await getLesson(l.id);
    // d3 names d1 too: reached twice, undone once. A proposal built on d1 is not applied, so there is nothing to undo.
    const d3 = await x.apply(await lessonDecision(l2, { title: 'Use the gateway' }, 'reword_lesson', { dependsOn: [d1.id, ...await dependenciesOf(s, [lessonSnapshot(l2)])] }), { by: 'loop:1' });
    await lessonDecision(l1, { rule: 'never applied' }, 'reword_lesson', { dependsOn: [d1.id] });

    const preview = await x.rollback(d1, { by: 'you', cascade: 'preview' });
    expect(preview).toEqual({ cascade: [expect.objectContaining({ id: d3.id }), expect.objectContaining({ id: d2.id })], blocked: [], own: null });

    // The owner edits the lesson: the newest decision on it is blocked, and nothing is undone.
    await s.knowledge.updateLesson(l.id, { appliesWhen: 'the owner said when' }, { by: 'you' });
    expect(await x.rollback(d1, { by: 'you', cascade: 'preview' })).toMatchObject({ blocked: [{ id: d3.id, reason: `lesson ${l.id} changed since it was applied` }] });
    const err = await x.rollback(d1, { by: 'you', cascade: 'apply' }).catch((e) => e);
    expect(err).toBeInstanceOf(CascadeBlockedError);
    expect(err.blocked).toEqual([{ id: d3.id, reason: `lesson ${l.id} changed since it was applied` }]);
    expect((await Promise.all([d1, d2, d3].map((d) => s.decisions.get(d.id)))).map((d) => d!.status)).toEqual(['applied', 'applied', 'applied']);

    // Put back as d3 left it: the cascade runs.
    const now = await getLesson(l.id);
    await s.knowledge.writeLessonSnapshots([{ id: l.id, fields: d3.after[0].fields as never, expect: lessonSnapshot(now).fingerprint }]);
    const back = await x.rollback(d1, { by: 'you', cascade: 'apply' }) as Decision;
    expect(back.rollback!.cascade).toEqual([d3.id, d2.id]);
    expect((await Promise.all([d2, d3].map((d) => s.decisions.get(d.id)))).map((d) => [d!.status, d!.rollback!.cascade])).toEqual([['rolled_back', []], ['rolled_back', []]]);
    expect(await fp({ kind: 'lesson', id: l.id })).toBe(d1.before[0].fingerprint);
  });

  test('a cascade that fails part way moves every target it wrote back', async () => {
    const a = await lesson('lesson:p1');
    // d1 also names a project, which the generic handler cannot write back (applied by hand): undoing it fails.
    const project = { kind: 'project' as const, id: 'demo', role: 'primary' as const };
    const d1 = await propose('narrow_scope', [{ kind: 'lesson', id: a.id, role: 'primary' }, project],
      [lessonSnapshot(a), { ...absentSnapshot(project), fingerprint: 'threshold .80' }], [lessonSnapshot({ ...a, title: 'tuned' }), thresholdsSnapshot('demo', { similarityFloor: null, factRankFloor: null })]);
    await s.decisions.markApplying(d1.id);
    await s.knowledge.writeLessonSnapshots([{ id: a.id, fields: d1.after[0].fields as never, expect: d1.before[0].fingerprint }]);
    await s.decisions.markApplied(d1.id, d1.after);
    const a1 = await getLesson(a.id);
    const d2 = await x.apply(await lessonDecision(a1, approve, 'approve_lesson', { dependsOn: [d1.id] }), { by: 'loop:1' });
    // d2 is undone first, then d1 fails: d2's lesson is moved back to as d2 left it.
    await expect(x.rollback((await s.decisions.get(d1.id))!, { by: 'you', cascade: 'apply' })).rejects.toThrow('cannot write project demo');
    expect(await fp({ kind: 'lesson', id: a.id })).toBe(d2.after[0].fingerprint);
    expect((await Promise.all([d1, d2].map((d) => s.decisions.get(d.id)))).map((d) => d!.status)).toEqual(['applied', 'applied']);

    // record_fact whose decision also names that project: the new fact is closed again when the project write fails.
    const b = await lesson('lesson:p2');
    const factId = 'fact:loop:p2';
    const planned = factSnapshot({ id: factId, projectKey: 'demo', kind: 'convention', statement: 's', path: 'src/x.ts', lines: null, why: 'w', relevance: null, relevanceBy: null, current: true });
    const r = await propose('record_fact', [{ kind: 'fact', id: factId, role: 'created' }, { ...project, id: 'shop' }, { kind: 'lesson', id: b.id, role: 'primary' }],
      [absentSnapshot({ kind: 'fact', id: factId }), thresholdsSnapshot('shop', { similarityFloor: null, factRankFloor: null }), lessonSnapshot(b)], [planned, { ...absentSnapshot({ ...project, id: 'shop' }), fingerprint: 'x' }, lessonSnapshot(b)]);
    await expect(x.apply(r, { by: 'loop:1' })).rejects.toBeInstanceOf(UnsupportedTargetError);
    expect(await s.facts.fact(factId)).toMatchObject({ current: false });
    expect((await s.decisions.get(r.id))!.status).toBe('proposed');
  });

  test('Inbox items are compared just before they are written; the generic handler writes no miss or project', async () => {
    const t: DecisionTarget = { kind: 'candidate', id: 'nope', role: 'primary' };
    const to = candidateSnapshot({ id: 'nope', status: 'rejected', note: null, decidedBy: 'you' });
    await expect(moveTargets(s, [t], [candidateSnapshot({ id: 'nope', status: 'pending', note: null, decidedBy: null })], [to], { by: 'you' }))
      .rejects.toMatchObject({ name: 'TargetChangedError', actual: null });
    await expect(moveTargets(s, [], [absentSnapshot({ kind: 'miss', id: 'miss:z' })], [{ ...absentSnapshot({ kind: 'miss', id: 'miss:z' }), fingerprint: 'x' }], { by: 'you' }))
      .rejects.toThrow('cannot write miss miss:z');
  });

  test('reconcile settles decisions a crash left applying by where their targets are', async () => {
    const mk = async (id: string) => {
      const l = await lesson(id);
      const d = await lessonDecision(l, approve);
      await s.decisions.markApplying(d.id);
      return d;
    };
    const written = await mk('lesson:r1');
    await s.knowledge.writeLessonSnapshots([{ id: 'lesson:r1', fields: written.after[0].fields as never, expect: written.before[0].fingerprint }]);
    const untouched = await mk('lesson:r2');
    const changed = await mk('lesson:r3');
    await s.knowledge.updateLesson('lesson:r3', { rule: 'owner' }, { by: 'you' });
    // An apply may still be running in another process: nothing is settled before RECONCILE_AFTER_MS.
    expect(await x.reconcile()).toEqual({ applied: 0, proposed: 0, overridden: 0 });
    expect(await x.reconcile(later())).toEqual({ applied: 1, proposed: 1, overridden: 1 });
    expect((await Promise.all([written, untouched, changed].map((d) => s.decisions.get(d.id)))).map((d) => d!.status)).toEqual(['applied', 'proposed', 'overridden']);
    expect((await s.decisions.get(written.id))!.after).toEqual(written.after);
    expect(await x.reconcile(later())).toEqual({ applied: 0, proposed: 0, overridden: 0 });
  });

  for (const variant of ['split', 'record_fact'] as const) {
    test(`an apply still running renews its lease: reconcile past RECONCILE_AFTER_MS leaves a slow ${variant} alone and settles a dead one`, async () => {
      const l = await lesson(`lesson:slow-${variant}`, { status: 'approved' });
      const made = `${l.id}:split`;
      const factId = `fact:loop:slow-${variant}`;
      const d = variant === 'split'
        ? await propose('reword_lesson', [{ kind: 'lesson', id: l.id, role: 'primary' }, { kind: 'lesson', id: made, role: 'created' }],
          [lessonSnapshot(l), absentSnapshot({ kind: 'lesson', id: made })], [lessonSnapshot({ ...l, rule: 'first half' }), lessonSnapshot({ ...l, id: made, rule: 'second half' })], { tier: 'A' })
        : await propose('record_fact', [{ kind: 'lesson', id: l.id, role: 'primary' }, { kind: 'fact', id: factId, role: 'created' }],
          [lessonSnapshot(l), absentSnapshot({ kind: 'fact', id: factId })],
          [lessonSnapshot({ ...l, status: 'rejected', decidedAt: T0, decidedBy: 'you', decisionNote: 'converted to a fact' }),
            factSnapshot({ id: factId, projectKey: 'demo', kind: 'convention', statement: l.rule, path: 'src/api.ts', lines: null, why: 'w', relevance: 0.6, relevanceBy: 'loop:1', current: true })], { tier: 'A' });
      // A crashed apply of another decision, left applying with no process to renew it.
      const dead = await lessonDecision(await lesson(`lesson:dead-${variant}`), approve);
      // The embedder stalls on the apply's last embedding (a cold or busy Ollama) until released.
      let calls = 0;
      let release!: () => void;
      const stalled = new Promise<void>((r) => { release = r; });
      let reached!: () => void;
      const atStall = new Promise<void>((r) => { reached = r; });
      const slowAt = variant === 'split' ? 2 : 1;
      const slow = async (texts: string[]) => { if (++calls === slowAt) { reached(); await stalled; } return embed(texts); };
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: Date.now() });
      try {
        const applying = decisionExecutor(s, { embed: slow }).apply(d, { by: 'you' });
        await s.decisions.markApplying(dead.id, { by: 'loop:1' });
        await atStall;
        // Five lease periods pass while the embedding stalls; each renewal lands before the next.
        for (let i = 0; i < 5; i++) {
          vi.advanceTimersByTime(APPLY_LEASE_RENEW_MS);
          const at = new Date().toISOString();
          for (let n = 0; n < 400 && (await s.decisions.get(d.id))!.decidedAt !== at; n++) await new Promise((r) => setTimeout(r, 5));
        }
        expect(Date.now() - Date.parse((await s.decisions.get(dead.id))!.decidedAt!)).toBeGreaterThan(RECONCILE_AFTER_MS);
        // The worker's reconcile settles the dead one and leaves the running one alone.
        expect(await x.reconcile(Date.now())).toEqual({ applied: 0, proposed: 1, overridden: 0 });
        expect((await s.decisions.get(d.id))!.status).toBe('applying');
        release();
        expect(await applying).toMatchObject({ status: 'applied', decidedBy: 'you' });
      } finally {
        vi.useRealTimers();
      }
      if (variant === 'split') {
        expect((await getLesson(l.id)).rule).toBe('first half');
        expect((await getLesson(made)).status).toBe('approved');
      } else {
        expect((await s.facts.fact(factId))?.current).toBe(true);
        expect((await getLesson(l.id)).status).toBe('rejected');
      }
      expect((await s.decisions.get(dead.id))!.status).toBe('proposed');
    });
  }

  test('reconcile applies a decision whose write landed as its apply would have: by the loop, with its sync hold', async () => {
    const l = await lesson('lesson:rh', { status: 'approved' });
    const d = await lessonDecision(l, { status: 'revoked', decidedAt: T0, decidedBy: 'loop:1', decisionNote: 'retired' }, 'retire_lesson');
    const hold = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await s.decisions.markApplying(d.id, { by: 'loop:1', syncHoldUntil: hold });
    await genericHandler.apply(handlerContext(s, { embed }, 'loop:1'), d);
    expect(await x.reconcile(later())).toEqual({ applied: 1, proposed: 0, overridden: 0 });
    expect(await s.decisions.get(d.id)).toMatchObject({ status: 'applied', decidedBy: 'loop:1', syncHoldUntil: hold });
    expect((await s.portability.exportData({ projectKey: 'demo', approvedOnly: true })).lessons.map((e) => e.id)).toContain(l.id);
  });

  test('reconcile undoes a record_fact a crash stopped part way: the fact it made is closed, the lesson stays, the decision is proposed again', async () => {
    const l = await lesson('lesson:crash', { status: 'approved' });
    const factId = 'fact:loop:crash';
    const planned = factSnapshot({ id: factId, projectKey: 'demo', kind: 'convention', statement: l.rule, path: 'src/api.ts', lines: null, why: 'w', relevance: 0.6, relevanceBy: 'loop:1', current: true });
    const d = await propose('record_fact', [{ kind: 'lesson', id: l.id, role: 'primary' }, { kind: 'fact', id: factId, role: 'created' }],
      [lessonSnapshot(l), absentSnapshot({ kind: 'fact', id: factId })],
      [lessonSnapshot({ ...l, status: 'rejected', decidedAt: T0, decidedBy: 'loop:1', decisionNote: 'converted to a fact' }), planned], { tier: 'A' });
    await s.decisions.markApplying(d.id, { by: 'loop:1' });
    // The process died after the fact was added, before the lesson write.
    await genericHandler.apply(handlerContext(s, { embed }, 'loop:1'), { ...d, targets: d.targets.filter((t) => t.kind === 'fact'), before: d.before.slice(1), after: d.after.slice(1) });
    expect((await s.facts.fact(factId))?.current).toBe(true);
    expect(await x.reconcile(later())).toEqual({ applied: 0, proposed: 1, overridden: 0 });
    expect((await s.decisions.get(d.id))!.status).toBe('proposed');
    expect(await fp({ kind: 'fact', id: factId })).toBe(ABSENT);
    expect(await fp({ kind: 'lesson', id: l.id })).toBe(d.before[0].fingerprint);
    // Applied again later, it is whole.
    expect((await x.apply((await s.decisions.get(d.id))!, { by: 'loop:1' })).status).toBe('applied');
    expect((await s.facts.fact(factId))?.current).toBe(true);
  });

  test('reconcile undoes a split a crash stopped part way: the reworded lesson goes back to its words', async () => {
    const l = await lesson('lesson:bundled', { status: 'approved' });
    const made = 'lesson:bundled-2';
    const d = await propose('reword_lesson', [{ kind: 'lesson', id: l.id, role: 'primary' }, { kind: 'lesson', id: made, role: 'created' }],
      [lessonSnapshot(l), absentSnapshot({ kind: 'lesson', id: made })],
      [lessonSnapshot({ ...l, rule: 'first half' }), lessonSnapshot({ ...l, id: made, rule: 'second half' })], { tier: 'A' });
    await s.decisions.markApplying(d.id, { by: 'loop:1' });
    // The reworded lesson written; the process died before the split-off lesson was made.
    await genericHandler.apply(handlerContext(s, { embed }, 'loop:1'), { ...d, targets: d.targets.slice(0, 1), before: d.before.slice(0, 1), after: d.after.slice(0, 1) });
    expect(await x.reconcile(later())).toEqual({ applied: 0, proposed: 1, overridden: 0 });
    expect(await fp({ kind: 'lesson', id: l.id })).toBe(d.before[0].fingerprint);
    expect(await s.knowledge.lessonDetail(made)).toBeNull();
  });

  test('an apply that another process\'s reconcile pass runs into is left to finish: applied, not proposed with its write landed', async () => {
    const l = await lesson('lesson:rc');
    const d = await lessonDecision(l, approve, 'approve_lesson', { mode: 'propose' });
    let reconciled: unknown = null;
    const racing = new Proxy(s, { get: (t, k) => (k === 'knowledge' ? new Proxy(t.knowledge, { get: (kt, kk) => {
      const v = (kt as never)[kk] as unknown;
      if (kk === 'writeLessonSnapshots') return async (...a: unknown[]) => { reconciled = await x.reconcile(); return (v as (...y: unknown[]) => unknown).apply(kt, a); };
      return typeof v === 'function' ? (v as (...y: unknown[]) => unknown).bind(kt) : v;
    } }) : (t as never)[k]) }) as Store;
    const applied = await decisionExecutor(racing, { embed }).apply(d, { by: 'you' });
    expect(reconciled).toEqual({ applied: 0, proposed: 0, overridden: 0 });
    expect(applied).toMatchObject({ status: 'applied', decidedBy: 'you' });
  });

  test('snapshot: a target as it is now, redacted, null when gone', async () => {
    const l = await lesson('lesson:snap');
    expect(await x.snapshot('lesson', l.id)).toEqual(lessonSnapshot(l));
    expect(await x.snapshot('lesson', 'lesson:none')).toBeNull();
    expect(await x.snapshot('project', 'demo')).toEqual(thresholdsSnapshot('demo', { similarityFloor: null, factRankFloor: null }));
    expect(await x.snapshot('miss', 'miss:none')).toMatchObject({ fields: { repeats: [] } });
  });

  test('writeLessonSnapshots: all or nothing, every lesson compared first', async () => {
    const a = await lesson('lesson:w1');
    const b = await lesson('lesson:w2');
    const err = await s.knowledge.writeLessonSnapshots([
      { id: a.id, fields: lessonSnapshot({ ...a, title: 'new' }).fields as never, expect: lessonSnapshot(a).fingerprint },
      { id: b.id, fields: lessonSnapshot(b).fields as never, expect: 'stale' },
    ]).catch((e) => e);
    expect(err).toMatchObject({ name: 'TargetChangedError', targetId: b.id, actual: lessonSnapshot(b).fingerprint });
    expect((await getLesson(a.id)).title).toBe(a.title);
    await expect(s.knowledge.writeLessonSnapshots([{ id: 'lesson:gone', fields: lessonSnapshot(a).fields as never, expect: 'x' }])).rejects.toMatchObject({ actual: null });
    await s.knowledge.writeLessonSnapshots([]);
  });

  /** The rollback property: for random histories, apply then rollback is the identity on every target's fingerprint. */
  test('property: apply then rollback is the identity on the targets, for random histories', async () => {
    const statuses: LessonStatus[] = ['proposed', 'approved', 'rejected', 'revoked', 'superseded'];
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
      const maybe = <T,>(v: T) => (r() < 0.5 ? v : undefined);
      const id = `lesson:prop${seed}`;
      await lesson(id, { status: pick(['proposed', 'approved'] as const), paths: pick([[], ['a.ts'], ['a.ts', 'b.ts']]) });
      // The owner's history before the loop looks.
      for (let i = Math.floor(r() * 4); i > 0; i--) {
        const cur = await getLesson(id);
        const patch = pick([{ title: `t${seed}-${i}` }, { rule: `r${seed}-${i}` }, { paths: ['c.ts'] }, { status: cur.status === 'approved' ? 'revoked' as const : 'approved' as const }]);
        await s.knowledge.updateLesson(id, patch, { by: pick(['you', 'operator:bot']), note: maybe('because') });
      }
      const l = await getLesson(id);
      const patch: Partial<Lesson> = Object.fromEntries(Object.entries({
        status: maybe(pick(statuses)), title: maybe(`loop title ${seed}`), rule: maybe(`loop rule ${seed}`), paths: maybe(pick([[], ['z.ts'], ['a.ts', 'z.ts']])),
        scope: maybe(pick(['global', 'project', 'task'] as const)), projectKey: maybe(pick([null, 'demo', 'other'])), decisionNote: maybe(pick([null, 'loop note'])),
        decidedAt: maybe(T0), decidedBy: maybe('loop:1'), appliesWhen: maybe(''),
      }).filter(([, v]) => v !== undefined));
      const targets: DecisionTarget[] = [{ kind: 'lesson', id, role: 'primary' }];
      let before = [lessonSnapshot(l)];
      const after = [lessonSnapshot({ ...l, ...patch })];
      // Half the histories also rescore a fact.
      if (r() < 0.5) {
        await s.facts.saveFileFacts('demo', { path: `src/p${seed}.ts`, hash: `h${seed}`, summary: '' }, [{ kind: 'gotcha', statement: `s${seed}`, path: `src/p${seed}.ts`, lines: null, confidence: 1, why: 'w', embedding: vec(3), relevance: maybe(r()) }], 'ollama:x');
        const f = (await s.facts.listFacts({ projectKey: 'demo', path: `src/p${seed}.ts` }))[0];
        const fs = await snapshotTarget(s, { kind: 'fact', id: f.id });
        targets.push({ kind: 'fact', id: f.id, role: 'primary' });
        before = [...before, fs];
        after.push(factSnapshot({ ...(fs.fields as Parameters<typeof factSnapshot>[0]), id: f.id, relevance: Math.round(r() * 100) / 100, relevanceBy: 'model' }));
      }
      const d = await propose('rank_weight', targets, before, after);
      const applied = await x.apply(d, { by: pick(['loop:1', 'you']) });
      expect((await snapshotTargets(s, targets)).map((t) => t.fingerprint), `seed ${seed} applied`).toEqual(after.map((a) => a.fingerprint));
      await x.rollback(applied, { by: pick(['you', 'operator:bot']), cascade: 'apply' });
      expect((await snapshotTargets(s, targets)).map((t) => t.fingerprint), `seed ${seed} rolled back`).toEqual(before.map((b) => b.fingerprint));
    }
  });
});
