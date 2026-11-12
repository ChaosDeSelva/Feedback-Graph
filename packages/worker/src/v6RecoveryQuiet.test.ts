import { expect, test, vi } from 'vitest';
import type { ActivityInput } from '@fb/core';
import { repairV6Sources, V6_REPAIR_CURSOR } from './v6Recovery.ts';

test('an install with nothing the v6 rules damaged gets no all-zero recovery entry in Activity, and is not checked again', async () => {
  const cursors = new Map<string, string>();
  const activity = { record: vi.fn(async (_input: ActivityInput) => {}) };
  const d = {
    facts: { redactionRepairCandidates: vi.fn(async () => []), requestFilesScan: vi.fn(async () => 0), requestScan: vi.fn(async () => ({}) as never) },
    docs: { getCursor: async (k: string) => cursors.get(k) ?? null, setCursor: async (k: string, v: string) => { cursors.set(k, v); }, queueRedactionRepair: vi.fn(async () => false) },
    knowledge: { listLessons: vi.fn(async () => []), updateLesson: vi.fn(async () => ({ unscoped: false })), setLessonChecks: vi.fn(async () => true) },
    projects: async () => [],
    activity,
  };
  expect(await repairV6Sources(d)).toEqual({ suspectedFacts: 0, filesQueued: 0, uploadsQueued: 0, lessonsRestored: 0, lessonsNeedOriginal: 0, factsNeedOriginal: 0 });
  expect(activity.record).not.toHaveBeenCalled();
  expect(cursors.get(V6_REPAIR_CURSOR)).toBe('scheduled');
  expect(await repairV6Sources(d)).toBeNull();
});
