import { FileState } from '../state.ts';
import type { ClassifiableTurn, HumanTurn } from '@fb/core';
import { expect, test } from 'vitest';
import { runCycle } from '../cycle.ts';
import { describeTurn } from './classify.ts';

const external = {
  source: 'github' as const, kind: 'review_comment' as const, author: 'lead', url: 'u', thread: 'acme/shop#7', title: 'Add checkout', threadUrl: 'u',
  path: 'src/cart.ts', line: 3, diffHunk: null, branch: 'feat', createdAt: '2026-10-02T10:00:00Z', linkedSessionIds: [],
};
const comment: HumanTurn = {
  uuid: 'github:acme/shop#7/review_comment/1', sessionId: 'github:acme/shop#7', ts: '2026-10-02T10:00:00Z', index: 1,
  text: 'Could we use the existing price helper here?', precedingAssistantText: 'PR acme/shop#7 "Add checkout"\nOn src/cart.ts:3', precedingToolCalls: [], external,
};

test('a review comment is described to the classifier as a reviewer on agent work, with what it is about', () => {
  const d = describeTurn(comment);
  expect(d).toContain("reviewer's comment");
  expect(d).toContain('On src/cart.ts:3');
  expect(d).toContain('existing price helper');
  expect(d).not.toContain("AGENT'S TOOL CALLS");
});

test('a polite review comment the keyword prefilter misses still goes to the model', async () => {
  const calls: string[] = [];
  const saved: string[] = [];
  const turn: ClassifiableTurn = { ...comment, projectKey: 'shop' };
  await runCycle({
    listFiles: async () => [],
    readFile: async () => '',
    state: new FileState(':memory:'),
    repo: {
      upsertSession: async () => {},
      unclassifiedTurns: async () => (saved.length ? [] : [turn]),
      saveClassification: async (uuid, _c, cand) => { saved.push(uuid); return cand ? uuid : null; },
      recordClassifyFailure: async () => {},
    },
    roots: [],
    commits: async () => [],
    classify: async (t) => { calls.push(t.uuid); return { label: 'correction', confidence: 0.7, summary: 'reuse the price helper', signals: [] }; },
    classifyBatch: 5,
  });
  expect(calls).toEqual([comment.uuid]);
  expect(saved).toEqual([comment.uuid]);
});
