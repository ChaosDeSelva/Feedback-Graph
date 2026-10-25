import { cleanEvidence, cleanNote, linkIdOf, linkPair } from '@fb/core';
import type { DetectedLink, LinkPatch, LinksStore, ProjectLink } from '@fb/core';
import { iso, toJson, tx, type Db } from './db.ts';

/** Links between projects, one row per pair (a < b, byte order as in Neo4j). */
export class PgLinksStore implements LinksStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async listLinks(q: { projectKey?: string; projectKeys?: string[] }): Promise<ProjectLink[]> {
    const { rows } = await this.db.pool.query(
      `SELECT * FROM project_links
       WHERE ($1::text IS NULL OR a = $1 OR b = $1) AND ($2::text[] IS NULL OR (a = ANY($2) AND b = ANY($2)))
       ORDER BY a COLLATE "C", b COLLATE "C"`,
      [q.projectKey ?? null, q.projectKeys ?? null],
    );
    return rows.map(linkOf);
  }

  async replaceDetected(scanned: string[], found: DetectedLink[]): Promise<number> {
    const now = new Date();
    const rows = found.map((f) => {
      const [a, b] = linkPair(f.a, f.b);
      return { id: linkIdOf(a, b), a, b, relation: f.relation, score: f.score, evidence: toJson(cleanEvidence(f.evidence)) };
    });
    return tx(this.db, async (c) => {
      await c.query(
        `DELETE FROM project_links WHERE status = 'suggested' AND a = ANY($1) AND b = ANY($1) AND NOT (id = ANY($2))`,
        [scanned, rows.map((r) => r.id)],
      );
      if (!rows.length) return 0;
      const { rows: out } = await c.query(
        `INSERT INTO project_links (id, a, b, relation, note, status, source, score, evidence, created_at, updated_at)
         SELECT r.id, r.a, r.b, r.relation, '', 'suggested', 'detected', r.score, r.evidence::jsonb, $6, $6
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::float8[], $7::text[]) AS r(id, a, b, relation, score, evidence)
         ON CONFLICT (id) DO UPDATE SET evidence = EXCLUDED.evidence, score = EXCLUDED.score, updated_at = EXCLUDED.updated_at,
           relation = CASE WHEN project_links.status = 'suggested' THEN EXCLUDED.relation ELSE project_links.relation END
         RETURNING (xmax = 0) AS inserted`,
        [rows.map((r) => r.id), rows.map((r) => r.a), rows.map((r) => r.b), rows.map((r) => r.relation), rows.map((r) => r.score), now, rows.map((r) => r.evidence)],
      );
      return out.filter((r) => r.inserted).length;
    });
  }

  async setLink(x: string, y: string, patch: LinkPatch): Promise<ProjectLink> {
    const [a, b] = linkPair(x, y);
    const now = new Date();
    const { rows: [row] } = await this.db.pool.query(
      `INSERT INTO project_links (id, a, b, relation, note, status, source, score, evidence, created_at, updated_at, decided_by)
       VALUES ($1, $2, $3, coalesce($4, 'related'), coalesce($5, ''), coalesce($6, 'confirmed'), 'you', 0, '[]', $7, $7, $8)
       ON CONFLICT (id) DO UPDATE SET relation = coalesce($4, project_links.relation), note = coalesce($5, project_links.note),
         status = coalesce($6, project_links.status), decided_by = coalesce($8, project_links.decided_by), updated_at = $7
       RETURNING *`,
      [linkIdOf(a, b), a, b, patch.relation ?? null, patch.note === undefined ? null : cleanNote(patch.note), patch.status ?? null, now, patch.decidedBy ?? null],
    );
    return linkOf(row);
  }

  async deleteLink(id: string): Promise<boolean> {
    return ((await this.db.pool.query('DELETE FROM project_links WHERE id = $1', [id])).rowCount ?? 0) > 0;
  }
}

function linkOf(r: Record<string, any>): ProjectLink {
  return {
    id: r.id,
    a: r.a,
    b: r.b,
    relation: r.relation,
    note: r.note ?? '',
    status: r.status,
    source: r.source,
    score: Number(r.score ?? 0),
    evidence: r.evidence ?? [],
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    decidedBy: r.decided_by ?? null,
  };
}
