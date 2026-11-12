import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { junkPathReason, repoFileList, validateLessonPaths } from './paths.ts';

test('a git repository lists what git tracks, and a second ask within minutes is answered from the first', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'fg-list-git-'));
  await mkdir(join(repo, 'api'));
  await writeFile(join(repo, 'api/search.ts'), '');
  await writeFile(join(repo, '.gitignore'), 'dist/\n');
  await mkdir(join(repo, 'dist'));
  await writeFile(join(repo, 'dist/out.js'), '');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const first = repoFileList(repo);
  expect((await first)?.sort()).toEqual(['.gitignore', 'api/search.ts']);
  expect(repoFileList(repo)).toBe(first);
});

test('a glob that closes a brace before opening it is malformed', () => {
  expect(junkPathReason('src/}a{.ts')).toBe('a malformed path or glob');
});

test('with no path the evidence supports, the files that fixed the miss stand in: a few as they are, many as their common folder', async () => {
  const ev = (fixed: string[]) => ({ named: '', touched: { edited: [], fixed }, transcript: true });
  expect((await validateLessonPaths([], ev(['api/a.ts', 'api/b.ts', 'api/c.ts', 'api/d/e.ts']))).paths).toEqual(['api/**']);
  expect((await validateLessonPaths([], ev(['api/a.ts', 'web/b.ts', 'db/c.sql', 'cmd/d.go']))).paths).toEqual([]);
});

test('a folder walk stops at the listing cap, across nested folders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fg-list-cap-'));
  await mkdir(join(dir, 'a'));
  for (const f of ['a/1.ts', 'a/2.ts', 'a/3.ts', 'b.ts', 'c.ts']) await writeFile(join(dir, f), '');
  const files = await repoFileList(dir, 2);
  expect(files).toHaveLength(2);
  expect(files!.every((f) => ['a/1.ts', 'a/2.ts', 'a/3.ts', 'b.ts', 'c.ts'].includes(f))).toBe(true);
});
