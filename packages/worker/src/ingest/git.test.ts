import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { cachedRemote, commitsInWindow, projectRemote } from './git.ts';

function commitAt(dir: string, date: string, msg: string) {
  const env = { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date };
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-qm', msg], { env });
}

test('returns only commits inside the window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbgit-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  commitAt(dir, '2026-10-01T10:00:00Z', 'first');
  commitAt(dir, '2026-10-02T10:00:00Z', 'second');
  const commits = await commitsInWindow(dir, '2026-10-02T00:00:00Z', '2026-10-03T00:00:00Z');
  expect(commits).toHaveLength(1);
  expect(commits[0].subject).toBe('second');
  expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
  expect(Date.parse(commits[0].ts)).toBe(Date.parse('2026-10-02T10:00:00Z'));
});

test('a non-repo path returns no commits', async () => {
  expect(await commitsInWindow(mkdtempSync(join(tmpdir(), 'fbnogit-')), '2026-01-01', '2026-12-31')).toEqual([]);
});

describe('projectRemote', () => {
  const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args]);
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'fbremote-')));
  git(outer, 'init', '-q');
  git(outer, 'remote', 'add', 'origin', 'https://bot:ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789@github.com/Org/Outer.git');
  // Like examples/demo-shop inside the feedback_tool repo: a plain folder, and a folder with its own repo.
  const plain = join(outer, 'examples', 'demo-shop');
  mkdirSync(plain, { recursive: true });
  const nested = join(outer, 'nested');
  mkdirSync(nested);
  git(nested, 'init', '-q');
  git(nested, 'remote', 'add', 'origin', '/Users/x/repos/Nested.git');

  test('reads and normalizes the origin of a repo root, dropping credentials', async () => {
    expect(await projectRemote(outer)).toBe('github.com/org/outer');
  });

  test('a folder inside another repo does not inherit its remote', async () => {
    expect(await projectRemote(plain)).toBeNull();
  });

  test('a nested repo has its own remote', async () => {
    expect(await projectRemote(nested)).toBe('local/nested');
  });

  test('no origin, no repo, missing path or a symlink gives null', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'fbnoorigin-'));
    git(bare, 'init', '-q');
    expect(await projectRemote(bare)).toBeNull();
    expect(await projectRemote(mkdtempSync(join(tmpdir(), 'fbnogit-')))).toBeNull();
    expect(await projectRemote(join(outer, 'missing'))).toBeNull();
    const link = join(mkdtempSync(join(tmpdir(), 'fblink-')), 'outer');
    symlinkSync(outer, link);
    expect(await projectRemote(link)).toBeNull();
  });
});

test('cachedRemote asks git once per folder until the entry expires, including for no remote', async () => {
  let now = 0;
  const calls: string[] = [];
  const remote = cachedRemote(async (p) => { calls.push(p); return p === '/a' ? 'local/a' : null; }, 1000, () => now);
  expect(await remote('/a')).toBe('local/a');
  expect(await remote('/b')).toBeNull();
  expect(await remote('/a')).toBe('local/a');
  expect(await remote('/b')).toBeNull();
  expect(calls).toEqual(['/a', '/b']);
  now = 1001;
  await remote('/a');
  expect(calls).toEqual(['/a', '/b', '/a']);
});

describe('the commits a session made: its branch, else its worktree', () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'fbgitb-'));
    execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
    commitAt(dir, '2026-10-01T09:00:00Z', 'base');
    execFileSync('git', ['-C', dir, 'branch', 'feat/cart']);
    execFileSync('git', ['-C', dir, 'branch', 'feat/other']);
    execFileSync('git', ['-C', dir, 'checkout', '-q', 'feat/cart']);
    commitAt(dir, '2026-10-02T10:00:00Z', 'cart total');
    execFileSync('git', ['-C', dir, 'checkout', '-q', 'feat/other']);
    commitAt(dir, '2026-10-02T11:00:00Z', 'someone else');
    execFileSync('git', ['-C', dir, 'checkout', '-q', 'main']);
    return dir;
  }
  const from = '2026-10-02T00:00:00Z';
  const to = '2026-10-03T00:00:00Z';
  const subjects = (c: { subject: string }[]) => c.map((x) => x.subject).sort();

  test("a session's branch: only that branch's commits; an unknown branch or none: every branch's", async () => {
    const dir = repo();
    expect(subjects(await commitsInWindow(dir, from, to, { branch: 'feat/cart' }))).toEqual(['cart total']);
    expect(subjects(await commitsInWindow(dir, from, to))).toEqual(['cart total', 'someone else']);
    expect(subjects(await commitsInWindow(dir, from, to, { branch: 'gone/branch' }))).toEqual(['cart total', 'someone else']);
  });

  test("no branch known, a worktree of its own: that worktree's commits; a mere subfolder is no worktree", async () => {
    const dir = repo();
    const wt = join(dir, '.worktrees', 'cart');
    execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', wt, 'feat/cart']);
    expect(subjects(await commitsInWindow(dir, from, to, { worktree: wt }))).toEqual(['cart total']);
    mkdirSync(join(dir, 'src'));
    expect(subjects(await commitsInWindow(dir, from, to, { worktree: join(dir, 'src') }))).toEqual(['cart total', 'someone else']);
  });
});
