import { expect, test } from 'vitest';
import type { Db } from './db.ts';
import { pgvectorProblem, relatedMissesQuery, searchDocsQuery, searchFactsQuery, searchLessonsQuery } from './vector.ts';

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

test('while the database holds no sandbox record the searches carry no run filter, and still name the run parameter', () => {
  const db = { dims: 3 } as Db;
  const q = { embedding: [1, 0, 0], projectKey: 'demo', k: 2, run: null };
  for (const sql of [
    searchFactsQuery(db, q, 'x.id', { sandbox: false }).sql,
    searchDocsQuery(db, q, { sandbox: false }).sql,
    searchLessonsQuery(db, q, { sandbox: false }).sql,
    relatedMissesQuery(db, q, { sandbox: false }).sql,
  ]) {
    expect(sql).not.toMatch(/\.sandbox/);
    expect(sql).toMatch(/\(true OR \$\d::text IS NULL\)/);
  }
});

test('lesson vector queries exclude no-miss flags without changing the stored approval', () => {
  const db = { vector: { kind: 'halfvec', dims: 768 } } as never;
  const sql = searchLessonsQuery(db, { embedding: [1], projectKey: 'demo', k: 5 }).sql;
  expect(sql).toContain('no-miss');
  expect(sql).toContain('NOT coalesce(l.checks @>');
});
