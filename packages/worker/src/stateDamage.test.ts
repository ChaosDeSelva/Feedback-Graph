import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { FileState } from './state.ts';

test('a damaged folder list in the state file reads as empty instead of failing the read', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'fbstate-')), 'w.sqlite');
  const s = new FileState(path);
  s.markIngested('/t/broken.jsonl', 1, 1, 10, { keys: ['demo'], skipped: ['demo'] });
  s.markIngested('/t/object.jsonl', 1, 1, 10, { keys: ['demo'], skipped: ['demo'] });
  const raw = new DatabaseSync(path);
  raw.exec(`UPDATE ingested SET skipped = '{not json', keys = '{not json' WHERE path = '/t/broken.jsonl'`);
  raw.exec(`UPDATE ingested SET skipped = '{"demo":1}', keys = '"demo"' WHERE path = '/t/object.jsonl'`);
  raw.close();
  const again = new FileState(path);
  expect(again.ingestState('/t/broken.jsonl', 1, 1).skipped).toEqual([]);
  expect(again.ingestState('/t/object.jsonl', 1, 1).skipped).toEqual([]);
  // With no readable keys, forgetting the folder can't tell they were its: both marks stay.
  expect(again.forget(['demo'], () => ['demo'])).toBe(0);
});

test('forgetting no folders forgets nothing', () => {
  const s = new FileState(':memory:');
  s.markIngested('/t/a.jsonl', 1, 1, 10, { keys: ['demo'] });
  expect(s.forget([], () => ['demo'])).toBe(0);
  expect(s.ingestState('/t/a.jsonl', 1, 1).changed).toBe(false);
});

test('a memory file from before folder keys that the caller cannot place is kept', () => {
  const s = new FileState(':memory:');
  s.mark('/m/unknown/memory/x.md', 1, 1);
  s.markIngested('/t/unknown.jsonl', 1, 1, 10);
  expect(s.forget(['demo'], () => null)).toBe(0);
  expect(s.changed('/m/unknown/memory/x.md', 1, 1)).toBe(false);
  expect(s.ingestState('/t/unknown.jsonl', 1, 1).changed).toBe(false);
});

test('the Codex copy-rule migration takes the folder with or without a trailing slash', () => {
  const s = new FileState(':memory:');
  s.markIngested('/codex/a.jsonl', 1, 1, 10);
  s.markIngested('/codexx/b.jsonl', 1, 1, 10);
  expect(s.migrateCodexCopyRule('/codex/')).toBe(1);
  expect(s.ingestState('/codex/a.jsonl', 1, 1).changed).toBe(true);
  expect(s.ingestState('/codexx/b.jsonl', 1, 1).changed).toBe(false);
});
