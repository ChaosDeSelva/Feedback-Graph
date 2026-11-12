import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { mirrorForAgent } from './mirror.ts';

function repoWith(files: string[], git: boolean) {
  const repo = mkdtempSync(join(tmpdir(), 'fb-mirror-src-'));
  for (const f of files) {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), f);
  }
  if (git) execFileSync('git', ['init', '-q', repo]);
  return repo;
}

const copied = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && !d.name.startsWith('.')).length;

test.each([['a git repo', true], ['a folder that is not one (walked)', false]])('the mirror of %s stops at the file cap', async (_what, git) => {
  const repo = repoWith(['a.ts', 'b.ts', 'c/d.ts', 'c/e.ts', 'f.ts'], git);
  const m = await mirrorForAgent(repo, mkdtempSync(join(tmpdir(), 'fb-mirror-parent-')), { maxFiles: 2 });
  expect(m.files).toBe(2);
  expect(copied(m.dir)).toBe(2);
  await m.dispose();
  expect(existsSync(m.dir)).toBe(false);
});

test('a file whose mirrored path is too long is left out; the rest of the repo is still mirrored', async () => {
  // The mirror's folder is longer than the repo's, so a deep file fits under the repo and not under the mirror.
  const limit = process.platform === 'darwin' ? 1024 : 4096;
  let parent = mkdtempSync(join(tmpdir(), 'fb-mirror-parent-'));
  while (parent.length < limit - 300) parent = join(parent, 'p'.repeat(Math.min(200, limit - 300 - parent.length)));
  mkdirSync(parent, { recursive: true });
  const deep = Array.from({ length: 2 }, (_, i) => `${i}${'d'.repeat(150)}`).join('/') + '/deep.ts';
  const repo = repoWith(['src/a.ts', deep], true);
  const m = await mirrorForAgent(repo, parent);
  expect(m.files).toBe(1);
  expect(existsSync(join(m.dir, 'src/a.ts'))).toBe(true);
  await m.dispose();
});

test('a file with a non-ASCII name in a git repo is mirrored (git would quote it outside -z)', async () => {
  const repo = repoWith(['src/café.ts', 'src/a.ts'], true);
  const m = await mirrorForAgent(repo, mkdtempSync(join(tmpdir(), 'fb-mirror-parent-')));
  expect(existsSync(join(m.dir, 'src/café.ts'))).toBe(true);
  expect(m.files).toBe(2);
  await m.dispose();
});
