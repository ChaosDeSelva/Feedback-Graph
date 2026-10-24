import { beforeAll, expect, test } from 'vitest';
import { syncBundle } from '../cloud.ts';
import { withMarkdown, type SummaryWorkQuery, type SummaryWrite } from '../sessions.ts';
import type { GraphStore, SessionsStore, Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { ParsedSession, PostMortem, Project } from '../types.ts';
import type { GraphRepo } from './repo.ts';

const demo: Project = { key: 'demo', name: 'demo', repoPath: '/vibe/demo' };
const other: Project = { key: 'other', name: 'other', repoPath: '/vibe/other' };
const MIN = 60_000;
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));

/** A session of n turns, the last one `lastAgo` ms ago, a minute apart. */
function session(id: string, n: number, lastAgo: number, o: Partial<ParsedSession> = {}): ParsedSession {
  const turns = Array.from({ length: n }, (_, i) => ({
    uuid: `${id}-t${i}`, sessionId: id, ts: at(lastAgo + (n - 1 - i) * MIN), index: i, text: `${id} turn ${i}`,
    precedingAssistantText: i ? `${id} reply ${i - 1}` : '', precedingToolCalls: [],
  }));
  return { sessionId: id, sourceFile: `${id}.jsonl`, cwd: '/vibe/demo', gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[n - 1].ts, turns, toolCalls: [], ...o };
}

const summary = (goal: string) => withMarkdown({ goal, done: ['built it'], decisions: [], openThreads: [], filesTouched: ['src/a.ts'], pushback: [], outcome: 'works' });

function write(over: Partial<SummaryWrite> & { to: SummaryWrite['to'] }): SummaryWrite {
  return { summary: summary('Ship the orders list'), prevVersion: 0, rebuild: false, from: null, deltaTurns: over.to.index + 1, model: 'fake', state: 'active', ...over };
}

describeStores('SessionsStore (Neo4j startup)', (h) => {
  test('sessions stored before summaries get their stats when the schema is ensured', async () => {
    const g = h.store.graph as GraphRepo;
    await g.run(
      `CREATE (p:Project {key: 'demo'})<-[:IN]-(s:Session {id: 'legacy', endedAt: '2026-10-01T10:30:00Z'})
       CREATE (s)-[:HAS_TURN]->(:Turn {uuid: 'l0', sessionId: 'legacy', index: 0, ts: '2026-10-01T10:00:00Z', text: 'a'})
       CREATE (s)-[:HAS_TURN]->(:Turn {uuid: 'l1', sessionId: 'legacy', index: 1, ts: '2026-10-01T10:05:00Z', text: 'b'})
       CREATE (p)<-[:IN]-(:Session {id: 'empty'})`,
    );
    expect((await h.store.sessions.list({ projectKeys: ['demo'], limit: 5 })).sessions).toEqual([]);
    await h.store.ensureSchema();
    const { sessions } = await h.store.sessions.list({ projectKeys: ['demo'], limit: 5 });
    expect(sessions).toEqual([expect.objectContaining({ id: 'legacy', turnCount: 2, lastActivityAt: '2026-10-01T10:30:00.000Z', pendingTurns: 2 })]);
    await h.store.ensureSchema(); // nothing left to do, and no error
  });
}, { only: ['neo4j'] });

describeStores('SessionsStore', (h) => {
  let store: Store;
  let repo: GraphStore;
  let s: SessionsStore;
  beforeAll(() => {
    store = h.store;
    repo = h.store.graph;
    s = h.store.sessions;
  });

  const query = (o: Partial<SummaryWorkQuery> = {}): SummaryWorkQuery => ({
    projectKeys: ['demo'], quietBefore: new Date(Date.now() - 10 * MIN), idleBefore: new Date(Date.now() - 30 * MIN), maxDeltaTurns: 40, backfill: false, limit: 50, ...o,
  });
  const ids = async (o: Partial<SummaryWorkQuery> = {}) => (await s.work(query(o))).map((w) => w.id);

  test('upsertSession keeps the turn count, last turn and last activity; the list is newest first and leaves agent reports out', async () => {
    await repo.upsertSession(demo, session('old', 2, 120 * MIN), []);
    const fresh = session('new', 3, 1 * MIN, { source: 'codex' });
    await repo.upsertSession(demo, fresh, []);
    await store.knowledge.createManualFeedback({ project: demo, cwd: '/vibe/demo', text: 'you missed X', whatWasDone: 'Y' });
    const { sessions, next } = await s.list({ projectKeys: ['demo'], limit: 10 });
    expect(sessions.map((x) => x.id)).toEqual(['new', 'old']);
    expect(next).toBeNull();
    expect(sessions[0]).toMatchObject({ projectKey: 'demo', source: 'codex', turnCount: 3, state: 'active', snippet: null, summarizedThrough: null, summaryVersion: 0, pendingTurns: 3, gitBranch: 'main' });
    expect(sessions[0].lastActivityAt).toBe(fresh.endedAt);
    // A longer transcript read again: the stats follow it.
    await repo.upsertSession(demo, session('old', 4, 100 * MIN), []);
    const again = await s.detail('old');
    expect(again).toMatchObject({ turnCount: 4, pendingTurns: 4 });
    expect(await s.list({ projectKeys: [], limit: 10 })).toEqual({ sessions: [], next: null });
  });

  test('save stores the summary redacted, moves the cursor and appends the history; a stale version is not applied', async () => {
    await repo.upsertSession(demo, session('s1', 5, 20 * MIN), []);
    const secret = 'sk-' + 'ant-api03-' + 'A'.repeat(40);
    const first = write({ to: { index: 2, ts: 't2' }, summary: summary(`deploy with ${secret}`) });
    expect(await s.save('s1', first)).toBe(true);
    expect(await s.save('s1', first)).toBe(false); // planned against version 0, which is gone
    const d = (await s.detail('s1'))!;
    expect(d.summary!.goal).not.toContain(secret);
    expect(d.summary!.goal).toContain('[REDACTED]');
    expect(d.summary!.markdown).not.toContain(secret);
    expect(d).toMatchObject({ summarizedThrough: { index: 2, ts: 't2' }, summaryVersion: 1, summaryModel: 'fake', pendingTurns: 2, rebuildRequested: false });
    expect(await s.save('s1', write({ prevVersion: 1, from: { index: 2, ts: 't2' }, to: { index: 4, ts: 't4' }, deltaTurns: 2, model: 'fake-2', state: 'idle' }))).toBe(true);
    const d2 = (await s.detail('s1'))!;
    expect(d2).toMatchObject({ summaryVersion: 2, state: 'idle', pendingTurns: 0, summaryModel: 'fake-2', snippet: 'Ship the orders list' });
    expect(d2.history.map(({ at: _, ...x }) => x)).toEqual([
      { version: 1, from: null, to: { index: 2, ts: 't2' }, deltaTurns: 3, model: 'fake', rebuild: false },
      { version: 2, from: { index: 2, ts: 't2' }, to: { index: 4, ts: 't4' }, deltaTurns: 2, model: 'fake-2', rebuild: false },
    ]);
    expect(d2.summary!.markdown).toContain('**Goal:** Ship the orders list');
  });

  test("upsertSession keeps the agent's final reply, redacted, on the session: it is no turn, so it is never classified", async () => {
    const reply = { text: 'All done, the orders list ships.\nDB_PASSWORD=hunter2EXAMPLE', ts: at(19 * MIN) };
    await repo.upsertSession(demo, session('f', 3, 20 * MIN, { finalReply: reply }), []);
    const [w] = (await s.work(query())).filter((x) => x.id === 'f');
    expect(w.finalReply).toEqual({ text: expect.stringContaining('All done, the orders list ships.'), ts: reply.ts });
    expect(w.finalReply!.text).not.toContain('hunter2EXAMPLE');
    expect(w).toMatchObject({ turnCount: 3, lastTurn: { index: 2 }, pending: 3 });
    expect((await s.turns('f', -1, 10)).map((t) => t.text)).toEqual(['f turn 0', 'f turn 1', 'f turn 2']);
    const queued = await repo.unclassifiedTurns(100, ['demo']);
    expect(queued.filter((t) => t.sessionId === 'f').map((t) => t.text).sort()).toEqual(['f turn 1', 'f turn 2']);
    expect(JSON.stringify(queued)).not.toContain('All done');
    // A later human turn took it in as its preceding text: the transcript read again has no final reply.
    await repo.upsertSession(demo, session('f', 4, 12 * MIN, { finalReply: null }), []);
    expect((await s.work(query())).find((x) => x.id === 'f')!.finalReply).toBeNull();
    // An older worker's ParsedSession has no finalReply at all: none is stored.
    await repo.upsertSession(demo, session('g', 2, 20 * MIN), []);
    expect((await s.work(query())).find((x) => x.id === 'g')!.finalReply).toBeNull();
  });

  test('work: a final reply stored after the summary reached the last turn is due until an update covers it; a newer one is due again', async () => {
    // A big delta was summarized to the last turn while the agent was still answering.
    await repo.upsertSession(demo, session('late', 3, 15 * MIN), []);
    await s.save('late', write({ to: { index: 2, ts: 'x' } }));
    expect(await ids()).toEqual([]);
    const reply = { text: 'Done: the orders list ships.', ts: at(14 * MIN) };
    await repo.upsertSession(demo, session('late', 3, 15 * MIN, { finalReply: reply, endedAt: reply.ts }), []);
    const [w] = await s.work(query());
    expect(w).toMatchObject({ id: 'late', pending: 0, finalReply: reply, finalReplySummarizedTs: null, summarizedThrough: { index: 2 } });
    // Still active (not quiet yet): it waits, like a delta.
    expect(await ids({ quietBefore: new Date(Date.now() - 20 * MIN) })).toEqual([]);
    // The update that took the reply in marks it.
    expect(await s.save('late', write({ prevVersion: 1, from: { index: 2, ts: 'x' }, to: { index: 2, ts: 'x' }, deltaTurns: 0, finalReplyTs: reply.ts }))).toBe(true);
    expect(await ids()).toEqual([]);
    // An update that carries no reply keeps the mark.
    expect(await s.save('late', write({ prevVersion: 2, from: { index: 2, ts: 'x' }, to: { index: 2, ts: 'x' }, deltaTurns: 0 }))).toBe(true);
    expect((await s.work(query({ idleBefore: new Date(Date.now() - 5 * MIN) })))[0]).toMatchObject({ id: 'late', finalReplySummarizedTs: reply.ts });
    expect(await ids()).toEqual([]);
    // The agent answered again (a resumed session): the newer reply is due, idle or not.
    const newer = { text: 'Also fixed the footer.', ts: at(12 * MIN) };
    await repo.upsertSession(demo, session('late', 3, 15 * MIN, { finalReply: newer, endedAt: newer.ts }), []);
    expect(await ids()).toEqual(['late']);
    await s.setState('late', 'idle');
    expect(await ids()).toEqual(['late']);
    expect(await s.save('late', write({ prevVersion: 3, from: { index: 2, ts: 'x' }, to: { index: 2, ts: 'x' }, deltaTurns: 0, finalReplyTs: newer.ts }))).toBe(true);
    expect(await ids()).toEqual([]);
    // A rebuild that stops short of the last turn clears the mark: the rebuilt summary has not seen the reply.
    await s.requestRebuild('late');
    expect(await s.save('late', write({ prevVersion: 4, rebuild: true, to: { index: 1, ts: 'x' } }))).toBe(true);
    expect((await s.work(query()))[0]).toMatchObject({ id: 'late', pending: 1, finalReplySummarizedTs: null });
    // A session never summarized is a delta (or backfill), not a final reply to take in.
    await repo.upsertSession(demo, session('fresh', 2, 15 * MIN, { finalReply: { text: 'hi', ts: at(14 * MIN) } }), []);
    expect((await s.work(query())).find((x) => x.id === 'fresh')).toMatchObject({ pending: 2, finalReplySummarizedTs: null });
  });

  test('turns gives the turns after an index, in order', async () => {
    await repo.upsertSession(demo, session('s1', 5, 20 * MIN), []);
    expect((await s.turns('s1', 2, 10)).map((t) => t.index)).toEqual([3, 4]);
    expect((await s.turns('s1', -1, 2)).map((t) => t.text)).toEqual(['s1 turn 0', 's1 turn 1']);
  });

  test('work: a quiet delta or a big one is due; an active one is not; never-summarized history is backfill', async () => {
    await repo.upsertSession(demo, session('busy', 3, 1 * MIN), []); // new, still active, small delta
    await repo.upsertSession(demo, session('quiet', 3, 15 * MIN), []); // went quiet
    await repo.upsertSession(demo, session('big', 45, 1 * MIN), []); // active but a big delta
    await repo.upsertSession(demo, session('ancient', 3, 600 * MIN), []); // history: never summarized
    await repo.upsertSession(other, session('elsewhere', 3, 15 * MIN), []);
    expect(await ids()).toEqual(['big', 'quiet']);
    expect(await ids({ backfill: true })).toEqual(['ancient']);
    expect(await ids({ projectKeys: [] })).toEqual([]);
    expect(await ids({ excludeKeys: ['demo'] })).toEqual([]);
    const [big] = await s.work(query());
    expect(big).toMatchObject({ id: 'big', pending: 45, lastTurn: { index: 44 }, summarizedThrough: null, summaryVersion: 0, rebuild: false, state: null, summary: null });
  });

  test('work: a summarized session with nothing new is marked idle once quiet long enough; new turns bring an idle one back', async () => {
    await repo.upsertSession(demo, session('done', 3, 40 * MIN), []);
    await s.save('done', write({ to: { index: 2, ts: 'x' } }));
    expect(await ids()).toEqual(['done']); // pending 0, active, idle by time: to be marked idle
    expect((await s.work(query()))[0].pending).toBe(0);
    await s.setState('done', 'idle');
    expect(await ids()).toEqual([]);
    // The developer came back: one new turn, just now.
    await repo.upsertSession(demo, session('done', 4, 0), []);
    expect(await ids()).toEqual(['done']);
    expect((await s.list({ projectKeys: ['demo'], limit: 5, state: 'idle' })).sessions.map((x) => x.id)).toEqual(['done']);
  });

  test('a failed update backs off; an idle session with new turns is still listed so it can be reactivated', async () => {
    await repo.upsertSession(demo, session('q', 3, 15 * MIN), []);
    const { attempts, retryAt } = await s.recordFailure('q', 'bad JSON from the model');
    expect(attempts).toBe(1);
    expect(Date.parse(retryAt)).toBeGreaterThan(Date.now());
    expect(await ids()).toEqual([]);
    expect(await ids({ now: new Date(Date.parse(retryAt) + 1000) })).toEqual(['q']);
    expect((await s.detail('q'))!.summaryError).toBe('bad JSON from the model');
    expect((await s.recordFailure('q', 'again')).attempts).toBe(2);
    await s.setState('q', 'idle');
    const [w] = await s.work(query());
    expect(w).toMatchObject({ id: 'q', retryAt: expect.any(String) });
    // A success clears the backoff.
    expect(await s.save('q', write({ to: { index: 2, ts: 'x' } }))).toBe(true);
    expect((await s.detail('q'))!).toMatchObject({ summaryError: null, summaryRetryAt: null });
  });

  test('a rebuild is due at once, refuses an update planned before it, and is cleared by the rebuild', async () => {
    await repo.upsertSession(demo, session('r', 3, 1 * MIN), []);
    await s.save('r', write({ to: { index: 2, ts: 'x' } }));
    expect(await s.requestRebuild('r')).toBe(true);
    expect(await s.requestRebuild('nope')).toBe(false);
    expect((await s.detail('r'))!.rebuildRequested).toBe(true);
    expect((await s.work(query()))[0]).toMatchObject({ id: 'r', rebuild: true, pending: 0 });
    expect(await s.save('r', write({ prevVersion: 1, to: { index: 2, ts: 'x' } }))).toBe(false);
    expect(await s.save('r', write({ prevVersion: 1, rebuild: true, to: { index: 2, ts: 'x' } }))).toBe(true);
    const d = (await s.detail('r'))!;
    expect(d).toMatchObject({ rebuildRequested: false, summaryVersion: 2 });
    expect(d.history.at(-1)).toMatchObject({ rebuild: true, from: null });
  });

  test('the list pages by cursor and filters by state and by having a summary', async () => {
    for (let i = 0; i < 5; i++) await repo.upsertSession(demo, session(`p${i}`, 2, i * MIN), []);
    const one = await s.list({ projectKeys: ['demo'], limit: 2 });
    expect(one.sessions.map((x) => x.id)).toEqual(['p0', 'p1']);
    const two = await s.list({ projectKeys: ['demo'], limit: 2, after: one.next });
    expect(two.sessions.map((x) => x.id)).toEqual(['p2', 'p3']);
    const three = await s.list({ projectKeys: ['demo'], limit: 2, after: two.next });
    expect(three).toEqual({ sessions: [expect.objectContaining({ id: 'p4' })], next: null });
    await s.save('p3', write({ to: { index: 1, ts: 'x' }, state: 'idle' }));
    expect((await s.list({ projectKeys: ['demo'], limit: 9, summarizedOnly: true })).sessions.map((x) => x.id)).toEqual(['p3']);
    expect((await s.list({ projectKeys: ['demo'], limit: 9, state: 'active' })).sessions).toHaveLength(4);
  });

  test('detail links the Inbox items flagged in the session and the lesson each one led to', async () => {
    await repo.upsertSession(demo, session('i', 3, 5 * MIN), []);
    await repo.saveClassification('i-t2', { label: 'pushback', confidence: 0.9, summary: 'missed tenant scoping', signals: [] }, true);
    await repo.saveClassification('i-t1', { label: 'correction', confidence: 0.8, summary: 'wrong file', signals: [] }, true);
    await repo.decide('i-t2', 'confirmed', null);
    const pm: PostMortem = {
      taskTitle: 'Orders', missed: 'no scoping', cause: 'context_available_ignored', causeExplanation: 'x', outcome: 'addressed',
      lesson: { title: 'Scope by org', rule: 'Filter by orgId', appliesWhen: 'lists', scope: 'project', paths: [] }, contextItems: [],
    };
    await store.knowledge.savePostmortem('i-t2', pm, { miss: vec(1), lesson: vec(1) });
    const d = (await s.detail('i'))!;
    expect(d.inbox).toEqual([
      { id: 'i-t1', status: 'pending', label: 'correction', summary: 'wrong file', lessonId: null, lessonStatus: null },
      { id: 'i-t2', status: 'confirmed', label: 'pushback', summary: 'missed tenant scoping', lessonId: 'lesson:i-t2', lessonStatus: 'proposed' },
    ]);
    expect(await s.detail('missing')).toBeNull();
  });

  test('retention: with keepUnsummarized only turns a summary covers lose their text, and the summary stays', async () => {
    const old = (id: string) => session(id, 4, 30 * 86_400_000);
    await repo.upsertSession(demo, old('a'), []);
    await repo.upsertSession(demo, old('b'), []);
    for (const id of ['a', 'b']) for (let i = 1; i < 4; i++) await repo.saveClassification(`${id}-t${i}`, { label: 'neutral', confidence: 0, summary: '', signals: [] }, false);
    await s.save('a', write({ to: { index: 1, ts: 'x' } }));
    const cutoff = new Date(Date.now() - 86_400_000);
    expect(await repo.pruneTurnText(cutoff, 5000, { keepUnsummarized: true })).toBe(2); // a-t0 and a-t1
    expect((await h.probe.turn('a-t1'))!.text).toBeNull();
    expect((await h.probe.turn('a-t2'))!.text).toBe('a turn 2');
    expect((await h.probe.turn('b-t0'))!.text).toBe('b turn 0');
    // A rebuild needs every turn: nothing more is pruned from a session waiting for one.
    await s.requestRebuild('a');
    expect(await repo.pruneTurnText(cutoff, 5000, { keepUnsummarized: true })).toBe(0);
    const d = (await s.detail('a'))!;
    expect(d.summary!.goal).toBe('Ship the orders list');
    expect(d.prunedTurns).toBe(2);
    // Without the option, the old rule: every old classified turn nobody flagged.
    expect(await repo.pruneTurnText(cutoff)).toBe(6);
    expect((await s.detail('a'))!.summary).not.toBeNull();
  });

  test("retention removes an old session's final reply with its turns' text; a summary not caught up keeps it", async () => {
    const old = (id: string) => session(id, 2, 30 * 86_400_000, { finalReply: { text: `${id} final reply`, ts: at(30 * 86_400_000 - MIN) } });
    await repo.upsertSession(demo, old('c'), []);
    await repo.upsertSession(demo, old('d'), []);
    await repo.upsertSession(demo, session('e', 2, 15 * MIN, { finalReply: { text: 'e final reply', ts: at(14 * MIN) } }), []);
    for (const id of ['c', 'd', 'e']) await repo.saveClassification(`${id}-t1`, { label: 'neutral', confidence: 0, summary: '', signals: [] }, false);
    await s.save('c', write({ to: { index: 1, ts: 'x' } }));
    await s.save('d', write({ to: { index: 0, ts: 'x' } }));
    const reply = async (id: string) => {
      const all = [...(await s.work(query())), ...(await s.work(query({ backfill: true })))];
      return all.find((w) => w.id === id)?.finalReply?.text ?? null;
    };
    expect(await reply('c')).toBe('c final reply');
    await repo.pruneTurnText(new Date(Date.now() - 86_400_000), 5000, { keepUnsummarized: true });
    expect(await reply('c')).toBeNull();
    expect(await reply('d')).toBe('d final reply');
    expect(await reply('e')).toBe('e final reply');
    await repo.pruneTurnText(new Date(Date.now() - 86_400_000));
    expect(await reply('d')).toBeNull();
    expect(await reply('e')).toBe('e final reply');
  });

  test('summaries are never exported or synced, and a project delete removes them', async () => {
    await repo.upsertSession(demo, session('x', 3, 5 * MIN, { finalReply: { text: 'PRIVATE-FINAL-REPLY', ts: at(4 * MIN) } }), []);
    await s.save('x', write({ to: { index: 2, ts: 'x' }, summary: summary('PRIVATE-SUMMARY-GOAL'), }));
    const bundle = JSON.stringify(await store.portability.exportData({ projectKey: 'demo' }));
    expect(bundle).not.toContain('PRIVATE-SUMMARY-GOAL');
    expect(bundle).not.toContain('built it');
    expect(JSON.stringify(await store.portability.exportData())).not.toContain('PRIVATE-SUMMARY-GOAL');
    const sync = await syncBundle(store.portability, 'demo');
    expect(JSON.stringify(sync)).not.toContain('PRIVATE-SUMMARY-GOAL');
    expect(bundle + JSON.stringify(sync)).not.toContain('PRIVATE-FINAL-REPLY');
    await store.portability.deleteProject('demo');
    expect(await s.detail('x')).toBeNull();
    expect(await h.probe.count('Session')).toBe(0);
  });
});
