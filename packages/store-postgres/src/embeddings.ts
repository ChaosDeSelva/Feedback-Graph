import { LEGACY_EMBED_MODEL, type EmbeddingsStore } from '@fb/core';
import { toVector, type Db } from './db.ts';

/**
 * What each embedded table was embedded from; must match the texts the pipeline embeds (Neo4j's SOURCES in
 * packages/core/src/graph/embeddings.ts). `label` is what progress reports, as Neo4j does. Table names and
 * expressions are constants, never input.
 */
const SOURCES: { label: string; table: string; text: string; where?: string }[] = [
  { label: 'Lesson', table: 'lessons', text: `title || E'\\n' || rule || E'\\nApplies when: ' || coalesce(applies_when, '')` },
  { label: 'Miss', table: 'misses', text: `missed || E'\\n' || coalesce(cause_explanation, '')` },
  { label: 'Fact', table: 'facts', text: `path || ': ' || statement`, where: 'current' },
  { label: 'Chunk', table: 'chunks', text: 'text' },
];

const BATCH = 64;

/**
 * The embedding model of the stored vectors (graph_config row 'embedding'), and re-embedding everything with a new
 * one. Vectors of different models live in different spaces, so a changed model is refused until re-embedded.
 */
export class PgEmbeddingsStore implements EmbeddingsStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async stored(): Promise<string | null> {
    const { rows } = await this.db.pool.query(`SELECT model FROM graph_config WHERE id = 'embedding'`);
    return rows[0]?.model ?? null;
  }

  private async record(model: string) {
    await this.db.pool.query(
      `INSERT INTO graph_config (id, model, updated_at) VALUES ('embedding', $1, $2)
       ON CONFLICT (id) DO UPDATE SET model = EXCLUDED.model, updated_at = EXCLUDED.updated_at`,
      [model, new Date()],
    );
  }

  /** Records the model on first use; afterwards reports whether `model` matches the stored vectors. */
  async check(model: string): Promise<{ ok: boolean; stored: string }> {
    let stored = await this.stored();
    if (!stored) {
      // Vectors stored before the model was recorded came from the old default.
      const { rows } = await this.db.pool.query(
        `SELECT EXISTS (SELECT 1 FROM lessons WHERE embedding IS NOT NULL)
             OR EXISTS (SELECT 1 FROM misses WHERE embedding IS NOT NULL)
             OR EXISTS (SELECT 1 FROM facts WHERE embedding IS NOT NULL)
             OR EXISTS (SELECT 1 FROM chunks WHERE embedding IS NOT NULL) AS any`,
      );
      stored = rows[0].any ? LEGACY_EMBED_MODEL : model;
      await this.record(stored);
    }
    return { ok: stored === model, stored };
  }

  /**
   * Re-embed everything with `model`. Closed facts lose their vectors (they are never searched). Returns rows
   * re-embedded. Mark-and-sweep: every row is marked first, then a 'reembedding' row records the target model; a run
   * that stopped part way (crash, Ollama gone) is resumed by the next run for the same model, which skips the marking
   * and embeds only the rows still pending.
   */
  async reembed(model: string, embed: (texts: string[]) => Promise<number[][]>, progress?: (label: string, done: number) => void): Promise<number> {
    const q = (sql: string, params: unknown[] = []) => this.db.pool.query(sql, params);
    let total = 0;
    const { rows: running } = await q(`SELECT model FROM graph_config WHERE id = 'reembedding'`);
    if (running[0]?.model !== model) {
      await q(`UPDATE facts SET embedding = NULL WHERE NOT current AND embedding IS NOT NULL`);
      for (const s of SOURCES) {
        await q(`UPDATE ${s.table} SET reembed_pending = false WHERE reembed_pending`);
        await q(`UPDATE ${s.table} SET reembed_pending = true WHERE embedding IS NOT NULL ${s.where ? `AND ${s.where}` : ''}`);
      }
      await q(
        `INSERT INTO graph_config (id, model, updated_at) VALUES ('reembedding', $1, $2)
         ON CONFLICT (id) DO UPDATE SET model = EXCLUDED.model, updated_at = EXCLUDED.updated_at`,
        [model, new Date()],
      );
    }
    for (const s of SOURCES) {
      let done = 0;
      for (;;) {
        const { rows } = await q(`SELECT id, ${s.text} AS text FROM ${s.table} WHERE reembed_pending ORDER BY id LIMIT $1`, [BATCH]);
        if (!rows.length) break;
        const vectors = await embed(rows.map((r) => r.text ?? ''));
        // One statement per batch: every row of it lands with its flag cleared, or none does.
        await q(
          `UPDATE ${s.table} t SET embedding = v.e::vector, reembed_pending = false
           FROM unnest($1::text[], $2::text[]) AS v(id, e) WHERE t.id = v.id`,
          [rows.map((r) => r.id), rows.map((_, i) => toVector(vectors[i]))],
        );
        done += rows.length;
        progress?.(s.label, done);
      }
      total += done;
    }
    await this.record(model);
    await q(`DELETE FROM graph_config WHERE id = 'reembedding'`);
    return total;
  }
}
