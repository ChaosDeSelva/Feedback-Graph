import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { FileState } from '../state.ts';
import { cachedHead, readSessionHead } from './heads.ts';

const fx = (name: string) => join(import.meta.dirname, '../../../../fixtures', name);
const tmp = () => mkdtempSync(join(tmpdir(), 'fb-heads-'));

test('a Claude Code transcript head gives the first cwd, even after records that carry none', async () => {
  const dir = tmp();
  const p = join(dir, 's.jsonl');
  writeFileSync(p, [
    JSON.stringify({ type: 'summary', summary: 'x' }),
    JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }),
    JSON.stringify({ type: 'user', sessionId: 's', cwd: '/H/Vibe/demo/app', timestamp: 't' }),
  ].join('\n'));
  expect(await readSessionHead(p, 'claude')).toEqual({ cwd: '/H/Vibe/demo/app', human: true });
  expect(await readSessionHead(fx('transcripts/basic.jsonl'), 'claude')).toEqual({ cwd: '/Users/you/code/demo/app', human: true });
});

test('a Codex rollout head gives session_meta cwd and whether a human drove it', async () => {
  expect(await readSessionHead(fx('codex/normal.jsonl'), 'codex')).toEqual({ cwd: '/work/demo-shop', human: true });
  expect(await readSessionHead(fx('codex/subagent.jsonl'), 'codex')).toEqual({ cwd: '/work/demo-shop', human: false });
  expect(await readSessionHead(fx('codex/fork.jsonl'), 'codex')).toEqual({ cwd: '/work/demo-shop', human: false });
});

test('the earliest Codex format has no cwd in its meta: it comes from the environment context', async () => {
  expect(await readSessionHead(fx('codex/legacy-bare.jsonl'), 'codex')).toEqual({ cwd: '/work/demo-shop', human: true });
});

test('only the head is read: a first line over the cap still yields its cwd, and nothing past the cap is parsed', async () => {
  const dir = tmp();
  const p = join(dir, 'big.jsonl');
  const meta = { timestamp: 't', type: 'session_meta', payload: { id: 'x', cwd: '/H/Vibe/big', thread_source: 'user', base_instructions: { text: 'x'.repeat(3 * 1024 * 1024) } } };
  writeFileSync(p, JSON.stringify(meta) + '\n');
  expect(await readSessionHead(p, 'codex')).toEqual({ cwd: '/H/Vibe/big', human: true });
});

test('a symlink is never followed', async () => {
  const dir = tmp();
  const link = join(dir, 'link.jsonl');
  symlinkSync(fx('codex/normal.jsonl'), link);
  expect(await readSessionHead(link, 'codex')).toEqual({ cwd: null, human: false });
});

test('heads are cached by path and re-read only when the file shrank or had no cwd yet', async () => {
  const st = new FileState(':memory:');
  let reads = 0;
  const read = async () => { reads++; return { cwd: '/H/Vibe/a', human: true }; };
  const f = { path: '/t/a.jsonl', size: 10, mtimeMs: 1, source: 'claude' as const };
  await cachedHead(st, f, read);
  await cachedHead(st, { ...f, size: 20, mtimeMs: 2 }, read);
  expect(reads).toBe(1);
  await cachedHead(st, { ...f, size: 5, mtimeMs: 3 }, read);
  expect(reads).toBe(2);

  let n = 0;
  const empty = async () => { n++; return { cwd: null, human: true }; };
  const g = { path: '/t/b.jsonl', size: 0, mtimeMs: 1, source: 'claude' as const };
  await cachedHead(st, g, empty);
  await cachedHead(st, g, empty);
  expect(n).toBe(1);
  await cachedHead(st, { ...g, size: 50 }, empty);
  expect(n).toBe(2);
});
