import { expect, test } from 'vitest';
import type { ActivityInput, DetectedLink } from '@fb/core';
import { runLinkDetection } from './stage.ts';

const found: DetectedLink = { a: 'api', b: 'game', relation: 'depends_on', score: 0.9, evidence: [{ signal: 'manifest', detail: 'game depends on @me/api', path: 'package.json', from: 'game' }] };

function deps(newOnes: number, detected: DetectedLink[] = [found]) {
  const calls: unknown[][] = [];
  const activity: ActivityInput[] = [];
  return {
    calls,
    activity,
    d: {
      links: { replaceDetected: async (scanned: string[], f: DetectedLink[]) => { calls.push([scanned, f]); return newOnes; } },
      projects: async () => [{ key: 'game', repoPath: '/r/game', remote: null }, { key: 'api', repoPath: '/r/api', remote: null }],
      detect: async () => detected,
      activity: { record: async (a: ActivityInput) => { activity.push(a); } },
    },
  };
}

test('one round replaces the suggestions among the projects it looked at and logs the new ones', async () => {
  const t = deps(1);
  expect(await runLinkDetection(t.d)).toEqual({ found: 1, fresh: 1 });
  expect(t.calls).toEqual([[['game', 'api'], [found]]]);
  expect(t.activity[0]).toMatchObject({ kind: 'links_suggested', actor: 'deterministic', projectKey: null, subject: '1 new link suggestion: api ↔ game' });
});

test('nothing new is not logged; fewer than two projects is not a round', async () => {
  const t = deps(0);
  await runLinkDetection(t.d);
  expect(t.activity).toEqual([]);
  const one = deps(0);
  one.d.projects = async () => [{ key: 'game', repoPath: '/r/game', remote: null }];
  expect(await runLinkDetection(one.d)).toEqual({ found: 0, fresh: 0 });
  expect(one.calls).toEqual([]);
});
