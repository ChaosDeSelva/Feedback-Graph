import type { Activity, SessionDetail, TurnEvidence } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { EvidenceDeps } from './evidence.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;

const session = {
  id: 's1', projectKey: 'demo', source: 'claude', cwd: '/vibe/demo', gitBranch: 'main', startedAt: '2026-10-25T09:00:00Z', lastActivityAt: '2026-10-25T09:30:00Z',
  turnCount: 4, state: 'idle', snippet: 'Keep cents', summarizedThrough: null, summaryUpdatedAt: null, summaryVersion: 0, pendingTurns: 0,
  summary: null, summaryModel: null, history: [], rebuildRequested: false, prunedTurns: 0, summaryError: null, summaryRetryAt: null,
  inbox: [{ id: 's1-t2', status: 'confirmed', label: 'pushback', summary: 'no, keep cents', lessonId: 'lesson:s1-t2', lessonStatus: 'proposed' }],
} as SessionDetail;

const turn = (index: number, o: Partial<TurnEvidence> = {}): TurnEvidence => ({
  uuid: `s1-t${index}`, index, ts: `2026-10-25T09:0${index}:00Z`, label: null, confidence: null, summary: null, signals: [], classifyAttempts: 0, candidateId: null, ...o,
});

function deps(o: Partial<EvidenceDeps> = {}): EvidenceDeps {
  return {
    sessions: {
      detail: async (id) => (id === 's1' || id === 'hidden' ? { ...session, id, projectKey: id === 'hidden' ? 'secret' : 'demo' } : null),
      turnEvidence: async () => [
        turn(0),
        turn(1, { label: 'neutral', confidence: 0.8, summary: 'an instruction about git', signals: ['skip:git-instruction'] }),
        turn(2, { label: 'pushback', confidence: 0.9, summary: 'no, keep cents with token ghp_' + 'A'.repeat(36), candidateId: 's1-t2' }),
        turn(3, { classifyAttempts: 3 }),
      ],
    },
    inScope: (key) => key === 'demo',
    candidateDetail: async (id) => ({
      candidate: { id, turnUuid: id, sessionId: 's1', projectKey: 'demo', source: 'claude', classification: { label: 'pushback', confidence: 0.9, summary: 'no, keep cents', signals: [] }, status: 'confirmed', createdAt: 't', decidedAt: 't', note: null, decidedBy: 'you', origins: ['detector'] },
      turn: {} as never, before: [], after: [], commits: [],
      postmortem: { done: true, attempts: 1, lastError: null, retryAt: null, gaveUp: false },
    }),
    lessonDetail: async (id) => ({
      lesson: { id, projectKey: 'demo', title: 'Keep cents', rule: 'Never round totals', appliesWhen: 'money', scope: 'project', paths: [], status: 'proposed', source: 'postmortem', cause: 'requirement_unstated', missId: 'miss:s1-t2', createdAt: 't', decidedAt: null, checks: [{ name: 'needs-path', detail: 'd' }] as never },
      miss: { id: 'miss:s1-t2', missed: 'totals were rounded', cause: 'requirement_unstated', causeExplanation: 'never stated' },
      feedback: null, contextItems: [], fixCommits: [], supersedes: [],
    }),
    sessionFiles: async () => [{ path: 'src/total.ts', read: true, edited: true, firstEditAt: 't', lastEditAt: 't' }, { path: 'README.md', read: true, edited: false, firstEditAt: null, lastEditAt: null }],
    activity: {
      list: async (q) => (q.target === 's1'
        ? [{ id: 'act:1', ts: 't', kind: 'context_served', actor: 'claude-code (MCP)', projectKey: 'demo', subject: 'context for "x": 1 lesson', why: 'w', details: { lessons: [{ id: 'lesson:old' }] }, targets: ['s1', 'lesson:old'] } as Activity]
        : q.target === 's1-t2'
          ? [{ id: 'act:2', ts: 't', kind: 'feedback_decided', actor: 'you', projectKey: 'demo', subject: 'confirmed', why: 'you confirmed', details: {}, targets: ['s1-t2'] } as Activity]
          : []),
    },
    ...o,
  };
}

test('GET /api/sessions/:id/evidence: the turns read, what the detector made of each and why, the Inbox items with their post-mortem, miss and lesson, the context served; redacted', async () => {
  const app = createApp(repo, { evidence: deps() });
  const res = await app.request('/api/sessions/s1/evidence');
  expect(res.status).toBe(200);
  const e = (await res.json()) as Record<string, any>;
  expect(e.session).toMatchObject({ id: 's1', projectKey: 'demo', source: 'claude', state: 'idle' });
  expect(e.turns).toEqual({ count: 4, first: '2026-10-25T09:00:00Z', last: '2026-10-25T09:03:00Z', classified: 2, waiting: 0, givenUp: 1, prunedText: 0 });
  expect(e.files).toEqual({ edited: ['src/total.ts'], readOnly: ['README.md'] });
  expect(e.flags).toEqual([
    expect.objectContaining({ index: 1, label: 'neutral', flagged: false, skipped: ['git-instruction'], why: 'an instruction about git' }),
    expect.objectContaining({ index: 2, label: 'pushback', flagged: true, candidateId: 's1-t2' }),
  ]);
  expect(e.inbox).toEqual([expect.objectContaining({
    id: 's1-t2', status: 'confirmed', decidedBy: 'you', postmortem: expect.objectContaining({ done: true }),
    miss: { id: 'miss:s1-t2', missed: 'totals were rounded', cause: 'requirement_unstated' },
    lesson: expect.objectContaining({ id: 'lesson:s1-t2', status: 'proposed', title: 'Keep cents', checks: ['needs-path'] }),
    history: [expect.objectContaining({ kind: 'feedback_decided', actor: 'you' })],
  })]);
  expect(e.served).toEqual([expect.objectContaining({ kind: 'context_served', actor: 'claude-code (MCP)', lessons: ['lesson:old'] })]);
  expect(JSON.stringify(e)).not.toContain('ghp_');
});

test('served lessons are read from entries that kept plain ids too (an older not-judged check, search_graph)', async () => {
  const entry = (id: string, details: Record<string, unknown>) => ({ id, ts: 't', kind: 'predone_check', actor: 'a', projectKey: 'demo', subject: 's', why: 'w', details, targets: ['s1'] }) as Activity;
  const app = createApp(repo, { evidence: deps({ activity: { list: async (q) => (q.target === 's1' ? [entry('act:3', { notJudged: true, lessons: ['lesson:a', 'lesson:b'] }), entry('act:4', { notJudged: true, lessons: [{ id: 'lesson:c', title: 'C' }] })] : []) } }) });
  const e = (await (await app.request('/api/sessions/s1/evidence')).json()) as Record<string, any>;
  expect(e.served.map((x: { lessons: string[] }) => x.lessons)).toEqual([['lesson:a', 'lesson:b'], ['lesson:c']]);
});

test('evidence follows the project selection and says when there is no such session', async () => {
  const app = createApp(repo, { evidence: deps() });
  expect((await app.request('/api/sessions/hidden/evidence')).status).toBe(404);
  expect((await app.request('/api/sessions/nope/evidence')).status).toBe(404);
});

test('what an agent is served, and what it reports, name its session when it passes session_id, so the evidence can find them', async () => {
  const logged: { kind: string; targets?: string[] }[] = [];
  const app = createApp(repo, {
    context: {
      roots: [{ host: '/Users/j/Vibe', container: '/vibe' }], embed: async (t) => t.map(() => [1]), judge: async () => [],
      k: { searchLessons: async () => [], relatedMisses: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'manual:9' },
      activity: { record: async (e) => { logged.push(e); } },
    },
  });
  const call = (name: string, args: object) => app.request('/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { cwd: '/Users/j/Vibe/demo', ...args } } }),
  });
  await call('get_task_context', { task: 'tune it', session_id: 's-7' });
  await call('get_task_context', { task: 'tune it', session_id: 's-7', brief: true });
  await call('report_feedback', { feedback: 'missed auth', what_was_done: 'endpoint', session_id: 's-7' });
  await call('get_task_context', { task: 'no session' });
  expect(logged.map((e) => e.targets?.includes('s-7'))).toEqual([true, true, true, false]);
});

test('check_before_done takes session_id: the check is recorded with it and its Activity entry names the session, against lessons or past misses', async () => {
  const logged: { kind: string; targets?: string[]; details?: Record<string, unknown> }[] = [];
  const checks: unknown[] = [];
  const lessonHit = { score: 0.9, lesson: { id: 'lesson:a', projectKey: 'demo', title: 'T', rule: 'R', appliesWhen: 'W', scope: 'project', paths: [], status: 'approved', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't' } };
  const miss = { missId: 'miss:a', missed: 'm', cause: 'other', feedbackText: 'f', sessionId: 's0', ts: '2026-10-01T10:00:00Z', score: 0.9 };
  let lessons = true;
  const app = createApp(repo, {
    context: {
      roots: [{ host: '/Users/j/Vibe', container: '/vibe' }], embed: async (t) => t.map(() => [1]),
      judge: async (_w, ls) => ls.map((l) => ({ lessonId: l.lesson.id, status: 'addressed' as const, why: 'ok', applies: true })),
      k: {
        searchLessons: async () => (lessons ? [lessonHit as never] : []), relatedMisses: async () => [miss as never],
        recordPreDoneCheck: async (c) => { checks.push(c); }, createManualFeedback: async () => 'manual:9',
      },
      activity: { record: async (e) => { logged.push(e); } },
    },
  });
  const call = (args: object) => app.request('/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_before_done', arguments: { cwd: '/Users/j/Vibe/demo', task: 't', summary: 's', ...args } } }),
  });
  expect((await call({ session_id: 's-7' })).status).toBe(200);
  expect(checks).toEqual([expect.objectContaining({ projectKey: 'demo', sessionId: 's-7' })]);
  expect(logged.at(-1)).toMatchObject({ kind: 'predone_check', details: expect.objectContaining({ sessionId: 's-7' }) });
  expect(logged.at(-1)!.targets).toContain('s-7');
  lessons = false;
  await call({ session_id: 's-7' });
  expect(logged.at(-1)).toMatchObject({ kind: 'predone_check', details: expect.objectContaining({ againstMisses: true }) });
  expect(logged.at(-1)!.targets).toContain('s-7');
  // Without one, nothing names a session.
  lessons = true;
  await call({});
  expect((checks.at(-1) as { sessionId?: unknown }).sessionId ?? null).toBeNull();
  expect(logged.at(-1)!.targets).not.toContain('s-7');
});
