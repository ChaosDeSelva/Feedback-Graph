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

// ── A project's own lessons: the 0.6.2 report ("0 of 6 served lessons applied; a nonsense task still gets 4") ──

const ids = (hs: { lesson: Lesson }[]) => hs.map((h) => h.lesson.id);
const NONSENSE = ACME_TASKS.filter((t) => !t.applies.length);

test('the absolute floor filters nothing: a nonsense task scores every acme lesson above it (as nomic-embed-text does)', () => {
  for (const { task } of NONSENSE) expect(searchAcme(task).every((h) => h.score >= SIMILARITY_FLOOR)).toBe(true);
});

test('a nonsense task gets no lesson at all, neither to follow nor possibly related', () => {
  for (const { task } of NONSENSE) expect({ task, ...gradeLessons(searchAcme(task), task, { projectKey: 'acme' }) }).toEqual({ task, follow: [], related: [] });
});

test('an on-topic task gets the lessons that apply to follow, and only a few', () => {
  for (const { task, applies } of ACME_TASKS.filter((t) => t.applies.length)) {
    const { follow } = gradeLessons(searchAcme(task), task, { projectKey: 'acme' });
    expect({ task, follow: ids(follow).filter((id) => applies.includes(id)).sort() }).toEqual({ task, follow: [...applies].sort() });
    expect({ task, few: follow.length <= 3 }).toEqual({ task, few: true });
  }
});

test('a lesson tied to a named or changed file is always followed, however low it scored', () => {
  const hits = searchAcme(PATH_TASK.task);
  const tied = hits.find((h) => h.lesson.id === PATH_TASK.tied)!;
  const low = [...hits.filter((h) => h !== tied), { ...tied, score: SIMILARITY_FLOOR - 0.1 }];
  expect(ids(gradeLessons(low, PATH_TASK.task, { files: PATH_TASK.files, projectKey: 'acme' }).follow)).toContain(PATH_TASK.tied);
  expect(ids(rankLessons(low, PATH_TASK.task, { files: PATH_TASK.files, projectKey: 'acme' }))).toContain(PATH_TASK.tied);
  // Without the file it is not.
  expect(ids(rankLessons(low, PATH_TASK.task, { projectKey: 'acme' }))).not.toContain(PATH_TASK.tied);
});

test('a lesson that passes only weakly is possibly related, never one to follow', () => {
  // As nomic-embed-text scored ACME_LESSONS for this task: one lesson stands far out; the sessionization lesson shares a
  // word ("session") but scores with the crowd.
  const task = 'rotate the refresh token when a session is renewed';
  const by = new Map(ACME_LESSONS.map((l) => [l.id, l]));
  const top: [string, number][] = [['auth-refresh', 0.917], ['auth-jwt-clock', 0.586], ['pipe-late-events', 0.577], ['g-secrets-logs', 0.552], ['auth-session-cookie', 0.546], ['web-feature-flags', 0.545]];
  const rest = ACME_LESSONS.filter((l) => !top.some(([id]) => id === l.id)).map((lesson, i) => ({ lesson, score: 0.53 - i * 0.006 }));
  const { follow, related } = gradeLessons([...top.map(([id, score]) => ({ lesson: by.get(id)!, score })), ...rest], task, { projectKey: 'acme' });
  expect(ids(follow)).toEqual(['auth-refresh']);
  expect(ids(related)).toContain('pipe-late-events');
  // Sharing no word and standing out not at all: not served.
  expect(ids(related)).not.toContain('web-feature-flags');
  expect(related.length).toBeLessThanOrEqual(RELATED_K);
});

test('on nomic-embed-text\'s scores a flat search gets nothing, and a lesson standing far out is followed without a shared word', () => {
  // The shape nomic-embed-text gave over ACME_LESSONS: "make the purple elephant sing opera on tuesdays" (nothing stands
  // out: best z 1.9), and "add Google as an OAuth login provider" (its lesson at 0.655, z 3.6).
  const flat = [0.429, 0.419, 0.412, 0.404, 0.396, 0.395, 0.39, 0.385, 0.38, 0.378, 0.377, 0.376, 0.37, 0.365, 0.36, 0.355, 0.35, 0.345, 0.34, 0.335];
  const nonsense = flat.map((score, i) => ({ lesson: ACME_LESSONS[i], score }));
  expect(gradeLessons(nonsense, 'make the purple elephant sing opera on tuesdays', { projectKey: 'acme' })).toEqual({ follow: [], related: [] });
  const out = [0.655, 0.559, 0.548, 0.505, 0.495, 0.48, 0.47, 0.465, 0.46, 0.455, 0.45, 0.447, 0.44, 0.435, 0.43, 0.425, 0.42, 0.41, 0.4, 0.39];
  const others = ACME_LESSONS.filter((l) => l.id.startsWith('pipe') || l.id.startsWith('web'));
  const standOut = { ...ACME_LESSONS[0], id: 'stand-out', title: 'Check the callback', rule: 'Compare before calling.', appliesWhen: 'n/a', paths: [] };
  const hits = out.map((score, i) => ({ lesson: i === 0 ? standOut : { ...others[i % others.length], id: `o${i}` }, score }));
  expect(ids(gradeLessons(hits, 'add Google as an OAuth login provider', { projectKey: 'acme' }).follow)).toEqual(['stand-out']);
});

// ── Small projects: a few approved lessons (the 0.6.3 review) ──

// A lesson that is about the task in other words: no topic word shared with TASK_OAUTH.
const TASK_OAUTH = 'add Google as an OAuth login provider';
const reworded = lesson('reworded', { title: 'Check the callback', rule: 'Compare before calling.', appliesWhen: 'n/a' });
const crowd = (n: number, at: (i: number) => number) => ACME_LESSONS.filter((l) => l.id.startsWith('pipe') || l.id.startsWith('web'))
  .slice(0, n).map((l, i) => ({ lesson: l, score: at(i) }));

test('8 or 9 lessons: one standing far out from the rest is followed without a shared word (z can reach the bar)', () => {
  for (const n of [7, 8]) {
    // One at 0.80 and the rest at 0.50 (with nomic-like jitter): population z over n+1 hits topped out at sqrt(n). At
    // 0.66, under PROJECT_CLOSE, only how far it stands out from the rest can serve it.
    for (const top of [0.8, 0.66]) {
      for (const rest of [() => 0.5, (i: number) => 0.45 + (i % 4) * 0.03]) {
        const hits = [{ lesson: reworded, score: top }, ...crowd(n, rest)];
        expect({ n: hits.length, top, follow: ids(gradeLessons(hits, TASK_OAUTH, { projectKey: 'acme' }).follow) }).toEqual({ n: hits.length, top, follow: ['reworded'] });
      }
    }
  }
});

test('a project with 3 to 7 approved lessons still gets an on-topic lesson worded differently, at a score no unrelated task reaches', () => {
  for (const n of [2, 4, 6]) {
    const hits = [{ lesson: reworded, score: 0.74 }, ...crowd(n, (i) => 0.42 + i * 0.03)];
    expect(ids(gradeLessons(hits, TASK_OAUTH, { projectKey: 'acme' }).follow)).toEqual(['reworded']);
  }
  // Under that cut, and with nothing shared, it is not served.
  expect(gradeLessons([{ lesson: reworded, score: 0.62 }, ...crowd(4, () => 0.5)], TASK_OAUTH, { projectKey: 'acme' })).toEqual({ follow: [], related: [] });
  // A global lesson is not served on that cut: only GLOBAL_CLOSE or its topic.
  const global = { ...reworded, id: 'g-reworded', projectKey: null, scope: 'global' as const };
  expect(gradeLessons([{ lesson: global, score: 0.74 }, ...crowd(4, () => 0.5)], TASK_OAUTH, { projectKey: 'acme' }).follow).toEqual([]);
  // Nor is another project's lesson, should a caller pass one in: the project's own allowances are for its own lessons.
  const foreign = { ...reworded, id: 'web-reworded', projectKey: 'web' };
  expect(gradeLessons([{ lesson: foreign, score: 0.74 }, ...crowd(4, () => 0.5)], TASK_OAUTH, { projectKey: 'acme' })).toEqual({ follow: [], related: [] });
});

test('a nonsense task gets nothing from a small project: the acme corpus cut to 3..15 lessons, and nomic-like scores', () => {
  const project = ACME_LESSONS.filter((l) => l.projectKey);
  for (const { task } of NONSENSE) {
    const scored = searchAcme(task);
    for (let n = 3; n <= 15; n++) {
      for (let start = 0; start + n <= project.length; start += 5) {
        const pool = project.slice(start, start + n).map((l) => scored.find((h) => h.lesson.id === l.id)!).sort((a, b) => b.score - a.score);
        expect({ task, n, start, ...gradeLessons(pool, task, { projectKey: 'acme' }) }).toEqual({ task, n, start, follow: [], related: [] });
      }
    }
  }
  // nomic-embed-text's range for an unrelated task (0.35 to 0.6), a 5-lesson project and an 8-lesson one.
  const five = [0.6, 0.52, 0.47, 0.41, 0.35].map((score, i) => ({ lesson: ACME_LESSONS[i], score }));
  expect(gradeLessons(five, 'make the purple elephant sing opera on tuesdays', { projectKey: 'acme' })).toEqual({ follow: [], related: [] });
  const eight = [0.6, 0.55, 0.52, 0.5, 0.47, 0.44, 0.4, 0.35].map((score, i) => ({ lesson: ACME_LESSONS[i], score }));
  expect(gradeLessons(eight, 'make the purple elephant sing opera on tuesdays', { projectKey: 'acme' })).toEqual({ follow: [], related: [] });
});

test('a small project\'s on-topic task still gets the lessons that apply; a lesson tied to a named file always', () => {
  const project = ACME_LESSONS.filter((l) => l.projectKey);
  for (const { task, applies } of ACME_TASKS.filter((t) => t.applies.length)) {
    // The applying lessons plus a handful of others: a 5- to 8-lesson project.
    const others = project.filter((l) => !applies.includes(l.id)).slice(0, 5);
    const pool = searchAcme(task).filter((h) => applies.includes(h.lesson.id) || others.includes(h.lesson));
    const { follow } = gradeLessons(pool, task, { projectKey: 'acme' });
    expect({ task, follow: ids(follow).filter((id) => applies.includes(id)).sort() }).toEqual({ task, follow: [...applies].sort() });
  }
  const tied = searchAcme(PATH_TASK.task).filter((h) => h.lesson.id === PATH_TASK.tied).map((h) => ({ ...h, score: SIMILARITY_FLOOR - 0.1 }));
  expect(ids(gradeLessons([...tied, ...crowd(3, () => 0.5)], PATH_TASK.task, { files: PATH_TASK.files, projectKey: 'acme' }).follow)).toEqual([PATH_TASK.tied]);
});
