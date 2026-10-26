import { expect, test } from 'vitest';
import { lessonsFor } from './codegraph.ts';
import { GLOBAL_CLOSE, rankLessons, sharesTopic } from './lessonRank.ts';
import { SIMILARITY_FLOOR } from './relevance.ts';
import type { Lesson } from './types.ts';

const lesson = (id: string, over: Partial<Lesson>): Lesson => ({
  id, projectKey: 'acme', origin: 'acme', title: id, rule: '', appliesWhen: '', scope: 'project', paths: [], status: 'approved',
  source: 'postmortem', cause: 'requirement_unstated', missId: null, createdAt: 't', decidedAt: 't', ...over,
});

// A global lesson learned in acme, about acme's retention job: nothing to do with a list's pagination.
const retention = lesson('g-retention', {
  projectKey: null, scope: 'global',
  title: 'Purge audit records only through the retention job',
  rule: 'Expired audit rows are removed by app/jobs/retention.ts on its schedule; never delete them by hand or in a migration.',
  appliesWhen: 'changing how long data is kept, purging or archiving records',
  paths: ['app/jobs/retention.ts', 'app/models/audit_log.rb'],
});
// A global lesson that is about pagination, worded differently from the task.
const cursor = lesson('g-cursor', {
  projectKey: null, scope: 'global',
  title: 'Paginate with a cursor, never OFFSET',
  rule: 'Every endpoint returning many rows takes an after=<id> cursor and a limit; OFFSET scans get slower page by page.',
  appliesWhen: 'adding an endpoint that returns many rows',
});
// A global lesson whose words share nothing with the task but whose meaning is very close.
const secrets = lesson('g-secrets', {
  projectKey: null, scope: 'global', title: 'Never write credentials to logs', rule: 'Redact tokens before logging a request.',
  appliesWhen: 'adding logging',
});
// A lesson of the project itself: ranked by similarity alone, as before.
const own = lesson('l-own', { projectKey: 'demo-shop', origin: 'demo-shop', title: 'Members are scoped by organisation', rule: 'Filter by org_id.' });

const TASK = 'add pagination to the members list';

test('a global lesson with nothing in common with the task is left out, however the embedding scored it', () => {
  // The reported case: 0.77 for an unrelated task.
  expect(rankLessons([{ lesson: retention, score: 0.77 }], TASK)).toEqual([]);
  expect(sharesTopic(TASK, retention)).toBe(false);
});

test('a global lesson on the task\'s topic stays, a word form apart (pagination, paginate)', () => {
  expect(sharesTopic(TASK, cursor)).toBe(true);
  expect(rankLessons([{ lesson: cursor, score: 0.74 }], TASK).map((h) => h.lesson.id)).toEqual(['g-cursor']);
  // Words of the lesson's paths count too.
  expect(sharesTopic('change how often the retention job runs', retention)).toBe(true);
  // A shared generic word ("list", "data") or a stopword ("add") is no topic.
  expect(sharesTopic('add a list of data', retention)).toBe(false);
});

test('a global lesson very close in meaning stays without a shared word', () => {
  expect(rankLessons([{ lesson: secrets, score: GLOBAL_CLOSE }], 'print the auth header while debugging').map((h) => h.lesson.id)).toEqual(['g-secrets']);
  expect(rankLessons([{ lesson: secrets, score: GLOBAL_CLOSE - 0.01 }], 'print the auth header while debugging')).toEqual([]);
});

test('the similarity floor applies to every lesson; a project\'s own lesson needs no shared word above it', () => {
  const hits = [
    { lesson: own, score: 0.72 },
    { lesson: retention, score: 0.77 },
    { lesson: cursor, score: 0.74 },
    { lesson: { ...own, id: 'l-far' }, score: SIMILARITY_FLOOR - 0.01 },
    { lesson: { ...cursor, id: 'g-far' }, score: SIMILARITY_FLOOR - 0.01 },
  ];
  // Order is kept: the search's.
  expect(rankLessons(hits, TASK).map((h) => h.lesson.id)).toEqual(['l-own', 'g-cursor']);
});

test('a task of stopwords and generic words gives no global lesson a topic', () => {
  expect(rankLessons([{ lesson: cursor, score: 0.8 }], 'fix the list')).toEqual([]);
});

test('a global lesson\'s project files match only in the project it was learned in; patterns and root files match anywhere', () => {
  const files = ['app/jobs/retention.ts', 'db/migrate/001_init.sql', 'Dockerfile'];
  // In another project the same-named file is not the one the lesson was about: no path match, so no boost.
  expect(lessonsFor([retention], files, [], 'demo-shop')).toEqual([]);
  expect(lessonsFor([retention], files, [], 'acme')).toEqual([{ lesson: retention, paths: ['app/jobs/retention.ts'] }]);
  const sql = { ...retention, id: 'g-sql', paths: ['**/*.sql', 'Dockerfile', 'app/jobs/retention.ts'] };
  expect(lessonsFor([sql], files, [], 'demo-shop')).toEqual([{ lesson: sql, paths: ['Dockerfile', 'db/migrate/001_init.sql'] }]);
  // No origin (imported, written by hand): its paths are nobody's in particular.
  const imported = { ...retention, id: 'g-imported', origin: null };
  expect(lessonsFor([imported], files, [], 'demo-shop')).toEqual([{ lesson: imported, paths: ['app/jobs/retention.ts'] }]);
  // Without a project (callers that do not say), as before.
  expect(lessonsFor([retention], files, [])).toEqual([{ lesson: retention, paths: ['app/jobs/retention.ts'] }]);
});
