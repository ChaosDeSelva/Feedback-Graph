import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { gitChurn, hotScore, longCommentLines, scanOrder } from './priority.ts';

test('long explanatory comments are counted; short ones, code and markdown headings are not', () => {
  const ts = [
    '// x',
    '// The HTML5 parser ignores a self-closing slash on custom elements, so rewrite them to paired tags first.',
    '/**',
    ' * Pools are created lazily: the first query opens the pool, and a failed open is retried three times.',
    ' */',
    'const a = 1; // trailing notes are not counted as a block',
    '# not a comment in TypeScript',
  ].join('\n');
  expect(longCommentLines('src/a.ts', ts)).toBe(2);
  expect(longCommentLines('svc/app.py', '# Retries are idempotent because every write carries a request id from the caller.\nx = 1\n')).toBe(1);
  expect(longCommentLines('README.md', '# A heading that is long enough to have many words in it for sure\n')).toBe(0);
  expect(longCommentLines('db/q.sql', '-- Rows are soft deleted: always filter on deleted_at being null in every query here.\n')).toBe(1);
});

test('the scan order puts files an agent asked for first, then files sessions edited, then hotspots, else the ranked order', () => {
  const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'].map((path) => ({ path }));
  const order = scanOrder(files, {
    requested: ['e.ts', 'missing.ts'],
    touched: ['f.ts'],
    churn: new Map([['c.ts', 12]]),
    prPaths: new Set(['d.ts']),
    comments: new Map([['b.ts', 30]]),
  });
  // c: churn 12 (score 3); b: 30 long comment lines (2); d: discussed in a PR (2), b before d in the ranked order.
  expect(order.map((f) => f.path)).toEqual(['e.ts', 'f.ts', 'c.ts', 'b.ts', 'd.ts', 'a.ts']);
  expect(scanOrder(files, {}).map((f) => f.path)).toEqual(files.map((f) => f.path));
  expect(hotScore('c.ts', { churn: new Map([['c.ts', 5]]) })).toBeCloseTo(1.5);
});

test('gitChurn counts the commits that touched each file recently; a folder that is not a repo has none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbchurn-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args]);
  git('init', '-q');
  mkdirSync(join(dir, 'src'));
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(dir, 'src/hot.ts'), `export const v = ${i};\n`);
    if (i === 0) writeFileSync(join(dir, 'src/cold.ts'), 'export {};\n');
    git('add', '-A');
    git('commit', '-q', '-m', `c${i}`);
  }
  expect(await gitChurn(dir)).toEqual(new Map([['src/hot.ts', 3], ['src/cold.ts', 1]]));
  expect(await gitChurn(mkdtempSync(join(tmpdir(), 'fbnogit-')))).toEqual(new Map());
});
