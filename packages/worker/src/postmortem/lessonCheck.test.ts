import type { HumanTurn, PostMortem } from '@fb/core';
import { expect, test } from 'vitest';
import { checkLesson, recheckLesson } from './lessonCheck.ts';

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

test('a severity label (LOW) or the word "typo" in a review is not a nit; nit markers at the start or in a tag are', () => {
  const rule = 'Always lock the target row before an insert conditioned on its status in orders/claim.sql';
  for (const text of ['LOW severity, real gap, address before merge: the insert races the status check', 'the typo check in lint passes, but the insert races the status check']) {
    expect(checkLesson(lesson(rule), feedback(text, {})).flags, text).toEqual([]);
  }
  for (const text of ['nit: rename this', 'Minor: the comment is stale', '**nit** extra blank line', '(optional) could be a const', 'Non-blocking, but the name is odd']) {
    expect(checkLesson(lesson(rule), feedback(text, {})).flags.map((f) => f.name), text).toEqual(['universal-from-nit']);
  }
});

test('meta-lessons phrased as relevance, scope or "pertains" are flagged too', () => {
  for (const rule of [
    'Verify that feedback is relevant to the current task before acting on it',
    'Strictly filter review comments to the current PR scope',
    'Check whether a comment pertains to the feature you are working on',
    'Consult detailed PR review comments before pushing',
    'Incorporate optional nitpicks from reviewers',
  ]) expect(checkLesson(lesson(rule), feedback('this is wrong', {})).flags.map((f) => f.name), rule).toContain('meta-lesson');
});

test('a platitude with nothing from the code in it is flagged; the same verb with an identifier is not', () => {
  expect(checkLesson(lesson('Always verify concurrent state interactions.'), feedback('handleRemoveAccount resends the cached list')).flags.map((f) => f.name)).toEqual(['platitude']);
  expect(checkLesson(lesson('Always verify that handleRemoveAccount does not resend the cached vendorAccountIds list'), feedback('it resends the list')).flags).toEqual([]);
});

test('a rule field holding the scope word takes the title as the rule and is flagged', () => {
  const r = checkLesson(lesson('task', { title: 'Assert the timezone offset, not its name, in session tests' }), feedback('this fails in CI'));
  expect(r.lesson.rule).toBe('Assert the timezone offset, not its name, in session tests');
  expect(r.flags.map((f) => f.name)).toEqual(['broken-rule']);
});

test('a statement about the codebase with nothing to do is flagged as looking like a fact', () => {
  const r = checkLesson(lesson('The app_frontend.organizations mirror lags fifteen minutes behind the source table.'), feedback('the mirror lags'));
  expect(r.flags.map((f) => f.name)).toEqual(['looks-like-a-fact']);
  expect(checkLesson(lesson('Read organizations from the source table, not the mirror, because the mirror lags fifteen minutes'), feedback('the mirror lags')).flags).toEqual([]);
  // The model can say so itself.
  expect(checkLesson(lesson('Read from the source table in sync/orgs.ts, not the mirror'), feedback('x'), { factLike: true }).flags.map((f) => f.name)).toEqual(['looks-like-a-fact']);
});

test('a comment that is only an approval, a status table or an echo is flagged as not pushback', () => {
  const rule = 'Lock the target row before an insert conditioned on its status in orders/claim.sql';
  for (const text of ['Approving - details inline', 'LGTM, one thing inline', 'We reached the same conclusions as the first reviewer.', '| finding | status |\n|---|---|\n| race | fixed |\n| naming | resolved |']) {
    expect(checkLesson(lesson(rule), feedback(text, {})).flags.map((f) => f.name), text).toEqual(['not-pushback']);
  }
});

test('the model saying the lesson is about process, or an agent reviewing its own PR, is flagged', () => {
  const rule = 'Lock the target row before an insert conditioned on its status in orders/claim.sql';
  expect(checkLesson(lesson(rule), feedback('x'), { about: 'process' }).flags.map((f) => f.name)).toEqual(['meta-lesson']);
  const self = checkLesson(lesson(rule), feedback('[claude] the insert races the check', { author: 'dev', threadAuthor: 'dev', authorKind: 'agent' }));
  expect(self.flags.map((f) => f.name)).toEqual(['self-review']);
});

test('a re-check of a stored lesson only flags: it never changes the lesson', () => {
  const stored = lesson('Always treat documentation nitpicks as mandatory', { paths: ['src/webapp/AGENTS.md', 'acme/shop#12', 'handleUpload', 'src/upload.ts'] });
  const flags = recheckLesson(stored, 'nit: the README example is out of date');
  expect(flags.map((f) => f.name)).toEqual(['bad-path', 'universal-from-nit', 'meta-lesson']);
  expect(flags[0].why).toContain('src/webapp/AGENTS.md');
  expect(flags[0].why).not.toContain('src/upload.ts');
});
