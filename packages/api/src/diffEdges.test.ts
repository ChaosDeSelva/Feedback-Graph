import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { capDiff, githubCommitPrLookup, readRepoDiff, readRepoPrNumbers, splitDiff } from './diff.ts';

test('a diff that does not end in a newline keeps its last line as it was', () => {
  const [f] = splitDiff('diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b');
  expect(f.text.endsWith('+b')).toBe(true);
  expect(f.hunks[0].lines).toEqual(['-a', '+b']);
});

test('text that is not a diff is cut to the budget and the note says so', () => {
  const r = capDiff('x'.repeat(3000), 2048);
  expect(r).toEqual({ text: 'x'.repeat(2048), shown: [], omitted: [], secret: 0, note: 'diff cut at 2.0 KB' });
  expect(capDiff('short', 2048).note).toBeNull();
});

describe('readRepoDiff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fg-diff-edges-'));
  afterAll(() => { chmodSync(join(dir, 'locked.ts'), 0o644); rmSync(dir, { recursive: true, force: true }); });
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/a.ts'), 'a\n');
  writeFileSync(join(dir, 'locked.ts'), 'locked\n');
  writeFileSync(join(dir, '.gitignore'), 'build/\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'init');

  test('a new file git ignores is not part of the change', async () => {
    mkdirSync(join(dir, 'build'));
    writeFileSync(join(dir, 'build/out.js'), 'generated\n');
    expect(await readRepoDiff(dir, ['build/out.js'])).toBeNull();
  });

  test('a new file without a final newline shows every line', async () => {
    writeFileSync(join(dir, 'src/new.ts'), 'one\ntwo');
    const r = await readRepoDiff(dir, ['src/new.ts']);
    expect(r?.text).toContain('@@ -0,0 +1,2 @@\n+one\n+two\n');
  });

  test('a named folder is not a file: nothing to show', async () => {
    expect(await readRepoDiff(dir, ['src'])).toBeNull();
  });

  test.skipIf(process.getuid?.() === 0)('a tracked file the API cannot read shows as deleted rather than failing the check', async () => {
    chmodSync(join(dir, 'locked.ts'), 0o000);
    const r = await readRepoDiff(dir, ['locked.ts']);
    expect(r?.text).toContain('deleted file');
  });
});

test('a commit the task names that git cannot resolve asks GitHub about nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fg-own-pr-none-'));
  try {
    execFileSync('git', ['-C', dir, 'init', '-q']);
    const asked: string[] = [];
    expect(await readRepoPrNumbers(dir, 'review abcdef1234', { associatedPulls: async (s) => { asked.push(s); return [1]; } })).toEqual([]);
    expect(asked).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

describe('GitHub commit associations', () => {
  const sha = 'b'.repeat(40);
  test('a refused or malformed answer is no PRs; pages are read while GitHub links a next one', async () => {
    const answers = [new Response('', { status: 403 }), Response.json({ message: 'x' }),
      Response.json([{ number: 7 }], { headers: { link: '<https://api.github.com/x?page=2>; rel="next"' } }), Response.json([{ number: 8 }], { headers: { link: '<https://api.github.com/x?page=1>; rel="prev"' } })];
    let calls = 0;
    const lookup = githubCommitPrLookup((async () => answers[calls++]) as typeof fetch, () => 0);
    expect(await lookup('acme/a', sha, 't')).toEqual([]);
    expect(await lookup('acme/b', sha, 't')).toEqual([]);
    expect(await lookup('acme/c', sha, 't')).toEqual([7, 8]);
    expect(calls).toBe(4);
  });

  test('more than a thousand cached lookups forget the oldest', async () => {
    let calls = 0;
    const lookup = githubCommitPrLookup((async () => { calls++; return Response.json([{ number: 1 }]); }) as typeof fetch, () => 0);
    const shaN = (i: number) => i.toString(16).padStart(40, '0');
    for (let i = 0; i <= 1000; i++) await lookup('acme/demo', shaN(i), 't');
    expect(calls).toBe(1001);
    await lookup('acme/demo', shaN(1000), 't');
    expect(calls).toBe(1001);
    await lookup('acme/demo', shaN(0), 't');
    expect(calls).toBe(1002);
  });
});
