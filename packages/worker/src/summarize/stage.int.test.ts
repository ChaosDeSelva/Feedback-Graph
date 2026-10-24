import type { ActivityInput, JsonTask, LlmProvider, ParsedSession, Project, Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { beforeAll, expect, test } from 'vitest';
import { runSummaries, type SummarizeDeps } from './stage.ts';

const demo: Project = { key: 'demo', name: 'demo', repoPath: '/vibe/demo' };
const MIN = 60_000;
const DAY = 86_400_000;

/** n turns ending `lastAgo` ms before `now`, a minute apart. */
function session(id: string, n: number, now: number, lastAgo: number): ParsedSession {
  const turns = Array.from({ length: n }, (_, i) => ({
    uuid: `${id}-t${i}`, sessionId: id, ts: new Date(now - lastAgo - (n - 1 - i) * MIN).toISOString(), index: i,
    text: `${id} user turn ${i}`, precedingAssistantText: i ? `${id} agent reply ${i - 1}` : '', precedingToolCalls: [],
  }));
  return { sessionId: id, sourceFile: `${id}.jsonl`, cwd: '/vibe/demo', gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[n - 1].ts, turns, toolCalls: [] };
}

describeStores('summarize stage', (h) => {
  let store: Store;
  beforeAll(() => {
    store = h.store;
  });

  function model() {
    const prompts: string[] = [];
    const llm: LlmProvider = {
      id: 'fake:model', agentic: false,
      json: async (t: JsonTask) => {
        prompts.push(t.user);
        return { goal: `goal ${prompts.length}`, done: [`step ${prompts.length}`], decisions: [], openThreads: [], filesTouched: [], pushback: [], outcome: 'ok' };
      },
    };
    return { llm, prompts };
  }
  const deps = (llm: LlmProvider, now: number, activity: ActivityInput[] = []): SummarizeDeps => ({
    sessions: store.sessions, llm, activity: { record: async (a) => { activity.push(a); await store.activity.record(a); } }, projects: () => ['demo'],
    quietMinutes: 10, idleMinutes: 30, maxDeltaTurns: 40, backfillPerCycle: 3, now: () => now,
  });

  test('two updates: the second sends only the new turns, cursors advance exactly, and the session goes idle once caught up and quiet', async () => {
    const now = Date.now();
    await store.graph.upsertSession(demo, session('s1', 3, now, 15 * MIN), []);
    const { llm, prompts } = model();
    expect((await runSummaries(deps(llm, now))).summarized).toBe(1);
    let d = (await store.sessions.detail('s1'))!;
    expect(d).toMatchObject({ summarizedThrough: { index: 2 }, summaryVersion: 1, state: 'active', pendingTurns: 0, snippet: 'goal 1' });

    // Two more turns arrive, and the session goes quiet again.
    await store.graph.upsertSession(demo, session('s1', 5, now, 12 * MIN), []);
    expect((await store.sessions.detail('s1'))!.pendingTurns).toBe(2);
    await runSummaries(deps(llm, now));
    expect(prompts).toHaveLength(2);
    for (const i of [0, 1, 2]) expect(prompts[1]).not.toContain(`s1 user turn ${i}`);
    expect(prompts[1]).toContain('s1 user turn 3');
    expect(prompts[1]).toContain('goal 1');
    d = (await store.sessions.detail('s1'))!;
    expect(d.summarizedThrough!.index).toBe(4);
    expect(d.history.map((u) => [u.from?.index ?? null, u.to.index, u.deltaTurns])).toEqual([[null, 2, 3], [2, 4, 2]]);

    // Half an hour later with nothing new: idle, no model call.
    expect(await runSummaries(deps(llm, now + 30 * MIN))).toMatchObject({ idled: 1, summarized: 0 });
    expect((await store.sessions.detail('s1'))!.state).toBe('idle');
    expect(prompts).toHaveLength(2);
    const log = await store.activity.list({ kind: 'session_summarized' });
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ actor: 'fake:model', targets: ['session:s1'], details: expect.objectContaining({ from: expect.objectContaining({ index: 2 }), deltaTurns: 2 }) });
  });

  test('retention keeps the turns no summary covers yet, never removes the summary, and later updates still work', async () => {
    const now = Date.now();
    await store.graph.upsertSession(demo, session('old', 4, now, 40 * DAY), []);
    for (let i = 1; i < 4; i++) await store.graph.saveClassification(`old-t${i}`, { label: 'neutral', confidence: 0, summary: '', signals: [] }, false);
    const cutoff = new Date(now - 30 * DAY);
    // Not summarized yet: nothing is pruned.
    expect(await store.graph.pruneTurnText(cutoff, 5000, { keepUnsummarized: true })).toBe(0);
    const { llm, prompts } = model();
    await runSummaries(deps(llm, now)); // backfill
    expect((await store.sessions.detail('old'))!.summarizedThrough!.index).toBe(3);
    expect(await store.graph.pruneTurnText(cutoff, 5000, { keepUnsummarized: true })).toBe(4);
    const d = (await store.sessions.detail('old'))!;
    expect(d.summary!.goal).toBe('goal 1');
    expect(d.prunedTurns).toBe(4);
    // The developer resumes the old session: only the new turn is sent, the pruned ones are not needed.
    const resumed = session('old', 5, now, 15 * MIN);
    await store.graph.upsertSession(demo, { ...resumed, turns: resumed.turns.slice(4) }, []);
    await runSummaries(deps(llm, now));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('old user turn 4');
    expect(prompts[1]).toContain('goal 1');
    expect((await store.sessions.detail('old'))!.summarizedThrough!.index).toBe(4);
  });

  test('a final reply stored after a big delta reached the last turn is summarized alone, once, when the session is quiet', async () => {
    const now = Date.now();
    await store.graph.upsertSession(demo, session('late', 41, now, 1 * MIN), []); // active, a big delta
    const { llm, prompts } = model();
    await runSummaries(deps(llm, now));
    const calls = prompts.length;
    expect((await store.sessions.detail('late'))!).toMatchObject({ summarizedThrough: { index: 40 }, pendingTurns: 0 });
    // The agent's answer is stored on the next read of the transcript.
    const reply = { text: 'LATE-FINAL-REPLY: the orders list ships.', ts: new Date(now - 0.5 * MIN).toISOString() };
    await store.graph.upsertSession(demo, { ...session('late', 41, now, 1 * MIN), finalReply: reply, endedAt: reply.ts }, []);
    await runSummaries(deps(llm, now));
    expect(prompts).toHaveLength(calls); // not quiet yet
    await runSummaries(deps(llm, now + 15 * MIN));
    expect(prompts).toHaveLength(calls + 1);
    expect(prompts.at(-1)).toContain('LATE-FINAL-REPLY');
    expect(prompts.at(-1)).not.toContain('late user turn');
    const d = (await store.sessions.detail('late'))!;
    expect(d).toMatchObject({ summarizedThrough: { index: 40 }, snippet: `goal ${calls + 1}` });
    expect(d.history.at(-1)).toMatchObject({ from: { index: 40 }, to: { index: 40 }, deltaTurns: 0 });
    await runSummaries(deps(llm, now + 20 * MIN));
    await runSummaries(deps(llm, now + 60 * MIN));
    expect(prompts).toHaveLength(calls + 1);
  });
});
