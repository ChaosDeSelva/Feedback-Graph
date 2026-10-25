import { redactSecrets } from '../redact.ts';
import type { LinksStore } from '../store.ts';
import type { GraphRepo } from './repo.ts';

/**
 * How two projects belong together. depends_on: one uses the other's code, package or API. same_product: parts of one
 * product (a game and its backend, an app and its site). shares_code: they share or vendor code. related: anything else.
 */
export const LINK_RELATIONS = ['depends_on', 'same_product', 'shares_code', 'related'] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];
/** suggested: found by the worker, not served to agents. confirmed: by you, served. dismissed: by you, never suggested again. */
export const LINK_STATUSES = ['suggested', 'confirmed', 'dismissed'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];
export type LinkSignal = 'manifest' | 'remote' | 'name';
/** One piece of evidence for a link: what was found, in which file of which project (`from`). */
export type LinkEvidence = { signal: LinkSignal; detail: string; path: string | null; from: string };

/** An undirected link between two projects, stored once per pair: `a` sorts before `b`. */
export type ProjectLink = {
  id: string;
  a: string;
  b: string;
  relation: LinkRelation;
  note: string;
  status: LinkStatus;
  source: 'detected' | 'you';
  /** Strength of the detected evidence (0..1); 0 for a link you made by hand with none. */
  score: number;
  evidence: LinkEvidence[];
  createdAt: string;
  updatedAt: string;
  /**
   * Who made its last decision: 'you' (the UI) or 'operator:<name>' (an agent holding FG_OPERATOR_TOKEN). Null for a
   * detected suggestion nobody has decided, or one decided before this was recorded.
   */
  decidedBy: string | null;
};

export type DetectedLink = { a: string; b: string; relation: LinkRelation; score: number; evidence: LinkEvidence[] };
/** decidedBy: who made this change ('you', 'operator:<name>'); unset keeps the last one. */
export type LinkPatch = { status?: LinkStatus; relation?: LinkRelation; note?: string; decidedBy?: string };

/** The pair in store order. Throws on a link from a project to itself. */
export function linkPair(x: string, y: string): [string, string] {
  if (x === y) throw new Error('a project cannot be linked to itself');
  return x < y ? [x, y] : [y, x];
}
export const linkIdOf = (x: string, y: string) => {
  const [a, b] = linkPair(x, y);
  return `link:${a}|${b}`;
};
/** The other end of a link, seen from one project. */
export const otherEnd = (l: Pick<ProjectLink, 'a' | 'b'>, key: string) => (l.a === key ? l.b : l.a);

export const MAX_EVIDENCE = 5;
export const MAX_NOTE = 500;
export const cleanEvidence = (e: LinkEvidence[]) =>
  e.slice(0, MAX_EVIDENCE).map((x) => ({ ...x, detail: redactSecrets(x.detail).slice(0, 300), path: x.path === null ? null : redactSecrets(x.path) }));
export const cleanNote = (n: string) => redactSecrets(n).slice(0, MAX_NOTE);

/**
 * Links between projects: ProjectLink nodes naming both ends by key (no edges, so a link never creates a project).
 * Evidence is kept as JSON text.
 */
export class LinksRepo implements LinksStore {
  readonly g: GraphRepo;
  constructor(g: GraphRepo) {
    this.g = g;
  }

  async listLinks(q: { projectKey?: string; projectKeys?: string[] }): Promise<ProjectLink[]> {
    const rows = await this.g.run(
      `MATCH (l:ProjectLink)
       WHERE ($key IS NULL OR l.a = $key OR l.b = $key) AND ($keys IS NULL OR (l.a IN $keys AND l.b IN $keys))
       RETURN l ORDER BY l.a, l.b`,
      { key: q.projectKey ?? null, keys: q.projectKeys ?? null },
    );
    return rows.map((r) => linkOf(r.get('l').properties));
  }

  async replaceDetected(scanned: string[], found: DetectedLink[]): Promise<number> {
    const now = new Date().toISOString();
    const rows = found.map((f) => {
      const [a, b] = linkPair(f.a, f.b);
      return { id: linkIdOf(a, b), a, b, relation: f.relation, score: f.score, evidence: JSON.stringify(cleanEvidence(f.evidence)) };
    });
    const results = await this.g.runInTransaction([
      [
        `MATCH (l:ProjectLink {status: 'suggested'}) WHERE l.a IN $scanned AND l.b IN $scanned AND NOT l.id IN $ids DETACH DELETE l`,
        { scanned, ids: rows.map((x) => x.id) },
      ],
      [
        `UNWIND $rows AS row
         OPTIONAL MATCH (old:ProjectLink {id: row.id})
         WITH row, old IS NULL AS isNew
         MERGE (l:ProjectLink {id: row.id})
           ON CREATE SET l.a = row.a, l.b = row.b, l.status = 'suggested', l.source = 'detected', l.note = '', l.createdAt = $now
         SET l.evidence = row.evidence, l.score = row.score, l.updatedAt = $now,
             l.relation = CASE WHEN l.status = 'suggested' THEN row.relation ELSE coalesce(l.relation, row.relation) END
         RETURN count(CASE WHEN isNew THEN 1 END) AS n`,
        { rows, now },
      ],
    ]);
    return Number(results[1]?.[0]?.get('n') ?? 0);
  }

  async setLink(x: string, y: string, patch: LinkPatch): Promise<ProjectLink> {
    const [a, b] = linkPair(x, y);
    const [r] = await this.g.run(
      `MERGE (l:ProjectLink {id: $id})
         ON CREATE SET l.a = $a, l.b = $b, l.status = 'confirmed', l.source = 'you', l.note = '', l.relation = 'related',
                       l.score = 0.0, l.evidence = '[]', l.createdAt = $now
       SET l.status = coalesce($status, l.status), l.relation = coalesce($relation, l.relation), l.note = coalesce($note, l.note),
           l.decidedBy = coalesce($decidedBy, l.decidedBy), l.updatedAt = $now
       RETURN l`,
      { id: linkIdOf(a, b), a, b, status: patch.status ?? null, relation: patch.relation ?? null, note: patch.note === undefined ? null : cleanNote(patch.note), decidedBy: patch.decidedBy ?? null, now: new Date().toISOString() },
    );
    return linkOf(r.get('l').properties);
  }

  async deleteLink(id: string): Promise<boolean> {
    const [r] = await this.g.run(`OPTIONAL MATCH (l:ProjectLink {id: $id}) WITH l, l IS NOT NULL AS existed DETACH DELETE l RETURN existed`, { id });
    return r.get('existed');
  }
}

function linkOf(p: Record<string, unknown>): ProjectLink {
  let evidence: LinkEvidence[] = [];
  try {
    evidence = JSON.parse((p.evidence as string) ?? '[]');
  } catch {
    evidence = [];
  }
  return {
    id: p.id as string,
    a: p.a as string,
    b: p.b as string,
    relation: (p.relation as LinkRelation) ?? 'related',
    note: (p.note as string) ?? '',
    status: p.status as LinkStatus,
    source: (p.source as 'detected' | 'you') ?? 'detected',
    score: Number(p.score ?? 0),
    evidence,
    createdAt: p.createdAt as string,
    updatedAt: p.updatedAt as string,
    decidedBy: (p.decidedBy as string) ?? null,
  };
}
