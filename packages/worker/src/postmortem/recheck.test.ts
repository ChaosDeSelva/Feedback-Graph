import type { ActivityInput, Lesson, LessonCheck, LessonDetail } from '@fb/core';
import { expect, test } from 'vitest';
import { recheckProposedLessons } from './recheck.ts';

const lesson = (id: string, rule: string, extra: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'shop', title: 'T', rule, appliesWhen: '', scope: 'project', paths: [], status: 'proposed', source: 'postmortem',
  cause: 'context_missing', missId: null, createdAt: '2026-10-24T00:00:00Z', decidedAt: null, checks: null, ...extra,
});

function fake(lessons: Lesson[], feedback: Record<string, string>) {
  const saved = new Map<string, LessonCheck[]>();
  const listed: unknown[] = [];
  const k = {
    listLessons: async (f: { status?: string; limit?: number }) => { listed.push(f); return lessons.filter((l) => !f.status || l.status === f.status); },
    lessonDetail: async (id: string) => ({ lesson: lessons.find((l) => l.id === id)!, miss: null, feedback: feedback[id] ? { id, text: feedback[id], status: 'open', sessionId: 's', ts: 't' } : null, contextItems: [], fixCommits: [], supersedes: [] }) as LessonDetail,
    setLessonChecks: async (id: string, checks: LessonCheck[]) => { saved.set(id, checks); return true; },
  };
  return { k, saved, listed };
}

test('proposed lessons never checked get their checks once; checked, approved and memory-free ones are left alone', async () => {
  const f = fake(
    [
      lesson('lesson:a', 'Verify that feedback is relevant to the current task', { paths: ['src/webapp/AGENTS.md'] }),
      lesson('lesson:b', 'Lock the order row in orders/claim.sql before the status insert'),
      lesson('lesson:c', 'Always verify state.', { checks: [] }),
      lesson('lesson:d', 'Always verify state.', { status: 'approved' }),
    ],
    { 'lesson:a': 'this is wrong', 'lesson:b': 'the insert races the status check' },
  );
  const activity: ActivityInput[] = [];
  expect(await recheckProposedLessons({ k: f.k, activity: { record: async (a) => void activity.push(a) } })).toBe(2);
  expect(f.saved.get('lesson:a')?.map((c) => c.name)).toEqual(['bad-path', 'meta-lesson']);
  expect(f.saved.get('lesson:b')).toEqual([]);
  expect([...f.saved.keys()]).toEqual(['lesson:a', 'lesson:b']);
  expect(activity).toEqual([expect.objectContaining({ kind: 'lessons_checked', actor: 'lesson-check', subject: '2 proposed lessons checked: 1 flagged', details: { checked: 2, flagged: 1, flags: { 'bad-path': 1, 'meta-lesson': 1 } } })]);
});

test('nothing to check: no activity', async () => {
  const f = fake([lesson('lesson:c', 'x', { checks: [] })], {});
  const activity: ActivityInput[] = [];
  expect(await recheckProposedLessons({ k: f.k, activity: { record: async (a) => void activity.push(a) } })).toBe(0);
  expect(activity).toEqual([]);
});
