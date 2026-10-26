import { shownProjects, type DecidedLessonsQuery, type Lesson } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const writer = { title: 'Verify', rule: 'Always verify', appliesWhen: 'always', scope: 'global' as const, paths: [] };
const lesson = (id: string, origin: string, status: Lesson['status'], days: number, edited = false): Lesson => ({
  id, projectKey: origin, origin, title: 'T', rule: 'R', appliesWhen: 'W', scope: 'project', paths: [], status, source: 'postmortem',
  cause: null, missId: null, createdAt: ago(days + 1), decidedAt: ago(days), ...(edited && { proposedAs: writer }),
});

function setup(o: { shown?: string[]; limit?: number } = {}) {
  const queries: DecidedLessonsQuery[] = [];
  const decided = [
    lesson('a', 'shop', 'approved', 1),
    lesson('b', 'shop', 'approved', 2, true),
    lesson('c', 'shop', 'rejected', 40),
    lesson('d', 'api', 'rejected', 3),
    lesson('e', 'hidden', 'approved', 3),
  ];
  const knowledge = {
    listLessons: async () => [], lessonDetail: async () => null, updateLesson: async () => ({ unscoped: false }),
    decidedLessons: async (q: DecidedLessonsQuery) => {
      queries.push(q);
      return decided.filter((l) => !q.projectKeys || q.projectKeys.includes(l.origin!)).slice(0, q.limit).map((lesson) => ({ lesson, score: null }));
    },
  };
  const shown = o.shown ?? ['shop', 'api'];
  const app = createApp(repo, { knowledge, shown: async () => shownProjects({ tracked: shown, initialized: true }, { excludeProjects: [] }) });
  return { app, queries };
}

test('GET /api/lessons/quality: of the decided lessons, approved as written / after an edit / rejected, in the last 30 and 90 days, per shown project', async () => {
  const { app, queries } = setup();
  const q = await (await app.request('/api/lessons/quality')).json();
  expect(q.windows).toEqual([
    { days: 30, asWritten: 1, edited: 1, rejected: 1, decided: 3, byOperator: 0 },
    { days: 90, asWritten: 1, edited: 1, rejected: 2, decided: 4, byOperator: 0 },
  ]);
  expect(q.projects.shop).toEqual([
    { days: 30, asWritten: 1, edited: 1, rejected: 0, decided: 2, byOperator: 0 },
    { days: 90, asWritten: 1, edited: 1, rejected: 1, decided: 3, byOperator: 0 },
  ]);
  expect(Object.keys(q.projects).sort()).toEqual(['api', 'shop']);
  expect(q.capped ?? false).toBe(false);
  // Only the shown projects are asked for, from 90 days back.
  expect(queries[0].projectKeys?.sort()).toEqual(['api', 'shop']);
  expect(Date.parse(queries[0].since)).toBeLessThan(Date.now() - 89 * 86_400_000);
});

test('GET /api/lessons/quality?project=: that project only; a hidden one counts nothing', async () => {
  const { app } = setup();
  const q = await (await app.request('/api/lessons/quality?project=api')).json();
  expect(q.windows[0]).toEqual({ days: 30, asWritten: 0, edited: 0, rejected: 1, decided: 1, byOperator: 0 });
  const hidden = await (await app.request('/api/lessons/quality?project=hidden')).json();
  expect(hidden.windows[1].decided).toBe(0);
});

test('GET /api/lessons/quality is 404 on a store that cannot tell', async () => {
  const app = createApp(repo, { knowledge: { listLessons: async () => [], lessonDetail: async () => null, updateLesson: async () => ({ unscoped: false }) } as never });
  expect((await app.request('/api/lessons/quality')).status).toBe(404);
});

test('GET /api/pipeline carries the same 30 and 90 day numbers under lessons.quality', async () => {
  const { app } = setup();
  const p = await (await app.request('/api/pipeline')).json();
  expect(p.lessons.quality).toEqual([
    { days: 30, asWritten: 1, edited: 1, rejected: 1, decided: 3, byOperator: 0 },
    { days: 90, asWritten: 1, edited: 1, rejected: 2, decided: 4, byOperator: 0 },
  ]);
  expect((await (await app.request('/api/pipeline?project=api')).json()).lessons.quality[1]).toEqual({ days: 90, asWritten: 0, edited: 0, rejected: 1, decided: 1, byOperator: 0 });
});
