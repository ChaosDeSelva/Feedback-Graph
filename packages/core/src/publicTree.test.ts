import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// This repository is public. Example paths in tests, fixtures and docs use placeholder home folders, never a
// contributor's real one, and private planning documents live elsewhere.
const repo = join(import.meta.dirname, '../../..');
const PLACEHOLDER_USERS = new Set(['you', 'me', 'j', 'a', 'x', 'dev', 'H', 'test']);

function trackedFiles(): string[] | null {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    return null; // not a git checkout (e.g. a source tarball): nothing to check
  }
}

test('tracked files use placeholder home folders only', () => {
  const files = trackedFiles();
  if (!files) return;
  const found: string[] = [];
  for (const f of files) {
    if (f === 'pnpm-lock.yaml' || !existsSync(join(repo, f))) continue;
    const text = readFileSync(join(repo, f), 'utf8');
    for (const m of text.matchAll(/\/Users\/([A-Za-z0-9_.-]+)|-Users-([A-Za-z0-9_.]+)-/g)) {
      const user = m[1] ?? m[2];
      if (!PLACEHOLDER_USERS.has(user)) found.push(`${f}: ${m[0]}`);
    }
  }
  expect(found).toEqual([]);
});

test('no private planning documents are tracked', () => {
  const files = trackedFiles();
  if (!files) return;
  expect(files.filter((f) => f.startsWith('docs/strategy/'))).toEqual([]);
});
