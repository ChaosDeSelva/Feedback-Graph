import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { claudeTranscriptFiles } from './claude.ts';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fg-claude-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test('lists the .jsonl transcripts one level down, as Claude sessions, never following links', async () => {
  await mkdir(join(dir, '-H-Vibe-demo', 'memory'), { recursive: true });
  await writeFile(join(dir, '-H-Vibe-demo', 's1.jsonl'), '{}\n');
  await writeFile(join(dir, '-H-Vibe-demo', 'notes.txt'), 'x');
  await writeFile(join(dir, 'top.jsonl'), '{}');
  await writeFile(join(dir, '-H-Vibe-demo', 'memory', 'deep.jsonl'), '{}');
  await writeFile(join(dir, 'outside.jsonl'), '{"a":1}');
  await symlink(join(dir, 'outside.jsonl'), join(dir, '-H-Vibe-demo', 'link.jsonl'));
  await mkdir(join(dir, '-H-Vibe-demo', 'dir.jsonl'));
  await symlink(join(dir, '-H-Vibe-demo'), join(dir, 'linked-project'));
  const files = await claudeTranscriptFiles(dir);
  expect(files).toEqual([{ path: join(dir, '-H-Vibe-demo', 's1.jsonl'), size: 3, mtimeMs: expect.any(Number), source: 'claude' }]);
});

test('a transcripts folder that does not exist (no Claude Code) lists nothing', async () => {
  expect(await claudeTranscriptFiles(join(dir, 'missing'))).toEqual([]);
});
