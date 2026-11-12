import { beforeAll, expect, test } from 'vitest';
import { decisionExecutor, LOOP_TYPE_INFO, loopExecutor, sessionFiles, type Decision, writeLoopSettings, seedLoopSettings, readLoopRound, type Classification, type ParsedSession, type PostMortem, type Project, type Store, type ToolCall } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { runLoopRound, type LoopEngineDeps } from './engine.ts';

const vec = (axis: number, tilt = 0) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : i === axis + 1 ? tilt : 0));
const pushback: Classification = { label: 'pushback', confidence: 0.9, summary: 's', signals: [] };
const demo: Project = { key: 'demo', name: 'demo', repoPath: '/projects/demo' };
const HOST = '/Users/me/Vibe/demo';
const edit = (path: string): ToolCall => ({ name: 'Edit', ts: '2026-10-01T10:01:00Z', filePath: `${HOST}/${path}` });

function session(id: string, calls: ToolCall[]): ParsedSession {
  const turns = [0, 1, 2].map((i) => ({
    uuid: `${id}-t${i}`, sessionId: id, ts: `2026-10-01T10:0${i * 2}:00Z`, index: i, text: `turn ${i}`, precedingAssistantText: 'r', precedingToolCalls: [],
  }));
  return { sessionId: id, sourceFile: 'f', cwd: HOST, gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[2].ts, turns, toolCalls: calls };
}
const pm = (missed: string): PostMortem => ({
  taskTitle: 't', missed, cause: 'verification_gap', causeExplanation: 'no test ran', outcome: 'addressed',
  lesson: { title: `lesson for ${missed}`, rule: 'r', appliesWhen: 'a', scope: 'project', paths: [] }, contextItems: [],
});

describeStores('learning loop round', (h) => {
  let store: Store;
  beforeAll(() => {
    store = h.store;
  });

  /** A miss as the worker makes one: the session, its edits, the confirmed pushback, the post-mortem and its Activity entry. */
  async function miss(id: string, embedding: number[]) {
    const s = session(id, [edit('src/jobs.ts')]);
    await store.graph.upsertSession(demo, s, []);
    await store.codegraph.recordSessionFiles(id, sessionFiles(s, HOST));
    await store.graph.saveClassification(`${id}-t1`, pushback, true);
    await store.graph.decide(`${id}-t1`, 'confirmed', null);
    await store.knowledge.savePostmortem(`${id}-t1`, pm(`missed in ${id}`), { miss: embedding, lesson: embedding });
    await store.activity.record({ kind: 'postmortem_done', actor: 'pm', projectKey: 'demo', subject: `missed in ${id}`, why: 'w', targets: [`${id}-t1`, `miss:${id}-t1`] });
  }

  const deps = (now: () => number): LoopEngineDeps => ({
    store, cursors: store.docs, tokenless: false, inScope: (k) => k === null || k === 'demo', executor: loopExecutor(store), llm: null, now, log: () => {},
    config: { mode: null, disabled: false, llm: null, llmCallsPerDay: 40, autoPerDay: 5, autoPerProject: 2, syncHoldDays: 7, holdout: 0, types: null },
  });

  test('auto: a repeated miss is linked and the decision applied; a second round over the same data makes no new decision', async () => {
    await writeLoopSettings(store.docs, seedLoopSettings({ mode: 'auto' }));
    await miss('s-old', vec(1));
    await new Promise((r) => setTimeout(r, 5));
    await miss('s-new', vec(1, 0.1));
    const later = () => Date.now() + 60_000;
    const { round } = await runLoopRound(deps(later));
    expect(round).toMatchObject({ phase: 'done', decisions: { applied: 1, observed: 0, proposed: 0 } });
    const [d] = await store.decisions.list({ type: 'link_misses' });
    expect(d).toMatchObject({ status: 'applied', mode: 'auto', targets: [{ id: 'miss:s-new-t1' }, { id: 'miss:s-old-t1' }] });
    expect(await store.decisions.missLinks('miss:s-new-t1')).toEqual([expect.objectContaining({ from: 'miss:s-new-t1', to: 'miss:s-old-t1', decisionId: d.id })]);
    const logged = await store.activity.list({ kind: 'decision_applied', limit: 5 });
    expect(logged).toEqual([expect.objectContaining({ actor: 'loop:1', targets: [d.id, 'miss:s-new-t1', 'miss:s-old-t1'], details: expect.objectContaining({ decisionId: d.id, action: 'applied' }) })]);
    expect((await readLoopRound(store.docs))?.phase).toBe('done');

    const again = await runLoopRound(deps(later));
    expect(again.round).toMatchObject({ signalsIngested: 0, decisions: { applied: 0, observed: 0, proposed: 0 } });
    expect(await store.decisions.list({})).toHaveLength(1);
  });

  test('one owner rollback is one negative calibration label: the engine folds it from Activity, the executor writes none', async () => {
    await writeLoopSettings(store.docs, seedLoopSettings({ mode: 'auto' }));
    await miss('s-old', vec(1));
    await new Promise((r) => setTimeout(r, 5));
    await miss('s-new', vec(1, 0.1));
    await runLoopRound(deps(() => Date.now() + 60_000));
    const [d] = await store.decisions.list({ type: 'link_misses', status: ['applied'] });
    const rolled = await decisionExecutor(store).rollback(d, { by: 'you', reason: 'wrong_evidence', cascade: 'apply' }) as Decision;
    expect(rolled.status).toBe('rolled_back');
    expect(await store.decisions.missLinks('miss:s-new-t1')).toEqual([]);
    expect(await store.decisions.calibration('link_misses', d.policyVersion)).toEqual([]);
    // As the API's rollback route records it.
    await store.activity.record({
      kind: 'decision_rolled_back', actor: 'you', projectKey: d.projectKey, subject: 'rolled back', why: 'you rolled it back',
      details: { decisionId: d.id, decisionType: d.type, status: 'rolled_back', action: 'rollback', cascade: [], reason: 'wrong_evidence' }, targets: [d.id],
    });
    const later = () => Date.now() + 120_000;
    await runLoopRound(deps(later));
    await runLoopRound(deps(later));
    const { prior } = LOOP_TYPE_INFO.link_misses;
    expect(await store.decisions.calibration('link_misses', d.policyVersion)).toEqual([
      expect.objectContaining({ band: d.confidence.band, alpha: prior.alpha, beta: prior.beta + 1, n: 1 }),
    ]);
    expect(JSON.parse((await store.docs.getCursor('loop-penalty:link_misses'))!)).toEqual({ evidence: 1, scope: 0 });
  });

  test('an observed link rechecked under auto: out of scope, it is expired; made again later, it is observed again and applied', async () => {
    await writeLoopSettings(store.docs, seedLoopSettings({ mode: 'observe' }));
    await miss('s-old', vec(1));
    await new Promise((r) => setTimeout(r, 5));
    await miss('s-new', vec(1, 0.1));
    const later = () => Date.now() + 60_000;
    await runLoopRound(deps(later));
    const [d] = await store.decisions.list({ type: 'link_misses' });
    expect(d.status).toBe('observed');
    await writeLoopSettings(store.docs, seedLoopSettings({ mode: 'auto' }));
    const away = await runLoopRound({ ...deps(later), inScope: (k) => k === null });
    expect(away.round?.decisions.applied).toBe(0);
    expect(await store.decisions.get(d.id)).toMatchObject({ status: 'expired', decidedBy: 'loop:1' });
    await store.activity.record({ kind: 'postmortem_done', actor: 'pm', projectKey: 'demo', subject: 'again', why: 'w', targets: ['s-new-t1', 'miss:s-new-t1'] });
    const back = await runLoopRound(deps(later));
    expect(back.round).toMatchObject({ decisions: { applied: 1 } });
    expect(await store.decisions.get(d.id)).toMatchObject({ status: 'applied', mode: 'auto' });
    expect(await store.decisions.missLinks('miss:s-new-t1')).toHaveLength(1);
  });
});
