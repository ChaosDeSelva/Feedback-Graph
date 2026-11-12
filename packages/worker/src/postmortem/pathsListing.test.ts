import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { junkPathReason, normalizeStoredPaths, repoFileList, repoHas, validateLessonPaths } from './paths.ts';

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

test('a stored path through a symlinked folder is in the repository: git lists the link, not what is under it', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'fg-list-link-'));
  await mkdir(join(repo, 'libs/shared/util'), { recursive: true });
  await writeFile(join(repo, 'libs/shared/util/format.ts'), '');
  await symlink('libs/shared', join(repo, 'shared'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const n = await normalizeStoredPaths(['shared/util/format.ts', 'shared/util/gone.ts'], { exists: (p) => repoHas(repo, p), repoFiles: () => repoFileList(repo) });
  expect(n.paths).toEqual(['shared/util/format.ts']);
  expect(n.dropped.map((d) => d.path)).toEqual(['shared/util/gone.ts']);
  // A link whose target is gone is not there.
  await symlink('libs/nowhere', join(repo, 'dangling'));
  expect(await repoHas(repo, 'dangling')).toBe(false);
});
