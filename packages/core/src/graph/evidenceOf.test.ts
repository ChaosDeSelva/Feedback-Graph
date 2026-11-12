import { expect, test } from 'vitest';
import { evidenceOf } from './knowledge.ts';

test("evidenceOf: what was done, and a comment's file and diff lines, from the stored turn (JSON text in Neo4j, jsonb in Postgres)", () => {
  const ext = { source: 'github', path: 'api/users.ts', diffHunk: '@@ -1 +1 @@\n+SELECT 1' };
  expect(evidenceOf('changed the lookup', JSON.stringify(ext))).toEqual({ done: 'changed the lookup', commentPath: 'api/users.ts', diffHunk: ext.diffHunk });
  expect(evidenceOf(null, ext)).toEqual({ done: null, commentPath: 'api/users.ts', diffHunk: ext.diffHunk });
  expect(evidenceOf('', { source: 'linear' })).toEqual({ done: null, commentPath: null, diffHunk: null });
  expect(evidenceOf(undefined, null)).toEqual({ done: null, commentPath: null, diffHunk: null });
});
