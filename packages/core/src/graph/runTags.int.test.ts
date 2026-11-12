import { beforeAll, expect, test } from 'vitest';
import type { Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { ParsedSession, Project, RunTag } from '../types.ts';

const demo: Project = { key: 'demo', name: 'demo', repoPath: '/vibe/demo' };
const MIN = 60_000;
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const tester: RunTag = { id: 'run-1', sandbox: false };
const sandbox: RunTag = { id: 'sbx-1', sandbox: true };

/** Three turns, the last 15 minutes ago: quiet, not yet idle, so its delta is due a summary. */
function session(id: string): ParsedSession {
  const turns = [0, 1, 2].map((i) => ({
    uuid: `${id}-t${i}`, sessionId: id, ts: at(15 * MIN + (2 - i) * MIN), index: i, text: `${id} turn ${i}`,
    precedingAssistantText: i ? `${id} reply ${i - 1}` : '', precedingToolCalls: [],
  }));
  return { sessionId: id, sourceFile: `${id}.jsonl`, cwd: '/vibe/demo', gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[2].ts, turns, toolCalls: [] };
}

describeStores('Run tags on what a run made', (h) => {
  let s: Store;
  beforeAll(() => {
    s = h.store;
  });

  test('a session a run claimed says which run, and whether it is a sandbox, in the list and in the summary work', async () => {
    for (const [id, run] of [['owner-s', null], ['tester-s', tester], ['sandbox-s', sandbox]] as const) {
      if (run) expect(await s.sessions.claimRun(id, run)).toBe(true);
      await s.graph.upsertSession(demo, session(id), []);
    }
    const tags = (rows: { id: string; run?: string; sandbox?: true }[]) => Object.fromEntries(rows.map((r) => [r.id, { run: r.run, sandbox: r.sandbox }]));
    const expected = { 'owner-s': { run: undefined, sandbox: undefined }, 'tester-s': { run: 'run-1', sandbox: undefined }, 'sandbox-s': { run: 'sbx-1', sandbox: true } };
    const work = await s.sessions.work({ projectKeys: ['demo'], quietBefore: new Date(Date.now() - 10 * MIN), idleBefore: new Date(Date.now() - 30 * MIN), maxDeltaTurns: 40, backfill: false, limit: 50 });
    expect(tags(work)).toEqual(expected);
    const listed = [
      ...(await s.sessions.list({ projectKeys: ['demo'], limit: 10 })).sessions,
      ...(await s.sessions.list({ projectKeys: ['demo'], limit: 10, run: 'run-1' })).sessions,
      ...(await s.sessions.list({ projectKeys: ['demo'], limit: 10, run: 'sbx-1' })).sessions,
    ];
    expect(tags(listed)).toEqual(expected);
  });

  test('feedback in a session a run claimed carries its run tag into the post-mortem queue', async () => {
    for (const [id, run] of [['owner-s', null], ['tester-s', tester], ['sandbox-s', sandbox]] as const) {
      if (run) await s.sessions.claimRun(id, run);
      await s.graph.upsertSession(demo, session(id), []);
      await s.graph.saveClassification(`${id}-t1`, { label: 'pushback', confidence: 0.9, summary: 'missed it', signals: [] }, true);
      await s.graph.decide(`${id}-t1`, 'confirmed', null);
    }
    const queue = await s.knowledge.feedbackNeedingPostmortem(10);
    expect(Object.fromEntries(queue.map((q) => [q.feedbackId, { run: q.run, sandbox: q.sandbox }]))).toEqual({
      'owner-s-t1': { run: undefined, sandbox: undefined },
      'tester-s-t1': { run: 'run-1', sandbox: undefined },
      'sandbox-s-t1': { run: 'sbx-1', sandbox: true },
    });
  });
});
