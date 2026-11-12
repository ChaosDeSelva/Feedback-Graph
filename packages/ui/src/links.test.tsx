import { afterEach, expect, test } from 'vitest';
import { hashFocus, hashModule, hashNewChat, moduleHref, newChatHref, saveHashFilters, sourceHref } from './links.ts';

afterEach(() => { history.replaceState(null, '', '#'); });
const go = (hash: string) => history.replaceState(null, '', hash);

test('a link to one item opens the page on it; a malformed escape opens the page on nothing', () => {
  go('#lessons/lesson%3Alinear%2FREA-1?status=approved');
  expect(hashFocus('lessons')).toBe('lesson:linear/REA-1');
  expect(hashFocus('inbox')).toBeNull();
  go('#lessons/%E0%A4%A');
  expect(hashFocus('lessons')).toBeNull();
  go('#lessons');
  expect(hashFocus('lessons')).toBeNull();
  go('#lessons/');
  expect(hashFocus('lessons')).toBeNull();
});

test('a Projects link names its project and file; a malformed one names nothing', () => {
  go(moduleHref('demo shop', 'src/a b.ts'));
  expect(hashModule()).toEqual({ project: 'demo shop', path: 'src/a b.ts' });
  go('#projects/demo');
  expect(hashModule()).toEqual({ project: 'demo', path: null });
  go('#projects/%E0%A4%A');
  expect(hashModule()).toBeNull();
  go('#projects');
  expect(hashModule()).toBeNull();
});

test('a new-conversation link round-trips its project, question and model', () => {
  go(newChatHref('demo', '  why?  ', 'codex'));
  expect(hashNewChat()).toEqual({ project: 'demo', q: 'why?', provider: 'codex' });
  go('#ask/new');
  expect(hashNewChat()).toEqual({ project: '', q: '', provider: null });
  go('#ask/c1');
  expect(hashNewChat()).toBeNull();
});

test('each Ask source opens where it lives', () => {
  expect(sourceHref('p', { kind: 'code', ref: 'src/a.ts:10-20' })).toBe('#projects/p/src%2Fa.ts');
  expect(sourceHref('p', { kind: 'miss', ref: 'miss:f1' })).toBe('#inbox/f1');
  expect(sourceHref('p', { kind: 'miss', ref: 'src/a.ts:3' })).toBe('#projects/p/src%2Fa.ts');
  expect(sourceHref('p', { kind: 'doc', ref: 'https://example.com/x' })).toBe('https://example.com/x');
  expect(sourceHref('p', { kind: 'doc', ref: 'README.md' })).toBe('#projects/p');
  expect(sourceHref('p', { kind: 'linked', ref: 'other' })).toBe('#projects/other');
  expect(sourceHref('p', { kind: 'session', ref: 's1' })).toBe('#sessions/s1');
  expect(sourceHref('p', { kind: 'lesson', ref: 'l1' })).toBe('#lessons/l1');
  expect(sourceHref('p', { kind: 'web', ref: 'x' })).toBeNull();
});

test('filters are written to the hash of their own page only, leaving out the default status', () => {
  go('#inbox');
  saveHashFilters('inbox', { status: 'pending', project: 'demo', q: '' });
  expect(location.hash).toBe('#inbox?project=demo');
  saveHashFilters('lessons', { project: 'other' });
  expect(location.hash).toBe('#inbox?project=demo');
  saveHashFilters('inbox', { status: 'pending' });
  expect(location.hash).toBe('#inbox');
});
