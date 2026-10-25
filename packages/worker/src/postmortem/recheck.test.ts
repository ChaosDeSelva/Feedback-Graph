import { LESSON_CHECKS_VERSION, type ActivityInput, type Lesson, type LessonCheck, type LessonDetail, type SimilarLesson } from '@fb/core';
import { expect, test } from 'vitest';
import { duplicateFlag, recheckLessons } from './recheck.ts';

const lesson = (id: string, rule: string, extra: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'shop', title: 'T', rule, appliesWhen: '', scope: 'project', paths: ['src/orders.ts'], status: 'proposed', source: 'postmortem',
  cause: 'context_missing', missId: null, createdAt: '2026-10-24T00:00:00Z', decidedAt: null, checks: null, checksVersion: null, from: 'session', ...extra,
});

type Miss = { missed: string; causeExplanation: string };

function fake(lessons: Lesson[], o: { feedback?: Record<string, string>; miss?: Record<string, Miss>; near?: Record<string, SimilarLesson[]> } = {}) {
  const saved = new Map<string, { checks: LessonCheck[]; version?: number }>();
  const k = {
    listLessons: async () => lessons,
    staleLessonChecks: async (version: number) => lessons.filter((l) => (l.status === 'proposed' || l.status === 'approved') && (l.checksVersion ?? 0) < version),
    lessonDetail: async (id: string) => ({
      lesson: lessons.find((l) => l.id === id)!,
      miss: o.miss?.[id] ? { id: `miss:${id}`, cause: 'context_missing', ...o.miss[id] } : null,
      feedback: o.feedback?.[id] ? { id, text: o.feedback[id], status: 'open', sessionId: 's', ts: 't' } : null,
      contextItems: [], fixCommits: [], supersedes: [],
    }) as LessonDetail,
    setLessonChecks: async (id: string, checks: LessonCheck[], version?: number) => { saved.set(id, { checks, version }); return true; },
    similarLessons: async (id: string) => o.near?.[id] ?? [],
  };
  return { k, saved };
}

const names = (s: { checks: LessonCheck[] } | undefined) => s?.checks.map((c) => c.name);

test('lessons whose checks are older than the current version are re-checked, stamped, and the change is logged', async () => {
  const f = fake(
    [
      lesson('lesson:a', 'Verify that feedback is relevant to the current task', { paths: ['src/webapp/AGENTS.md'] }),
      lesson('lesson:b', 'Lock the order row in orders/claim.sql before the status insert'),
      lesson('lesson:c', 'Always verify state.', { checks: [], checksVersion: LESSON_CHECKS_VERSION }),
      lesson('lesson:d', 'Always verify state.', { status: 'rejected' }),
      lesson('lesson:e', 'Lock the order row in orders/claim.sql', { status: 'approved', checks: [{ name: 'platitude', why: 'old rule' }], checksVersion: 1 }),
    ],
    { feedback: { 'lesson:a': 'this is wrong', 'lesson:b': 'the insert races the status check' } },
  );
  const activity: ActivityInput[] = [];
  const r = await recheckLessons({ k: f.k, activity: { record: async (a) => void activity.push(a) } });
  expect(r).toEqual({ checked: 3, flagged: 1, changed: 2 });
  expect(names(f.saved.get('lesson:a'))).toEqual(['bad-path', 'needs-path', 'meta-lesson']);
  expect(f.saved.get('lesson:b')).toEqual({ checks: [], version: LESSON_CHECKS_VERSION });
  // An approved lesson is re-checked too: the stale platitude is gone.
  expect(f.saved.get('lesson:e')).toEqual({ checks: [], version: LESSON_CHECKS_VERSION });
  expect([...f.saved.keys()].sort()).toEqual(['lesson:a', 'lesson:b', 'lesson:e']);
  expect(activity).toEqual([expect.objectContaining({
    kind: 'lessons_checked', actor: 'lesson-check', subject: `3 lessons re-checked (checks v${LESSON_CHECKS_VERSION}): 1 flagged, 2 changed`,
    details: expect.objectContaining({
      checked: 3, flagged: 1, changed: 2, version: LESSON_CHECKS_VERSION,
      flags: { 'bad-path': 1, 'needs-path': 1, 'meta-lesson': 1 },
      added: { 'bad-path': 1, 'needs-path': 1, 'meta-lesson': 1 }, removed: { platitude: 1 },
    }),
  })]);
});

test('the stored miss saying the session did other work flags a comment lesson wrong-session; a session lesson is not', async () => {
  const miss = { missed: 'the agent did not add the index', causeExplanation: 'The feedback pertains to a different PR than the one the session worked on.' };
  const f = fake(
    [lesson('lesson:gh', 'Add the index in db/schema.sql', { from: 'github' }), lesson('lesson:s', 'Add the index in db/schema.sql', { from: 'session' })],
    { miss: { 'lesson:gh': miss, 'lesson:s': miss } },
  );
  await recheckLessons({ k: f.k });
  expect(names(f.saved.get('lesson:gh'))).toEqual(['wrong-session']);
  expect(names(f.saved.get('lesson:s'))).toEqual([]);
});

test('cited paths are checked against the mounted repo: a missing one is flagged path-missing; globs and unmounted repos are not', async () => {
  const f = fake([
    lesson('lesson:a', 'Lock the row in src/orders.ts', { paths: ['src/orders.ts', 'src/gone.ts', 'src/**/*.sql'] }),
    lesson('lesson:b', 'Lock the row in src/orders.ts', { projectKey: 'elsewhere', paths: ['src/gone.ts'] }),
  ]);
  const present = new Set(['/repos/shop/src/orders.ts']);
  await recheckLessons({
    k: f.k,
    repoPaths: async () => new Map([['shop', '/repos/shop']]),
    exists: async (repo, p) => present.has(`${repo}/${p}`),
  });
  expect(f.saved.get('lesson:a')?.checks).toEqual([{ name: 'path-missing', why: 'not in the repository: src/gone.ts' }]);
  expect(names(f.saved.get('lesson:b'))).toEqual([]);
});

test('flags a re-check cannot work out again (made from the comment metadata or the model) are kept', async () => {
  const kept: LessonCheck[] = [
    { name: 'wrong-session', why: 'the matched session x did other work; redone from the comment alone' },
    { name: 'self-review', why: 'an agent reviewing its own pull request' },
    { name: 'looks-like-a-fact', why: 'the post-mortem model said it states how the code is rather than what to do: it may belong in the project facts' },
  ];
  const f = fake([lesson('lesson:a', 'Lock the order row in orders/claim.sql', { checks: [...kept, { name: 'universal-from-nit', why: 'from an APPROVED review' }], checksVersion: 1 })]);
  await recheckLessons({ k: f.k });
  expect(f.saved.get('lesson:a')?.checks).toEqual(kept);
});

test('a near-identical lesson in the same project flags the newer (or the unapproved) one duplicate-of the other', async () => {
  const f = fake(
    [
      lesson('lesson:old', 'Lock the order row in orders/claim.sql', { createdAt: '2026-10-01T00:00:00Z' }),
      lesson('lesson:new', 'Lock the order row in orders/claim.sql first', { createdAt: '2026-10-02T00:00:00Z' }),
    ],
    {
      near: {
        'lesson:old': [{ id: 'lesson:new', cosine: 0.95, status: 'proposed', createdAt: '2026-10-02T00:00:00Z' }],
        'lesson:new': [{ id: 'lesson:old', cosine: 0.95, status: 'proposed', createdAt: '2026-10-01T00:00:00Z' }],
      },
    },
  );
  await recheckLessons({ k: f.k });
  expect(f.saved.get('lesson:new')?.checks).toEqual([{ name: 'duplicate-of', of: 'lesson:old', why: 'repeats lesson:old (cosine 0.95): merge them or reject one' }]);
  expect(names(f.saved.get('lesson:old'))).toEqual([]);
});

test('duplicateFlag: an approved neighbour wins, rejected ones and those under the threshold do not count', () => {
  const me = { id: 'lesson:b', status: 'approved' as const, createdAt: '2026-10-02T00:00:00Z' };
  const near = (over: Partial<SimilarLesson>): SimilarLesson => ({ id: 'lesson:a', cosine: 0.97, status: 'proposed', createdAt: '2026-10-01T00:00:00Z', ...over });
  // I am approved and it is only proposed: it is the duplicate, not me.
  expect(duplicateFlag(me, [near({})])).toBeNull();
  expect(duplicateFlag({ ...me, status: 'proposed' }, [near({ status: 'approved', createdAt: '2026-10-03T00:00:00Z' })])?.of).toBe('lesson:a');
  expect(duplicateFlag({ ...me, status: 'proposed' }, [near({ status: 'rejected' })])).toBeNull();
  expect(duplicateFlag({ ...me, status: 'proposed' }, [near({ cosine: 0.9 })])).toBeNull();
});

test('nothing to check: no activity', async () => {
  const f = fake([lesson('lesson:c', 'x', { checks: [], checksVersion: LESSON_CHECKS_VERSION })]);
  const activity: ActivityInput[] = [];
  expect(await recheckLessons({ k: f.k, activity: { record: async (a) => void activity.push(a) } })).toEqual({ checked: 0, flagged: 0, changed: 0 });
  expect(activity).toEqual([]);
});
