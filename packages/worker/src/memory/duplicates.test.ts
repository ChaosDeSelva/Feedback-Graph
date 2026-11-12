import type { ActivityInput, Lesson, LessonCheck } from '@fb/core';
import { expect, test } from 'vitest';
import { withdrawDuplicateMemory } from './duplicates.ts';

const memoryLesson = (o: Partial<Lesson> = {}) =>
  ({ id: 'L1', projectKey: 'demo', title: 'no em dashes', status: 'proposed', source: 'memory', decidedAt: null, proposedAs: null, checks: [], ...o }) as Lesson;

function fakes(lesson: Lesson | null) {
  const updates: unknown[] = [];
  const checks: LessonCheck[][] = [];
  const activity: ActivityInput[] = [];
  const d = {
    knowledge: {
      lessonDetail: async () => (lesson ? { lesson } : null) as never,
      updateLesson: async (id: string, patch: unknown, o: unknown) => { updates.push([id, patch, o]); return { unscoped: false }; },
      setLessonChecks: async (_id: string, c: LessonCheck[]) => { checks.push(c); return true; },
    },
    activity: { record: async (a: ActivityInput) => { activity.push(a); } },
  };
  return { d, updates, checks, activity };
}

test('an undecided, unedited memory lesson written after the same feedback is rejected and logged', async () => {
  const f = fakes(memoryLesson());
  await withdrawDuplicateMemory(f.d, 'L1', 'fb1');
  expect(f.updates).toEqual([['L1', { status: 'rejected' }, { by: 'memory-deduplication', note: 'the agent wrote this memory after feedback already represented in the Inbox' }]]);
  expect(f.activity).toEqual([expect.objectContaining({ kind: 'lesson_decided', actor: 'memory-deduplication', projectKey: 'demo', subject: 'duplicate feedback memory: no em dashes', targets: ['L1', 'fb1'] })]);
});

test('one the owner decided or edited is kept, flagged duplicate-of the feedback\'s lesson for review', async () => {
  const existing: LessonCheck = { name: 'path-missing', why: 'x' };
  const f = fakes(memoryLesson({ status: 'approved', decidedAt: '2026-11-01T00:00:00Z', checks: [existing] }));
  await withdrawDuplicateMemory(f.d, 'L1', 'fb1');
  expect(f.updates).toEqual([]);
  expect(f.checks).toEqual([[existing, expect.objectContaining({ name: 'duplicate-of', of: 'lesson:fb1' })]]);
  expect(f.activity).toHaveLength(1);

  // An edited proposal (its draft kept) is flagged too; with no feedback id the check names none.
  const g = fakes(memoryLesson({ proposedAs: { title: 't', rule: 'r' } as Lesson['proposedAs'], checks: null }));
  await withdrawDuplicateMemory(g.d, 'L1', null);
  expect(g.checks).toEqual([[{ name: 'duplicate-of', why: expect.any(String) }]]);
  expect(g.activity[0].targets).toEqual(['L1']);
});

test('a lesson already flagged, not a memory lesson, no longer live, or gone is left alone', async () => {
  for (const lesson of [
    memoryLesson({ status: 'approved', checks: [{ name: 'duplicate-of', why: 'x' }] }),
    memoryLesson({ source: 'postmortem' } as Partial<Lesson>),
    memoryLesson({ status: 'rejected' }),
    memoryLesson({ status: 'superseded' }),
    memoryLesson({ status: 'revoked' }),
    null,
  ]) {
    const f = fakes(lesson);
    await withdrawDuplicateMemory(f.d, 'L1', 'fb1');
    expect([f.updates, f.checks, f.activity]).toEqual([[], [], []]);
  }
});
