import { cleanEvidence, cleanNote, linkIdOf, linkPair, runWriteOwner } from '@fb/core';
import type { DetectedLink, LinkPatch, LinksStore, ProjectLink } from '@fb/core';
import { iso, toJson, tx, type Db } from './db.ts';
import { sandboxPresence, visibleToRun } from './vector.ts';

/** Links between projects, one row per pair (a < b, byte order as in Neo4j). */
export class PgLinksStore implements LinksStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async listLinks(q: { projectKey?: string; projectKeys?: string[]; run?: string | null }): Promise<ProjectLink[]> {
    const { rows } = await this.db.pool.query(
      `SELECT * FROM project_links l
       WHERE ($1::text IS NULL OR a = $1 OR b = $1) AND ($2::text[] IS NULL OR (a = ANY($2) AND b = ANY($2))) AND ${visibleToRun('l', '$3')}
         -- A sandbox run's own row of a pair stands in for the shared one, for that run.
         AND ($3::text IS NULL OR l.run IS NOT DISTINCT FROM $3
              OR NOT EXISTS (SELECT 1 FROM project_links s WHERE s.a = l.a AND s.b = l.b AND s.sandbox AND s.run = $3))
       ORDER BY a COLLATE "C", b COLLATE "C"`,
      [q.projectKey ?? null, q.projectKeys ?? null, q.run ?? null],
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
    const id = linkIdOf(a, b, patch.run);
    sandboxPresence(this.db).wrote(patch.run);
    const now = new Date();
    return tx(this.db, async (c) => {
      // A run decides only on a link it made (runWriteOwner); the owner's decision makes a run's link the owner's.
      const { rows: [cur] } = await c.query('SELECT run FROM project_links WHERE id = $1 FOR UPDATE', [id]);
      const run = runWriteOwner(`the link ${a} ↔ ${b}`, cur ? (cur.run ?? null) : undefined, patch.run, patch.byOwner);
      // A sandbox run's own row starts as a copy of the shared one (when there is one), so only its decision differs.
      const { rows: [row] } = await c.query(
        `INSERT INTO project_links (id, a, b, relation, note, status, source, score, evidence, created_at, updated_at, decided_by, run, sandbox)
         SELECT $1::text, $2::text, $3::text, coalesce($4::text, base.relation, 'related'), coalesce($5::text, base.note, ''), coalesce($6::text, base.status, 'confirmed'),
                coalesce(base.source, 'you'), coalesce(base.score, 0), coalesce(base.evidence, '[]'::jsonb), $7::timestamptz, $7::timestamptz,
                coalesce($8::text, base.decided_by), $9::text, $10::boolean
         FROM (SELECT 1) one LEFT JOIN project_links base ON base.id = $11::text
         ON CONFLICT (id) DO UPDATE SET relation = coalesce($4, project_links.relation), note = coalesce($5, project_links.note),
           status = coalesce($6, project_links.status), decided_by = coalesce($8, project_links.decided_by), updated_at = $7,
           run = $9, sandbox = $10
         RETURNING *`,
        [id, a, b, patch.relation ?? null, patch.note === undefined ? null : cleanNote(patch.note), patch.status ?? null, now, patch.decidedBy ?? null, run?.id ?? null, !!run?.sandbox, linkIdOf(a, b)],
      );
      return linkOf(row);
    });
  }

  async deleteLink(id: string, o: { run?: string | null } = {}): Promise<boolean> {
    return ((await this.db.pool.query('DELETE FROM project_links WHERE id = $1 AND ($2::text IS NULL OR run = $2)', [id, o.run ?? null])).rowCount ?? 0) > 0;
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
    ...(r.run ? { run: r.run as string } : {}),
    ...(r.sandbox === true && { sandbox: true as const }),
  };
}
