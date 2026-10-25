import type { Lesson } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const lesson: Lesson = {
  id: 'lesson:a', projectKey: 'demo', title: 'T', rule: 'R', appliesWhen: 'W', scope: 'project', paths: [],
  status: 'proposed', source: 'postmortem', cause: 'verification_gap', missId: 'miss:a', createdAt: 't', decidedAt: null,
};

function setup() {
  const calls: unknown[][] = [];
  const knowledge = {
    listLessons: async (f: object) => { calls.push(['list', f]); return [lesson]; },
    lessonDetail: async (id: string) => (id === lesson.id ? { lesson, miss: null, feedback: null, contextItems: [], fixCommits: [], supersedes: [] } : null),
    updateLesson: async (...a: unknown[]) => { calls.push(['update', ...a]); return { unscoped: false }; },
  };
  const embedded: string[][] = [];
  const app = createApp(repo, { knowledge, embed: async (t) => { embedded.push(t); return t.map(() => [0.5]); } });
  return { app, calls, embedded };
}

const patch = (body: object) => ({ method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(body) });

test('GET /api/lessons filters by status and project', async () => {
  const { app, calls } = setup();
  const res = await app.request('/api/lessons?status=proposed&project=demo');
  expect(await res.json()).toEqual([lesson]);
  expect(calls[0]).toEqual(['list', { status: 'proposed', projectKey: 'demo' }]);
});

test('GET /api/lessons/:id is 404 for unknown ids', async () => {
  const { app } = setup();
  expect((await app.request('/api/lessons/lesson%3Aa')).status).toBe(200);
  expect((await app.request('/api/lessons/nope')).status).toBe(404);
});

test('PATCH approving without text changes does not re-embed', async () => {
  const { app, calls, embedded } = setup();
  const res = await app.request('/api/lessons/lesson%3Aa', patch({ status: 'approved' }));
  expect(res.status).toBe(204);
  expect(embedded).toEqual([]);
  expect(calls).toContainEqual(['update', 'lesson:a', { status: 'approved' }, { reembed: undefined, by: 'you' }]);
});

test('PATCH editing the rule re-embeds the lesson text', async () => {
  const { app, calls, embedded } = setup();
  await app.request('/api/lessons/lesson%3Aa', patch({ rule: 'New rule', scope: 'global' }));
  expect(embedded).toEqual([['T\nNew rule\nApplies when: W']]);
  expect(calls).toContainEqual(['update', 'lesson:a', { rule: 'New rule', scope: 'global' }, { reembed: [0.5], by: 'you' }]);
});

test('PATCH rejects unknown fields and bad statuses', async () => {
  const { app } = setup();
  expect((await app.request('/api/lessons/lesson%3Aa', patch({ status: 'superseded' }))).status).toBe(400);
  expect((await app.request('/api/lessons/lesson%3Aa', patch({ embedding: [1] }))).status).toBe(400);
});
