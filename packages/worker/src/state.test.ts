import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { FileState, INGEST_VERSION } from './state.ts';

test('changed() is true until marked, and again when size or mtime moves', () => {
  const st = new FileState(':memory:');
  expect(st.changed('/a', 10, 1)).toBe(true);
  st.mark('/a', 10, 1);
  expect(st.changed('/a', 10, 1)).toBe(false);
  expect(st.changed('/a', 11, 1)).toBe(true);
  expect(st.changed('/a', 10, 2)).toBe(true);
});

test('state survives reopening the same file', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'fbstate-')), 'w.sqlite');
  new FileState(path).mark('/a', 5, 5);
  expect(new FileState(path).changed('/a', 5, 5)).toBe(false);
});

test('transcript cursors are kept apart from memory-file marks, with when each was read', () => {
  const s = new FileState(':memory:');
  s.mark('/t/x/s1.jsonl', 1, 1); // marked by an older version that read every project
  expect(s.ingestState('/t/x/s1.jsonl', 1, 1)).toEqual({ changed: true, readAt: null, skipped: [] });
  s.markIngested('/t/x/s1.jsonl', 1, 1, 1000);
  expect(s.ingestState('/t/x/s1.jsonl', 1, 1)).toEqual({ changed: false, readAt: 1000, skipped: [] });
  expect(s.ingestState('/t/x/s1.jsonl', 2, 1).changed).toBe(true);
});

test('transcripts read by an older version (before touched files were recorded) are read once more', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'fbstate-')), 'w.sqlite');
  const old = new FileState(path);
  old.markIngested('/t/x/s1.jsonl', 1, 1, 1000);
  // what an older worker left: the same row with no version
  (old as unknown as { db: { exec(sql: string): void } }).db.exec('UPDATE ingested SET version = 0');
  old.close();
  const s = new FileState(path);
  expect(s.ingestState('/t/x/s1.jsonl', 1, 1)).toEqual({ changed: true, readAt: 1000, skipped: [] });
  s.markIngested('/t/x/s1.jsonl', 1, 1, 2000);
  expect(s.ingestState('/t/x/s1.jsonl', 1, 1)).toEqual({ changed: false, readAt: 2000, skipped: [] });
});

test('a state file from before ingest versions opens and treats its transcripts as unread by this version', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'fbstate-')), 'w.sqlite');
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE ingested (path TEXT PRIMARY KEY, size INTEGER, mtime REAL, read_at REAL)');
  raw.exec(`INSERT INTO ingested VALUES ('/t/a.jsonl', 1, 1, 5)`);
  raw.close();
  expect(new FileState(path).ingestState('/t/a.jsonl', 1, 1)).toEqual({ changed: true, readAt: 5, skipped: [] });
});

test('a transcript remembers the folders skipped in it as out of scope', () => {
  const s = new FileState(':memory:');
  s.markIngested('/t/a.jsonl', 1, 1, 10, { keys: ['demo', 'other'], skipped: ['other'] });
  expect(s.ingestState('/t/a.jsonl', 1, 1)).toEqual({ changed: false, readAt: 10, skipped: ['other'] });
});

test('forgetting folders drops the read marks of their transcripts and memory files, and only theirs', () => {
  const s = new FileState(':memory:');
  s.markIngested('/t/a.jsonl', 1, 1, 10, { keys: ['demo'], skipped: [] });
  s.markIngested('/t/b.jsonl', 1, 1, 10, { keys: ['keep'], skipped: ['demo'] });
  s.markIngested('/t/c.jsonl', 1, 1, 10, { keys: ['keep'], skipped: [] });
  s.markIngested('/t/old-demo.jsonl', 1, 1, 10); // from before keys were kept: the caller says whose it is
  s.markIngested('/t/old-keep.jsonl', 1, 1, 10);
  s.mark('/m/demo/memory/x.md', 1, 1, 'demo');
  s.mark('/m/keep/memory/x.md', 1, 1, 'keep');
  s.mark('/m/legacy-demo/memory/y.md', 1, 1);

  const legacy = (path: string) => (path.includes('demo') ? ['demo'] : ['keep']);
  expect(s.forget(['demo'], legacy)).toBe(5);
  for (const p of ['/t/a.jsonl', '/t/b.jsonl', '/t/old-demo.jsonl']) expect(s.ingestState(p, 1, 1).changed, p).toBe(true);
  for (const p of ['/t/c.jsonl', '/t/old-keep.jsonl']) expect(s.ingestState(p, 1, 1).changed, p).toBe(false);
  expect(s.changed('/m/demo/memory/x.md', 1, 1)).toBe(true);
  expect(s.changed('/m/legacy-demo/memory/y.md', 1, 1)).toBe(true);
  expect(s.changed('/m/keep/memory/x.md', 1, 1)).toBe(false);
});

test('settings round-trip', () => {
  const s = new FileState(':memory:');
  expect(s.getSetting('x')).toBeNull();
  s.setSetting('x', '3');
  expect(s.getSetting('x')).toBe('3');
});

test('a state file from before folder keys opens and keeps its marks', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'fbstate-')), 'w.sqlite');
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE files (path TEXT PRIMARY KEY, size INTEGER, mtime REAL)');
  raw.exec(`INSERT INTO files VALUES ('/m/x.md', 1, 1)`);
  raw.exec('CREATE TABLE ingested (path TEXT PRIMARY KEY, size INTEGER, mtime REAL, read_at REAL, version INTEGER NOT NULL DEFAULT 0)');
  raw.exec(`INSERT INTO ingested VALUES ('/t/a.jsonl', 1, 1, 5, ${INGEST_VERSION})`);
  raw.exec(`INSERT INTO ingested VALUES ('/t/old.jsonl', 1, 1, 5, ${INGEST_VERSION - 1})`);
  raw.exec('CREATE TABLE heads (path TEXT PRIMARY KEY, size INTEGER, cwd TEXT, human INTEGER)');
  raw.close();
  const s = new FileState(path);
  expect(s.changed('/m/x.md', 1, 1)).toBe(false);
  expect(s.ingestState('/t/a.jsonl', 1, 1)).toEqual({ changed: false, readAt: 5, skipped: [] });
  expect(s.ingestState('/t/old.jsonl', 1, 1).changed).toBe(true); // read by an older ingest: read again
  expect(s.getCwds('/c/r.jsonl')).toBeNull();
});

test('a Codex file keeps every cwd seen and how far it was scanned', () => {
  const s = new FileState(':memory:');
  expect(s.getCwds('/c/r.jsonl')).toBeNull();
  s.putCwds('/c/r.jsonl', 100, ['/w/a', '/w/b']);
  expect(s.getCwds('/c/r.jsonl')).toEqual({ scanned: 100, cwds: ['/w/a', '/w/b'] });
});
