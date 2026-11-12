import { beforeAll, expect, test } from 'vitest';
import { factFingerprint, lessonFingerprint, TargetChangedError } from '../decisions/record.ts';
import type { FactsStore, KnowledgeStore } from '../store.ts';
import { describeStores } from '../testing/index.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));

/** A decision's domain write passes the snapshot's fingerprint (`expect`): a target changed since is never overwritten. */
describeStores('expect fingerprints on domain writes', (h) => {
  let k: KnowledgeStore;
  let f: FactsStore;
  beforeAll(() => {
    k = h.store.knowledge;
    f = h.store.facts;
  });
  const lesson = (id: string) => k.upsertLesson({
    id, projectKey: 'demo', title: 'Use the gateway', rule: 'Call the API through the gateway', appliesWhen: 'calling the API',
    scope: 'project', paths: ['src/api.ts'], status: 'proposed', source: 'memory', embedding: vec(1),
  });

  test('updateLesson with expect writes only while the lesson still has that fingerprint', async () => {
    await lesson('lesson:e');
    const fp = lessonFingerprint((await k.lessonDetail('lesson:e'))!.lesson);
    await k.updateLesson('lesson:e', { status: 'approved' }, { by: 'loop:1', expect: fp });
    const approved = (await k.lessonDetail('lesson:e'))!.lesson;
    expect(approved).toMatchObject({ status: 'approved', decidedBy: 'loop:1' });
    // The snapshot is stale now: nothing is written, and the error says what the lesson is.
    const err = await k.updateLesson('lesson:e', { status: 'rejected' }, { by: 'loop:1', expect: fp }).catch((e) => e);
    expect(err).toBeInstanceOf(TargetChangedError);
    expect(err).toMatchObject({ targetId: 'lesson:e', expected: fp, actual: lessonFingerprint(approved) });
    expect((await k.lessonDetail('lesson:e'))!.lesson.status).toBe('approved');
    await expect(k.updateLesson('lesson:gone', { status: 'approved' }, { expect: fp })).rejects.toMatchObject({ name: 'TargetChangedError', actual: null });
    // An edit the fingerprint does not cover (a recheck) leaves it valid.
    await k.setLessonChecks('lesson:e', []);
    await k.updateLesson('lesson:e', { rule: 'Call it through the gateway' }, { expect: lessonFingerprint(approved) });
    expect((await k.lessonDetail('lesson:e'))!.lesson.rule).toBe('Call it through the gateway');
  });

  test('setFactRelevance with expect writes none of its updates when one fact changed or is gone', async () => {
    const fact = (statement: string) => ({ kind: 'convention' as const, statement, path: 'src/a.ts', lines: null, confidence: 0.9, why: 'w', embedding: vec(2) });
    await f.saveFileFacts('demo', { path: 'src/a.ts', hash: 'h1', summary: '' }, [fact('one'), fact('two')], 'ollama:gemma4');
    const byStatement = async () => Object.fromEntries((await f.listFacts({ projectKey: 'demo' })).map((x) => [x.statement, x]));
    const { one, two } = await byStatement();
    const fp = (x: typeof one) => factFingerprint({ ...x, current: true });
    expect(await f.setFactRelevance([{ id: one.id, relevance: 0.7, by: 'model', expect: fp(one) }, { id: two.id, relevance: 0.6, by: 'model' }])).toBe(2);
    const { one: oneNow } = await byStatement();
    const stale = await f.setFactRelevance([{ id: two.id, relevance: 0.1, by: 'model' }, { id: one.id, relevance: 0.2, by: 'model', expect: fp(one) }]).catch((e) => e);
    expect(stale).toBeInstanceOf(TargetChangedError);
    expect(stale).toMatchObject({ targetId: one.id, actual: fp(oneNow) });
    expect(Object.values(await byStatement()).map((x) => [x.statement, x.relevance]).sort()).toEqual([['one', 0.7], ['two', 0.6]]);
    await expect(f.setFactRelevance([{ id: 'fact:gone', relevance: 0.2, by: 'model', expect: fp(one) }])).rejects.toMatchObject({ name: 'TargetChangedError', actual: null });
    expect(await f.setFactRelevance([{ id: one.id, relevance: 0.3, by: 'model', expect: fp(oneNow) }])).toBe(1);
  });
});
