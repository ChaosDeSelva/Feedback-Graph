import { finalReplyDue, ModelOutputError, ModelTimeoutError, ProviderUnavailableError, STRICT_JSON, type ActivityInput, type FinalReply, type HumanTurn, type JsonTask, type LlmProvider, type SessionState, type SessionSummary, type SessionsStore, type SummaryCursor, type SummaryWork, type SummaryWorkQuery, type SummaryWrite } from '@fb/core';
import { beforeEach, expect, test } from 'vitest';
import { runSummaries, type SummarizeDeps } from './stage.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-23T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

type Sess = {
  id: string; projectKey: string; cwd: string; turns: HumanTurn[]; lastActivityAt: string; state: SessionState | null;
  summary: SessionSummary | null; through: SummaryCursor | null; version: number; rebuild: boolean; retryAt: string | null; attempts: number;
  writes: SummaryWrite[]; finalReply: FinalReply | null; replyMark: string | null;
};

/**
 * An in-memory SessionsStore with the rules of SummaryWorkQuery (the contract suite proves both real stores keep them).
 */
class MemSessions implements Pick<SessionsStore, 'work' | 'turns' | 'save' | 'recordFailure' | 'setState'> {
  readonly s = new Map<string, Sess>();
  failures: string[] = [];

  add(id: string, n: number, lastAgo: number, o: Partial<Sess> = {}) {
    this.s.set(id, { id, projectKey: 'demo', cwd: '/vibe/demo', turns: [], lastActivityAt: iso(lastAgo), state: null, summary: null, through: null, version: 0, rebuild: false, retryAt: null, attempts: 0, writes: [], finalReply: null, replyMark: null, ...o });
    this.addTurns(id, n, lastAgo);
  }

  /** n more turns, the last `lastAgo` ms ago, a minute apart. */
  addTurns(id: string, n: number, lastAgo: number, extra: (i: number) => Partial<HumanTurn> = () => ({})) {
    const x = this.s.get(id)!;
    const start = x.turns.length;
    for (let k = 0; k < n; k++) {
      const i = start + k;
      x.turns.push({ uuid: `${id}-${i}`, sessionId: id, ts: iso(lastAgo + (n - 1 - k) * MIN), index: i, text: `${id} user turn ${i}`, precedingAssistantText: i ? `${id} agent reply ${i - 1}` : '', precedingToolCalls: [], ...extra(i) });
    }
    x.lastActivityAt = iso(lastAgo);
  }

  async work(q: SummaryWorkQuery): Promise<SummaryWork[]> {
    const now = (q.now ?? new Date()).toISOString();
    const out = [...this.s.values()].filter((x) => {
      if (!q.projectKeys.includes(x.projectKey) || q.excludeKeys?.includes(x.projectKey) || !x.turns.length) return false;
      const pending = x.turns.length - 1 - (x.through?.index ?? -1);
      const act = x.lastActivityAt;
      const due = !x.retryAt || x.retryAt <= now;
      const history = !x.through && !x.rebuild && act < q.idleBefore.toISOString();
      if (q.backfill) return history && due;
      if (history) return false;
      const reply = finalReplyDue({ finalReply: x.finalReply, finalReplySummarizedTs: x.replyMark, summarizedThrough: x.through, lastTurn: { index: x.turns.length - 1, ts: '' }, rebuild: x.rebuild });
      return (reply && due && (act < q.quietBefore.toISOString() || x.state === 'idle'))
        || ((x.rebuild || pending > 0) && due && (x.rebuild || act < q.quietBefore.toISOString() || pending >= q.maxDeltaTurns || x.state === 'idle'))
        || (pending > 0 && x.state === 'idle')
        || (pending <= 0 && (x.state ?? 'active') === 'active' && act < q.idleBefore.toISOString());
    });
    out.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.id.localeCompare(b.id));
    return out.slice(0, q.limit).map((x) => ({
      id: x.id, projectKey: x.projectKey, source: 'claude', cwd: x.cwd, lastTurn: { index: x.turns.length - 1, ts: x.turns.at(-1)!.ts },
      lastActivityAt: x.lastActivityAt, turnCount: x.turns.length, state: x.state, summary: x.summary, summarizedThrough: x.through,
      summaryVersion: x.version, rebuild: x.rebuild, retryAt: x.retryAt, pending: Math.max(0, x.turns.length - 1 - (x.through?.index ?? -1)), finalReply: x.finalReply,
      finalReplySummarizedTs: x.replyMark,
    }));
  }

  async turns(id: string, after: number, limit: number) {
    return this.s.get(id)!.turns.filter((t) => t.index > after).slice(0, limit);
  }

  async save(id: string, w: SummaryWrite) {
    const x = this.s.get(id)!;
    if (x.version !== w.prevVersion || x.rebuild !== w.rebuild) return false;
    const replyMark = w.finalReplyTs ?? (w.rebuild ? null : x.replyMark);
    Object.assign(x, { summary: w.summary, through: w.to, version: w.prevVersion + 1, state: w.state, rebuild: false, retryAt: null, attempts: 0, replyMark });
    x.writes.push(w);
    return true;
  }

  async recordFailure(id: string, error: string) {
    const x = this.s.get(id)!;
    x.attempts++;
    x.retryAt = new Date(NOW + 5 * MIN).toISOString();
    this.failures.push(error);
    return { attempts: x.attempts, retryAt: x.retryAt };
  }

  async setState(id: string, state: SessionState) {
    this.s.get(id)!.state = state;
  }
}

/** A model that answers every request with `answer(prompt)` and remembers each prompt. */
function fakeModel(answer: (user: string, n: number) => unknown = (u) => ({ goal: `goal after ${(u.match(/\[turn \d+/g) ?? []).length} turns`, done: ['did a thing'], decisions: [], openThreads: [], filesTouched: [], pushback: [], outcome: 'ok' })) {
  const prompts: string[] = [];
  const llm: LlmProvider = { id: 'fake:model', agentic: false, json: async (t: JsonTask) => { prompts.push(t.user); return answer(t.user, prompts.length); } };
  return { llm, prompts };
}

let mem: MemSessions;
let activity: ActivityInput[];
let logs: string[];
const deps = (llm: LlmProvider | null, o: Partial<SummarizeDeps> = {}): SummarizeDeps => ({
  sessions: mem, llm, activity: { record: async (a) => void activity.push(a) }, projects: () => ['demo'],
  quietMinutes: 10, idleMinutes: 30, maxDeltaTurns: 40, backfillPerCycle: 3, now: () => NOW, log: (m) => void logs.push(m), ...o,
});

beforeEach(() => {
  mem = new MemSessions();
  activity = [];
  logs = [];
});

test('a quiet session is summarized from its first turn; the cursor lands exactly on the last turn sent', async () => {
  mem.add('s1', 3, 15 * MIN);
  const { llm, prompts } = fakeModel();
  expect(await runSummaries(deps(llm))).toEqual({ summarized: 1, idled: 0, reactivated: 0, failed: 0 });
  const x = mem.s.get('s1')!;
  expect(x.through).toEqual({ index: 2, ts: x.turns[2].ts });
  expect(x.version).toBe(1);
  expect(x.state).toBe('active'); // quiet, not yet idle
  expect(x.summary!.goal).toBe('goal after 3 turns');
  expect(x.summary!.markdown).toContain('**Goal:** goal after 3 turns');
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('PREVIOUS SUMMARY: none');
  expect(activity).toEqual([expect.objectContaining({
    kind: 'session_summarized', actor: 'fake:model', projectKey: 'demo', targets: ['session:s1'],
    details: expect.objectContaining({ sessionId: 's1', from: null, to: { index: 2, ts: x.turns[2].ts }, deltaTurns: 3, chunks: 1, modelCalls: 1, version: 1, rebuild: false }),
  })]);
  // Nothing new: nothing is sent again.
  await runSummaries(deps(llm));
  expect(prompts).toHaveLength(1);
});

test('the second update sends only the turns after the cursor, with the previous summary, and moves the cursor exactly', async () => {
  mem.add('s1', 3, 15 * MIN);
  const { llm, prompts } = fakeModel();
  await runSummaries(deps(llm));
  mem.addTurns('s1', 2, 12 * MIN);
  await runSummaries(deps(llm));
  expect(prompts).toHaveLength(2);
  const second = prompts[1];
  for (const i of [0, 1, 2]) expect(second).not.toContain(`s1 user turn ${i}`);
  expect(second).toContain('s1 user turn 3');
  expect(second).toContain('s1 user turn 4');
  // The agent's reply to turn 2 came after the last update: it is part of this delta.
  expect(second).toContain('s1 agent reply 2');
  expect(second).not.toContain('s1 agent reply 1');
  expect(second).toContain('PREVIOUS SUMMARY (covers turns 0 to 2)');
  expect(second).toContain('goal after 3 turns');
  const x = mem.s.get('s1')!;
  expect(x.through).toEqual({ index: 4, ts: x.turns[4].ts });
  expect(x.version).toBe(2);
  expect(x.writes[1]).toMatchObject({ from: { index: 2 }, to: { index: 4 }, deltaTurns: 2, prevVersion: 1 });
  expect(activity[1].details).toMatchObject({ from: { index: 2 }, to: { index: 4 }, deltaTurns: 2, version: 2 });
  expect(activity[1].subject).toContain('turns 3 to 4 (2 new)');
});

test('an active session waits until it is quiet, unless its delta is large', async () => {
  mem.add('busy', 3, 2 * MIN);
  mem.add('big', 41, 1 * MIN);
  const { llm } = fakeModel();
  expect((await runSummaries(deps(llm))).summarized).toBe(1);
  expect(mem.s.get('busy')!.through).toBeNull();
  expect(mem.s.get('big')!.through!.index).toBe(40);
  expect(activity[0].why).toMatch(/41 turns were waiting/);
});

test('idle: a caught-up session quiet for SESSION_IDLE_MINUTES is marked idle after its final pass, without another model call', async () => {
  mem.add('done', 3, 45 * MIN);
  mem.add('quiet', 3, 15 * MIN);
  mem.s.get('done')!.through = { index: 0, ts: 'x' }; // summarized before, two turns behind
  mem.s.get('done')!.summary = { goal: 'g', done: [], decisions: [], openThreads: [], filesTouched: [], pushback: [], outcome: '', markdown: '' };
  const { llm, prompts } = fakeModel();
  const r = await runSummaries(deps(llm));
  expect(r).toMatchObject({ summarized: 2, idled: 1 });
  expect(mem.s.get('done')!.state).toBe('idle'); // final pass and idle in one write
  expect(mem.s.get('quiet')!.state).toBe('active');
  // Later the quiet one passes the idle mark with nothing new: idle, no model call.
  const later = NOW + 20 * MIN;
  expect(await runSummaries(deps(llm, { now: () => later }))).toMatchObject({ summarized: 0, idled: 1 });
  expect(mem.s.get('quiet')!.state).toBe('idle');
  expect(prompts).toHaveLength(2);
});

test('reactivation: a new turn makes an idle session active; once quiet again the summary is extended from its cursor', async () => {
  mem.add('s', 3, 60 * MIN);
  mem.s.get('s')!.through = { index: 2, ts: 'x' };
  mem.s.get('s')!.summary = { goal: 'first goal', done: [], decisions: [], openThreads: [], filesTouched: [], pushback: [], outcome: '', markdown: '' };
  mem.s.get('s')!.state = 'idle';
  mem.s.get('s')!.version = 1;
  mem.addTurns('s', 1, 1 * MIN);
  const { llm, prompts } = fakeModel();
  expect(await runSummaries(deps(llm))).toMatchObject({ reactivated: 1, summarized: 0 });
  expect(mem.s.get('s')!.state).toBe('active');
  expect(prompts).toHaveLength(0);
  await runSummaries(deps(llm, { now: () => NOW + 15 * MIN }));
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain('first goal');
  expect(prompts[0]).toContain('s user turn 3');
  expect(prompts[0]).not.toContain('s user turn 2');
  expect(mem.s.get('s')!).toMatchObject({ through: { index: 3 }, version: 2, state: 'active' });
});

test('an unavailable model leaves every cursor where it was, charges nothing, and stops the pass', async () => {
  mem.add('a', 3, 15 * MIN);
  mem.add('b', 3, 20 * MIN);
  let calls = 0;
  const llm: LlmProvider = { id: 'ollama:gemma4', agentic: false, json: async () => { calls++; throw new ProviderUnavailableError('cannot reach the model'); } };
  const r = await runSummaries(deps(llm));
  expect(r).toEqual({ summarized: 0, idled: 0, reactivated: 0, failed: 0, unavailable: 'cannot reach the model' });
  expect(calls).toBe(1);
  for (const id of ['a', 'b']) expect(mem.s.get(id)!).toMatchObject({ through: null, version: 0, attempts: 0, retryAt: null });
  expect(activity).toEqual([]);
  // No model could be built at all: the same.
  expect((await runSummaries(deps(null))).unavailable).toMatch(/no summary model/);
  // A network error from fetch counts as unavailable too.
  const down: LlmProvider = { id: 'x', agentic: false, json: async () => { throw Object.assign(new TypeError('fetch failed'), {}); } };
  expect((await runSummaries(deps(down))).unavailable).toBeTruthy();
  expect(mem.s.get('a')!.attempts).toBe(0);
});

test('an invalid answer is asked again once; twice invalid keeps the previous summary and backs off', async () => {
  mem.add('s', 3, 15 * MIN);
  const flaky = fakeModel((u, n) => (n === 1 ? { nonsense: true } : { goal: 'second try', done: [], decisions: [], openThreads: [], filesTouched: [], pushback: [], outcome: '' }));
  expect((await runSummaries(deps(flaky.llm))).summarized).toBe(1);
  expect(flaky.prompts).toHaveLength(2);
  expect(mem.s.get('s')!.summary!.goal).toBe('second try');

  mem.addTurns('s', 1, 12 * MIN);
  const bad = fakeModel(() => ({ goal: '' }));
  expect(await runSummaries(deps(bad.llm))).toMatchObject({ summarized: 0, failed: 1 });
  expect(bad.prompts).toHaveLength(2);
  expect(mem.s.get('s')!).toMatchObject({ through: { index: 2 }, version: 1, attempts: 1 });
  expect(mem.s.get('s')!.summary!.goal).toBe('second try');
  expect(mem.failures[0]).toMatch(/did not return a valid summary/);
  // Backing off: the next pass does not ask again.
  await runSummaries(deps(bad.llm));
  expect(bad.prompts).toHaveLength(2);
});

test('the second ask after an unusable answer carries a stricter instruction, and prose with no JSON counts as unusable', async () => {
  mem.add('s', 3, 15 * MIN);
  const systems: string[] = [];
  const good = { goal: 'strict try', done: [], decisions: [], openThreads: [], filesTouched: [], pushback: [], outcome: '' };
  const llm: LlmProvider = {
    id: 'fake:model', agentic: false,
    json: async (t) => { systems.push(t.system); if (systems.length === 1) throw new ModelOutputError('no JSON object in the answer', 'Here is the summary'); return good; },
  };
  expect((await runSummaries(deps(llm))).summarized).toBe(1);
  expect(systems[1]).toContain(STRICT_JSON);
  expect(mem.s.get('s')!.summary!.goal).toBe('strict try');
});

test('a summary call that timed out is charged to that session (backoff) and the pass goes on to the next', async () => {
  mem.add('slow', 3, 20 * MIN);
  mem.add('ok', 3, 15 * MIN);
  const ok = fakeModel();
  const llm: LlmProvider = {
    id: 'fake:model', agentic: false,
    json: async (t) => { if (t.user.includes('slow user turn')) throw new ModelTimeoutError('Ollama (gemma4) did not answer within 300 s'); return ok.llm.json(t); },
  };
  const r = await runSummaries(deps(llm));
  expect(r).toMatchObject({ summarized: 1, failed: 1 });
  expect(r.unavailable).toBeUndefined();
  expect(mem.s.get('slow')!).toMatchObject({ attempts: 1, through: null });
  expect(mem.failures[0]).toMatch(/did not answer within 300 s/);
});

test('a big delta is summarized in parts (map), then merged into the previous summary; each part sees only its turns', async () => {
  mem.add('big', 45, 15 * MIN);
  const { llm, prompts } = fakeModel();
  await runSummaries(deps(llm, { chunkTurns: 20 }));
  expect(prompts).toHaveLength(4); // parts of 20, 20 and 5 turns, then the merge
  expect(prompts[0]).toContain('PART 1 OF 3');
  expect(prompts[0]).toContain('big user turn 19');
  expect(prompts[0]).not.toContain('big user turn 20');
  expect(prompts[1]).toContain('big user turn 20');
  expect(prompts[1]).not.toContain('big user turn 19\n');
  expect(prompts[2]).toContain('big user turn 44');
  expect(prompts[3]).toContain('SUMMARIES OF THE NEW TURNS');
  expect(prompts[3]).toContain('PART 3 (turns 40 to 44)');
  expect(prompts[3]).not.toContain('big user turn');
  expect(mem.s.get('big')!.through!.index).toBe(44);
  expect(activity[0].details).toMatchObject({ chunks: 3, modelCalls: 4, deltaTurns: 45 });
});

test('a very long delta is taken in over several passes, the cursor advancing by what was sent', async () => {
  mem.add('long', 100, 15 * MIN);
  const { llm } = fakeModel();
  await runSummaries(deps(llm, { maxTurnsPerUpdate: 80 }));
  expect(mem.s.get('long')!).toMatchObject({ through: { index: 79 }, state: 'active' });
  await runSummaries(deps(llm, { maxTurnsPerUpdate: 80 }));
  expect(mem.s.get('long')!.through!.index).toBe(99);
});

test('backfill: sessions from before summaries, newest first, a few per cycle', async () => {
  for (let i = 0; i < 5; i++) mem.add(`old${i}`, 2, (100 + i) * MIN);
  const { llm } = fakeModel();
  await runSummaries(deps(llm, { backfillPerCycle: 2 }));
  expect([...mem.s.values()].filter((x) => x.through).map((x) => x.id)).toEqual(['old0', 'old1']);
  expect(mem.s.get('old0')!.state).toBe('idle');
  expect(activity[0].why).toMatch(/backfill/);
  await runSummaries(deps(llm, { backfillPerCycle: 0 }));
  expect([...mem.s.values()].filter((x) => x.through)).toHaveLength(2);
});

test('a rebuild starts again from the first turn, without the previous summary', async () => {
  mem.add('r', 3, 15 * MIN);
  const { llm, prompts } = fakeModel();
  await runSummaries(deps(llm));
  mem.s.get('r')!.rebuild = true;
  await runSummaries(deps(llm));
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain('PREVIOUS SUMMARY: none');
  expect(prompts[1]).toContain('r user turn 0');
  expect(mem.s.get('r')!).toMatchObject({ rebuild: false, version: 2, through: { index: 2 } });
  expect(mem.s.get('r')!.writes[1]).toMatchObject({ rebuild: true, from: null });
  expect(activity[1].why).toMatch(/rebuilt|rebuild/);
});

test('the prompt is redacted, carries tool names and paths (relative to the session folder) but not commands, and fences the transcript', async () => {
  mem.add('s', 2, 15 * MIN);
  const key = 'gh' + 'p_' + 'x'.repeat(36);
  mem.addTurns('s', 1, 14 * MIN, () => ({
    text: `use ${key} to push`,
    precedingToolCalls: [
      { name: 'Edit', ts: 't', filePath: '/vibe/demo/src/orders.ts' },
      { name: 'Bash', ts: 't', command: 'rm -rf /tmp/secret-cmd' },
      { name: 'Bash', ts: 't', command: 'ls' },
    ],
  }));
  const { llm, prompts } = fakeModel();
  await runSummaries(deps(llm));
  expect(prompts[0]).not.toContain(key);
  expect(prompts[0]).toContain('[REDACTED]');
  expect(prompts[0]).toContain('Edit src/orders.ts');
  expect(prompts[0]).toContain('Bash ×2');
  expect(prompts[0]).not.toContain('secret-cmd');
  expect(prompts[0]).toMatch(/<<<TRANSCRIPT[\s\S]*TRANSCRIPT>>>/);
  // What the transcript shows was edited is kept even when the model leaves it out.
  expect(mem.s.get('s')!.summary!.filesTouched).toEqual(['src/orders.ts']);
});

test('nothing is selected: nothing is read or sent', async () => {
  mem.add('s', 3, 15 * MIN);
  const { llm, prompts } = fakeModel();
  expect(await runSummaries(deps(llm, { projects: () => [] }))).toEqual({ summarized: 0, idled: 0, reactivated: 0, failed: 0 });
  expect(prompts).toHaveLength(0);
});

test('an update planned before a rebuild was asked for is not saved, and nothing is logged for it', async () => {
  mem.add('s', 3, 15 * MIN);
  const { llm } = fakeModel(() => {
    mem.s.get('s')!.rebuild = true; // the owner presses Resummarize while the model works
    return { goal: 'stale', done: [], decisions: [], openThreads: [], filesTouched: [], pushback: [], outcome: '' };
  });
  expect((await runSummaries(deps(llm))).summarized).toBe(0);
  expect(mem.s.get('s')!.summary).toBeNull();
  expect(activity).toEqual([]);
});

test("the agent's final reply is sent with the delta that reaches the last turn, after it, and is not a turn", async () => {
  mem.add('s1', 3, 15 * MIN, { finalReply: { text: 'Shipped: the orders list is live.', ts: iso(14 * MIN) } });
  const { llm, prompts } = fakeModel();
  expect((await runSummaries(deps(llm))).summarized).toBe(1);
  expect(prompts).toHaveLength(1);
  const p = prompts[0];
  expect(p).toContain('Shipped: the orders list is live.');
  expect(p.indexOf('Shipped: the orders list')).toBeGreaterThan(p.indexOf('s1 user turn 2'));
  // The cursor still lands on the last turn, and the goal (counted from the turn markers) saw three turns.
  const x = mem.s.get('s1')!;
  expect(x.through).toEqual({ index: 2, ts: x.turns[2].ts });
  expect(x.summary!.goal).toBe('goal after 3 turns');
  // The update marks the reply as taken in: it is not sent again.
  expect(x.writes.at(-1)!.finalReplyTs).toBe(x.finalReply!.ts);
  await runSummaries(deps(llm));
  expect(prompts).toHaveLength(1);
});

test('a delta that stops short of the last turn does not carry the final reply; the one that reaches it does', async () => {
  mem.add('s1', 5, 15 * MIN, { finalReply: { text: 'FINAL-REPLY-TEXT', ts: iso(14 * MIN) } });
  const { llm, prompts } = fakeModel();
  await runSummaries(deps(llm, { maxTurnsPerUpdate: 3 }));
  expect(prompts.at(-1)).not.toContain('FINAL-REPLY-TEXT');
  await runSummaries(deps(llm, { maxTurnsPerUpdate: 3 }));
  expect(prompts.at(-1)).toContain('FINAL-REPLY-TEXT');
});

test('a delta summarized in parts carries the final reply in its last part', async () => {
  mem.add('s1', 6, 15 * MIN, { finalReply: { text: 'FINAL-REPLY-TEXT', ts: iso(14 * MIN) } });
  const { llm, prompts } = fakeModel();
  await runSummaries(deps(llm, { chunkTurns: 3 }));
  expect(prompts).toHaveLength(3);
  expect(prompts.filter((p) => p.includes('FINAL-REPLY-TEXT'))).toHaveLength(1);
  expect(prompts[1]).toContain('FINAL-REPLY-TEXT');
});

test('a final reply stored after a SUMMARY_MAX_DELTA_TURNS update reached the last turn is summarized alone, once the session is quiet', async () => {
  mem.add('s1', 45, 1 * MIN); // active, but a big delta
  const { llm, prompts } = fakeModel();
  const big = { chunkTurns: 100, chunkChars: 1_000_000 };
  await runSummaries(deps(llm, big));
  const x = mem.s.get('s1')!;
  expect(x.through!.index).toBe(44);
  expect(prompts).toHaveLength(1);
  // The agent's answer arrives after that update: the transcript read again now has a final reply.
  x.finalReply = { text: 'LATE-FINAL-REPLY: the orders list ships.', ts: iso(0.5 * MIN) };
  x.lastActivityAt = iso(0.5 * MIN);
  await runSummaries(deps(llm, big));
  expect(prompts).toHaveLength(1); // not quiet yet
  x.lastActivityAt = iso(15 * MIN);
  expect(await runSummaries(deps(llm, big))).toMatchObject({ summarized: 1, failed: 0 });
  expect(prompts).toHaveLength(2);
  const p = prompts[1];
  // Only the reply is the delta: no turn is sent again, and the previous summary comes with it.
  expect(p).toContain('LATE-FINAL-REPLY: the orders list ships.');
  expect(p).not.toMatch(/\[turn \d+ ·/);
  expect(p).not.toContain('s1 user turn');
  expect(p).toContain('goal after 45 turns');
  expect(x.through).toEqual({ index: 44, ts: x.turns[44].ts });
  expect(x.version).toBe(2);
  expect(x.writes.at(-1)).toMatchObject({ from: { index: 44 }, to: { index: 44 }, deltaTurns: 0, finalReplyTs: x.finalReply.ts, rebuild: false });
  expect(activity.at(-1)).toMatchObject({
    kind: 'session_summarized', subject: expect.stringContaining("final reply"),
    details: expect.objectContaining({ deltaTurns: 0, finalReply: true, from: { index: 44, ts: x.turns[44].ts }, to: { index: 44, ts: x.turns[44].ts } }),
  });
  // Taken in: nothing more to send.
  await runSummaries(deps(llm, big));
  expect(prompts).toHaveLength(2);
});

test('an idle session whose final reply arrived late gets it too, and stays idle', async () => {
  mem.add('s1', 3, 60 * MIN);
  const { llm, prompts } = fakeModel();
  await runSummaries(deps(llm));
  const x = mem.s.get('s1')!;
  expect(x.state).toBe('idle');
  x.finalReply = { text: 'LATE-FINAL-REPLY', ts: iso(40 * MIN) };
  x.lastActivityAt = iso(40 * MIN);
  expect(await runSummaries(deps(llm))).toMatchObject({ summarized: 1, idled: 1, reactivated: 0 });
  expect(prompts.at(-1)).toContain('LATE-FINAL-REPLY');
  expect(x.state).toBe('idle');
});
