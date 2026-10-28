import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { ActivityInput, Lesson } from '@fb/core';
import { repairV6Sources, safeRetainedOriginal, v6FalsePositiveMask } from './v6Recovery.ts';

test('restores only exact safe retained originals, never guesses masked wording or credentials', () => {
  for (const original of ['basic understanding', 'file:42:7: error: compiler failed', '"auth":"required"']) {
    const masked = v6FalsePositiveMask(original);
    expect(masked).not.toBe(original);
    expect(safeRetainedOriginal(masked, original)).toBe(true);
  }
  expect(safeRetainedOriginal('basic [REDACTED]', 'basic familiarity')).toBe(true);
  expect(safeRetainedOriginal('basic [REDACTED]', 'other wording')).toBe(false);
  expect(safeRetainedOriginal('basic [REDACTED]', 'basic [REDACTED]')).toBe(false);
  expect(safeRetainedOriginal('Basic [REDACTED]', 'Basic dXNlcjpwYXNzd29yZA==')).toBe(false);
});

test('queues real source-backed rebuilds, reports missing originals, preserves approval and runs once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fg-v6-repair-'));
  try {
    await writeFile(join(root, 'source.ts'), 'export const value = 1;');
    const cursors = new Map<string, string>();
    const facts = { redactionRepairCandidates: vi.fn(async (after: string) => after ? [] : [
      { id: 'a', projectKey: 'p', path: 'source.ts', docId: null },
      { id: 'b', projectKey: 'p', path: '../outside', docId: null },
      { id: 'c', projectKey: 'unselected', path: 'source.ts', docId: null },
      { id: 'd', projectKey: 'p', path: 'image', docId: 'intact-image' },
      { id: 'e', projectKey: 'p', path: 'masked-upload', docId: 'lost-original' },
    ]), requestFilesScan: vi.fn(async () => 1), requestScan: vi.fn(async () => ({} as never)) };
    const docs = { getCursor: async (k: string) => cursors.get(k) ?? null,
      setCursor: async (k: string, v: string) => { cursors.set(k, v); },
      queueRedactionRepair: vi.fn(async (id: string) => id === 'intact-image') };
    const lessons = [
      { id: 'lesson1', title: 'title', rule: 'basic [REDACTED]', appliesWhen: 'always', proposedAs: { rule: 'basic understanding' } },
      { id: 'lesson2', title: 'title', rule: '[REDACTED]', appliesWhen: 'always' },
    ] as Lesson[];
    const knowledge = { listLessons: vi.fn(async () => lessons), updateLesson: vi.fn(async () => ({ unscoped: false })), setLessonChecks: vi.fn(async () => true) };
    const activity = { record: vi.fn(async (_input: ActivityInput) => {}) };
    const deps = { facts, docs, knowledge, activity, projects: async () => [{ key: 'p', repoPath: root }] };
    expect(await repairV6Sources(deps)).toEqual({ suspectedFacts: 5, filesQueued: 1, uploadsQueued: 1, lessonsRestored: 1, lessonsNeedOriginal: 1, factsNeedOriginal: 3 });
    expect(facts.requestFilesScan).toHaveBeenCalledWith('p', ['source.ts']);
    expect(facts.requestScan).toHaveBeenCalledWith({ key: 'p', name: 'p', repoPath: root }, null);
    expect(knowledge.updateLesson).toHaveBeenCalledWith('lesson1', { rule: 'basic understanding' }, expect.anything());
    expect(knowledge.setLessonChecks).toHaveBeenCalledWith('lesson2', expect.arrayContaining([expect.objectContaining({ name: 'contradicts-evidence' })]));
    expect(activity.record.mock.calls[0][0]).toMatchObject({ subject: 'Redaction v6 source recovery scheduled' });
    expect(await repairV6Sources(deps)).toBe(null);
    expect(facts.requestScan).toHaveBeenCalledTimes(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
