import { expect, test } from 'vitest';
import type { ContextItem } from '@fb/core';
import { capToCommentDir, codeNotRead, shapeLesson, stripRefs } from './shape.ts';

const lesson = (o: Partial<{ title: string; rule: string; appliesWhen: string; paths: string[] }>) => ({
  title: 'Pair self-closing custom tags', rule: 'Rewrite self-closing <chart /> tags to paired tags in pipeline.ts before rehype-raw parses them',
  appliesWhen: 'When rendering markdown with custom tags', scope: 'project' as const, paths: ['web/src/markdown/pipeline.ts'], ...o,
});

test('stripRefs takes pull request and issue numbers out of a rule, leaving a sentence', () => {
  expect(stripRefs('Use the shared pipeline (see PR #14217) for chart embeds')).toBe('Use the shared pipeline for chart embeds');
  expect(stripRefs('As in PR #812, read orders from the source table')).toBe('Read orders from the source table');
  expect(stripRefs('Keep the retry in fetchOrders, as pull request 77 did.')).toBe('Keep the retry in fetchOrders.');
  expect(stripRefs('Close the pool in db.ts on error (#91).')).toBe('Close the pool in db.ts on error.');
  // Not a reference: a colour, an anchor, a number in code.
  expect(stripRefs('Use #fff in theme.ts and link to README.md#setup')).toBe('Use #fff in theme.ts and link to README.md#setup');
});

test('a title that repeats the rule becomes a short name; one that names the rule stays', () => {
  const same = shapeLesson(lesson({ title: 'Rewrite self-closing <chart /> tags to paired tags in pipeline.ts before rehype-raw parses them' }), { taskTitle: 'Chart embeds' });
  expect(same.lesson.title).toBe('Rewrite self-closing <chart /> tags to paired tags in…');
  expect(same.lesson.title).not.toBe(same.lesson.rule);
  expect(same.repaired).toContain('title');
  // A short rule: its first clause is the rule again, so the task names it.
  const short = shapeLesson(lesson({ title: 'Filter search on the server.', rule: 'Filter search on the server' }), { taskTitle: 'Customer search' });
  expect(short.lesson.title).toBe('Customer search');
  expect(shapeLesson(lesson({}), { taskTitle: 'x' })).toEqual({ lesson: lesson({}), repaired: [] });
});

test('the rule loses its PR numbers', () => {
  const r = shapeLesson(lesson({ rule: 'Pair self-closing tags in pipeline.ts, as PR #14217 does' }), { taskTitle: 't' });
  expect(r.lesson.rule).toBe('Pair self-closing tags in pipeline.ts');
  expect(r.repaired).toEqual(['rule']);
});

test('appliesWhen is never empty or the rule again: it names the files, else the task', () => {
  const empty = shapeLesson(lesson({ appliesWhen: '  ' }), { taskTitle: 'Chart embeds' });
  expect(empty.lesson.appliesWhen).toBe('When changing web/src/markdown/pipeline.ts');
  const again = shapeLesson(lesson({ appliesWhen: 'rewrite self-closing <chart/> tags to paired tags in pipeline.ts before rehype-raw parses them' }), { taskTitle: 'Chart embeds' });
  expect(again.lesson.appliesWhen).toBe('When changing web/src/markdown/pipeline.ts');
  expect(again.repaired).toEqual(['appliesWhen']);
  const pathless = shapeLesson(lesson({ appliesWhen: '', paths: [] }), { taskTitle: 'Legacy thread rendering' });
  expect(pathless.lesson.appliesWhen).toBe('When working on legacy thread rendering');
});

const item = (ref: string, o: Partial<ContextItem> = {}): ContextItem => ({ kind: 'code', ref, excerpt: 'x', why: 'y', wasAvailable: false, ...o });

test("a review comment's context items stay in the comment's directory; instruction files and discussions stay too", () => {
  const items = [item('web/src/markdown/legacy.tsx:20-52'), item('web/src/markdown/pipeline.ts'), item('services/go/checkpoint.go'), item('CLAUDE.md', { kind: 'claude_md' }), item('acme/web#12', { kind: 'pr' })];
  expect(capToCommentDir(items, 'web/src/markdown/pipeline.ts').map((i) => i.ref)).toEqual(['web/src/markdown/legacy.tsx:20-52', 'web/src/markdown/pipeline.ts', 'CLAUDE.md', 'acme/web#12']);
  // No file (a PR-level comment), or one at the root: nothing to cap to.
  expect(capToCommentDir(items, null)).toEqual(items);
  expect(capToCommentDir(items, 'README.md')).toEqual(items);
});

test('code_not_read: the code that showed the way is in the repository and the session never read it', async () => {
  const exists = async (p: string) => p === 'web/src/markdown/legacy.tsx';
  const items = [item('web/src/markdown/legacy.tsx:20-52')];
  expect(await codeNotRead('context_missing', items, exists)).toBe('code_not_read');
  // The model said "available, ignored" but nothing it cites was available: the code was there, unread.
  expect(await codeNotRead('context_available_ignored', items, exists)).toBe('code_not_read');
  // Something was available (CLAUDE.md said so): that stays the cause.
  expect(await codeNotRead('context_available_ignored', [...items, item('CLAUDE.md', { kind: 'claude_md', wasAvailable: true })], exists)).toBe('context_available_ignored');
  // Read in the session, not in the repository, or another cause: unchanged.
  expect(await codeNotRead('context_missing', [item('web/src/markdown/legacy.tsx', { wasAvailable: true })], exists)).toBe('context_missing');
  expect(await codeNotRead('context_missing', [item('web/src/gone.tsx')], exists)).toBe('context_missing');
  expect(await codeNotRead('implementation_error', items, exists)).toBe('implementation_error');
  expect(await codeNotRead('context_missing', items, undefined)).toBe('context_missing');
});
