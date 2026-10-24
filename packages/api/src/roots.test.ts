import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { normalizeRoots, rootsFile } from './roots.ts';

test('the roots file round-trips, is written whole, and one root per line (setup.sh reads it without Node)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-roots-'));
  const f = rootsFile(join(dir, 'project-roots.json'), () => '2026-10-24T00:00:00.000Z');
  expect(await f.read()).toBeNull();
  const saved = await f.write(['/Users/me/Vibe', '/Users/me/my projects']);
  expect(saved).toEqual({ roots: ['/Users/me/Vibe', '/Users/me/my projects'], updatedAt: '2026-10-24T00:00:00.000Z' });
  expect(await f.read()).toEqual(saved);
  expect(readFileSync(join(dir, 'project-roots.json'), 'utf8')).toBe(
    '{\n  "roots": [\n    "/Users/me/Vibe",\n    "/Users/me/my projects"\n  ],\n  "updatedAt": "2026-10-24T00:00:00.000Z"\n}\n',
  );
});

test('a damaged roots file reads as nothing saved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-roots-'));
  writeFileSync(join(dir, 'r.json'), '{"roots": [1, 2]');
  expect(await rootsFile(join(dir, 'r.json')).read()).toBeNull();
  writeFileSync(join(dir, 'r.json'), '{"roots": [1, 2]}');
  expect(await rootsFile(join(dir, 'r.json')).read()).toBeNull();
});

test('normalizeRoots trims, drops trailing slashes, expands ~ with the host home, and dedupes in order', () => {
  expect(normalizeRoots([' /a/b/ ', '~/c', '/a/b'], '/Users/me')).toEqual({ roots: ['/a/b', '/Users/me/c'] });
  // The whole home folder is never a root: containers see only the folders you choose.
  expect(normalizeRoots(['~'], '/Users/me')).toEqual({ error: expect.stringMatching(/home folder/) });
  expect(normalizeRoots(['/Users/me/'], '/Users/me')).toEqual({ error: expect.stringMatching(/home folder/) });
  expect(normalizeRoots(['~/c'], null)).toEqual({ error: expect.stringMatching(/absolute/) });
  expect(normalizeRoots(['/a/./b'], null)).toEqual({ error: expect.stringMatching(/\.\./) });
});
