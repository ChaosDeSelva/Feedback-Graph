import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ActivityInput } from '@fb/core';
import { repairV6Sources, V6_REPAIR_CURSOR } from './v6Recovery.ts';

let root = '';
let outside = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fg-v6-edge-'));
  outside = await mkdtemp(join(tmpdir(), 'fg-v6-outside-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function deps(facts: Partial<Parameters<typeof repairV6Sources>[0]['facts']>) {
  const cursors = new Map<string, string>();
  const activity = { record: vi.fn(async (_a: ActivityInput) => {}) };
  return {
    activity,
    d: {
      facts: { requestFilesScan: vi.fn(async () => 1), requestScan: vi.fn(async () => ({}) as never), redactionRepairCandidates: async () => [], ...facts },
      docs: { getCursor: async (k: string) => cursors.get(k) ?? null, setCursor: async (k: string, v: string) => void cursors.set(k, v), queueRedactionRepair: async () => false },
      knowledge: { listLessons: async () => [], updateLesson: vi.fn(async () => ({ unscoped: false })), setLessonChecks: vi.fn(async () => true) },
      activity,
      projects: async () => [{ key: 'p', repoPath: root }],
    },
  };
}

test('a fact whose source is a folder, or a link out of the repository, is not rebuilt from it: its original is needed', async () => {
  await mkdir(join(root, 'src'));
  await writeFile(join(outside, 'secret.ts'), 'x');
  await symlink(join(outside, 'secret.ts'), join(root, 'escape.ts'));
  const t = deps({
    redactionRepairCandidates: async (after: string) => (after ? [] : [
      { id: 'a', projectKey: 'p', path: 'src', docId: null },
      { id: 'b', projectKey: 'p', path: 'escape.ts', docId: null },
    ]),
  });
  expect(await repairV6Sources(t.d)).toMatchObject({ suspectedFacts: 2, filesQueued: 0, factsNeedOriginal: 2 });
  expect(t.d.facts.requestFilesScan).not.toHaveBeenCalled();
  expect(t.activity.record.mock.calls[0][0].why).toMatch(/No lesson originals were restored\./);
});

test('with no repair candidates there is nothing to rebuild, no Activity entry, and the recovery runs once', async () => {
  const t = deps({});
  expect(await repairV6Sources(t.d)).toEqual({ suspectedFacts: 0, filesQueued: 0, uploadsQueued: 0, lessonsRestored: 0, lessonsNeedOriginal: 0, factsNeedOriginal: 0 });
  expect(await repairV6Sources(t.d)).toBeNull();
  expect(t.activity.record).not.toHaveBeenCalled();
});

test('a store that hands back the same page again stops the recovery instead of looping forever, and it is tried again', async () => {
  const t = deps({ redactionRepairCandidates: async () => [{ id: 'a', projectKey: 'p', path: 'gone.ts', docId: null }] });
  await expect(repairV6Sources(t.d)).rejects.toThrow('did not advance');
  expect(await t.d.docs.getCursor(V6_REPAIR_CURSOR)).toBeNull();
});
