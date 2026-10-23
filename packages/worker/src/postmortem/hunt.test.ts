import type { LinearIssue, PostMortemInput } from '@fb/core';
import { expect, test } from 'vitest';
import { huntContext } from './hunt.ts';

const input = {
  feedbackId: 'f1', projectKey: 'shop', repoPath: '/vibe/shop', cwd: '/vibe/shop', sessionId: 's1', note: null, turns: [],
  feedback: { uuid: 'f1', sessionId: 's1', ts: 't', index: 2, text: "orders list isn't scoped by org", precedingAssistantText: 'added GET /orders', precedingToolCalls: [] },
} as PostMortemInput;
const issue: LinearIssue = { identifier: 'ENG-7', title: 'Orders API', description: 'must be tenant scoped', url: 'https://linear.app/x/ENG-7', state: 'Todo', team: 'ENG', updatedAt: 't', comments: [] };

test('gathers code facts, doc excerpts and Linear tickets as lines for the post-mortem', async () => {
  const stored: string[] = [];
  const queries: string[] = [];
  const lines = await huntContext(input, {
    embed: async (t) => t.map(() => [1]),
    facts: { searchFacts: async () => [{ fact: { path: 'src/db.ts', statement: 'use db.scoped(orgId)' }, score: 0.9 } as never] },
    docs: {
      searchDocs: async () => [{ docId: 'd', source: 'github', ref: 'github:acme/shop#3', title: 'acme/shop#3: Customers', url: null, text: 'lead: scope every list', score: 0.8 }],
      upsertDoc: async (doc) => { stored.push(doc.ref); return 'id'; },
    },
    linear: { apiKey: 'k', search: async (o) => { queries.push(o.query); return [issue]; } },
  });
  expect(lines).toEqual([
    'code fact src/db.ts: use db.scoped(orgId)',
    'github github:acme/shop#3 (acme/shop#3: Customers): lead: scope every list',
    'linear ENG-7 (Orders API, Todo): must be tenant scoped',
  ]);
  expect(queries).toEqual(["orders list isn't scoped by org"]);
  // Linear search is workspace-wide: a hit informs this post-mortem only, never becomes a project doc served to agents.
  expect(stored).toEqual([]);
});

test('a failing source is skipped, the rest still come back', async () => {
  const lines = await huntContext(input, {
    embed: async (t) => t.map(() => [1]),
    facts: { searchFacts: async () => { throw new Error('index missing'); } },
    linear: { apiKey: 'k', search: async () => [issue] },
  });
  expect(lines).toEqual(['linear ENG-7 (Orders API, Todo): must be tenant scoped']);
});

test('every line handed to the post-mortem is redacted, titles included', async () => {
  const leaky = { ...issue, title: `key ghp_${'A'.repeat(36)}` };
  const lines = await huntContext(input, { embed: async (t) => t.map(() => [1]), linear: { apiKey: 'k', search: async () => [leaky] } });
  expect(lines.join('\n')).not.toContain('ghp_');
});
