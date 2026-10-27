import { expect, test } from 'vitest';
import { lessonsFor } from './codegraph.ts';
import { GLOBAL_CLOSE, gradeLessons, rankLessons, RELATED_K, sharesTopic } from './lessonRank.ts';
import { SIMILARITY_FLOOR } from './relevance.ts';
import { ACME_LESSONS, ACME_TASKS, PATH_TASK, searchAcme } from './testing/lessonCorpus.ts';
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

test('only a file tie can promote a lesson to a rule, even at a perfect semantic score', () => {
  const hits = [{ lesson: { ...own, paths: ['src/members.ts'] }, score: 1 }];
  expect(rankLessons(hits, TASK, { projectKey: 'demo-shop' })).toEqual([]);
  expect(rankLessons(hits, TASK, { projectKey: 'demo-shop', files: ['src/members.ts'] })).toEqual(hits);
  expect(rankLessons(hits, TASK, { projectKey: 'demo-shop', files: ['src/other.ts'] })).toEqual([]);
});

test('a file tie is followed below the semantic floor', () => {
  const hits = [{ lesson: { ...own, paths: ['src/members.ts'] }, score: 0.1 }];
  expect(rankLessons(hits, TASK, { projectKey: 'demo-shop', files: ['src/members.ts'] })).toEqual(hits);
});

test('global file rules stay in their origin project even when paths or globs coincide', () => {
  for (const paths of [['app/jobs/retention.ts'], ['**/*.ts']]) {
    const hits = [{ lesson: { ...retention, paths }, score: 1 }];
    expect(rankLessons(hits, 'retention', { projectKey: 'demo-shop', files: ['app/jobs/retention.ts'] })).toEqual([]);
    expect(rankLessons(hits, 'retention', { projectKey: 'acme', files: ['app/jobs/retention.ts'] })).toEqual(hits);
  }
});

test('a topical semantic match is a bounded pointer, never a rule', () => {
  const hits = Array.from({ length: 10 }, (_, i) => ({ lesson: { ...cursor, id: `cursor-${i}` }, score: 0.95 }));
  const result = gradeLessons(hits, TASK, { projectKey: 'acme' });
  expect(result.follow).toEqual([]);
  expect(result.related).toHaveLength(RELATED_K);
  expect(sharesTopic(TASK, cursor)).toBe(true);
});

test('nonsense tasks receive no lessons from the real corpus', () => {
  for (const { task } of ACME_TASKS.filter((t) => !t.applies.length)) {
    expect(gradeLessons(searchAcme(task), task, { projectKey: 'acme' })).toEqual({ follow: [], related: [] });
  }
});

test('an approved no-miss lesson stays available for review but is never served, even on a named file', () => {
  const l = { ...own, paths: ['src/orders.ts'], checks: [{ name: 'no-miss' as const, why: 'false disputed claim; review required' }] };
  expect(gradeLessons([{ lesson: l, score: 1 }], 'orders', { files: ['src/orders.ts'], projectKey: 'demo-shop' })).toEqual({ follow: [], related: [] });
  expect(l.status).toBe('approved');
});
