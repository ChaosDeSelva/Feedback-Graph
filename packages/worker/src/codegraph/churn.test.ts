import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { churn } from './churn.ts';

const DAY = 86_400_000;

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'fbchurn-'));
  const git = (args: string[], daysAgo = 0) => {
    const date = new Date(Date.now() - daysAgo * DAY).toISOString();
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  };
  const w = (p: string, c: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  const body = (n: number) => Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i === 0 ? n : i};`).join('\n');
  git(['init', '-q']);
  w('a.ts', body(0)); w('old.ts', 'x'); w('sub/s.ts', 's');
  git(['add', '-A']); git(['commit', '-qm', 'old'], 100);
  w('a.ts', body(1));
  git(['commit', '-qam', 'edit a'], 10);
  mkdirSync(join(dir, 'src'));
  git(['mv', 'a.ts', 'src/b.ts']);
  git(['commit', '-qm', 'rename a -> b'], 5);
  w('src/b.ts', body(2)); w('c.ts', 'c'); w('sub/s.ts', 's2'); w('with space.ts', 'w');
  git(['add', '-A']); git(['commit', '-qm', 'edit b, add c'], 1);
  return dir;
}

test('churn counts commits per file within the window and follows renames to the current path', async () => {
  const dir = gitRepo();
  try {
    const c = await churn(dir, 30);
    expect([...c.keys()].sort()).toEqual(['c.ts', 'src/b.ts', 'sub/s.ts', 'with space.ts']);
    expect(c.get('src/b.ts')?.commits).toBe(3);
    expect(c.get('c.ts')?.commits).toBe(1);
    const last = Date.parse(c.get('src/b.ts')!.lastTs);
    expect(Math.abs(last - (Date.now() - DAY))).toBeLessThan(60_000);
    expect(c.get('src/b.ts')!.lastTs).toMatch(/Z$/);

    const all = await churn(dir, 365);
    expect(all.get('src/b.ts')?.commits).toBe(4);
    expect(all.get('old.ts')?.commits).toBe(1);

    // a subdirectory of the repo gets paths relative to itself, and only its own files
    const sub = await churn(join(dir, 'sub'), 365);
    expect([...sub.entries()].map(([p, v]) => [p, v.commits])).toEqual([['s.ts', 2]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('churn of a directory that is not a git repo is empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbchurn-nogit-'));
  expect((await churn(dir, 30)).size).toBe(0);
});
