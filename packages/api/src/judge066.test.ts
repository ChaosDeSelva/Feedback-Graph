import { expect, test } from 'vitest';
import type { LessonHit } from '@fb/core';
import { checkBeforeDone, makeJudge } from './context.ts';

const diff = 'diff --git a/src/routes.ts b/src/routes.ts\n--- a/src/routes.ts\n+++ b/src/routes.ts\n@@ -1 +1 @@\n-db.scoped(org).list();\n+db.raw().list();\n';
const lessons = ['tenant', 'other'].map(id => ({ score: .9, lesson: { id, title: id, rule: 'Scope database reads to the tenant.', appliesWhen: 'database reads', paths: ['src/routes.ts'] } })) as LessonHit[];
const correct = { lessonId: 'L1', status: 'not_addressed', applies: true, why: 'The added raw read omits the tenant.', evidence: ['+db.raw().list();'] };

test('keeps a supported violation when a sibling causes a retry whose answer downgrades it', async () => {
  let calls = 0;
  const judge = makeJudge({ id: 'test', agentic: false, json: async () => ++calls === 1
    ? { verdicts: [correct, { lessonId: 'L2', status: 'addressed', applies: true, why: 'done', evidence: [] }] }
    : { verdicts: [{ lessonId: 'L1', status: 'cannot_tell', applies: true, why: 'uncertain', evidence: [] }, { lessonId: 'L2', status: 'not_applicable', applies: false, why: 'other behaviour', evidence: [] }] } });
  const verdicts = await judge({ task: 'edit src/routes.ts', summary: 'change database read', diff }, lessons);
  expect(calls).toBe(2);
  expect(verdicts.find(v => v.lessonId === 'tenant')).toMatchObject({ status: 'not_addressed', evidence: ['+db.raw().list();'] });
});

test('one malformed sibling and a malformed retry cannot erase a correct verdict', async () => {
  let calls = 0;
  const judge = makeJudge({ id: 'test', agentic: false, json: async () => ++calls === 1 ? { verdicts: [correct, { lessonId: 'L2', status: 'wrong' }] } : { wrong: 'shape' } });
  expect(await judge({ task: 'edit src/routes.ts', summary: 'change database read', diff }, lessons)).toEqual([{ ...correct, lessonId: 'tenant' }]);
  expect(calls).toBe(2);
});

test('does not retain an unsupported verdict just because retry fails', async () => {
  let calls = 0;
  const judge = makeJudge({ id: 'test', agentic: false, json: async () => ++calls === 1 ? { verdicts: [{ ...correct, evidence: ['+invented.call();'] }] } : { wrong: 'shape' } });
  await expect(judge({ task: 'edit src/routes.ts', summary: 'change database read', diff }, lessons)).rejects.toThrow();
});

test('short quoted 005 literal is valid evidence for a KeyPrefix violation', async () => {
  const judge = makeJudge({ id: 'test', agentic: false, json: async () => ({ verdicts: [{ lessonId: 'L1', status: 'not_addressed', applies: true, why: 'KeyPrefix remains 005.', evidence: ['"005"'] }] }) });
  const result = await judge({ task: 'change KeyPrefix', summary: 'done', diff: '--- a/schema.ts\n+++ b/schema.ts\n@@ -1 +1 @@\n-KeyPrefix = "004";\n+KeyPrefix = "005";\n' }, [lessons[0]]);
  expect(result[0].status).toBe('not_addressed');
});

test('conditional console policy is evaluated only for its explicit task trigger and file', async () => {
  let calls = 0;
  const judge = makeJudge({ id: 'test', agentic: false, json: async () => { calls++; return { verdicts: [{ lessonId: 'L1', status: 'not_applicable', applies: false, why: 'Trigger absent.', evidence: [] }] }; } });
  const policy = [{ ...lessons[0], lesson: { ...lessons[0].lesson, rule: 'When asked for console.* output in src/routes.ts, do not add console.log.' } }];
  const consoleDiff = diff.replace('+db.raw().list();', '+console.log("debug");');
  expect((await judge({ task: 'add console output in src/routes.ts', summary: 'done', diff: consoleDiff }, policy))[0].status).toBe('not_addressed');
  expect(calls).toBe(0);
  expect((await judge({ task: 'change database reads', summary: 'done', diff: consoleDiff }, policy))[0].status).toBe('not_applicable');
  expect(calls).toBe(1);
});

test('runtime timezone invariant retries comment-only evidence and retains the actual require.Equal code', async () => {
  const timezoneDiff = '--- a/time_test.go\n+++ b/time_test.go\n@@ -1 +1,2 @@\n-old()\n+// UTC timestamps are equal\n+require.Equal(t, want.Local(), got)\n';
  const policy = [{ ...lessons[0], lesson: { ...lessons[0].lesson, rule: 'Compare timestamps in UTC.', paths: ['time_test.go'] } }];
  const systems: string[] = [];
  const judge = makeJudge({ id: 'test', agentic: false, json: async task => {
    systems.push(task.system);
    return { verdicts: [{ lessonId: 'L1', status: 'not_addressed', applies: true, why: 'The timestamp assertion does not normalize to UTC.', evidence: [systems.length === 1 ? '+// UTC timestamps are equal' : '+require.Equal(t, want.Local(), got)'] }] };
  } });
  const result = await judge({ task: 'edit time_test.go', summary: 'compare times', diff: timezoneDiff }, policy);
  expect(systems).toHaveLength(2);
  expect(result[0].evidence).toEqual(['+require.Equal(t, want.Local(), got)']);
});

test('a lesson explicitly about comments may use changed comments as evidence without retrying', async () => {
  let calls = 0;
  const judge = makeJudge({ id: 'test', agentic: false, json: async () => { calls++; return { verdicts: [{ lessonId: 'L1', status: 'not_addressed', applies: true, why: 'The comment contains TODO.', evidence: ['+// TODO remove this'] }] }; } });
  const policy = [{ ...lessons[0], lesson: { ...lessons[0].lesson, rule: 'Do not leave TODO comments.' } }];
  expect((await judge({ task: 'edit', summary: 'done', diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old();\n+// TODO remove this\n' }, policy))[0].status).toBe('not_addressed');
  expect(calls).toBe(1);
});


test('standalone comments cannot create a runtime gap after both model attempts', async () => {
  const policy = [{ ...lessons[0], lesson: { ...lessons[0].lesson, projectKey: 'demo', rule: 'Compare timestamps in UTC.' } }];
  const judge = makeJudge({ id: 'test', agentic: false, json: async () => ({ verdicts: [{ lessonId: 'L1', status: 'not_addressed', applies: true, why: 'The timestamp behavior is wrong.', evidence: ['+// UTC timestamps are equal'] }] }) });
  const result = await checkBeforeDone({ project: 'demo', task: 'edit src/routes.ts', summary: 'done', filesChanged: ['src/routes.ts'], diff: diff.replace('+db.raw().list();', '+// UTC timestamps are equal') }, {
    roots: [{ host: '/projects', container: '/projects' }], exists: () => true, embed: async () => [[1]],
    k: { searchLessons: async () => policy, relatedMisses: async () => [], createManualFeedback: async () => 'f', recordPreDoneCheck: async () => {} }, judge,
  });
  expect(result.gaps).toEqual([]);
  expect(result.cannotTell).toHaveLength(1);
});
