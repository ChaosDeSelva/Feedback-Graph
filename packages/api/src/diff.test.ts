import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { capDiff, citeDiff, readRepoDiff, splitDiff } from './diff.ts';

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

  test('a secret file is never shown, and the note says it was left out', () => {
    const c = capDiff(ENV + TEST, 50_000);
    expect(c.text).toBe(TEST);
    expect(c.text).not.toContain('API_TOKEN');
    expect(c.note).toBe('secret files left out: .env');
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

  test('a hunk header cites that hunk', () => {
    expect(citeDiff(files, '@@ -20,4 +25,5 @@')?.hunk).toMatch(/^@@ -20,4 \+25,5 @@/);
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
