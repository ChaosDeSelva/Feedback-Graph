import { beforeAll, expect, test } from 'vitest';
import { lessonFingerprint, TargetChangedError, type LessonSnapshotFields } from '../decisions/record.ts';
import type { Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { Classification, Lesson, ParsedSession, PostMortem, Project } from '../types.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const pushback: Classification = { label: 'pushback', confidence: 0.9, summary: 's', signals: [] };
const demo: Project = { key: 'demo', name: 'demo', repoPath: '/projects/demo' };

function session(id: string): ParsedSession {
  const turns = [0, 1].map((i) => ({
    uuid: `${id}-t${i}`, sessionId: id, ts: `2026-10-01T10:0${i * 2}:00Z`, index: i, text: `turn ${i}`, precedingAssistantText: 'r', precedingToolCalls: [],
  }));
  return { sessionId: id, sourceFile: 'f', cwd: '/projects/demo', gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[1].ts, turns, toolCalls: [] };
}
const pm: PostMortem = {
  taskTitle: 't', missed: 'cents and the retry', cause: 'verification_gap', causeExplanation: 'no test ran', outcome: 'addressed',
  lesson: { title: 'Money and retries', rule: 'Store amounts in cents in src/money.ts; also retry 429s in src/http.ts', appliesWhen: 'editing payments', scope: 'project', paths: ['src/money.ts', 'src/http.ts'] },
  contextItems: [],
};
const half = (o: Partial<LessonSnapshotFields> = {}): LessonSnapshotFields => ({
  projectKey: 'demo', title: 'Retry 429s', rule: 'Retry 429 responses with backoff in src/http.ts', appliesWhen: 'editing the HTTP client', scope: 'project',
  paths: ['src/http.ts'], status: 'proposed', decidedAt: null, decidedBy: null, decisionNote: null, servingWeight: null, ...o,
});

describeStores('KnowledgeStore loop lessons (a split lesson)', (h) => {
  let store: Store;
  beforeAll(() => {
    store = h.store;
  });

  /** A post-mortem lesson derived from a confirmed miss. */
  async function original(): Promise<Lesson> {
    await store.graph.upsertSession(demo, session('s1'), []);
    await store.graph.saveClassification('s1-t1', pushback, true);
    await store.graph.decide('s1-t1', 'confirmed', null);
    await store.knowledge.savePostmortem('s1-t1', pm, { miss: vec(1), lesson: vec(1) });
    return (await store.knowledge.lessonDetail('lesson:s1-t1'))!.lesson;
  }

  test('addLoopLesson writes the fields as given, derived from the same miss as the lesson it splits, marked splitFrom; once', async () => {
    const from = await original();
    expect(await store.knowledge.addLoopLesson({ id: 'lesson:s1-t1:split:1', from: from.id, fields: half(), embedding: vec(2) })).toBe(true);
    const d = (await store.knowledge.lessonDetail('lesson:s1-t1:split:1'))!;
    const { servingWeight: _, ...written } = half();
    expect(d.lesson).not.toHaveProperty('servingWeight');
    expect(d.lesson).toMatchObject({
      ...written, source: 'postmortem', cause: 'verification_gap', missId: from.missId, origin: 'demo', splitFrom: from.id, checksVersion: 0, checks: null,
    });
    // A split keeps the serving weight it is given.
    expect(await store.knowledge.addLoopLesson({ id: 'lesson:s1-t1:split:w', from: from.id, fields: half({ servingWeight: 1.2 }), embedding: null })).toBe(true);
    expect((await store.knowledge.lessonDetail('lesson:s1-t1:split:w'))!.lesson.servingWeight).toBe(1.2);
    expect(d.miss?.missed).toBe('cents and the retry');
    // It is a lesson like any other: listed, found by its vector, its checks due.
    expect((await store.knowledge.listLessons({ projectKeys: ['demo'] })).map((l) => l.id).sort()).toEqual([from.id, 'lesson:s1-t1:split:1', 'lesson:s1-t1:split:w']);
    expect((await store.knowledge.searchLessons({ embedding: vec(2), projectKey: 'demo', k: 1, status: 'proposed' }))[0]?.lesson.id).toBe('lesson:s1-t1:split:1');
    expect(from.splitFrom).toBeUndefined();
    // Never twice, and never from a lesson that is gone.
    expect(await store.knowledge.addLoopLesson({ id: 'lesson:s1-t1:split:1', from: from.id, fields: half({ title: 'other' }), embedding: null })).toBe(false);
    expect((await store.knowledge.lessonDetail('lesson:s1-t1:split:1'))!.lesson.title).toBe('Retry 429s');
    expect(await store.knowledge.addLoopLesson({ id: 'lesson:none:split', from: 'lesson:none', fields: half(), embedding: null })).toBe(false);
    expect(await store.knowledge.lessonDetail('lesson:none:split')).toBeNull();
  });

  test('addLoopLesson redacts the words it is given', async () => {
    const from = await original();
    const secret = 'ghp_' + 'a'.repeat(36);
    await store.knowledge.addLoopLesson({ id: 'lesson:s1-t1:split:2', from: from.id, fields: half({ rule: `Never log ${secret} in src/http.ts` }), embedding: null });
    expect((await store.knowledge.lessonDetail('lesson:s1-t1:split:2'))!.lesson.rule).not.toContain(secret);
  });

  test('removeLoopLesson deletes only a lesson the loop split off, only while it is as expected', async () => {
    const from = await original();
    await store.knowledge.addLoopLesson({ id: 'lesson:s1-t1:split:3', from: from.id, fields: half(), embedding: vec(3) });
    const made = (await store.knowledge.lessonDetail('lesson:s1-t1:split:3'))!.lesson;
    await store.decisions.upsertSignals([{ lessonId: made.id, counts: { served: 1 } as never, lastServed: null, lastOwnerTouch: null }]);

    // The owner edited it since: refused, nothing deleted.
    await store.knowledge.updateLesson(made.id, { title: 'Retry 429 responses' }, { by: 'you' });
    await expect(store.knowledge.removeLoopLesson(made.id, lessonFingerprint(made))).rejects.toBeInstanceOf(TargetChangedError);
    expect(await store.knowledge.lessonDetail(made.id)).not.toBeNull();

    const now = (await store.knowledge.lessonDetail(made.id))!.lesson;
    await store.knowledge.removeLoopLesson(made.id, lessonFingerprint(now));
    expect(await store.knowledge.lessonDetail(made.id)).toBeNull();
    expect(await store.decisions.signals(made.id)).toBeNull();
    expect((await store.knowledge.lessonDetail(from.id))!.lesson.id).toBe(from.id);

    // Gone, or never the loop's: refused.
    await expect(store.knowledge.removeLoopLesson(made.id, lessonFingerprint(now))).rejects.toMatchObject({ name: 'TargetChangedError', actual: null });
    await expect(store.knowledge.removeLoopLesson(from.id, lessonFingerprint(from))).rejects.toBeInstanceOf(TargetChangedError);
    expect(await store.knowledge.lessonDetail(from.id)).not.toBeNull();
  });
});
