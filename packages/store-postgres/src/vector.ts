/**
 * Nearest-neighbour searches. Each HNSW index (0001_init.sql) covers `(embedding::vector(<dims>))` for rows with
 * `vector_dims(embedding) = <dims>`, so a query can only use it by repeating exactly that cast and that filter, with
 * the dimension as a literal (a parameter would not match the partial index's predicate). A query vector of another
 * length (an older model's) has no index and falls back to an exact scan with the same results.
 *
 * Searches filtered by project run with `hnsw.iterative_scan = relaxed_order`: when the index's first candidates
 * belong to other projects it keeps scanning instead of returning too few rows, and the outer ORDER BY puts the
 * relaxed order right. The planner still picks an exact scan when the filtered rows are few, which gives the same
 * answer. The score is Neo4j's vector.similarity.cosine, (1 + cos) / 2 = 1 - distance / 2.
 */
import type pg from 'pg';
import { toVector, tx, type Db } from './db.ts';

export type SqlQuery = { sql: string; params: unknown[] };

/** hnsw.iterative_scan, which every search sets, arrived in pgvector 0.8.0. */
export const MIN_PGVECTOR = '0.8.0';

/**
 * Why this pgvector cannot serve the searches, or null when it can. Older versions reserve the `hnsw.` prefix without
 * knowing iterative_scan, so every search would fail once the extension is loaded in a connection.
 */
export function pgvectorProblem(version: string | null): string | null {
  if (!version) return 'the pgvector extension (vector) is not installed in this database';
  const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const [have, need] = [parts(version), parts(MIN_PGVECTOR)];
  for (let i = 0; i < 3; i++) {
    if ((have[i] ?? 0) > need[i]) return null;
    if ((have[i] ?? 0) < need[i]) {
      return `the Postgres store needs pgvector ${MIN_PGVECTOR} or newer, found ${version}. Upgrade the extension on the server, then run ALTER EXTENSION vector UPDATE in this database (or use the bundled pgvector/pgvector:0.8.7-pg17 image)`;
    }
  }
  return null;
}

/** Refuse to start on a pgvector the searches cannot run on (see pgvectorProblem). */
export async function checkPgvector(db: Db): Promise<void> {
  const { rows } = await db.pool.query<{ v: string }>(`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`);
  const problem = pgvectorProblem(rows[0]?.v ?? null);
  if (problem) throw new Error(problem.replace(/^the/, 'The'));
}

/** pgvector's largest hnsw.ef_search. */
const MAX_EF_SEARCH = 1000;
const MIN_EF_SEARCH = 40;

/** The filter and distance for `col` against parameter `param`: the indexed form when the query has the indexed length. */
export function vectorTerms(db: Db, col: string, param: string, length: number): { where: string; distance: string } {
  const n = Math.trunc(length);
  if (Number.isInteger(db.dims) && db.dims > 0 && n === db.dims) {
    return { where: `vector_dims(${col}) = ${n}`, distance: `(${col}::vector(${n})) <=> ${param}::vector(${n})` };
  }
  return { where: `${col} IS NOT NULL AND vector_dims(${col}) = ${n}`, distance: `${col} <=> ${param}::vector` };
}

/** An embedding as a vector parameter; pgvector holds no empty vector, and a search for one finds nothing. */
const vectorParam = (v: number[]) => (v.length ? toVector(v) : null);

export function searchFactsQuery(db: Db, q: { embedding: number[]; projectKey: string; k: number }, columns: string): SqlQuery {
  const v = vectorTerms(db, 'f.embedding', '$2', q.embedding.length);
  return {
    sql: `SELECT ${columns}, cf.summary AS file_summary, 1 - x.distance / 2 AS score
          FROM (SELECT f.*, ${v.distance} AS distance FROM facts f
                WHERE f.project_key = $1 AND f.current AND ${v.where}
                ORDER BY ${v.distance}, f.id LIMIT $3) x
          LEFT JOIN code_files cf ON cf.id = x.code_file_id
          ORDER BY score DESC, x.id`,
    params: [q.projectKey, vectorParam(q.embedding), q.k],
  };
}

export function searchDocsQuery(db: Db, q: { embedding: number[]; projectKey: string; k: number }): SqlQuery {
  const v = vectorTerms(db, 'c.embedding', '$2', q.embedding.length);
  return {
    sql: `SELECT d.id AS doc_id, d.source, d.ref, d.title, d.url, x.text, 1 - x.distance / 2 AS score
          FROM (SELECT c.id, c.doc_id, c.text, ${v.distance} AS distance FROM chunks c
                WHERE c.project_key = $1 AND ${v.where}
                ORDER BY ${v.distance}, c.id LIMIT $3) x
          JOIN docs d ON d.id = x.doc_id
          ORDER BY score DESC, x.id`,
    params: [q.projectKey, vectorParam(q.embedding), q.k],
  };
}

export function searchLessonsQuery(db: Db, q: { embedding: number[]; projectKey: string | null; k: number; status?: string }): SqlQuery {
  const v = vectorTerms(db, 'l.embedding', '$1', q.embedding.length);
  return {
    sql: `SELECT x.*, 1 - x.distance / 2 AS score
          FROM (SELECT l.*, ${v.distance} AS distance FROM lessons l
                WHERE l.status = $2 AND (l.project_key IS NULL OR l.project_key = $3) AND ${v.where}
                ORDER BY ${v.distance}, l.id LIMIT $4) x
          ORDER BY score DESC, x.id`,
    params: [vectorParam(q.embedding), q.status ?? 'approved', q.projectKey, q.k],
  };
}

/** The k nearest misses first, then their feedback, as Neo4j does: a miss whose chain is broken drops out after the limit. */
export function relatedMissesQuery(db: Db, q: { embedding: number[]; projectKey: string | null; k: number }): SqlQuery {
  const v = vectorTerms(db, 'm.embedding', '$1', q.embedding.length);
  return {
    sql: `SELECT n.id, n.missed, n.cause, 1 - n.distance / 2 AS score, t.text, t.session_id, t.ts_text
          FROM (SELECT m.id, m.missed, m.cause, m.feedback_id, ${v.distance} AS distance FROM misses m
                WHERE ($2::text IS NULL OR m.project_key = $2) AND ${v.where}
                ORDER BY ${v.distance}, m.id LIMIT $3) n
          JOIN feedback f ON f.id = n.feedback_id JOIN turns t ON t.uuid = f.turn_uuid
          ORDER BY score DESC, n.id`,
    params: [vectorParam(q.embedding), q.projectKey, q.k],
  };
}

/** Run a search with iterative HNSW scans on (see the header), in its own transaction so the settings stay local. */
export async function runSearch(db: Db, query: SqlQuery, k: number): Promise<pg.QueryResultRow[]> {
  return tx(db, async (c) => {
    await c.query(`SET LOCAL hnsw.iterative_scan = relaxed_order`);
    await c.query(`SELECT set_config('hnsw.ef_search', $1, true)`, [String(Math.min(MAX_EF_SEARCH, Math.max(MIN_EF_SEARCH, Math.trunc(k))))]);
    return (await c.query(query.sql, query.params)).rows;
  });
}
