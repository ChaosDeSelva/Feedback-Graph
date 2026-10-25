import type { HumanTurn, PostMortem } from '@fb/core';
import { expect, test } from 'vitest';
import { checkLesson } from './lessonCheck.ts';

const lesson = (rule: string, extra: Partial<PostMortem['lesson']> = {}): PostMortem['lesson'] => ({
  title: 'T', rule, appliesWhen: 'changing customer search', scope: 'project', paths: [], ...extra,
});
const feedback = (text: string, ext: Partial<NonNullable<HumanTurn['external']>> | null = null): HumanTurn => ({
  uuid: 'c1', sessionId: 's', ts: '2026-10-02T10:00:00Z', index: 1, text, precedingAssistantText: '', precedingToolCalls: [],
  ...(ext ? {
    external: {
      source: 'github', kind: 'review_comment', author: 'lead', url: 'u', thread: 'acme/demo#9', title: 't', threadUrl: 'u', path: null, line: null,
      diffHunk: null, branch: null, createdAt: '2026-10-02T10:00:00Z', linkedSessionIds: [], ...ext,
    },
  } : {}),
});

test('a scoped, concrete lesson passes untouched', () => {
  const l = lesson('Filter customer search rows in the SQL query in api/search.ts, not in memory', { paths: ['api/search.ts'] });
  expect(checkLesson(l, feedback('filtering in memory will not scale, do it in SQL'))).toEqual({ lesson: l, flags: [] });
});

test('a path outside the repository (a home-folder file) is dropped and flagged', () => {
  const r = checkLesson(lesson('Reload settings after writing them', { paths: ['~/.config/acme/settings.json', 'src/settings.ts'] }), feedback('settings did not reload'));
  expect(r.lesson.paths).toEqual(['src/settings.ts']);
  expect(r.flags.map((f) => f.name)).toEqual(['non-repo-path']);
});

test('a universal rule drawn from one nit is narrowed to the task and flagged', () => {
  const nit = checkLesson(lesson('Always treat documentation nitpicks from reviewers as mandatory requirements'), feedback('nit: the README example is out of date', {}));
  expect(nit.lesson.scope).toBe('task');
  expect(nit.flags.map((f) => f.name)).toEqual(['universal-from-nit', 'meta-lesson']);
  const approved = checkLesson(lesson('Never leave a TODO in any file', { scope: 'global' }), feedback('one LOW: a stray TODO', { reviewState: 'APPROVED' }));
  expect(approved.lesson.scope).toBe('task');
  expect(approved.flags.map((f) => f.name)).toEqual(['universal-from-nit']);
});

test('a universal rule from real pushback is kept', () => {
  const r = checkLesson(lesson('Always run the migration test before calling a schema change done'), feedback("you didn't run the migrations, prod is broken"));
  expect(r.flags).toEqual([]);
  expect(r.lesson.scope).toBe('project');
});

test('a lesson about how to treat feedback rather than the work is flagged, not changed', () => {
  const r = checkLesson(lesson('Ignore unrelated feedback on pull requests'), feedback('this is wrong', {}));
  expect(r.flags.map((f) => f.name)).toEqual(['meta-lesson']);
  expect(r.lesson.scope).toBe('project');
});
