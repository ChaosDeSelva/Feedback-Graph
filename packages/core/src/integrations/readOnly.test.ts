import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// GitHub and Linear are only ever read. These pin it at the source, so a write cannot slip in unnoticed.
const src = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');

test('the GitHub client only sends GET requests', () => {
  const s = src('github.ts');
  expect(s).not.toMatch(/method\s*:/);
  expect(s).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
});

test('the Linear client sends GraphQL queries only, never a mutation', () => {
  const s = src('linear.ts');
  expect(s).not.toMatch(/\bmutation\b/i);
  // GraphQL goes over POST; that is the only method, and every operation in it is a query.
  expect(s.match(/method\s*:\s*'([A-Z]+)'/g)).toEqual(["method: 'POST'"]);
  const ops = [...s.matchAll(/`\s*(query|mutation|subscription)\b/g)].map((m) => m[1]);
  expect(ops.length).toBeGreaterThan(0);
  expect(new Set(ops)).toEqual(new Set(['query']));
});
