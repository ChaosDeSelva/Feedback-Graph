import { randomUUID } from 'node:crypto';
import { docIdOf, redactDeep, redactSecrets, relevanceOf, scanRetryAt, SCAN_UNAVAILABLE_WAIT_MS } from '@fb/core';
import type { DocHit, DocInput, DocSummary, DocsStore, DocToRead, EmbeddedFact, TaskImage, UpsertDocOpts } from '@fb/core';
import type pg from 'pg';
import { iso, toVector, tx, type Db } from './db.ts';
import { runSearch, searchDocsQuery } from './vector.ts';

/** Documents as embedded chunks, and integration sync cursors. */
export class PgDocsStore implements DocsStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** Insert or replace a document (same project + source + ref replaces its chunks). Returns the doc id. */
  async upsertDoc(input: DocInput, raw: { text: string; embedding: number[] }[], o: UpsertDocOpts = {}): Promise<string> {
    // Docs come from outside (uploads, PRs, tickets): redact here so no caller can skip it.
    const doc = { ...input, title: redactSecrets(input.title), ref: redactSecrets(input.ref) };
    const chunks = raw.map((c) => ({ ...c, text: redactSecrets(c.text) }));
    const id = docIdOf(doc);
    await tx(this.db, async (c) => {
      await c.query('INSERT INTO projects (key) VALUES ($1) ON CONFLICT DO NOTHING', [doc.projectKey]);
      await c.query(
        `INSERT INTO docs (id, project_key, source, ref, title, url, added_at, kind, media_type, read_status, read_attempts, read_error, read_retry_at, read_at, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, NULL, NULL, NULL, $11)
         ON CONFLICT (id) DO UPDATE SET project_key = EXCLUDED.project_key, source = EXCLUDED.source, ref = EXCLUDED.ref,
           title = EXCLUDED.title, url = EXCLUDED.url, added_at = EXCLUDED.added_at, added_by = EXCLUDED.added_by, kind = EXCLUDED.kind, media_type = EXCLUDED.media_type,
           read_status = EXCLUDED.read_status, read_attempts = 0, read_error = NULL, read_retry_at = NULL, read_at = NULL`,
        [id, doc.projectKey, doc.source, doc.ref, doc.title, doc.url ?? null, new Date(), o.image ? 'image' : 'text', o.image?.mediaType ?? null, o.read ? 'pending' : null, o.addedBy ?? null],
      );
      // A new version of the document: what was read from the old one goes.
      await c.query('DELETE FROM facts WHERE doc_id = $1', [id]);
      await c.query('DELETE FROM doc_blobs WHERE doc_id = $1', [id]);
      if (o.image) {
        await c.query('INSERT INTO doc_blobs (doc_id, project_key, media_type, data) VALUES ($1, $2, $3, $4)', [id, doc.projectKey, o.image.mediaType, Buffer.from(o.image.data, 'base64')]);
      }
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
      `SELECT d.*, (SELECT count(*) FROM chunks c WHERE c.doc_id = d.id) AS chunks,
              (SELECT count(*) FROM facts x WHERE x.doc_id = d.id AND x.current) AS facts
       FROM docs d WHERE d.project_key = $1 ORDER BY d.added_at DESC, d.id`,
      [projectKey],
    );
    return rows.map((r) => ({
      id: r.id, projectKey: r.project_key, source: r.source, ref: r.ref, title: r.title, url: r.url ?? null,
      addedAt: iso(r.added_at)!, addedBy: r.added_by ?? null, chunks: r.chunks, kind: r.kind, mediaType: r.media_type ?? null,
      read: r.read_status
        ? { status: r.read_status, attempts: r.read_attempts, error: r.read_error ?? null, retryAt: iso(r.read_retry_at), readAt: iso(r.read_at), facts: r.facts }
        : null,
    }));
  }

  async nextDocToRead(now = new Date()): Promise<DocToRead | null> {
    const { rows: [d] } = await this.db.pool.query(
      `SELECT d.*, b.media_type AS blob_type, encode(b.data, 'base64') AS blob_data,
              (SELECT string_agg(c.text, E'\n\n' ORDER BY c.idx) FROM chunks c WHERE c.doc_id = d.id) AS text
       FROM docs d LEFT JOIN doc_blobs b ON b.doc_id = d.id
       WHERE d.read_status = 'pending' AND (d.read_retry_at IS NULL OR d.read_retry_at <= $1)
       ORDER BY d.added_at, d.id LIMIT 1`,
      [now],
    );
    if (!d) return null;
    const image = d.blob_data ? { mediaType: d.blob_type, data: d.blob_data.replace(/\n/g, '') } : null;
    return { id: d.id, projectKey: d.project_key, ref: d.ref, title: d.title, kind: d.kind, text: image ? '' : d.text ?? '', image, attempts: d.read_attempts, version: iso(d.added_at)! };
  }

  async markDocReading(id: string, version?: string): Promise<boolean> {
    const { rowCount } = await this.db.pool.query(
      `UPDATE docs SET read_status = 'reading' WHERE id = $1 AND ($2::timestamptz IS NULL OR added_at = $2)`,
      [id, version ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  async saveDocReading(id: string, r: { version?: string; chunks?: { text: string; embedding: number[] }[]; facts: EmbeddedFact[]; source: string }): Promise<boolean> {
    // Model output about a document someone gave you: redact at the door, like code facts.
    const facts = redactDeep(r.facts);
    const now = new Date();
    return tx(this.db, async (c: pg.PoolClient) => {
      // Locked, so a re-upload either lands before (and the version no longer matches) or waits until this is saved.
      const { rows: [d] } = await c.query(
        'SELECT project_key, ref FROM docs WHERE id = $1 AND ($2::timestamptz IS NULL OR added_at = $2) FOR UPDATE',
        [id, r.version ?? null],
      );
      if (!d) return false;
      await c.query('DELETE FROM facts WHERE doc_id = $1', [id]);
      if (r.chunks) {
        const chunks = r.chunks.map((ch) => ({ ...ch, text: redactSecrets(ch.text) }));
        await c.query('DELETE FROM chunks WHERE doc_id = $1', [id]);
        if (chunks.length) {
          await c.query(
            `INSERT INTO chunks (id, doc_id, project_key, idx, text, embedding)
             SELECT $1 || '#' || (n.ord - 1), $1, $2, n.ord - 1, n.text, n.embedding::vector
             FROM unnest($3::text[], $4::text[]) WITH ORDINALITY AS n(text, embedding, ord)`,
            [id, d.project_key, chunks.map((ch) => ch.text), chunks.map((ch) => toVector(ch.embedding))],
          );
        }
      }
      if (facts.length) {
        await c.query(
          `INSERT INTO facts (id, project_key, doc_id, kind, statement, path, lines, confidence, why, source, current, created_at, valid_from, embedding, relevance, relevance_by)
           SELECT n.id, $1, $2, n.kind, n.statement, $3, n.lines, n.confidence, n.why, $4, true, $5, $5, n.embedding::vector,
                  n.relevance, CASE WHEN n.relevance IS NULL THEN NULL ELSE 'model' END
           FROM unnest($6::text[], $7::text[], $8::text[], $9::text[], $10::float8[], $11::text[], $12::text[], $13::float8[])
                  WITH ORDINALITY AS n(id, kind, statement, lines, confidence, why, embedding, relevance, ord)
           ORDER BY n.ord`,
          [
            d.project_key, id, d.ref, r.source, now,
            facts.map(() => randomUUID()), facts.map((f) => f.kind), facts.map((f) => f.statement), facts.map((f) => f.lines ?? null),
            facts.map((f) => f.confidence ?? null), facts.map((f) => f.why ?? null), facts.map((f) => toVector(f.embedding)), facts.map((f) => relevanceOf(f)),
          ],
        );
      }
      await c.query(`UPDATE docs SET read_status = 'done', read_at = $2, read_error = NULL, read_retry_at = NULL WHERE id = $1`, [id, now]);
      return true;
    });
  }

  async recordDocFailure(id: string, error: string, o: { counted: boolean; final?: boolean; version?: string }, now = new Date()): Promise<{ attempts: number; retryAt: string | null } | null> {
    const { rows: [d] } = await this.db.pool.query('SELECT read_attempts FROM docs WHERE id = $1 AND ($2::timestamptz IS NULL OR added_at = $2)', [id, o.version ?? null]);
    if (!d) return null;
    const attempts = (d?.read_attempts ?? 0) + (o.counted ? 1 : 0);
    const retryAt = o.final ? null : o.counted ? scanRetryAt(attempts, now) : new Date(now.getTime() + SCAN_UNAVAILABLE_WAIT_MS).toISOString();
    await this.db.pool.query(
      `UPDATE docs SET read_attempts = $2, read_error = $3, read_retry_at = $4,
         read_status = CASE WHEN $4::timestamptz IS NULL THEN 'failed' ELSE 'pending' END
       WHERE id = $1 AND ($5::timestamptz IS NULL OR added_at = $5)`,
      [id, attempts, redactSecrets(error).slice(0, 2000), retryAt, o.version ?? null],
    );
    return { attempts, retryAt };
  }

  async requeueStaleDocs(): Promise<void> {
    await this.db.pool.query(`UPDATE docs SET read_status = 'pending' WHERE read_status = 'reading'`);
  }

  async requeueDocRead(id: string): Promise<boolean> {
    const { rowCount } = await this.db.pool.query(
      `UPDATE docs SET read_status = 'pending', read_attempts = 0, read_error = NULL, read_retry_at = NULL
       WHERE id = $1 AND read_status IN ('failed', 'pending')`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async docImage(id: string): Promise<TaskImage | null> {
    const { rows: [b] } = await this.db.pool.query(`SELECT media_type, encode(data, 'base64') AS data FROM doc_blobs WHERE doc_id = $1`, [id]);
    return b ? { mediaType: b.media_type, data: b.data.replace(/\n/g, '') } : null;
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
