import { beforeAll, expect, test } from 'vitest';
import type { Store } from '../../store.ts';
import { describeStores } from '../../testing/index.ts';
import type { Classification, Decision, DecisionInput, DecisionTarget, Lesson, ParsedSession, PostMortem, Project, TargetSnapshot } from '../../types.ts';
import { decisionExecutor, type DecisionExecutor } from '../executor.ts';
import { ABSENT, TargetChangedError } from '../record.ts';
import { absentSnapshot, factSnapshot, lessonSnapshot, snapshotTarget } from '../snapshot.ts';
import { recordFact } from './record_fact.ts';
import { rewordLesson } from './reword_lesson.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const T0 = '2026-11-01T00:00:00.000Z';
const embedded: string[] = [];
const embed = async (texts: string[]) => { embedded.push(...texts); return texts.map((_, i) => vec(200 + i)); };
const pushback: Classification = { label: 'pushback', confidence: 0.9, summary: 's', signals: [] };
const demo: Project = { key: 'demo', name: 'demo', repoPath: '/projects/demo' };

function session(id: string): ParsedSession {
  const turns = [0, 1].map((i) => ({
    uuid: `${id}-t${i}`, sessionId: id, ts: `2026-10-01T10:0${i * 2}:00Z`, index: i, text: `turn ${i}`, precedingAssistantText: 'r', precedingToolCalls: [],
  }));
  return { sessionId: id, sourceFile: 'f', cwd: '/projects/demo', gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[1].ts, turns, toolCalls: [] };
}
const pm = (rule: string): PostMortem => ({
  taskTitle: 't', missed: 'cents and the retry', cause: 'verification_gap', causeExplanation: 'no test ran', outcome: 'addressed',
  lesson: { title: 'Money and retries', rule, appliesWhen: 'editing payments', scope: 'project', paths: ['src/money.ts', 'src/http.ts'] }, contextItems: [],
});
const half = { title: 'Retry 429s', rule: 'Retry 429 responses with backoff in src/http.ts', appliesWhen: 'editing the HTTP client', paths: ['src/http.ts'] };
const first = { title: 'Store cents', rule: 'Store amounts in integer cents in src/money.ts', appliesWhen: 'editing payments', paths: ['src/money.ts'] };

describeStores('reword_lesson and record_fact handlers', (h) => {
  let s: Store;
  let x: DecisionExecutor;
  beforeAll(() => {
    s = h.store;
    x = decisionExecutor(s, { embed });
  });

  /** A post-mortem lesson derived from a confirmed miss. */
  async function postmortemLesson(sid: string, rule = 'Store amounts in cents in src/money.ts; also retry 429s in src/http.ts'): Promise<Lesson> {
    await s.graph.upsertSession(demo, session(sid), []);
    await s.graph.saveClassification(`${sid}-t1`, pushback, true);
    await s.graph.decide(`${sid}-t1`, 'confirmed', null);
    await s.knowledge.savePostmortem(`${sid}-t1`, pm(rule), { miss: vec(1), lesson: vec(1) });
    return (await s.knowledge.lessonDetail(`lesson:${sid}-t1`))!.lesson;
  }
  const getLesson = async (id: string) => (await s.knowledge.lessonDetail(id))?.lesson ?? null;
  let n = 0;
  const propose = async (type: Decision['type'], targets: DecisionTarget[], before: TargetSnapshot[], after: TargetSnapshot[]) => (await s.decisions.propose({
    type, projectKey: 'demo', targets, before, after,
    evidence: [{ kind: 'lesson', id: `ev:${++n}`, role: 'because', weight: 1, observedAt: T0 }],
    features: {}, score: 0.9, confidence: { p: 0.9, lower: 0.8, n: 0, band: 4 }, tier: 'A', mode: 'auto',
    rationale: 'r', model: 'ollama:test', policyVersion: 1, status: 'proposed',
  } satisfies DecisionInput)).decision;

  /** A split as reword_lesson plans it: the lesson keeps the first instruction, a new lesson takes the second. */
  async function split(l: Lesson) {
    const id = `${l.id}:split:1`;
    const made: Lesson = { ...l, ...half, id, decidedAt: l.status === 'approved' ? T0 : null, decidedBy: l.status === 'approved' ? 'loop:1' : null };
    const targets: DecisionTarget[] = [{ kind: 'lesson', id: l.id, role: 'primary' }, { kind: 'lesson', id, role: 'created' }];
    const d = await propose('reword_lesson', targets, [lessonSnapshot(l), absentSnapshot({ kind: 'lesson', id })], [lessonSnapshot({ ...l, ...first }), lessonSnapshot(made)]);
    return { d, id, made };
  }

  test('reword: the lesson gets the new words, re-embedded; rollback restores them to the letter', async () => {
    const l = await postmortemLesson('s1', 'Check for existing patterns');
    const d = await propose('reword_lesson', [{ kind: 'lesson', id: l.id, role: 'primary' }], [lessonSnapshot(l)], [lessonSnapshot({ ...l, ...first })]);
    embedded.length = 0;
    const applied = await x.apply(d, { by: 'loop:1' });
    expect(applied.status).toBe('applied');
    expect(await getLesson(l.id)).toMatchObject({ ...first, status: 'proposed', checksVersion: 0 });
    expect(embedded).toEqual([`${first.title}\n${first.rule}\nApplies when: ${first.appliesWhen}`]);
    await x.rollback(applied, { by: 'you', cascade: 'apply' });
    expect((await snapshotTarget(s, { kind: 'lesson', id: l.id })).fingerprint).toBe(d.before[0].fingerprint);
  });

  test('split: apply rewords the lesson and creates the second from the same miss; rollback removes it and restores the original; redo makes it again', async () => {
    const l = await postmortemLesson('s2');
    const { d, id, made } = await split(l);
    const applied = await x.apply(d, { by: 'loop:1' });
    expect(await getLesson(l.id)).toMatchObject(first);
    expect(await getLesson(id)).toMatchObject({ ...half, status: 'proposed', splitFrom: l.id, missId: l.missId, source: 'postmortem' });
    expect(applied.after[1].fingerprint).toBe(lessonSnapshot(made).fingerprint);
    // Embedded: found by vector search.
    expect((await s.knowledge.searchLessons({ embedding: vec(200), projectKey: 'demo', k: 5, status: 'proposed' })).map((x) => x.lesson.id)).toContain(id);

    const back = await x.rollback(applied, { by: 'you', cascade: 'apply' }) as Decision;
    expect(back.status).toBe('rolled_back');
    expect(await getLesson(id)).toBeNull();
    expect((await snapshotTarget(s, { kind: 'lesson', id: l.id })).fingerprint).toBe(d.before[0].fingerprint);

    await x.redo(d, { by: 'you' });
    expect(await getLesson(id)).toMatchObject(half);
    expect(await getLesson(l.id)).toMatchObject(first);
  });

  test('split of an approved lesson: the new lesson is approved by the loop; the owner editing it since blocks the rollback', async () => {
    const l0 = await postmortemLesson('s3');
    await s.knowledge.updateLesson(l0.id, { status: 'approved' }, { by: 'you' });
    const l = (await getLesson(l0.id))!;
    const { d, id } = await split(l);
    const applied = await x.apply(d, { by: 'loop:1' });
    expect(await getLesson(id)).toMatchObject({ status: 'approved', decidedBy: 'loop:1', decidedAt: T0 });
    await s.knowledge.updateLesson(id, { rule: 'the owner rewrote the split-off lesson' }, { by: 'you' });
    await expect(x.rollback(applied, { by: 'you', cascade: 'apply' })).rejects.toBeInstanceOf(TargetChangedError);
    expect(await getLesson(id)).toMatchObject({ rule: 'the owner rewrote the split-off lesson' });
    expect(await getLesson(l.id)).toMatchObject(first);
  });

  test('split: a lesson by the new id exists already, or the original changed since: nothing is written', async () => {
    const l = await postmortemLesson('s4');
    const { d, id } = await split(l);
    await s.knowledge.addLoopLesson({ id, from: l.id, fields: { ...lessonSnapshot(l).fields, title: 'already here' } as never, embedding: null });
    const err = await x.apply(d, { by: 'loop:1' }).catch((e) => e);
    // The new lesson's own snapshot is compared first: it is not absent.
    expect(err).toBeInstanceOf(TargetChangedError);
    expect(await getLesson(l.id)).toMatchObject({ title: 'Money and retries' });
    expect(await getLesson(id)).toMatchObject({ title: 'already here' });
    // The handler on its own: the original is reworded, the create refused with what is there, the rewrite moved back.
    const there = (await snapshotTarget(s, { kind: 'lesson', id })).fingerprint;
    await expect(rewordLesson.apply({ store: s, deps: {}, by: 'loop:1' }, d)).rejects.toMatchObject({ name: 'TargetChangedError', targetId: id, actual: there });
    expect((await snapshotTarget(s, { kind: 'lesson', id: l.id })).fingerprint).toBe(d.before[0].fingerprint);

    const l2 = await postmortemLesson('s5');
    const s2 = await split(l2);
    await s.knowledge.updateLesson(l2.id, { title: 'the owner retitled it' }, { by: 'you' });
    await expect(x.apply(s2.d, { by: 'loop:1' })).rejects.toBeInstanceOf(TargetChangedError);
    expect(await getLesson(s2.id)).toBeNull();
  });

  test('split: creating the new lesson fails after the rewrite: the rewrite is moved back', async () => {
    const l = await postmortemLesson('s6');
    const { d, id } = await split(l);
    const failing = { ...s, knowledge: Object.assign(Object.create(s.knowledge), { addLoopLesson: async () => false }) } as Store;
    const err = await rewordLesson.apply({ store: failing, deps: {}, by: 'loop:1' }, d).catch((e) => e);
    expect(err).toMatchObject({ name: 'TargetChangedError', targetId: id, expected: ABSENT, actual: null });
    expect((await snapshotTarget(s, { kind: 'lesson', id: l.id })).fingerprint).toBe(d.before[0].fingerprint);
    // Two lessons made, the second refused: the first is taken back too.
    let calls = 0;
    const second = { ...s, knowledge: Object.assign(Object.create(s.knowledge), { addLoopLesson: async (i: Parameters<Store['knowledge']['addLoopLesson']>[0]) => (++calls === 1 ? s.knowledge.addLoopLesson(i) : false) }) } as Store;
    const two = { ...d, targets: [...d.targets, { kind: 'lesson' as const, id: `${id}b`, role: 'created' as const }], after: [...d.after, { ...d.after[1], id: `${id}b` }] };
    await expect(rewordLesson.apply({ store: second, deps: {}, by: 'loop:1' }, two)).rejects.toBeInstanceOf(TargetChangedError);
    expect(await getLesson(id)).toBeNull();
    expect((await snapshotTarget(s, { kind: 'lesson', id: l.id })).fingerprint).toBe(d.before[0].fingerprint);
  });

  test('split rollback: restoring the original fails after the new lesson was removed: it is made again', async () => {
    const l = await postmortemLesson('s7');
    const { d, id } = await split(l);
    const applied = await x.apply(d, { by: 'loop:1' });
    const gone = { ...applied, before: [{ ...applied.before[0], fields: { ...applied.before[0].fields, title: 'x' } }, applied.before[1]] };
    await s.knowledge.updateLesson(l.id, { title: 'the owner retitled it' }, { by: 'you' });
    await expect(rewordLesson.rollback({ store: s, deps: {}, by: 'you' }, gone, applied.after)).rejects.toBeInstanceOf(TargetChangedError);
    expect(await getLesson(id)).toMatchObject(half);
    // From a state where the new lesson is already gone (restore anyway): only the original is restored.
    await s.knowledge.removeLoopLesson(id, (await snapshotTarget(s, { kind: 'lesson', id })).fingerprint);
    const now = [await snapshotTarget(s, { kind: 'lesson', id: l.id }), absentSnapshot({ kind: 'lesson', id })];
    await rewordLesson.rollback({ store: s, deps: {}, by: 'you' }, applied, now);
    expect((await snapshotTarget(s, { kind: 'lesson', id: l.id })).fingerprint).toBe(d.before[0].fingerprint);
  });

  test("record_fact: the fact is the loop's (origin loop), kept from scans; rollback closes it and restores the lesson; redo reopens it", async () => {
    const l = await postmortemLesson('f1', 'Amounts are stored in cents in src/money.ts');
    const factId = '6f0b2c1e-0000-4000-8000-000000000001';
    const planned = factSnapshot({ id: factId, projectKey: 'demo', kind: 'convention', statement: l.rule, path: 'src/money.ts', lines: null, why: 'From the lesson', relevance: 0.8, relevanceBy: 'loop:1', current: true });
    const targets: DecisionTarget[] = [{ kind: 'lesson', id: l.id, role: 'primary' }, { kind: 'fact', id: factId, role: 'created' }];
    const d = await propose('record_fact', targets, [lessonSnapshot(l), absentSnapshot({ kind: 'fact', id: factId })],
      [lessonSnapshot({ ...l, status: 'rejected', decidedAt: T0, decidedBy: 'loop:1', decisionNote: 'converted to a fact' }), planned]);
    const applied = await x.apply(d, { by: 'loop:1' });
    expect(applied.after).toEqual(d.after);
    expect(await s.facts.fact(factId)).toMatchObject({ origin: 'loop', relevanceBy: 'loop:1', source: 'loop:1', current: true });
    expect(await getLesson(l.id)).toMatchObject({ status: 'rejected', decisionNote: 'converted to a fact' });
    await s.facts.replaceProjectFacts('demo', [], 'claude-cli', []);
    expect(await s.facts.fact(factId)).toMatchObject({ current: true });

    await x.rollback(applied, { by: 'you', cascade: 'apply' });
    expect(await s.facts.fact(factId)).toMatchObject({ current: false });
    expect((await snapshotTarget(s, { kind: 'lesson', id: l.id })).fingerprint).toBe(d.before[0].fingerprint);
    await x.redo(d, { by: 'you' });
    expect(await s.facts.fact(factId)).toMatchObject({ current: true, origin: 'loop' });
  });

  test('record_fact: the lesson changed since: the new fact is closed again and the decision overridden; no embedder: nothing written', async () => {
    const l = await postmortemLesson('f2', 'Amounts are stored in cents in src/money.ts');
    const factId = '6f0b2c1e-0000-4000-8000-000000000002';
    const planned = factSnapshot({ id: factId, projectKey: 'demo', kind: 'convention', statement: l.rule, path: '.', lines: null, why: 'w', relevance: 0.8, relevanceBy: 'loop:1', current: true });
    const targets: DecisionTarget[] = [{ kind: 'lesson', id: l.id, role: 'primary' }, { kind: 'fact', id: factId, role: 'created' }];
    const d = await propose('record_fact', targets, [lessonSnapshot(l), absentSnapshot({ kind: 'fact', id: factId })],
      [lessonSnapshot({ ...l, status: 'rejected', decidedAt: T0, decidedBy: 'loop:1', decisionNote: 'converted to a fact' }), planned]);
    await expect(recordFact.apply({ store: s, deps: {}, by: 'loop:1' }, d)).rejects.toThrow('cannot create without an embedder fact');
    expect(await s.facts.fact(factId)).toBeNull();
    // The lesson moves under the handler's feet: the fact it just added is closed again.
    const moved = { ...d, before: [lessonSnapshot({ ...l, title: 'not as it is' }), d.before[1]] };
    await expect(recordFact.apply({ store: s, deps: { embed }, by: 'loop:1' }, moved)).rejects.toBeInstanceOf(TargetChangedError);
    expect(await s.facts.fact(factId)).toMatchObject({ current: false, origin: 'loop' });
    expect(await getLesson(l.id)).toMatchObject({ status: 'proposed' });
  });
});
