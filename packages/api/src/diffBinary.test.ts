import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { readRepoDiff, splitDiff } from './diff.ts';

const dir = mkdtempSync(join(tmpdir(), 'fg-diff-bin-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });

test('a changed binary file and one too big to diff are named in the diff, their content is not', async () => {
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  writeFileSync(join(dir, 'assets/data.json'), '{"rows":[]}\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'init');
  writeFileSync(join(dir, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9]));
  writeFileSync(join(dir, 'assets/data.json'), `{"rows":["${'BIGROW'.repeat(40_000)}"]}\n`);
  const r = await readRepoDiff(dir, ['assets/logo.png', 'assets/data.json']);
  expect(r).not.toBeNull();
  expect(splitDiff(r!.text).map((f) => f.path).sort()).toEqual(['assets/data.json', 'assets/logo.png']);
  expect(r!.text).toContain('diff --git a/assets/logo.png b/assets/logo.png\n(binary or over 200 KB: not shown)');
  expect(r!.text).toContain('diff --git a/assets/data.json b/assets/data.json\n(binary or over 200 KB: not shown)');
  expect(r!.text).not.toContain('BIGROW');
});
