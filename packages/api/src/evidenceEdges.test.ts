import type { Activity, SessionDetail, TurnEvidence } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { EvidenceDeps } from './evidence.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const OP = 'o'.repeat(32);

const session = {
  id: 's1', projectKey: 'demo', source: 'claude', cwd: '/vibe/demo', gitBranch: 'main', startedAt: 't0', lastActivityAt: 't1',
  turnCount: 1, state: 'idle', snippet: 'g', summarizedThrough: null, summaryUpdatedAt: null, summaryVersion: 0, pendingTurns: 0,
  summary: null, summaryModel: null, history: [], rebuildRequested: false, prunedTurns: 0, summaryError: null, summaryRetryAt: null, inbox: [],
} as SessionDetail;
const turn = (index: number, o: Partial<TurnEvidence> = {}): TurnEvidence => ({
  uuid: `t${index}`, index, ts: `t${index}`, label: null, confidence: null, summary: null, signals: [], classifyAttempts: 0, candidateId: null, ...o,
});
const entry = (id: string, o: Partial<Activity> = {}) => ({ id, ts: 't', kind: 'predone_check', actor: 'a', projectKey: 'demo', subject: 's', why: 'w', details: {}, targets: ['s1'], ...o }) as Activity;
const deps = (o: Partial<EvidenceDeps> = {}): EvidenceDeps => ({
  sessions: { detail: async () => session, turnEvidence: async () => [] },
  inScope: () => true,
  ...o,
});
const get = async (d: EvidenceDeps, headers: Record<string, string> = {}) => {
  const res = await createApp(repo, { auth: { operator: { token: OP, allow: [] } }, evidence: d }).request('/api/sessions/s1/evidence', { headers });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

test('a run sees the evidence of its own sandboxed session', async () => {
  const d = deps({ sessions: { detail: async () => ({ ...session, sandbox: true, run: 'test-1' }), turnEvidence: async () => [turn(0)] } });
  const own = await get(d, { authorization: `Bearer ${OP}`, 'x-fg-run-key': 'session-registration-private-key-123456789', 'x-fg-run': 'test-1', 'x-fg-sandbox': '1' });
  expect(own.status).toBe(200);
  expect(own.body.turns.count).toBe(1);
  expect((await get(d)).status).toBe(404);
});

test('served lessons: a judged check\'s verdicts by lessonId, the run an entry was made in, and details that name no lessons', async () => {
  const d = deps({ activity: { list: async () => [
    entry('act:1', { run: 'test-1', details: { verdicts: [{ lessonId: 'lesson:a' }, { verdict: 'met' }, null] } }),
    entry('act:2', { details: { lessons: 'not a list' } }),
  ] } });
  const { body } = await get(d);
  expect(body.served).toEqual([
    expect.objectContaining({ id: 'act:1', run: 'test-1', lessons: ['lesson:a'] }),
    expect.objectContaining({ id: 'act:2', lessons: [] }),
  ]);
  expect(body.served[1]).not.toHaveProperty('run');
});

test('an Inbox item without item details, origins or lesson checks shows nulls for them', async () => {
  const inbox = [{ id: 'c1', status: 'pending', label: 'pushback', summary: 's', lessonId: 'lesson:c1', lessonStatus: 'proposed' }] as SessionDetail['inbox'];
  const lesson = { id: 'lesson:c1', projectKey: 'demo', title: 'T', rule: 'R', appliesWhen: 'w', scope: 'project', paths: [], status: 'proposed', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: null };
  const noCandidates = await get(deps({ sessions: { detail: async () => ({ ...session, inbox }), turnEvidence: async () => [] }, lessonDetail: async () => ({ lesson, miss: null }) as never }));
  expect(noCandidates.body.inbox[0]).toMatchObject({ decidedBy: null, origins: null, postmortem: null, lesson: { id: 'lesson:c1', checks: null } });
  const noOrigins = await get(deps({
    sessions: { detail: async () => ({ ...session, inbox }), turnEvidence: async () => [] },
    candidateDetail: async (id) => ({ candidate: { id, decidedBy: 'you', decidedAt: 't', note: null }, turn: {}, before: [], after: [], commits: [] }) as never,
  }));
  expect(noOrigins.body.inbox[0]).toMatchObject({ decidedBy: 'you', origins: null, lesson: null });
});

test('more classified turns than one answer lists: the counts cover them all and the answer says how many it left out', async () => {
  const turns = Array.from({ length: 2003 }, (_, i) => turn(i + 1, { label: 'neutral', confidence: 0.5 }));
  const { body } = await get(deps({ sessions: { detail: async () => session, turnEvidence: async () => turns } }));
  expect(body.turns.classified).toBe(2003);
  expect(body.flags).toHaveLength(2000);
  expect(body.flagsLeftOut).toBe(3);
});
