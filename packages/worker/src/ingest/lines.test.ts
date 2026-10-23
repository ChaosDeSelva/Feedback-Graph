import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readLines } from './lines.ts';

const collect = async (it: AsyncIterable<string>) => { const out: string[] = []; for await (const l of it) out.push(l); return out; };

test('yields each line, CRLF or LF, including a last line without a newline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-lines-'));
  const p = join(dir, 'a.jsonl');
  writeFileSync(p, 'one\r\ntwo\nthree');
  expect(await collect(readLines(p))).toEqual(['one', 'two', 'three']);
});

test('a symlink is refused, not followed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-lines-'));
  writeFileSync(join(dir, 'real.jsonl'), 'secret\n');
  symlinkSync(join(dir, 'real.jsonl'), join(dir, 'link.jsonl'));
  await expect(collect(readLines(join(dir, 'link.jsonl')))).rejects.toThrow(/ELOOP|symbolic/i);
});
