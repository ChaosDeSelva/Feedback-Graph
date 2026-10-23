import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** nomic-embed-text, the default OLLAMA_EMBED_MODEL. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
/** pgvector's HNSW index takes `vector` columns of at most 2,000 dimensions. */
const MAX_INDEXED_DIMENSIONS = 2000;

/** Any fixed number: it only has to be the same in every process that migrates this schema. */
const LOCK_KEY = 0x4642_6d67; // "FBmg"

const FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

export type MigrateOptions = { embeddingDimensions?: number; dir?: string };

/** A migration's SQL with its placeholders filled in. Only {{embedding_dimensions}} exists. */
export function renderMigration(sql: string, o: { embeddingDimensions: number }): string {
  const d = o.embeddingDimensions;
  if (!Number.isInteger(d) || d < 1 || d > MAX_INDEXED_DIMENSIONS) {
    throw new Error(`embedding dimension must be a whole number from 1 to ${MAX_INDEXED_DIMENSIONS}, not ${d}`);
  }
  return sql.replaceAll('{{embedding_dimensions}}', String(d));
}

/** Migration ids (file names) in the order they apply. */
export async function migrationIds(dir = MIGRATIONS_DIR): Promise<string[]> {
  return (await readdir(dir)).filter((f) => FILE.test(f)).sort();
}

/**
 * Apply every migration not yet in schema_migrations, each in its own transaction, in file-name order. Returns the
 * ids applied by this call. An advisory lock makes the api and the worker starting together take turns: the second
 * waits, then finds nothing left to do.
 */
export async function migrate(pool: pg.Pool, o: MigrateOptions = {}): Promise<string[]> {
  const dir = o.dir ?? MIGRATIONS_DIR;
  const embeddingDimensions = o.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
      );
      const done = new Set((await client.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
      const applied: string[] = [];
      for (const id of await migrationIds(dir)) {
        if (done.has(id)) continue;
        const sql = renderMigration(await readFile(`${dir}/${id}`, 'utf8'), { embeddingDimensions });
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`migration ${id} failed: ${(err as Error).message}`, { cause: err });
        }
        applied.push(id);
      }
      return applied;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
