/**
 * Shared by every repository class: the connection, transactions, and the conversions between Postgres values and
 * the shapes the Neo4j store returns. Owned by the seam: change it only in coordination with every implementer.
 */
import pg from 'pg';
import pgvector from 'pgvector';
import { DEFAULT_EMBEDDING_DIMENSIONS } from './migrate.ts';

export type PostgresConfig = {
  /** postgres://user:password@host:port/database */
  url: string;
  /** Length of the vectors the HNSW indexes cover (the embedding model's). Default 768 (nomic-embed-text). */
  embeddingDimensions?: number;
  /** Pool size. Default 10. */
  max?: number;
};

/** What every repository class gets: the pool, and the indexed embedding length. */
export type Db = { readonly pool: pg.Pool; readonly dims: number };

const INT8 = 20;
const NUMERIC = 1700;

/** count(*) and bigint come back as numbers (not strings), as Neo4j integers do with disableLosslessIntegers. */
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === INT8 || oid === NUMERIC) return (v: string) => Number(v);
    return pg.types.getTypeParser(oid, format as 'text');
  }) as typeof pg.types.getTypeParser,
};

/**
 * A value with every NUL character (U+0000) removed from its strings, inside arrays and plain objects (jsonb) too,
 * keys included. Postgres text and jsonb cannot hold NUL; transcripts can (Neo4j stores it). Other values pass as is.
 */
export function stripNul(v: unknown): unknown {
  if (typeof v === 'string') return v.includes('\0') ? v.replaceAll('\0', '') : v;
  if (Array.isArray(v)) return v.map(stripNul);
  if (v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [stripNul(k), stripNul(x)]));
  }
  return v;
}

/** JSON text for a jsonb parameter, without NUL characters (JSON's \\u0000 escape is refused by jsonb too). */
export const toJson = (v: unknown): string => JSON.stringify(stripNul(v));

const plainQuery = pg.Client.prototype.query;

/**
 * Every query of the pool goes through this client, so no repository can forget it: parameters lose their NUL
 * characters before they are sent (pool.query and transactions alike). Submittables (cursors) pass untouched.
 */
class NulSafeClient extends pg.Client {}
NulSafeClient.prototype.query = function query(this: pg.Client, ...args: unknown[]) {
  const [config, values] = args;
  if (Array.isArray(values)) args[1] = values.map(stripNul);
  else if (config && typeof config === 'object' && typeof (config as { submit?: unknown }).submit !== 'function' && Array.isArray((config as { values?: unknown }).values)) {
    args[0] = { ...config, values: ((config as { values: unknown[] }).values).map(stripNul) };
  }
  return (plainQuery as (...a: unknown[]) => unknown).apply(this, args);
} as typeof plainQuery;

export function openDb(config: PostgresConfig): Db {
  const pool = new pg.Pool({ connectionString: config.url, max: config.max ?? 10, types, Client: NulSafeClient });
  // An idle client losing its connection must not crash the process; the next query reconnects.
  pool.on('error', () => {});
  return { pool, dims: config.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS };
}

/** Run fn in one transaction: all of its statements land, or none do (Neo4j's runInTransaction). */
export async function tx<T>(db: Db, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/** A timestamptz as the ISO string the Neo4j store holds (Date.toISOString()); null stays null. */
export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** A JS vector as a pgvector parameter ('[1,2,3]'). Pass it as $n::vector. */
export const toVector = (v: number[] | null | undefined): string | null => (v ? pgvector.toSql(v) : null);

/** A vector column read as text back into numbers. */
export const fromVector = (s: string | null | undefined): number[] | null => (s == null ? null : (pgvector.fromSql(s) as number[]));

export class NotImplementedError extends Error {}

/** What every method throws until its implementation lands: 'not implemented: <Class>.<method>'. */
export const notImplemented = (cls: string, method: string) => new NotImplementedError(`not implemented: ${cls}.${method}`);
