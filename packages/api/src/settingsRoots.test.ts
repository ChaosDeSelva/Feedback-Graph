import type { ActivityInput } from '@fb/core';
import type { SavedRoots } from './roots.ts';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import type { SettingsDeps } from './settings.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const OWNER = 'owner-test-token-01234567890123456789';

test('saving the roots that are already mounted says nothing needs to restart', async () => {
  let saved: SavedRoots | null = { roots: ['/Users/me/work'], updatedAt: 'x' };
  const log: ActivityInput[] = [];
  const settings = {
    selection: { current: async () => ({ tracked: [], initialized: true, updatedAt: null }), candidates: async () => null, aliases: async () => new Map(), keysWithData: async () => [] },
    folders: async () => [],
    excluded: [],
    roots: ['/Users/me/Vibe'],
    hostHome: '/Users/me',
    savedRoots: { read: async () => saved, write: async (roots: string[]) => (saved = { roots, updatedAt: 'now' }) },
  } as unknown as SettingsDeps;
  const app = createApp(repo, { auth: { ownerToken: OWNER }, settings, activity: { removeRun: async () => 0, record: async (a) => { log.push(a); }, list: async () => [] } });
  // Back to the mounted folder after a pending change: it is added again (against what was saved) and in use already.
  const res = await app.request('/api/settings/roots', { method: 'PUT', headers: { authorization: `Bearer ${OWNER}`, 'x-fg-owner': 'true', 'content-type': 'application/json' }, body: JSON.stringify({ roots: ['~/Vibe'] }) });
  expect(res.status).toBe(200);
  expect(log).toEqual([expect.objectContaining({
    kind: 'roots_saved',
    subject: 'project roots saved: /Users/me/Vibe; added /Users/me/Vibe; removed /Users/me/work',
    why: 'you saved them in Settings; they are the folders already mounted, so nothing needs to restart',
  })]);
});
