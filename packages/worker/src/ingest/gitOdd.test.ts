import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { commitsInWindow, projectRemote } from './git.ts';

const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fbgit-odd-')));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  return dir;
};
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

test("a commit with a malformed timezone keeps git's date text, and the other commits are not lost", async () => {
  const dir = repo();
  const env = { ...process.env, GIT_COMMITTER_DATE: '2023-11-14T22:00:00Z', GIT_AUTHOR_DATE: '2023-11-14T22:00:00Z', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-qm', 'good'], { env });
  // A commit object as some old tools wrote them: a +9999 offset, which git prints and Date cannot parse.
  const raw = join(dir, 'commit.txt');
  writeFileSync(raw, `tree ${git(dir, 'rev-parse', 'HEAD^{tree}')}\nauthor A <a@b> 1700000000 +0000\ncommitter A <a@b> 1700000000 +9999\n\nweird tz\n`);
  git(dir, 'update-ref', 'refs/heads/weird', git(dir, 'hash-object', '-t', 'commit', '-w', '--literally', raw));
  const commits = await commitsInWindow(dir, '2023-11-01T00:00:00Z', '2023-12-31T00:00:00Z');
  expect(commits.map((c) => c.subject).sort()).toEqual(['good', 'weird tz']);
  const weird = commits.find((c) => c.subject === 'weird tz')!;
  expect(weird.ts).toMatch(/\+99:99$/);
  expect(commits.find((c) => c.subject === 'good')!.ts).toBe('2023-11-14T22:00:00.000Z');
});

test('an origin named like a token, or one that is no remote at all, is no remote', async () => {
  const token = repo();
  git(token, 'remote', 'add', 'origin', 'https://github.com/org/ghp' + '_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8.git');
  expect(await projectRemote(token)).toBeNull();
  const blank = repo();
  git(blank, 'config', 'remote.origin.url', ' ');
  expect(await projectRemote(blank)).toBeNull();
});
