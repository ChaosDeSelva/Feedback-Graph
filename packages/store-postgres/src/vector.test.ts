import { expect, test } from 'vitest';
import type { Db } from './db.ts';
import { pgvectorProblem, searchDocsQuery, searchFactsQuery } from './vector.ts';

test('pgvector 0.8.0 and newer serve the searches; older versions and a missing extension are refused with why', () => {
  for (const ok of ['0.8.0', '0.8.7', '0.9.0', '0.10.1', '1.0.0']) expect(pgvectorProblem(ok)).toBeNull();
  for (const old of ['0.5.1', '0.7.4', '0.7.10']) expect(pgvectorProblem(old)).toMatch(new RegExp(`pgvector 0\\.8\\.0 or newer, found ${old.replaceAll('.', '\\.')}`));
  expect(pgvectorProblem(null)).toMatch(/not installed/);
});

test("a search leaves out other runs' sandbox records inside the nearest-k scan, before its LIMIT: chunks as facts", () => {
  const db = { dims: 3 } as Db;
  const inner = (sql: string) => sql.slice(sql.indexOf('(SELECT'), sql.indexOf('LIMIT'));
  expect(inner(searchFactsQuery(db, { embedding: [1, 0, 0], projectKey: 'demo', k: 2 }, 'x.id').sql)).toMatch(/NOT f\.sandbox OR f\.run/);
  const docs = searchDocsQuery(db, { embedding: [1, 0, 0], projectKey: 'demo', k: 2, run: 'sbx-1' });
  expect(inner(docs.sql)).toMatch(/NOT c\.sandbox OR c\.run IS NOT DISTINCT FROM \$4::text/);
  expect(docs.params[3]).toBe('sbx-1');
});
