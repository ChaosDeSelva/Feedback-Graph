import { docIdOf, redactSecrets } from '@fb/core';
import type { DocHit, DocInput, DocSummary, DocsStore } from '@fb/core';
import { iso, toVector, tx, type Db } from './db.ts';
import { runSearch, searchDocsQuery } from './vector.ts';

/** Documents as embedded chunks, and integration sync cursors. */
export class PgDocsStore implements DocsStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** Insert or replace a document (same project + source + ref replaces its chunks). Returns the doc id. */
  async upsertDoc(input: DocInput, raw: { text: string; embedding: number[] }[]): Promise<string> {
    // Docs come from outside (uploads, PRs, tickets): redact here so no caller can skip it.
    const doc = { ...input, title: redactSecrets(input.title), ref: redactSecrets(input.ref) };
    const chunks = raw.map((c) => ({ ...c, text: redactSecrets(c.text) }));
    const id = docIdOf(doc);
    await tx(this.db, async (c) => {
      await c.query('INSERT INTO projects (key) VALUES ($1) ON CONFLICT DO NOTHING', [doc.projectKey]);
      await c.query(
        `INSERT INTO docs (id, project_key, source, ref, title, url, added_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET project_key = EXCLUDED.project_key, source = EXCLUDED.source, ref = EXCLUDED.ref,
           title = EXCLUDED.title, url = EXCLUDED.url, added_at = EXCLUDED.added_at`,
        [id, doc.projectKey, doc.source, doc.ref, doc.title, doc.url ?? null, new Date()],
      );
      await c.query('DELETE FROM chunks WHERE doc_id = $1', [id]);
      if (!chunks.length) return;
      await c.query(
        `INSERT INTO chunks (id, doc_id, project_key, idx, text, embedding)
         SELECT $1 || '#' || (n.ord - 1), $1, $2, n.ord - 1, n.text, n.embedding::vector
         FROM unnest($3::text[], $4::text[]) WITH ORDINALITY AS n(text, embedding, ord)`,
        [id, doc.projectKey, chunks.map((ch) => ch.text), chunks.map((ch) => toVector(ch.embedding))],
      );
    });
    return id;
  }

  async listDocs(projectKey: string): Promise<DocSummary[]> {
    const { rows } = await this.db.pool.query(
      `SELECT d.*, (SELECT count(*) FROM chunks c WHERE c.doc_id = d.id) AS chunks
       FROM docs d WHERE d.project_key = $1 ORDER BY d.added_at DESC, d.id`,
      [projectKey],
    );
    return rows.map((r) => ({
      id: r.id, projectKey: r.project_key, source: r.source, ref: r.ref, title: r.title, url: r.url ?? null,
      addedAt: iso(r.added_at)!, chunks: r.chunks,
    }));
  }

  async deleteDoc(id: string): Promise<boolean> {
    // Chunks go with their doc (ON DELETE CASCADE).
    const { rowCount } = await this.db.pool.query('DELETE FROM docs WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  async searchDocs(q: { embedding: number[]; projectKey: string; k: number }): Promise<DocHit[]> {
    // The project's chunks, nearest first, through the HNSW index when it pays (see vector.ts).
    const rows = await runSearch(this.db, searchDocsQuery(this.db, q), q.k);
    return rows.map((r) => ({ docId: r.doc_id, source: r.source, ref: r.ref, title: r.title, url: r.url ?? null, text: r.text, score: r.score }));
  }

  /** Small key/value store for integration sync cursors (e.g. last GitHub sync time per project). */
  async getCursor(key: string): Promise<string | null> {
    const { rows: [r] } = await this.db.pool.query('SELECT value FROM sync_cursors WHERE key = $1', [key]);
    return r ? r.value : null;
  }

  async setCursor(key: string, value: string): Promise<void> {
    await this.db.pool.query(
      'INSERT INTO sync_cursors (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, value],
    );
  }
}
