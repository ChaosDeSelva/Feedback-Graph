import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LESSON_CHECKS_VERSION, type ActivityInput, type Lesson, type LessonCheck, type LessonDetail, type SimilarLesson } from '@fb/core';
import { expect, test } from 'vitest';
import { duplicateFlag, recheckLessons } from './recheck.ts';

test('a stored miss blaming an AGENTS.md the session had is flagged contradicts-evidence; one the evidence does not contradict is not', async () => {
  const web = mkdtempSync(join(tmpdir(), 'fbre-'));
  writeFileSync(join(web, 'CLAUDE.md'), 'Shared rules:\n@AGENTS.md\n');
  writeFileSync(join(web, 'AGENTS.md'), 'Use pnpm.');
  const claim = { missed: 'ran npm', causeExplanation: 'Claude Code does not load AGENTS.md, so the pnpm rule was never seen.' };
  const one = (id: string, projectKey: string) => lesson(id, 'Run pnpm in package.json scripts', { projectKey, paths: [], scope: 'global' });
  const ids = ['lesson:attached', 'lesson:imported', 'lesson:true'];
  const f = fake([one(ids[0], 'shop'), one(ids[1], 'web'), one(ids[2], 'api')], { miss: Object.fromEntries(ids.map((id) => [id, claim])) });
  // Each lesson's feedback is in its own session; only the first session's transcript recorded AGENTS.md.
  const k = { ...f.k, lessonDetail: async (id: string) => ({ ...(await f.k.lessonDetail(id)), feedback: { id, text: 'use pnpm', status: 'open', sessionId: `session-${id}`, ts: 't' } }) as LessonDetail };
  const recorded: Record<string, string[]> = { 'session-lesson:attached': ['/Users/you/Vibe/shop/AGENTS.md'], 'session-lesson:true': [] };
  const activity: ActivityInput[] = [];
  await recheckLessons({
    k, activity: { record: async (a) => void activity.push(a) },
    instructionFiles: async (id) => recorded[id] ?? null,
    repoPaths: async () => new Map([['web', web]]),
    exists: async () => true,
  });
  expect(f.saved.get('lesson:attached')?.checks).toEqual([{ name: 'contradicts-evidence', why: "the miss says AGENTS.md was not loaded, but the session's transcript shows it (/Users/you/Vibe/shop/AGENTS.md): its cause is likely wrong" }]);
  expect(f.saved.get('lesson:imported')?.checks).toEqual([{ name: 'contradicts-evidence', why: "the miss says AGENTS.md was not loaded, but the project's CLAUDE.md imports it (@AGENTS.md), so Claude Code loads it: its cause is likely wrong" }]);
  expect(f.saved.get('lesson:true')?.checks).toEqual([]);
  expect(activity[0].details).toMatchObject({ added: { 'contradicts-evidence': 2 } });
});

test('a lesson whose post-mortem cited Linear tickets of another project is flagged unlinked-ticket; its own tickets are not', async () => {
  const cited = (refs: string[]) => refs.map((ref) => ({ kind: 'ticket' as const, ref, excerpt: '', why: 'w', wasAvailable: false }));
  const f = fake([lesson('lesson:leak', 'Lock the order row in orders/claim.sql'), lesson('lesson:own', 'Lock the order row in orders/claim.sql'), lesson('lesson:web', 'Lock the order row in orders/claim.sql', { projectKey: 'web' })]);
  const items: Record<string, ReturnType<typeof cited>> = { 'lesson:leak': cited(['linear:OPS-5', 'OPS-11', 'linear:SHOP-1']), 'lesson:own': cited(['linear:SHOP-1', 'OPS-9']), 'lesson:web': cited(['linear:SHOP-1']) };
  const k = { ...f.k, lessonDetail: async (id: string) => ({ ...(await f.k.lessonDetail(id)), contextItems: items[id] }) as LessonDetail };
  // shop: its own tickets (SHOP-*) and OPS-9, which one of its pull requests names; web has none.
  const linked: Record<string, string[]> = { shop: ['SHOP-1', 'OPS-9'], web: [] };
  await recheckLessons({ k, linkedTickets: async (key, ids) => ids.filter((id) => linked[key]?.includes(id)), exists: async () => true });
  expect(f.saved.get('lesson:leak')?.checks).toEqual([{ name: 'unlinked-ticket', why: 'its post-mortem cited Linear tickets not linked to shop (OPS-5, OPS-11): what it took from them is likely another project\'s' }]);
  expect(f.saved.get('lesson:own')?.checks).toEqual([]);
  expect(f.saved.get('lesson:web')?.checks).toEqual([{ name: 'unlinked-ticket', why: 'its post-mortem cited Linear tickets not linked to web (SHOP-1): what it took from them is likely another project\'s' }]);
});

test('a failed ticket lookup leaves the lesson unchecked, to be checked again, rather than calling its tickets linked', async () => {
  const f = fake([lesson('lesson:leak', 'Lock the order row in orders/claim.sql')]);
  const k = { ...f.k, lessonDetail: async (id: string) => ({ ...(await f.k.lessonDetail(id)), contextItems: [{ kind: 'ticket' as const, ref: 'linear:OPS-5', excerpt: '', why: 'w', wasAvailable: false }] }) as LessonDetail };
  await expect(recheckLessons({ k, linkedTickets: async () => { throw new Error('graph down'); }, exists: async () => true })).rejects.toThrow('graph down');
  expect(f.saved.get('lesson:leak')).toBeUndefined();
});

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
  expect(names(f.saved.get('lesson:a'))).toEqual(['bad-path', 'needs-path', 'meta-lesson', 'generic']);
  expect(f.saved.get('lesson:b')).toEqual({ checks: [], version: LESSON_CHECKS_VERSION });
  // An approved lesson is re-checked too: the stale platitude is gone.
  expect(f.saved.get('lesson:e')).toEqual({ checks: [], version: LESSON_CHECKS_VERSION });
  expect([...f.saved.keys()].sort()).toEqual(['lesson:a', 'lesson:b', 'lesson:e']);
  expect(activity).toEqual([expect.objectContaining({
    kind: 'lessons_checked', actor: 'lesson-check', subject: `3 lessons re-checked (checks v${LESSON_CHECKS_VERSION}): 1 flagged, 2 changed`,
    details: expect.objectContaining({
      checked: 3, flagged: 1, changed: 2, version: LESSON_CHECKS_VERSION,
      flags: { 'bad-path': 1, 'needs-path': 1, 'meta-lesson': 1, generic: 1 },
      added: { 'bad-path': 1, 'needs-path': 1, 'meta-lesson': 1, generic: 1 }, removed: { platitude: 1 },
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
    lesson('lesson:a', 'Lock the row in src/orders.ts', { status: 'approved', paths: ['src/orders.ts', 'src/gone.ts', 'src/**/*.sql'] }),
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

test('a proposed lesson gets its paths normalized and stored; an approved one keeps its paths and is only flagged', async () => {
  const files = ['jobs/export/csv.ts', 'jobs/import/csv.ts', 'jobs/export/schedule.go', 'web/src/upload/handleUpload.ts'];
  const paths = ['AGENTS.md', 'pull/13859/head', 'handleUpload', 'schedule.go', 'csv.ts', 'jobs/export/gone.ts', 'web/**/*.vue'];
  const f = fake([
    lesson('lesson:p', 'Escape the CSV header row before the export job writes it', { projectKey: 'data-pipeline', paths }),
    lesson('lesson:a', 'Escape the CSV header row before the export job writes it', { projectKey: 'data-pipeline', paths, status: 'approved' }),
  ]);
  const stored = new Map<string, string[]>();
  const k = { ...f.k, setLessonPaths: async (id: string, p: string[]) => { stored.set(id, p); return true; } };
  const activity: ActivityInput[] = [];
  const logs: [string, object | undefined][] = [];
  await recheckLessons({
    k, activity: { record: async (a) => void activity.push(a) }, log: (m, x) => logs.push([m, x]),
    repoPaths: async () => new Map([['data-pipeline', '/repos/data-pipeline']]),
    exists: async (_repo, p) => files.includes(p) || files.some((x) => x.startsWith(`${p}/`)),
    repoFiles: async () => files,
  });
  expect(stored).toEqual(new Map([['lesson:p', ['jobs/export/schedule.go', 'csv.ts']]]));
  const proposed = f.saved.get('lesson:p')!.checks;
  expect(proposed.find((c) => c.name === 'bad-path')?.why).toBe(
    'dropped AGENTS.md: an instruction file, not the code the lesson is about; pull/13859/head: a pull request reference, not a path; ' +
    'handleUpload: a bare identifier, not a path; jobs/export/gone.ts: no such file in the repository; web/**/*.vue: a glob that matches no file in the repository',
  );
  expect(proposed.find((c) => c.name === 'ambiguous-path')?.why).toBe('csv.ts is in more than one place (jobs/export/csv.ts, jobs/import/csv.ts): say which');
  const approved = f.saved.get('lesson:a')!.checks;
  expect(approved.map((c) => c.name)).toEqual(['bad-path', 'path-missing', 'ambiguous-path']);
  expect(approved.find((c) => c.name === 'path-missing')?.why).toBe('not in the repository: schedule.go (it is jobs/export/schedule.go), jobs/export/gone.ts, web/**/*.vue');
  expect(activity[0].details).toMatchObject({ normalized: 1 });
  expect(logs).toContainEqual(['lesson paths normalized', expect.objectContaining({ id: 'lesson:p', from: paths, to: ['jobs/export/schedule.go', 'csv.ts'] })]);
});

test("a proposed lesson the owner edited keeps the owner's paths (a file about to be created too): it is only flagged", async () => {
  const files = ['jobs/export/csv.ts'];
  const owner = { title: 'T', rule: 'r', appliesWhen: '', scope: 'project' as const, paths: ['csv.ts'] };
  const f = fake([lesson('lesson:e', 'Escape the CSV header row before the export job writes it', { projectKey: 'data-pipeline', paths: ['jobs/export/header.ts', 'AGENTS.md'], proposedAs: owner })]);
  const stored = new Map<string, string[]>();
  const k = { ...f.k, setLessonPaths: async (id: string, p: string[]) => { stored.set(id, p); return true; } };
  await recheckLessons({
    k, repoPaths: async () => new Map([['data-pipeline', '/repos/data-pipeline']]),
    exists: async (_repo, p) => files.includes(p), repoFiles: async () => files,
  });
  expect(stored).toEqual(new Map());
  expect(names(f.saved.get('lesson:e'))).toEqual(expect.arrayContaining(['bad-path', 'path-missing']));
});

test('flags a re-check cannot work out again (made from the comment metadata or the model) are kept', async () => {
  const kept: LessonCheck[] = [
    { name: 'wrong-session', why: 'the matched session x did other work; redone from the comment alone' },
    { name: 'self-review', why: 'an agent reviewing its own pull request' },
    { name: 'looks-like-a-fact', why: 'the post-mortem model said it states how the code is rather than what to do: it may belong in the project facts' },
    { name: 'no-miss', why: 'the post-mortem found no miss ("Nothing was missed."): this lesson may be invented; it is yours to decide' },
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
