import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { execResult } from '@fb/core/testing/exec';
import { capDiff, splitDiff } from './diff.ts';

// Diffs as git and diff -u really print them, for secret files whose names those tools decorate: git C-quotes a path
// with non-ASCII or a tab, and diff -u puts each file's date after a tab. check_before_done must leave each one out.
const SECRET = 'DB_PASS=Tr0ub4dor-horse-staple-9';
const dir = mkdtempSync(join(tmpdir(), 'fgdiffpaths-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Output of a command that exits 1 when the files differ, as diff does. */
async function out(cmd: string, args: string[], cwd: string) {
  const r = await execResult(cmd, args, { cwd, env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' } });
  if (r.status !== 0 && r.status !== 1) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function expectHidden(diff: string, path: string) {
  const files = splitDiff(diff);
  expect(files.map((f) => f.path)).toContain(path);
  const c = capDiff(diff, 50_000);
  expect(c.secret).toBe(files.filter((f) => f.secret).length);
  expect(c.secret).toBeGreaterThan(0);
  expect(c.text).not.toContain('Tr0ub4dor');
}

test('diff -u: a secret file is left out whatever date follows its name, on either side', async () => {
  const w = join(dir, 'plain');
  for (const d of ['old/config', 'new/config']) mkdirSync(join(w, d), { recursive: true });
  writeFileSync(join(w, 'old', '.env'), 'DB_PASS=old\n');
  writeFileSync(join(w, 'new', '.env'), `${SECRET}\n`);
  writeFileSync(join(w, 'old', 'config', 'prod.env'), 'A=1\n');
  writeFileSync(join(w, 'new', 'config', 'prod.env'), `A=1\n${SECRET}\n`);
  writeFileSync(join(w, 'notes.txt'), 'x\n');
  const one = await out('diff', ['-u', 'old/.env', 'new/.env'], w);
  expect(one).toMatch(/^--- old\/\.env\t/m);
  expectHidden(one, 'new/.env');
  // Only the new side is secret: a file renamed to .env.
  expectHidden(await out('diff', ['-u', 'notes.txt', 'new/.env'], w), 'new/.env');
  const tree = await out('diff', ['-ru', 'old', 'new'], w);
  expectHidden(tree, 'new/config/prod.env');
  expect(capDiff(tree, 50_000).secret).toBe(2);
});

test('git diff: a C-quoted secret path (non-ASCII, a tab) is left out', async () => {
  const w = join(dir, 'repo');
  mkdirSync(w);
  await out('git', ['init', '-q'], w);
  const tab = 'sec\tx';
  for (const d of ['café', tab]) {
    mkdirSync(join(w, d));
    writeFileSync(join(w, d, '.env'), 'DB_PASS=old\n');
  }
  await out('git', ['add', '-A'], w);
  await out('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], w);
  for (const d of ['café', tab]) writeFileSync(join(w, d, '.env'), `${SECRET}\n`);
  const diff = await out('git', ['diff'], w);
  expect(diff).toContain('"a/caf\\303\\251/.env"');
  expect(diff).toContain('"a/sec\\tx/.env"');
  expectHidden(diff, 'café/.env');
  expect(capDiff(diff, 50_000).secret).toBe(2);
  // git diff --no-index between two files prints the same quoting.
  writeFileSync(join(w, 'notes.txt'), 'x\n');
  expectHidden(await out('git', ['diff', '--no-index', 'notes.txt', `${tab}/.env`], w), `${tab}/.env`);
});
