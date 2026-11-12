import type { ActivityInput, LessonInput } from '@fb/core';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { FileState } from '../state.ts';
import { feedbackForMemoryWrite, importMemories, memoryProjectKey, parseMemoryFile, projectKeyForDir } from './memory.ts';

const unnamed = '---\ndescription: keep copy plain\ntype: feedback\n---\nNo em dashes.';

function transcripts(dir: string, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'fbmem-'));
  mkdirSync(join(root, dir, 'memory'), { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(root, dir, 'memory', f), c);
  return root;
}

test('a memory file without a name field has an empty name, and its lesson is titled by its file', async () => {
  expect(parseMemoryFile(unnamed)?.name).toBe('');
  const root = transcripts('-Users-j-Vibe-AcmeShop', { 'plain-copy.md': unnamed });
  const lessons: LessonInput[] = [];
  let correlations = 0;
  await importMemories({
    transcriptsDir: root, roots: async () => [{ host: '/Users/j/Vibe', keys: ['AcmeShop'] }], state: new FileState(':memory:'),
    embed: async (t) => t.map(() => [1]), upsertLesson: async (l) => void lessons.push(l), beginCorrelation: () => void correlations++,
  });
  expect(lessons.map((l) => l.title)).toEqual(['plain-copy']);
  expect(correlations).toBe(1);
});

test('a duplicate memory without a name is reported by its file, with the feedback it repeats, and withdrawn', async () => {
  const root = transcripts('-Users-j-Vibe-AcmeShop', { 'plain-copy.md': unnamed });
  const activity: ActivityInput[] = [];
  const withdrawn: unknown[][] = [];
  expect(await importMemories({
    transcriptsDir: root, roots: async () => [{ host: '/Users/j/Vibe', keys: ['AcmeShop'] }], state: new FileState(':memory:'),
    embed: async (t) => t.map(() => [1]), upsertLesson: async () => {}, writtenAfterFeedback: async () => 'fb-9',
    withdrawDuplicate: async (...a) => void withdrawn.push(a), activity: { record: async (a) => void activity.push(a) },
  })).toBe(0);
  expect(withdrawn).toEqual([['memory:-Users-j-Vibe-AcmeShop/plain-copy.md', 'fb-9']]);
  expect(activity[0]).toMatchObject({ subject: 'skipped duplicate feedback memory: plain-copy', details: { duplicate: true, feedbackId: 'fb-9' }, targets: ['fb-9'] });
});

test('the deepest project wins whatever order the folders and roots are listed in', () => {
  expect(projectKeyForDir('-H-shop-web', '/H', ['shop', 'shop/web'])).toBe('shop/web');
  expect(projectKeyForDir('-H-shop-web', '/H', ['shop/web', 'shop'])).toBe('shop/web');
  const roots = [{ host: '/H', keys: ['shop'] }, { host: '/H/shop', keys: ['web'] }, { host: '/H', keys: ['shop/web/app'] }];
  expect(memoryProjectKey('/t/-H-shop-web-app/memory/a.md', '/t', roots)).toBe('shop__web__app'); // a nested repo's key
});

test('a file straight in the transcripts folder belongs to no project', () => {
  expect(memoryProjectKey('/t/a.md', '/t', [{ host: '/H', keys: ['shop'] }])).toBeNull();
});

test('a memory no session wrote after any feedback is no duplicate', async () => {
  const page = [{ id: 'c1', turnUuid: 't1' }];
  expect(await feedbackForMemoryWrite({
    listCandidates: async () => page as never,
    callsAfter: async () => ({ calls: [{ name: 'Edit', ts: 't', filePath: '/w/src/a.ts' }], laterTurns: 0, endedAt: null }),
  }, 'shop', '/t/x/memory/fix.md')).toBeNull();
});

test('a project with no Inbox items has no feedback a memory could repeat', async () => {
  expect(await feedbackForMemoryWrite({ listCandidates: async () => [], callsAfter: async () => null }, 'shop', '/t/x/memory/fix.md')).toBeNull();
});
