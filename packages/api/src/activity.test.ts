import type { ActivityInput } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const cand = { id: 'c1', turnUuid: 'c1', sessionId: 's1', projectKey: 'shop', classification: { label: 'pushback', confidence: 0.9, summary: 's', signals: [] }, status: 'pending', createdAt: 't', decidedAt: null, note: null };
const repo = {
  listCandidates: async () => [], stats: async () => [], decide: async () => {},
  candidateDetail: async (id: string) => (id === 'c1' ? { candidate: cand, turn: { text: 'not good enough' }, before: [], after: [], commits: [] } : null),
} as unknown as ApiRepo;
const lesson = { id: 'lesson:1', projectKey: 'shop', title: 'Scope queries', rule: 'use scoped', appliesWhen: 'routes', scope: 'project', status: 'proposed' };

const entry = (projectKey: string) => ({ id: 'act:1', ts: 't', kind: 'scan_finished' as const, actor: 'm', projectKey, subject: 's', why: 'w', details: { log: 'long' }, targets: [] });

function setup() {
  const recorded: ActivityInput[] = [];
  const listed: object[] = [];
  const app = createApp(repo, {
    knowledge: {
      listLessons: async () => [],
      lessonDetail: async (id: string) => (id === lesson.id ? { lesson, miss: null, feedback: null, contextItems: [], fixCommits: [], supersedes: [] } : null),
      updateLesson: async () => ({ unscoped: false }),
    } as never,
    activity: {
      record: async (a) => { recorded.push(a); },
      list: async (q) => { listed.push(q); return []; },
      get: async (id) => (id === 'act:1' ? entry('shop') : id === 'act:hidden' ? entry('elsewhere') : null),
    },
    shown: () => ({ keys: ['shop'], has: (k: string) => k === 'shop' }) as never,
  });
  return { app, recorded, listed };
}
const json = (method: string, body: object) => ({ method, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'http://localhost' }, body: JSON.stringify(body) });

test('confirming a candidate logs your decision with the feedback text and your note', async () => {
  const { app, recorded } = setup();
  await app.request('/api/candidates/c1/decision', json('POST', { status: 'confirmed', note: 'missed tenant scoping' }));
  expect(recorded).toEqual([{
    kind: 'feedback_decided', actor: 'you', projectKey: 'shop', subject: 'confirmed: "not good enough"',
    why: 'missed tenant scoping', details: { status: 'confirmed', classifier: { label: 'pushback', confidence: 0.9 }, via: 'browser' }, targets: ['c1'],
  }]);
});

test('approving an edited lesson logs which fields you changed, before and after', async () => {
  const { app, recorded } = setup();
  await app.request('/api/lessons/lesson:1', json('PATCH', { status: 'approved', rule: 'always use db.scoped(orgId)' }));
  expect(recorded[0]).toMatchObject({
    kind: 'lesson_decided', actor: 'you', projectKey: 'shop', subject: 'approved lesson "Scope queries"', targets: ['lesson:1'],
    details: { status: 'approved', changed: { rule: { from: 'use scoped', to: 'always use db.scoped(orgId)' } } },
  });
});

test('saving edits without a status (Save on an approved lesson) keeps its status and logs an edit', async () => {
  const { app, recorded } = setup();
  const res = await app.request('/api/lessons/lesson:1', json('PATCH', { rule: 'always use db.scoped(orgId)' }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ sharing: { mode: 'next_sync_if_enabled' } });
  expect(recorded[0]).toMatchObject({
    kind: 'lesson_decided', actor: 'you', subject: 'edited lesson "Scope queries"', why: expect.stringContaining('you edited it'),
    details: { status: 'proposed', changed: { rule: { from: 'use scoped', to: 'always use db.scoped(orgId)' } } },
  });
});

test('GET /api/activity passes filters through', async () => {
  const { app, listed } = setup();
  expect((await app.request('/api/activity?project=shop&kind=facts_extracted&target=shop%3Asrc%2Fdb.ts&limit=20')).status).toBe(200);
  expect(listed[0]).toMatchObject({ projectKey: 'shop', kind: 'facts_extracted', target: 'shop:src/db.ts', limit: 20 });
  expect((await app.request('/api/activity?kind=bogus')).status).toBe(400);
});

test('GET /api/activity leaves big details out of its rows (details=1 keeps them); GET /api/activity/:id has them', async () => {
  const { app, listed } = setup();
  await app.request('/api/activity');
  expect(listed[0]).toMatchObject({ maxDetailBytes: 1024 });
  await app.request('/api/activity?details=1');
  expect(listed[1]).not.toHaveProperty('maxDetailBytes');
  const res = await app.request('/api/activity/act%3A1');
  expect(res.status).toBe(200);
  expect((await res.json()).details).toEqual({ log: 'long' });
  // An entry of a project that is not shown is not found, as an unknown one.
  expect((await app.request('/api/activity/act%3Ahidden')).status).toBe(404);
  expect((await app.request('/api/activity/act%3Anope')).status).toBe(404);
});
