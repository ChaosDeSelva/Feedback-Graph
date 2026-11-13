import neo4j from 'neo4j-driver';
import type { VerdictItem, VerdictKind, VerdictNeighbour, VerdictsStore } from '../store.ts';
import type { GraphRepo } from './repo.ts';

/** Per kind: the label, its embedding property, its project, and the statuses that are your approve and your reject. */
const KINDS: Record<VerdictKind, { label: string; emb: string; project: (v: string) => string; approve: string; reject: string }> = {
  candidate: { label: 'Candidate', emb: 'dedupeEmbedding', project: (v) => `${v}.projectKey`, approve: 'confirmed', reject: 'rejected' },
  lesson: { label: 'Lesson', emb: 'embedding', project: (v) => `coalesce(${v}.originProjectKey, ${v}.projectKey)`, approve: 'approved', reject: 'rejected' },
  claim: { label: 'Claim', emb: 'embedding', project: (v) => `${v}.projectKey`, approve: 'accepted', reject: 'rejected' },
};
const decided = (k: (typeof KINDS)[VerdictKind], v: string) =>
  `${v}.decidedBy = 'you' AND ${v}.status IN ['${k.approve}', '${k.reject}'] AND ${v}.decidedAt IS NOT NULL AND coalesce(${v}.sandbox, false) = false`;

export class VerdictsRepo implements VerdictsStore {
  private readonly g: GraphRepo;
  constructor(g: GraphRepo) {
    this.g = g;
  }

  async neighbours(q: { kind: VerdictKind; ids: string[]; k: number; minCosine: number; priorOnly?: boolean }): Promise<Record<string, VerdictNeighbour[]>> {
    if (!q.ids.length || q.k <= 0) return {};
    const k = KINDS[q.kind];
    const rows = await this.g.run(
      `UNWIND $ids AS id
       MATCH (p:${k.label} {id: id}) WHERE p.${k.emb} IS NOT NULL
       CALL {
         WITH p
         MATCH (d:${k.label}) WHERE ${decided(k, 'd')} AND d.id <> p.id AND d.${k.emb} IS NOT NULL AND size(d.${k.emb}) = size(p.${k.emb})
           AND (NOT $priorOnly OR (p.decidedAt IS NOT NULL AND datetime(d.decidedAt) < datetime(p.decidedAt)))
         WITH p, d, 2 * vector.similarity.cosine(d.${k.emb}, p.${k.emb}) - 1 AS cosine
         WHERE cosine >= $minCosine
         WITH d, cosine, ${k.project('d')} AS projectKey, coalesce(${k.project('d')} = ${k.project('p')}, false) AS same
         ORDER BY same DESC, cosine DESC, d.id LIMIT $k
         RETURN collect({id: d.id, projectKey: projectKey, approved: d.status = '${k.approve}', cosine: cosine, sameProject: same, decidedAt: d.decidedAt}) AS near
       }
       RETURN p.id AS id, near`,
      { ids: q.ids, k: neo4j.int(q.k), minCosine: q.minCosine, priorOnly: !!q.priorOnly },
    );
    return Object.fromEntries(rows.map((r) => [r.get('id') as string, (r.get('near') as VerdictNeighbour[]).map((n) => ({ ...n, projectKey: n.projectKey ?? null }))]));
  }

  async ownerVerdicts(kind: VerdictKind): Promise<VerdictItem[]> {
    const k = KINDS[kind];
    const rows = await this.g.run(
      `MATCH (d:${k.label}) WHERE ${decided(k, 'd')}
       RETURN d.id AS id, d.status = '${k.approve}' AS approved, d.decidedAt AS decidedAt ORDER BY datetime(d.decidedAt), d.id`,
    );
    return rows.map((r) => ({ id: r.get('id') as string, approved: r.get('approved') as boolean, decidedAt: r.get('decidedAt') as string }));
  }

  async inboxToEmbed(limit: number): Promise<{ id: string; text: string }[]> {
    const rows = await this.g.run(
      `MATCH (k:Candidate) WHERE k.dedupeEmbedding IS NULL
       MATCH (t:Turn {uuid: k.turnUuid}) WHERE trim(coalesce(t.text, '')) <> ''
       RETURN k.id AS id, t.text AS text ORDER BY k.id LIMIT $limit`,
      { limit: neo4j.int(limit) },
    );
    return rows.map((r) => ({ id: r.get('id') as string, text: r.get('text') as string }));
  }

  async setInboxEmbeddings(rows: { id: string; embedding: number[] }[]): Promise<void> {
    if (!rows.length) return;
    await this.g.run(`UNWIND $rows AS row MATCH (k:Candidate {id: row.id}) WHERE k.dedupeEmbedding IS NULL SET k.dedupeEmbedding = row.embedding`, { rows });
  }
}
