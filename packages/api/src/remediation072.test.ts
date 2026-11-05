import { expect, test } from 'vitest';
import type { Activity, ActivityInput, Lesson } from '@fb/core';
import { createApp, type ApiRepo } from './app.ts';
import { taskPrNumbers } from './diff.ts';
import { planCleanup } from './runs.ts';
import { checkBeforeDone, type ContextDeps } from './context.ts';
import { Admission } from './admission.ts';
import { Hono } from 'hono';
import { cloudRoutes } from './cloud.ts';
import { buildChatContext } from './chat.ts';

const OWNER = 'z'.repeat(48);
const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;

test('series counters in common stack notation are not PR identities', () => {
  expect(taskPrNumbers('review (PR 1/2) and (PR 2 of 3)')).toEqual([]);
  expect(taskPrNumbers('review PR 17 of 30 selected PRs; #42')).toEqual([42]);
  expect(taskPrNumbers('(PR #1 of 2), Stack: PR 1 of 2, see #14036')).toEqual([14036]);
  expect(taskPrNumbers('PR 1/2 [PR 2/3] (#3 of 4)')).toEqual([]);
});

test('scoped map deletion requires owner authorization and never deletes the project', async () => {
  const dropped: string[] = [];
  const app = createApp(repo, { auth: { ownerToken: OWNER }, codegraph: {
    hotspots: async () => [], moduleContext: async () => null, impact: async () => ({}) as never, codeMapMeta: async () => null,
    dropCodeMap: async key => { dropped.push(key); return true; },
  } });
  expect((await app.request('/api/projects/demo/codemap', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  const result = await app.request('/api/projects/demo/codemap', { method: 'DELETE', headers: { authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true', 'content-type': 'application/json' }, body: '{}' });
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ key: 'demo', removed: true });
  expect(dropped).toEqual(['demo']);
});

test('cleanup previews removal of decisions and uploads that belong entirely to removed run records', async () => {
  const entries = ['feedback_decided', 'doc_added'].map((kind, i) => ({ id: `a${i}`, kind, actor: 'agent', projectKey: 'demo', ts: 't', subject: 's', why: 'w', details: { via: 'api' }, targets: [i ? 'doc:d' : 'f'], run: 'r' })) as Activity[];
  const result = await planCleanup('r', { store: { items: async () => [{ kind: 'feedback', id: 'f', projectKey: 'demo', sandbox: true, merged: false, group: null }, { kind: 'doc', id: 'doc:d', projectKey: 'demo', sandbox: true, merged: false, group: null }], remove: async () => ({}) as never, owner: async () => ({ run: 'r', principal: 'agent', actor: null, firstSeen: 't' }) }, activity: { record: async () => {}, list: async query => query.target ? [] : entries } });
  expect(result.plan.entries).toBe(2);
});

const literal: Lesson = { id: 'l', projectKey: 'demo', title: 'No console', rule: 'Do not call console.log in src/a.ts.', appliesWhen: 'editing code', paths: ['src/a.ts'], scope: 'project', status: 'approved', source: 'manual', cause: null, missId: null, createdAt: 't', decidedAt: 't' };
function context(over: Partial<ContextDeps> = {}): ContextDeps { return { roots: [{ host: '/projects', container: '/projects' }], exists: () => true,
  embed: async () => [[1]], k: { searchLessons: async () => [{ lesson: literal, score: .9 }], relatedMisses: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'f' },
  judge: async () => { throw new Error('a literal violation must not ask a model'); }, ...over }; }

test('a literal violation bypasses an occupied model queue and reports direct provenance', async () => {
  const queue = new Admission({ concurrency: 1, timeoutMs: 5000 });
  let release!: () => void; const held = queue.run(() => new Promise<void>(resolve => { release = resolve; }));
  const result = await checkBeforeDone({ project: 'demo', task: 'edit src/a.ts', summary: 'added logging', filesChanged: ['src/a.ts'], diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+console.log(42);\n' }, context({ judgeQueue: queue, judgeId: 'model:test' }));
  release(); await held;
  expect(result.gaps.map(gap => gap.lessonId)).toEqual(['l']);
  expect(result.markdown).toContain('Checked directly');
  expect(result.markdown).not.toContain('Judged by model:test');
});

test('a context deadline stores both the queued record and its Activity entry', async () => {
  const activity: ActivityInput[] = []; let records = 0;
  const d = context({ checkTimeoutMs: 40, embed: async () => new Promise(() => {}), activity: { record: async value => { activity.push(value); } } });
  d.k.recordPreDoneCheck = async () => { records++; };
  const result = await checkBeforeDone({ project: 'demo', task: 'edit src/a.ts', summary: 'done' }, d);
  expect(result.queued).toBe(true); expect(records).toBe(1);
  expect(activity).toContainEqual(expect.objectContaining({ kind: 'predone_check', details: expect.objectContaining({ status: 'queued' }) }));
});

test('Ask only sends mapped paths to context Activity, never fake prompt paths', async () => {
  const activity: ActivityInput[] = [];
  const d = context({ activity: { record: async entry => { activity.push(entry); } } });
  const map = { fingerprint: 'h', builtAt: 't', candidates: 1, stats: { files: 1, symbols: 0, imports: 0, tests: 0 }, files: [{ path: 'src/a.ts', lang: 'ts', hash: 'h', loc: 1, isTest: false }], symbols: [], imports: [], outside: [] };
  await buildChatContext('demo', 'explain src/a.ts and invented/nope.ts', [], { context: d, codeMap: async () => map });
  expect(activity.find(entry => entry.kind === 'context_served')?.details?.files).toEqual(['src/a.ts']);
});

test('cloud status explains team approval before any project is selected and caches that policy', async () => {
  let calls = 0; const app = new Hono();
  const team = { adminApprovalRequired: true, approved: 0, suggested: 5, blocked: true, message: 'An admin must approve Suggested lessons before the team can use them.' };
  cloudRoutes(app, { cloud: { url: 'https://cloud.example.com', token: 'token', intervalMinutes: 60, projects: [], suggestions: false, machine: null },
    projects: async () => [], portability: { exportData: async () => { throw new Error('must not export an unselected project'); } },
    activity: { record: async () => {}, list: async () => [] }, worker: async () => null,
    fetch: (async () => { calls++; return Response.json({ teamLessons: team }); }) as typeof fetch,
  });
  const first = await (await app.request('/api/cloud?project=demo')).json();
  expect(first.teamLessons).toEqual(team); expect(first.preview.projects[0].reason).toContain('not selected');
  await app.request('/api/cloud?project=demo'); expect(calls).toBe(1);
});
