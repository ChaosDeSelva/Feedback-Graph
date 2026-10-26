import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityInput } from '@fb/core';
import { expect, test } from 'vitest';
import { dataDirs, forgetDataFiles, withoutDataDirs } from './data.ts';
import { hasCodeFiles, listCodeFilesWithTotal } from './scan.ts';

const many = (dir: string, n: number, ext: string) => Array.from({ length: n }, (_, i) => `${dir}/${String(i).padStart(5, '0')}${ext}`);

test('data folders are told apart from code by their names, their size and their mix of extensions', () => {
  const paths = [
    'package.json', 'README.md', ...many('src/api', 50, '.ts'),
    // 28,000 session transcripts: the case from the field
    ...many('transcripts/2025', 28_000, '.json'),
    ...many('logs', 400, '.md'),
    // A module named data is code
    ...many('src/data', 250, '.ts'),
    // Fixture sets are data only when huge (they are low-value in the scan plan anyway)
    ...many('test/fixtures', 300, '.json'),
    ...many('data', 20, '.json'),
    // Docs are read, whatever their number under a few thousand
    ...many('docs', 300, '.md'),
    // A folder named for exported records is data, whatever follows the name
    ...many('exports-2024', 2500, '.json'),
  ];
  expect(dataDirs(paths)).toEqual([
    { dir: 'exports-2024', files: 2500 },
    { dir: 'logs', files: 400 },
    { dir: 'transcripts', files: 28_000 },
  ]);
  const kept = withoutDataDirs(paths);
  expect(kept.paths).toHaveLength(2 + 50 + 250 + 300 + 20 + 300);
  expect(kept.paths).toContain('src/data/00000.ts');
  expect(kept.dataDirs.map((d) => d.dir)).toContain('transcripts');
  expect(dataDirs(['package.json', ...many('src', 30, '.ts')])).toEqual([]);
});

test('content is not data: decision records, game content, docs and code under data-like names are kept', () => {
  const paths = [
    'package.json', ...many('src', 30, '.ts'),
    // Architecture decision records: Markdown, under a records/ or history/ name
    ...many('docs/records', 260, '.md'), ...many('history', 230, '.md'),
    // Game content definitions: hundreds of JSON and YAML files under data/
    ...many('data/items', 150, '.json'), ...many('data/quests', 120, '.yaml'),
    // Real code under data-ish names, in languages the old list did not know
    ...many('logs', 220, '.scala'), ...many('services/data', 240, '.dart'),
    // A strong log name holding source is code, too
    ...many('exports/src', 210, '.ex'),
  ];
  expect(dataDirs(paths)).toEqual([]);
  // A data/ folder of JSON is excluded only when very large; a dumps/ or logs/ folder of it at the usual size.
  expect(dataDirs([...many('data/snapshots', 2500, '.json'), ...many('dumps', 300, '.json'), ...many('records', 300, '.yaml')])).toEqual([
    { dir: 'data', files: 2500 },
    { dir: 'dumps', files: 300 },
  ]);
});

test('a project of mostly transcripts lists only its code, and says what it left out; one of only transcripts has nothing to scan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbdata-'));
  const w = (p: string, c: string) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  w('package.json', '{}');
  for (let i = 0; i < 5; i++) w(`src/m${i}.ts`, `export const m${i} = ${i};\n`);
  for (const p of many('transcripts', 250, '.md')) w(p, '# session\n');
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  const r = await listCodeFilesWithTotal(dir, { maxBytes: 80_000, maxFiles: null });
  expect(r.files.map((f) => f.path).sort()).toEqual(['package.json', 'src/m0.ts', 'src/m1.ts', 'src/m2.ts', 'src/m3.ts', 'src/m4.ts']);
  expect(r.dataDirs).toEqual([{ dir: 'transcripts', files: 250 }]);

  const only = mkdtempSync(join(tmpdir(), 'fbdata-'));
  for (const p of many('transcripts', 250, '.md')) { mkdirSync(join(only, 'transcripts'), { recursive: true }); writeFileSync(join(only, p), '# s\n'); }
  expect(await hasCodeFiles(only)).toBe(false);
});

test('files a scan read in data folders before this rule are forgotten at start (once there is nothing left, nothing is done), so status stops asking to rescan them', async () => {
  const stored = new Map([...many('transcripts', 3000, '.json'), 'package.json', ...many('src', 40, '.ts')].map((p) => [p, 'h']));
  const removed: string[][] = [];
  const activity: ActivityInput[] = [];
  const facts = {
    fileHashes: async (k: string) => (k === 'demo' ? new Map(stored) : new Map<string, string>()),
    markFilesRemoved: async (_k: string, paths: string[]) => { removed.push(paths); for (const p of paths) stored.delete(p); },
  };
  const d = { facts, projects: async () => [{ key: 'demo', repoPath: '/repo' }, { key: 'other', repoPath: '/other' }], activity: { record: async (a: ActivityInput) => { activity.push(a); } } };
  expect(await forgetDataFiles(d)).toEqual({ files: 3000, projects: 1 });
  expect(removed.flat()).toHaveLength(3000);
  expect(removed.flat().every((p) => p.startsWith('transcripts/'))).toBe(true);
  expect(activity).toHaveLength(1);
  expect(activity[0]).toMatchObject({ projectKey: 'demo', actor: 'deterministic' });
  expect(activity[0].subject).toMatch(/3000 files in data folders/);
  expect(activity[0].details).toMatchObject({ dataDirs: [{ dir: 'transcripts', files: 3000 }] });
  expect(await forgetDataFiles(d)).toEqual({ files: 0, projects: 0 });
  expect(activity).toHaveLength(1);
});
