import type { ActivityInput } from '@fb/core';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { memoryProjectKey, feedbackForMemoryWrite, importMemories, parseMemoryFile, projectKeyForDir } from './memory.ts';
import { FileState } from '../state.ts';

const feedbackMd = `---
name: no-em-dashes-in-copy
description: User forbids em/en dashes in any user-facing copy
metadata:
  node_type: memory
  type: feedback
---

Never use em dashes in user-facing copy.

**Why:** reads as AI boilerplate.
`;

test('parseMemoryFile reads nested metadata.type and the body', () => {
  const m = parseMemoryFile(feedbackMd);
  expect(m).toEqual({
    name: 'no-em-dashes-in-copy',
    description: 'User forbids em/en dashes in any user-facing copy',
    type: 'feedback',
    body: 'Never use em dashes in user-facing copy.\n\n**Why:** reads as AI boilerplate.',
  });
});

test('parseMemoryFile reads a top-level type and strips quotes', () => {
  const m = parseMemoryFile('---\nname: x\ndescription: "Quoted desc"\ntype: project\n---\nbody');
  expect(m).toMatchObject({ type: 'project', description: 'Quoted desc' });
  expect(parseMemoryFile('no frontmatter')).toBeNull();
});

test('projectKeyForDir maps encoded dirs (including subdirs) to the longest matching project', () => {
  const keys = ['AcmeShop', 'GameX_1.2.0', 'feedback_tool'];
  expect(projectKeyForDir('-Users-j-Vibe-AcmeShop-web', '/Users/j/Vibe', keys)).toBe('AcmeShop');
  expect(projectKeyForDir('-Users-j-Vibe-GameX-1-2-0', '/Users/j/Vibe', keys)).toBe('GameX_1.2.0');
  expect(projectKeyForDir('-Users-j-Vibe-feedback-tool', '/Users/j/Vibe', keys)).toBe('feedback_tool');
  expect(projectKeyForDir('-private-tmp-x', '/Users/j/Vibe', keys)).toBeNull();
});

test('importMemories upserts feedback memories as proposed project lessons, once per file version', async () => {
  const transcripts = mkdtempSync(join(tmpdir(), 'fbmem-'));
  const dir = join(transcripts, '-Users-j-Vibe-AcmeShop', 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'no-dashes.md'), feedbackMd);
  writeFileSync(join(dir, 'other.md'), '---\nname: o\ndescription: d\ntype: project\n---\nnot feedback');
  writeFileSync(join(dir, 'MEMORY.md'), 'index');
  const upserts: unknown[] = [];
  const deps = {
    transcriptsDir: transcripts,
    roots: async () => [{ host: '/Users/j/Vibe', keys: ['AcmeShop'] }],
    state: new FileState(':memory:'),
    embed: async (t: string[]) => t.map(() => [0.1]),
    upsertLesson: async (l: unknown) => { upserts.push(l); },
  };
  expect(await importMemories(deps)).toBe(1);
  expect(await importMemories(deps)).toBe(0);
  expect(upserts[0]).toMatchObject({
    id: 'memory:-Users-j-Vibe-AcmeShop/no-dashes.md',
    projectKey: 'AcmeShop',
    title: 'no-em-dashes-in-copy',
    appliesWhen: 'User forbids em/en dashes in any user-facing copy',
    scope: 'project',
    status: 'proposed',
    source: 'memory',
    embedding: [0.1],
  });
  expect((upserts[0] as { rule: string }).rule).toContain('Never use em dashes');

  // Its project's data deleted: forgetting the project's reads imports the memory again.
  expect(deps.state.forget(['AcmeShop'], () => null)).toBe(2);
  expect(await importMemories(deps)).toBe(1);
});

test('memoryProjectKey names the project a memory file was imported for, from its path', () => {
  const roots = [{ host: '/Users/j/Vibe', keys: ['AcmeShop', 'Acme'] }];
  expect(memoryProjectKey('/transcripts/-Users-j-Vibe-AcmeShop-sub/memory/x.md', '/transcripts', roots)).toBe('AcmeShop');
  expect(memoryProjectKey('/transcripts/-Users-j-Other/memory/x.md', '/transcripts', roots)).toBeNull();
  expect(memoryProjectKey('/elsewhere/x.md', '/transcripts', roots)).toBeNull();
});

test('MEMORY_AUTO_APPROVE: memories are imported as approved lessons, and the log says so', async () => {
  const transcripts = mkdtempSync(join(tmpdir(), 'fbmem-'));
  const dir = join(transcripts, '-Users-j-Vibe-AcmeShop', 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'no-dashes.md'), feedbackMd);
  const upserts: { status: string }[] = [];
  const activity: ActivityInput[] = [];
  await importMemories({
    transcriptsDir: transcripts, roots: async () => [{ host: '/Users/j/Vibe', keys: ['AcmeShop'] }], state: new FileState(':memory:'),
    embed: async (t: string[]) => t.map(() => [0.1]), upsertLesson: async (l) => { upserts.push(l); },
    activity: { record: async (a) => { activity.push(a); } }, autoApprove: true,
  });
  expect(upserts.map((u) => u.status)).toEqual(['approved']);
  expect(activity[0].why).toMatch(/MEMORY_AUTO_APPROVE/);
});

test('importMemories logs each imported memory: which file, and that you wrote it', async () => {
  const transcripts = mkdtempSync(join(tmpdir(), 'fbmem-'));
  const dir = join(transcripts, '-Users-j-Vibe-AcmeShop', 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'no-dashes.md'), feedbackMd);
  const activity: ActivityInput[] = [];
  await importMemories({
    transcriptsDir: transcripts, roots: async () => [{ host: '/Users/j/Vibe', keys: ['AcmeShop'] }], state: new FileState(':memory:'),
    embed: async (t: string[]) => t.map(() => [0.1]), upsertLesson: async () => {},
    activity: { record: async (a) => { activity.push(a); } },
  });
  expect(activity).toEqual([expect.objectContaining({
    kind: 'memory_imported', actor: 'memory-file', projectKey: 'AcmeShop', subject: 'lesson "no-em-dashes-in-copy" imported',
    targets: ['memory:-Users-j-Vibe-AcmeShop/no-dashes.md'],
  })]);
  expect(activity[0].why).toMatch(/feedback memory .*no-dashes\.md/);
  expect(activity[0].why).toMatch(/proposed: approve it in Lessons/);
  expect(activity[0].details).toMatchObject({ file: join(dir, 'no-dashes.md'), description: 'User forbids em/en dashes in any user-facing copy' });
});

function memoryDirs(...projects: string[]) {
  const transcripts = mkdtempSync(join(tmpdir(), 'fbmem-'));
  for (const p of projects) {
    const dir = join(transcripts, p, 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'no-dashes.md'), feedbackMd);
  }
  return transcripts;
}

const base = (transcripts: string) => ({
  transcriptsDir: transcripts,
  state: new FileState(':memory:'),
  embed: async (t: string[]) => t.map(() => [0.1]),
});

test('importMemories covers every project root, not just the first', async () => {
  const transcripts = memoryDirs('-Users-j-Vibe-AcmeShop', '-Users-j-feedback-tool-examples-demo-shop');
  const keys: string[] = [];
  await importMemories({
    ...base(transcripts),
    roots: async () => [{ host: '/Users/j/Vibe', keys: ['AcmeShop'] }, { host: '/Users/j/feedback_tool/examples', keys: ['demo-shop'] }],
    upsertLesson: async (l) => { keys.push(l.projectKey!); },
  });
  expect(keys.sort()).toEqual(['AcmeShop', 'demo-shop']);
});

test('importMemories skips projects outside INGEST_PROJECTS', async () => {
  const transcripts = memoryDirs('-Users-j-Vibe-AcmeShop', '-Users-j-Vibe-other-app');
  const keys: string[] = [];
  await importMemories({
    ...base(transcripts),
    roots: async () => [{ host: '/Users/j/Vibe', keys: ['AcmeShop', 'other-app'] }],
    includeProject: (k) => k === 'AcmeShop',
    upsertLesson: async (l) => { keys.push(l.projectKey!); },
  });
  expect(keys).toEqual(['AcmeShop']);
});

test('a memory file that vanishes mid-import does not stop the others', async () => {
  const transcripts = memoryDirs('-Users-j-Vibe-AcmeShop');
  symlinkSync('/nonexistent/gone.md', join(transcripts, '-Users-j-Vibe-AcmeShop', 'memory', 'a-gone.md'));
  const n = await importMemories({
    ...base(transcripts),
    roots: async () => [{ host: '/Users/j/Vibe', keys: ['AcmeShop'] }],
    upsertLesson: async () => {},
  });
  expect(n).toBe(1);
});


test('a memory written after an existing feedback event is not imported as a duplicate lesson', async () => {
  const transcripts = mkdtempSync(join(tmpdir(), 'fbmem-'));
  const dir = join(transcripts, '-Users-j-Vibe-AcmeShop', 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fix.md'), feedbackMd);
  let embedded = false;
  expect(await importMemories({
    transcriptsDir: transcripts, roots: async () => [{ host: '/Users/j/Vibe', keys: ['AcmeShop'] }], state: new FileState(':memory:'),
    embed: async () => { embedded = true; return [[1]]; }, upsertLesson: async () => { throw new Error('duplicate'); },
    writtenAfterFeedback: async (key, path) => key === 'AcmeShop' && path.endsWith('/memory/fix.md'),
  })).toBe(0);
  expect(embedded).toBe(false);
});


test('memory deduplication scans past 500 candidates, includes rejected/Codex events and recognizes shell writes', async () => {
  const first = Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, turnUuid: `t${i}`, status: 'confirmed', source: 'claude' }));
  const seen: unknown[] = [];
  const result = await feedbackForMemoryWrite({
    listCandidates: async (query) => { seen.push(query); return (query?.offset ? [{ id: 'old', turnUuid: 'old-turn', status: 'rejected', source: 'codex' }] : first) as never; },
    callsAfter: async (uuid) => ({ calls: uuid === 'old-turn' ? [{ name: 'exec_command', ts: 't', command: "python -c \"Path('/home/me/memory/fix.md').write_text('fixed')\"" }] : [], laterTurns: 1, endedAt: null }),
  }, 'demo', '/transcripts/project/memory/fix.md');
  expect(result).toBe('old');
  expect(seen).toEqual([{ projectKey: 'demo', limit: 500, offset: 0 }, { projectKey: 'demo', limit: 500, offset: 500 }]);
});

test('upgrade rechecks unchanged memories and withdraws a previously imported duplicate once', async () => {
  const transcripts = memoryDirs('-Users-j-Vibe-AcmeShop');
  const state = new FileState(':memory:');
  const path = join(transcripts, '-Users-j-Vibe-AcmeShop', 'memory', 'no-dashes.md');
  const fs = await import('node:fs/promises');
  const info = await fs.stat(path);
  state.mark(path, info.size, info.mtimeMs, 'AcmeShop');
  const withdrawn: unknown[] = [];
  const options = { ...base(transcripts), state, roots: async () => [{ host: '/Users/j/Vibe', keys: ['AcmeShop'] }],
    upsertLesson: async () => { throw new Error('duplicate'); }, writtenAfterFeedback: async () => 'source-feedback',
    withdrawDuplicate: async (...args: unknown[]) => { withdrawn.push(args); } };
  expect(await importMemories(options)).toBe(0);
  expect(withdrawn).toEqual([['memory:-Users-j-Vibe-AcmeShop/no-dashes.md', 'source-feedback']]);
  expect(await importMemories(options)).toBe(0);
  expect(withdrawn).toHaveLength(1);
});


test('feedback classified in a later worker cycle still withdraws an unchanged memory', async () => {
  const transcripts = memoryDirs('-Users-j-Vibe-AcmeShop');
  let classified = false;
  const withdrawn: string[] = [];
  const options = { ...base(transcripts), roots: async () => [{ host: '/Users/j/Vibe', keys: ['AcmeShop'] }],
    upsertLesson: async () => {}, writtenAfterFeedback: async () => classified ? 'late-feedback' : null,
    withdrawDuplicate: async (id: string) => { withdrawn.push(id); } };
  expect(await importMemories(options)).toBe(1);
  classified = true;
  expect(await importMemories(options)).toBe(0);
  expect(withdrawn).toEqual(['memory:-Users-j-Vibe-AcmeShop/no-dashes.md']);
});
