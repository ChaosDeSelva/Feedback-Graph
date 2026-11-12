import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { capDiff, citeDiff, readRepoDiff, readRepoPrNumbers, githubCommitPrLookup, splitDiff } from './diff.ts';

// A realistic two-file diff, as `git diff HEAD` prints it.
const ROUTE = `diff --git a/src/routes/orders.ts b/src/routes/orders.ts
index 3b18e51..a9c4f2d 100644
--- a/src/routes/orders.ts
+++ b/src/routes/orders.ts
@@ -1,9 +1,14 @@
 import type { ServerResponse } from 'node:http';
 import { db } from '../db.ts';
-import { sendJson, type Req } from '../http.ts';
+import { paginate, sendError, sendJson, type Req } from '../http.ts';

 export function listOrders(req: Req, res: ServerResponse) {
-  sendJson(res, 200, db.raw().list('orders'));
+  sendJson(res, 200, paginate(db.scoped(req.auth.orgId).list('orders'), req.query));
+}
+
+export function getOrder(req: Req, res: ServerResponse) {
+  const row = db.scoped(req.auth.orgId).get('orders', req.params.id);
+  if (!row) return sendError(res, 404, 'not_found', 'order not found');
+  sendJson(res, 200, row);
 }
@@ -20,4 +25,5 @@ export function orderTotals(req: Req, res: ServerResponse) {
   const rows = db.scoped(req.auth.orgId).list('orders');
-  sendJson(res, 200, rows.map(total));
+  sendJson(res, 200, rows.map(total).filter(Boolean));
 }
`;
const TEST = `diff --git a/test/orders.test.ts b/test/orders.test.ts
new file mode 100644
index 0000000..5d1c2e0
--- /dev/null
+++ b/test/orders.test.ts
@@ -0,0 +1,6 @@
+import { test } from 'node:test';
+import assert from 'node:assert/strict';
+
+test('another org cannot read an order', async () => {
+  assert.equal((await call('GET', '/orders/o1', { org: 'other' })).status, 404);
+});
`;
const ENV = `diff --git a/.env b/.env
index 1111111..2222222 100644
--- a/.env
+++ b/.env
@@ -1 +1 @@
-API_TOKEN=${'a'.repeat(30)}
+API_TOKEN=${'b'.repeat(30)}
`;

describe('splitDiff', () => {
  test('splits a unified diff into files and hunks', () => {
    const files = splitDiff(ROUTE + TEST);
    expect(files.map((f) => f.path)).toEqual(['src/routes/orders.ts', 'test/orders.test.ts']);
    expect(files[0].hunks.map((h) => h.header)).toEqual(['@@ -1,9 +1,14 @@', '@@ -20,4 +25,5 @@ export function orderTotals(req: Req, res: ServerResponse) {']);
    expect(files[1].hunks[0].lines[0]).toBe("+import { test } from 'node:test';");
  });

  test('a bare hunk with no git header still counts, under the +++ path', () => {
    const files = splitDiff('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n');
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('x.ts');
  });

  test('a removed "-- x" and an added "++ y" inside a hunk stay in it; a bare header after the hunk\'s last line starts a file', () => {
    const env = '--- a/.env\n+++ b/.env\n@@ -1,3 +1,3 @@\n A=1\n--- x\n+++ y\n+K=Wq9Lm2Rx7Tp4Zc\n';
    expect(splitDiff(env).map((f) => [f.path, f.secret])).toEqual([['.env', true]]);
    expect(capDiff(env, 50_000).text).not.toContain('Wq9Lm2Rx7Tp4Zc');
    const two = '--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1 @@\n a\n-b\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-c\n+d\n';
    expect(splitDiff(two).map((f) => f.path)).toEqual(['x.ts', 'y.ts']);
    // A miscounted hunk can hide the next file, never show one: a secret path starts a file wherever it is.
    const short = '--- a/x.ts\n+++ b/x.ts\n@@ -1,5 +1,5 @@\n a\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-K=1\n+K=Wq9Lm2Rx7Tp4Zc\n';
    expect(splitDiff(short).map((f) => [f.path, f.secret])).toEqual([['x.ts', false], ['.env', true]]);
  });
});

describe('capDiff', () => {
  test('keeps everything that fits and says nothing was cut', () => {
    const c = capDiff(ROUTE + TEST, 50_000);
    expect(c.text).toBe(ROUTE + TEST);
    expect(c.note).toBeNull();
    expect(c.shown).toEqual(['src/routes/orders.ts', 'test/orders.test.ts']);
  });

  test('a cut names the size and every file it did not show', () => {
    const c = capDiff(ROUTE + TEST, TEST.length + 10);
    expect(c.text).toBe(TEST);
    expect(c.omitted).toEqual(['src/routes/orders.ts']);
    expect(c.note).toMatch(/^diff cut to fit \([\d.]+ of [\d.]+ KB shown\), files not shown: src\/routes\/orders\.ts$/);
  });

  test('one file bigger than the budget keeps the hunks that fit and is named as partly shown', () => {
    const c = capDiff(ROUTE, 900);
    expect(c.text).toContain('@@ -1,9 +1,14 @@');
    expect(c.text).not.toContain('@@ -20,4 +25,5 @@');
    expect(c.note).toMatch(/files not shown: src\/routes\/orders\.ts \(partly\)/);
  });

  test('a secret file is never shown, and the note counts it without naming it', () => {
    const c = capDiff(ENV + TEST, 50_000);
    expect(c.text).toBe(TEST);
    expect(c.text).not.toContain('API_TOKEN');
    expect(c.note).toBe('1 secret file left out (never shown or named)');
    const fly = ENV.replaceAll('.env', '.fly/config.yml');
    const both = capDiff(ENV + fly + TEST, 50_000);
    expect(both.note).toBe('2 secret files left out (never shown or named)');
    expect(both.note).not.toMatch(/\.env|\.fly/);
  });

  test('over the budget, the files related to what is judged go first, then files_changed in its order, then the rest; the note names what was cut', () => {
    const file = (p: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-${'a'.repeat(60)}\n+${'b'.repeat(60)}\n`;
    const [a, b, c, e] = ['src/a.ts', 'src/b.ts', 'src/db/pool.ts', 'src/e.ts'].map(file);
    const budget = c.length + e.length + 5;
    const capped = capDiff(a + b + c + e, budget, { related: (p) => p.startsWith('src/db/'), changed: ['src/e.ts', 'src/b.ts'] });
    expect(capped.shown).toEqual(['src/db/pool.ts', 'src/e.ts']);
    expect(capped.text).toBe(c + e);
    expect(capped.omitted).toEqual(['src/b.ts', 'src/a.ts']);
    expect(capped.note).toMatch(/files not shown: src\/b\.ts, src\/a\.ts/);
    // Without a preference, diff order as before; with everything fitting, nothing moves.
    expect(capDiff(a + b + c + e, budget).shown).toEqual(['src/a.ts', 'src/b.ts']);
    expect(capDiff(a + b + c, 50_000, { related: (p) => p === 'src/db/pool.ts' }).text).toBe(a + b + c);
  });

  test('a file renamed, copied or deleted to or from a secret path is left out like an edit of one', () => {
    const body = '@@ -1 +1 @@\n-API_TOKEN=Zx81Kq0LmN7rT2vW\n+API_TOKEN=Gq7Lm2Xv9Rt4Kp1Z\n';
    const cases = [
      `diff --git a/config/prod.env b/config/prod.txt\nsimilarity index 90%\nrename from config/prod.env\nrename to config/prod.txt\n--- a/config/prod.env\n+++ b/config/prod.txt\n${body}`,
      `diff --git a/notes.txt b/.env\nsimilarity index 90%\nrename from notes.txt\nrename to .env\n--- a/notes.txt\n+++ b/.env\n${body}`,
      'diff --git a/.env b/env.bak\nsimilarity index 100%\nrename from .env\nrename to env.bak\n',
      `diff --git a/deploy/secrets.sh b/deploy/vars.sh\ncopy from deploy/secrets.sh\ncopy to deploy/vars.sh\n--- a/deploy/secrets.sh\n+++ b/deploy/vars.sh\n${body}`,
      `--- a/config/prod.env\n+++ /dev/null\n${body}`,
      `diff --git a/config/prod.env b/config/prod.env\n--- a/config/prod.env\n+++ b/config/prod.env\n${body}`,
    ];
    for (const d of cases) {
      expect(splitDiff(d).map((f) => f.secret)).toEqual([true]);
      const c = capDiff(d + TEST, 50_000);
      expect(c.text).toBe(TEST);
      expect(c.note).toBe('1 secret file left out (never shown or named)');
    }
    expect(splitDiff('--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n')[0]).toMatchObject({ path: 'old.ts', oldPath: 'old.ts', secret: false });
  });

  test('a secret file under a path git C-quotes (non-ASCII, a quote, a backslash, a tab) is recognised by its decoded path', () => {
    // `git diff --cached -M` in a repository with these files, with the default core.quotePath.
    const quoted = [
      'diff --git "a/back\\\\slash/.env" "b/back\\\\slash/.env"', 'index 162c541..51589e6 100644', '--- "a/back\\\\slash/.env"', '+++ "b/back\\\\slash/.env"',
      '@@ -1 +1 @@', '-TOKEN=x1', '+TOKEN=Zq8Wm2Rx7Lp4',
      'diff --git "a/cfg\\"x/.env" "b/cfg\\"x/.env"', 'deleted file mode 100644', 'index d0251ad..0000000', '--- "a/cfg\\"x/.env"', '+++ /dev/null',
      '@@ -1 +0,0 @@', '-DB_PASS=Hunter2pass!',
      'diff --git "a/donn\\303\\251es/.env" "b/donn\\303\\251es/notes.txt"', 'similarity index 100%', 'rename from "donn\\303\\251es/.env"',
      'rename to "donn\\303\\251es/notes.txt"',
      'diff --git "a/tab\\tdir/.env" "b/tab\\tdir/notes.md"', 'similarity index 75%', 'rename from "tab\\tdir/.env"', 'rename to "tab\\tdir/notes.md"',
      'index 79e16ff..ab1f5df 100644', '--- "a/tab\\tdir/.env"', '+++ "b/tab\\tdir/notes.md"', '@@ -1,2 +1,2 @@', ' A=1', '-K=1', '+K=Wq9Lm2Rx7Tp4',
      '',
    ].join('\n');
    const files = splitDiff(quoted);
    expect(files.map((f) => [f.oldPath, f.path, f.secret])).toEqual([
      ['back\\slash/.env', 'back\\slash/.env', true],
      ['cfg"x/.env', 'cfg"x/.env', true],
      ['données/.env', 'données/notes.txt', true],
      ['tab\tdir/.env', 'tab\tdir/notes.md', true],
    ]);
    const c = capDiff(quoted + TEST, 50_000);
    expect(c.text).toBe(TEST);
    expect(c.note).toBe('4 secret files left out (never shown or named)');
    expect(c.text).not.toContain('Hunter2pass');
  });

  test('a git header this cannot read starts a file of its own and is left out as secret', () => {
    const files = splitDiff(`${TEST}diff --git odd header\nrename from x/.env\nrename to x/env.txt\n`);
    expect(files.at(-1)).toMatchObject({ oldPath: 'x/.env', path: 'x/env.txt', secret: true });
    expect(files[0].secret).toBe(false);
    // Fail closed: a header it cannot read hides the file, whatever its lines name.
    const odd = `diff --git "a/caf\\303\\251/.env b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -0,0 +1 @@\n+DEPLOY_KEY=Zr4Wq8Ny2Xc6Vb0Mk3Jh\n`;
    expect(splitDiff(odd)[0].secret).toBe(true);
    const c = capDiff(odd + TEST, 50_000);
    expect(c.text).toBe(TEST);
    expect(c.note).toBe('1 secret file left out (never shown or named)');
  });

  test('secret values inside a shown file are redacted', () => {
    const key = `sk-ant-${'x'.repeat(40)}`;
    const c = capDiff(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const k = '';\n+const k = '${key}';\n`, 50_000);
    expect(c.text).not.toContain(key);
  });
});

describe('citeDiff', () => {
  const files = splitDiff(ROUTE + TEST);

  test('finds the file and hunk of a quoted line, with or without its +/- mark', () => {
    expect(citeDiff(files, "+  const row = db.scoped(req.auth.orgId).get('orders', req.params.id);")).toEqual({
      path: 'src/routes/orders.ts', hunk: '@@ -1,9 +1,14 @@', line: "+  const row = db.scoped(req.auth.orgId).get('orders', req.params.id);",
    });
    expect(citeDiff(files, "db.raw().list('orders')")?.line).toBe("-  sendJson(res, 200, db.raw().list('orders'));");
    expect(citeDiff(files, "test('another org cannot read an order'")?.path).toBe('test/orders.test.ts');
  });

  test('a hunk header is not evidence', () => {
    expect(citeDiff(files, '@@ -20,4 +25,5 @@')).toBeNull();
  });

  test('a quote that is not in the diff, or too short to mean anything, cites nothing', () => {
    expect(citeDiff(files, 'rateLimit(req)')).toBeNull();
    expect(citeDiff(files, '}')).toBeNull();
    expect(citeDiff(files, '')).toBeNull();
    // A file header is not evidence about the code.
    expect(citeDiff(files, '+++ b/src/routes/orders.ts')).toBeNull();
  });

  test('every line of a multi-line quote must be in the diff', () => {
    expect(citeDiff(files, "if (!row) return sendError(res, 404, 'not_found', 'order not found');\n  sendJson(res, 200, row);")?.path).toBe('src/routes/orders.ts');
    expect(citeDiff(files, "if (!row) return sendError(res, 404, 'not_found', 'order not found');\n  rateLimit(req, res);")).toBeNull();
  });
});

describe('readRepoDiff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fg-diff-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'src/b.ts'), 'export const b = 1;\n');
  writeFileSync(join(dir, 'src/c.ts'), 'export const c = 1;\n');
  writeFileSync(join(dir, '.env'), 'X=1\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'init');

  test('staged, unstaged, new and just-committed changes to the named files, nothing else', async () => {
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n'); // unstaged
    writeFileSync(join(dir, 'src/b.ts'), 'export const b = 2;\n');
    git('add', 'src/b.ts'); // staged
    writeFileSync(join(dir, 'src/new.ts'), 'export const fresh = true;\n'); // untracked
    writeFileSync(join(dir, 'src/c.ts'), 'export const c = 2;\n');
    git('commit', '-qm', 'c', '--', 'src/c.ts'); // already committed this session
    writeFileSync(join(dir, 'src/other.ts'), 'not named\n');
    writeFileSync(join(dir, '.env'), 'X=2\n');
    const r = await readRepoDiff(dir, ['src/a.ts', 'src/b.ts', 'src/new.ts', 'src/c.ts', '.env', '../outside.ts']);
    expect(r).not.toBeNull();
    const files = splitDiff(r!.text).map((f) => f.path);
    expect(new Set(files)).toEqual(new Set(['src/a.ts', 'src/b.ts', 'src/new.ts', 'src/c.ts']));
    expect(r!.text).toContain('+export const a = 2;');
    expect(r!.text).toContain('+export const b = 2;');
    expect(r!.text).toContain('+export const fresh = true;');
    expect(r!.text).toContain('+export const c = 2;');
    expect(r!.text).not.toContain('X=2');
    expect(r!.text).not.toContain('not named');
    expect(r!.files).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts', 'src/new.ts', 'src/c.ts']));
  });

  test('an untracked link out of the repo is not read', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'fg-out-'));
    writeFileSync(join(outside, 'secret.ts'), 'outside the repo\n');
    symlinkSync(join(outside, 'secret.ts'), join(dir, 'src/link.ts'));
    const r = await readRepoDiff(dir, ['src/link.ts']);
    expect(r?.text ?? '').not.toContain('outside the repo');
    rmSync(outside, { recursive: true, force: true });
  });

  test('a filter, textconv or external diff the repo configures never runs', async () => {
    const evil = mkdtempSync(join(tmpdir(), 'fg-evil-'));
    const marks = mkdtempSync(join(tmpdir(), 'fg-marks-'));
    const g = (...a: string[]) => execFileSync('git', ['-C', evil, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
    mkdirSync(join(evil, 'src'));
    writeFileSync(join(evil, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(evil, 'src/b.ts'), 'export const b = 1;\n');
    g('init', '-q');
    g('add', '-A');
    g('commit', '-qm', 'init');
    // Attributes from every place git reads them, naming drivers whose commands would leave a marker.
    writeFileSync(join(evil, '.gitattributes'), '* filter=evil diff=evil\n');
    writeFileSync(join(evil, '.git/info/attributes'), '* filter=evil diff=evil\n');
    g('config', 'filter.evil.clean', `touch ${join(marks, 'clean')}; cat`);
    g('config', 'filter.evil.smudge', `touch ${join(marks, 'smudge')}; cat`);
    g('config', 'diff.evil.textconv', `touch ${join(marks, 'textconv')}; cat`);
    g('config', 'diff.evil.command', `touch ${join(marks, 'command')}; true`);
    g('config', 'diff.external', `touch ${join(marks, 'external')}; true`);
    // One file changed and committed today (git log -p), one changed in the working tree.
    writeFileSync(join(evil, 'src/b.ts'), 'export const b = 2;\n');
    execFileSync('git', ['-C', evil, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'filter.evil.clean=cat', 'commit', '-qam', 'b']);
    writeFileSync(join(evil, 'src/a.ts'), 'export const a = 2;\n');
    const r = await readRepoDiff(evil, ['src/a.ts', 'src/b.ts']);
    expect(readdirSync(marks)).toEqual([]);
    expect(r?.text).toContain('+export const a = 2;');
    expect(r?.text).toContain('+export const b = 2;');
    rmSync(evil, { recursive: true, force: true });
    rmSync(marks, { recursive: true, force: true });
  });

  test('a deleted file shows as removed', async () => {
    rmSync(join(dir, 'src/a.ts'));
    const r = await readRepoDiff(dir, ['src/a.ts']);
    expect(r?.text).toContain('deleted file');
    expect(r?.text).toContain('-export const a = 1;');
  });

  test('not a repo, or nothing named: null', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'fg-plain-'));
    expect(await readRepoDiff(plain, ['a.ts'])).toBeNull();
    expect(await readRepoDiff(dir, [])).toBeNull();
    rmSync(plain, { recursive: true, force: true });
  });
});

describe('readRepoPrNumbers', () => {
  test('recognizes merge and squash PR numbers for HEAD or the task commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-own-pr-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      git('commit', '--allow-empty', '-qm', 'Merge pull request #12 from acme/topic');
      const first = git('rev-parse', 'HEAD');
      git('commit', '--allow-empty', '-qm', 'Fix pagination (#34)');
      expect(await readRepoPrNumbers(dir, 'fix the current task')).toEqual([]);
      expect(await readRepoPrNumbers(dir, `review ${first}`)).toEqual([12]);
      expect(await readRepoPrNumbers(dir, 'review deadbeef')).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('GitHub commit associations', () => {
  const sha = 'a'.repeat(40);
  test('finds PRs for an ordinary commit, shares requests, and expires cached results', async () => {
    let calls = 0, time = 0;
    const lookup = githubCommitPrLookup((async (url, init) => {
      calls++;
      expect(String(url)).toContain(`/repos/acme/demo/commits/${sha}/pulls?`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
      return Response.json([{ number: 42 }, { number: 42 }, { number: -1 }]);
    }) as typeof fetch, () => time);
    expect(await Promise.all([lookup('acme/demo', sha, 'test-token'), lookup('acme/demo', sha, 'test-token')])).toEqual([[42], [42]]);
    expect(calls).toBe(1);
    time = 300_001;
    expect(await lookup('acme/demo', sha, 'test-token')).toEqual([42]);
    expect(calls).toBe(2);
  });
  test('bounds failures and retries after the short negative-cache period', async () => {
    let calls = 0, time = 0;
    const lookup = githubCommitPrLookup((async () => { calls++; throw new Error('offline'); }) as typeof fetch, () => time);
    expect(await lookup('acme/demo', sha, 'token')).toEqual([]);
    expect(await lookup('acme/demo', sha, 'token')).toEqual([]);
    expect(calls).toBe(1);
    time = 30_001;
    await lookup('acme/demo', sha, 'token');
    expect(calls).toBe(2);
    await lookup('../other', sha, 'token');
    expect(calls).toBe(2);
  });
  test('resolves an ordinary commit SHA before asking GitHub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-own-pr-api-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();
    try {
      git('init', '-q'); git('commit', '--allow-empty', '-qm', 'Implement search');
      const commit = git('rev-parse', 'HEAD');
      const seen: string[] = [];
      expect(await readRepoPrNumbers(dir, `review ${commit.slice(0, 8)}`, { associatedPulls: async (s) => { seen.push(s); return [99]; } })).toEqual([99]);
      expect(seen).toEqual([commit]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test('short literal evidence and complete meaningful changed lines are retained, not punctuation fragments', () => {
  const files = splitDiff('diff --git a/schema.ts b/schema.ts\n--- a/schema.ts\n+++ b/schema.ts\n@@ -1 +1,2 @@\n-key = old;\n+KeyPrefix = "005";\n+x=1\n');
  expect(citeDiff(files, '"005"')?.line).toBe('+KeyPrefix = "005";');
  expect(citeDiff(files, '005')?.line).toBe('+KeyPrefix = "005";');
  expect(citeDiff(files, '+x=1')?.line).toBe('+x=1');
  expect(citeDiff(files, '+=1')).toBe(null);
  expect(citeDiff(files, '+}')).toBe(null);
});

test('an explicit task PR is independent of an unrelated HEAD and works without a repository', async () => {
  expect(await readRepoPrNumbers('/not/a/repository', 'review PR #14194')).toEqual([14194]);
  expect(await readRepoPrNumbers('/not/a/repository', 'review https://github.com/acme/repo/pull/14194')).toEqual([14194]);
});
