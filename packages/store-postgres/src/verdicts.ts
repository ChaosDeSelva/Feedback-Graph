import type { VerdictItem, VerdictKind, VerdictNeighbour, VerdictsStore } from '@fb/core';
import { iso, toVector, type Db } from './db.ts';

/** Per kind (as core graph/verdicts.ts): the table, its embedding column, its project, your approve and your reject. */
const KINDS: Record<VerdictKind, { table: string; emb: string; project: (v: string) => string; approve: string; reject: string }> = {
  candidate: { table: 'candidates', emb: 'dedupe_embedding', project: (v) => `${v}.project_key`, approve: 'confirmed', reject: 'rejected' },
  lesson: { table: 'lessons', emb: 'embedding', project: (v) => `coalesce(${v}.origin_project_key, ${v}.project_key)`, approve: 'approved', reject: 'rejected' },
  claim: { table: 'claims', emb: 'embedding', project: (v) => `${v}.project_key`, approve: 'accepted', reject: 'rejected' },
};
const decided = (k: (typeof KINDS)[VerdictKind], v: string) =>
  `${v}.decided_by = 'you' AND ${v}.status IN ('${k.approve}', '${k.reject}') AND ${v}.decided_at IS NOT NULL AND NOT ${v}.sandbox`;

export class PgVerdictsStore implements VerdictsStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async neighbours(q: { kind: VerdictKind; ids: string[]; k: number; minCosine: number; priorOnly?: boolean }): Promise<Record<string, VerdictNeighbour[]>> {
    if (!q.ids.length || q.k <= 0) return {};
    const k = KINDS[q.kind];
    const { rows } = await this.db.pool.query<{ item: string; id: string; project_key: string | null; approved: boolean; cosine: number; same: boolean; decided_at: Date }>(
      `SELECT p.id AS item, n.* FROM ${k.table} p
       CROSS JOIN LATERAL (
         SELECT d.id, ${k.project('d')} AS project_key, d.status = '${k.approve}' AS approved, 1 - (d.${k.emb} <=> p.${k.emb}) AS cosine,
                coalesce(${k.project('d')} = ${k.project('p')}, false) AS same, d.decided_at
         FROM ${k.table} d
         WHERE ${decided(k, 'd')} AND d.id <> p.id AND d.${k.emb} IS NOT NULL AND vector_dims(d.${k.emb}) = vector_dims(p.${k.emb})
           AND (NOT $2::boolean OR d.decided_at < p.decided_at)
           AND 1 - (d.${k.emb} <=> p.${k.emb}) >= $3
         ORDER BY same DESC, cosine DESC, d.id LIMIT $4
       ) n
       WHERE p.id = ANY($1::text[]) AND p.${k.emb} IS NOT NULL`,
      [q.ids, !!q.priorOnly, q.minCosine, q.k],
    );
    const out: Record<string, VerdictNeighbour[]> = {};
    for (const r of rows) {
      (out[r.item] ??= []).push({ id: r.id, projectKey: r.project_key, approved: r.approved, cosine: Number(r.cosine), sameProject: r.same, decidedAt: iso(r.decided_at)! });
    }
    // An item with an embedding and no verdict near it is answered with [] (as the Neo4j store does).
    const { rows: embedded } = await this.db.pool.query<{ id: string }>(`SELECT id FROM ${k.table} WHERE id = ANY($1::text[]) AND ${k.emb} IS NOT NULL`, [q.ids]);
    for (const { id } of embedded) out[id] ??= [];
    return out;
  }

  async ownerVerdicts(kind: VerdictKind): Promise<VerdictItem[]> {
    const k = KINDS[kind];
    const { rows } = await this.db.pool.query<{ id: string; approved: boolean; decided_at: Date }>(
      `SELECT d.id, d.status = '${k.approve}' AS approved, d.decided_at FROM ${k.table} d WHERE ${decided(k, 'd')} ORDER BY d.decided_at, d.id`,
    );
    return rows.map((r) => ({ id: r.id, approved: r.approved, decidedAt: iso(r.decided_at)! }));
  }

  async inboxToEmbed(limit: number): Promise<{ id: string; text: string }[]> {
    const { rows } = await this.db.pool.query<{ id: string; text: string }>(
      `SELECT k.id, t.text FROM candidates k JOIN turns t ON t.uuid = k.turn_uuid
       WHERE k.dedupe_embedding IS NULL AND trim(coalesce(t.text, '')) <> '' ORDER BY k.id LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async setInboxEmbeddings(rows: { id: string; embedding: number[] }[]): Promise<void> {
    if (!rows.length) return;
    await this.db.pool.query(
      `UPDATE candidates k SET dedupe_embedding = v.embedding::vector
       FROM unnest($1::text[], $2::text[]) AS v(id, embedding) WHERE k.id = v.id AND k.dedupe_embedding IS NULL`,
      [rows.map((r) => r.id), rows.map((r) => toVector(r.embedding))],
    );
  }
}
