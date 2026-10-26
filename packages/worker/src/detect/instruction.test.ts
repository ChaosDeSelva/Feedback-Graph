import { expect, test } from 'vitest';
import type { ToolCall } from '@fb/core';
import { gitActions, gitEvidence, gitInstruction, isProcessMiss } from './instruction.ts';

const bash = (command: string, ts = '2026-10-25T10:00:00Z'): ToolCall => ({ name: 'Bash', ts, command });
const edit = (filePath: string): ToolCall => ({ name: 'Edit', ts: '2026-10-25T10:00:00Z', filePath });

const BRANCH_ORDER = 'this should be on its own branch based on main do not merge back to main, dont push pr yet, I want to look at the diff first';

test('a constraint on what the agent does next is an instruction while nothing it forbids has happened', () => {
  const r = gitInstruction(BRANCH_ORDER, { before: [edit('/r/web/src/pipeline.ts'), bash('git status'), bash('git diff --stat')], after: [bash('git checkout -b fix/one-renderer'), bash('git commit -m "fix: render every chart"')] });
  expect(r).toMatchObject({ instruction: true, forbids: expect.arrayContaining(['merge', 'push', 'pr']), violated: [] });
});

test('the same words become a correction when the agent already did what they forbid', () => {
  // Before the message the agent had pushed: "do not push" is about something that happened.
  expect(gitInstruction(BRANCH_ORDER, { before: [bash('git push -u origin HEAD')], after: [] })).toMatchObject({ instruction: false, done: ['push'] });
});

test('an instruction the agent broke afterwards is not cleared: the later push is the evidence', () => {
  const r = gitInstruction("don't push yet, keep it local", { before: [], after: [bash('git commit -am wip'), bash('git push origin fix/x')] });
  expect(r).toMatchObject({ instruction: true, violated: ['push'] });
});

test('true corrections of git behaviour are never read as instructions', () => {
  for (const text of [
    'you pushed to main, I said not to',
    'why did you merge it back to main? that was supposed to stay on its own branch',
    "I told you not to open a PR yet",
    'you merged without asking, revert that',
    'that commit went straight to main again',
  ]) expect(gitInstruction(text, { before: [], after: [] }), text).toMatchObject({ instruction: false });
});

test('a bare "should" about git work already there is not an instruction: the model decides', () => {
  expect(gitInstruction('the PR should have the tests too', { before: [], after: [] })).toMatchObject({ instruction: false });
  expect(gitInstruction('this branch should build, it fails on CI', { before: [], after: [] })).toMatchObject({ instruction: false });
  expect(gitInstruction('please look: your first commit broke the build', { before: [], after: [] })).toMatchObject({ instruction: false });
});

test('a message not about git is none of its business', () => {
  expect(gitInstruction('the chart should be bigger on mobile', { before: [], after: [] })).toMatchObject({ instruction: false, forbids: [] });
  expect(gitInstruction('the main menu should not scroll', { before: [], after: [] })).toMatchObject({ instruction: false, forbids: [] });
});

test('a forward-looking git request that forbids nothing is left to the model: nothing could show it broken', () => {
  expect(gitInstruction('commit this on a new branch off main, then open a draft PR', { before: [bash('pnpm test')], after: [] })).toMatchObject({ instruction: false });
  expect(gitInstruction('please rebase onto main before you push', { before: [], after: [] })).toMatchObject({ instruction: false });
});

test('a complaint or a request about the work that merely mentions git is never an instruction', () => {
  for (const text of [
    'The PR description is inaccurate, please fix it',
    "Don't use that API, it's deprecated. Commit when done.",
    "That's not right, the commit message should say what changed, please amend it",
    "nope, this is not the approach I want. let's keep the old schema and open a PR",
    'Can you not commit the .env file? That has secrets in it',
    "the tests don't cover the edge case, add one before you commit",
  ]) expect(gitInstruction(text, { before: [], after: [] }), text).toMatchObject({ instruction: false });
});

test('pure constraints on pushing, merging and pull requests stay instructions', () => {
  for (const text of [
    "this should be on its own branch based on main, do not merge back to main, don't push a PR yet",
    BRANCH_ORDER,
    "don't push yet, keep it local",
    'do not open a PR until I say so',
  ]) expect(gitInstruction(text, { before: [], after: [] }), text).toMatchObject({ instruction: true });
});

test('an instruction waits while its session is still active, even when later messages exist', async () => {
  const live = { calls: [], laterTurns: 1, endedAt: '2026-10-25T11:55:00Z' };
  expect(await gitEvidence({ uuid: 'u1', text: "don't push yet" }, async () => live, Date.parse('2026-10-25T12:00:00Z'))).toBe('wait');
  // Idle long enough: judged on what was recorded.
  expect(await gitEvidence({ uuid: 'u1', text: "don't push yet" }, async () => live, Date.parse('2026-10-25T13:00:00Z'))).toBe('instruction');
  const pushed = { calls: [bash('git push origin fix/x')], laterTurns: 1, endedAt: '2026-10-25T11:55:00Z' };
  expect(await gitEvidence({ uuid: 'u1', text: "don't push yet" }, async () => pushed, Date.parse('2026-10-25T13:00:00Z'))).toEqual([bash('git push origin fix/x')]);
});

test('a process miss is about the git process alone: feedback that names code behaviour or a lesson with paths is not', () => {
  // The complaint is about the code (login breaks); the PR is only where it showed.
  expect(isProcessMiss({ feedbackText: 'This PR breaks login on token expiry', rule: 'Before opening a PR, test token expiry in auth/session.ts', commentPath: null })).toBe(false);
  expect(isProcessMiss({ feedbackText: 'you pushed before the tests in api/search.ts passed', rule: 'Do not push until tests pass', commentPath: null })).toBe(false);
  expect(isProcessMiss({ feedbackText: 'you merged it back to main, it was supposed to stay on its own branch', rule: 'Keep work on its own branch and merge only when asked', commentPath: null, paths: ['src/api.ts'] })).toBe(false);
  expect(isProcessMiss({ feedbackText: 'you merged it back to main, it was supposed to stay on its own branch', rule: 'Keep work on its own branch and never merge to main unless asked', commentPath: null })).toBe(true);
  expect(isProcessMiss({ feedbackText: 'you opened the PR against main, I said the release branch', rule: 'Open pull requests against the release branch', commentPath: null, paths: [] })).toBe(true);
  expect(isProcessMiss({ feedbackText: 'squash those wip commits before you push', rule: 'Squash work-in-progress commits before pushing', commentPath: null })).toBe(true);
});

test('gitActions reads pushes, merges, pull requests and commits from shell and MCP calls', () => {
  expect(gitActions([
    bash('git push --force-with-lease'),
    bash('cd web && git merge main'),
    bash('gh pr create --fill --draft'),
    bash('git commit -m "x"'),
    bash('git status && git log --oneline -3'),
    { name: 'mcp__github__create_pull_request', ts: '' },
    { name: 'mcp__github__merge_pull_request', ts: '' },
  ])).toEqual(['push', 'merge', 'pr', 'commit']);
  expect(gitActions([bash('git diff main...HEAD'), bash('gh pr list --head fix/x'), bash('echo "git push later"')])).toEqual([]);
});

test('a pure instruction about git (no miss in its words) is a process miss whatever the lesson says, and so on no file', () => {
  const tenFiles = Array.from({ length: 10 }, (_, i) => `web/src/chat/f${i}.ts`);
  // The post-mortem gave its lesson the session's edited files, or wrote one about code, or none at all.
  expect(isProcessMiss({ feedbackText: BRANCH_ORDER, rule: 'Do not push until the developer has looked', commentPath: null, paths: tenFiles })).toBe(true);
  expect(isProcessMiss({ feedbackText: BRANCH_ORDER, rule: 'Run the tests in web/src/chat before pushing', commentPath: null })).toBe(true);
  expect(isProcessMiss({ feedbackText: "keep this on its own branch, don't push a PR yet", rule: null, commentPath: null })).toBe(true);
  // A review comment on a file stays on it.
  expect(isProcessMiss({ feedbackText: BRANCH_ORDER, rule: null, commentPath: 'web/src/chat/f0.ts' })).toBe(false);
  // A correction about code said with git words is not an instruction.
  expect(isProcessMiss({ feedbackText: 'you pushed before the tests in api/search.ts passed', rule: null, commentPath: null, paths: ['api/search.ts'] })).toBe(false);
});
