import { conditionalWrite } from './conditionalWrite.ts';
import { redactSecrets } from '../redact.ts';
import type { LinksStore } from '../store.ts';
import type { RunTag } from '../types.ts';
import { runWriteOwner } from '../runs.ts';
import type { GraphRepo } from './repo.ts';
import { VISIBLE_TO_RUN } from './runs.ts';

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
  /** The run that made it (RunTag), and whether that run was a sandbox; absent when none. */
  run?: string;
  sandbox?: true;
};

export type DetectedLink = { a: string; b: string; relation: LinkRelation; score: number; evidence: LinkEvidence[] };
/** decidedBy: who made this change ('you', 'operator:<name>'); unset keeps the last one. */
/**
 * run: the run (RunTag) the decision is made in; a link it creates is the run's, and it may change only a link it made
 * (LinksStore.setLink). byOwner: the owner opened the run, so it may decide on the owner's links (they stay the owner's).
 */
export type LinkPatch = { status?: LinkStatus; relation?: LinkRelation; note?: string; decidedBy?: string; run?: RunTag | null; byOwner?: boolean };

/** The pair in store order. Throws on a link from a project to itself. */
export function linkPair(x: string, y: string): [string, string] {
  if (x === y) throw new Error('a project cannot be linked to itself');
  return x < y ? [x, y] : [y, x];
}
/** A sandbox run's decision on a pair is its own row (link@<run>:a|b), never the shared one. */
export const linkIdOf = (x: string, y: string, run?: RunTag | null) => {
  const [a, b] = linkPair(x, y);
  return `link${run?.sandbox ? `@${run.id}` : ''}:${a}|${b}`;
};
/** The two ends a link id names (with or without a sandbox run), or null for anything else. */
export function linkEnds(id: string): [string, string] | null {
  const m = /^link(?:@[\w.-]+)?:([^|]+)\|(.+)$/.exec(id);
  return m ? [m[1], m[2]] : null;
}
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

  async listLinks(q: { projectKey?: string; projectKeys?: string[]; run?: string | null }): Promise<ProjectLink[]> {
    const rows = await this.g.run(
      `MATCH (l:ProjectLink)
       WHERE ($key IS NULL OR l.a = $key OR l.b = $key) AND ($keys IS NULL OR (l.a IN $keys AND l.b IN $keys)) AND ${VISIBLE_TO_RUN('l')}
         AND ($run IS NULL OR coalesce(l.run = $run, false) OR NOT EXISTS { MATCH (s:ProjectLink {a: l.a, b: l.b, run: $run, sandbox: true}) })
       RETURN l ORDER BY l.a, l.b`,
      { key: q.projectKey ?? null, keys: q.projectKeys ?? null, run: q.run ?? null },
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
    const id = linkIdOf(a, b, patch.run);
    this.g.sandbox.wrote(patch.run);
    // A run decides only on a link it made (runWriteOwner); the owner's decision makes a run's link the owner's.
    const [cur] = await this.g.run(`MATCH (l:ProjectLink {id: $id}) RETURN l.run AS run`, { id });
    const run = runWriteOwner(`the link ${a} ↔ ${b}`, cur ? (cur.get('run') ?? null) : undefined, patch.run, patch.byOwner);
    // A sandbox run's own row starts as a copy of the shared one (when there is one), so only its decision differs.
    const [r] = await this.g.run(
      `OPTIONAL MATCH (base:ProjectLink {id: $base})
       MERGE (l:ProjectLink {id: $id})
         ON CREATE SET l.a = $a, l.b = $b, l.status = coalesce(base.status, 'confirmed'), l.source = coalesce(base.source, 'you'),
                       l.note = coalesce(base.note, ''), l.relation = coalesce(base.relation, 'related'), l.score = coalesce(base.score, 0.0),
                       l.evidence = coalesce(base.evidence, '[]'), l.decidedBy = base.decidedBy, l.createdAt = $now
       SET l.status = coalesce($status, l.status), l.relation = coalesce($relation, l.relation), l.note = coalesce($note, l.note),
           l.decidedBy = coalesce($decidedBy, l.decidedBy), l.updatedAt = $now, l.run = $run, l.sandbox = $sandbox
       RETURN l`,
      { id, base: linkIdOf(a, b), a, b, status: patch.status ?? null, relation: patch.relation ?? null, note: patch.note === undefined ? null : cleanNote(patch.note), decidedBy: patch.decidedBy ?? null, now: new Date().toISOString(), run: run?.id ?? null, sandbox: !!run?.sandbox },
    );
    return linkOf(r.get('l').properties);
  }

  async deleteLink(id: string, o: { run?: string | null } = {}): Promise<boolean> {
    return conditionalWrite(this.g, async query => {
      const [r] = await query(
        `OPTIONAL MATCH (l:ProjectLink {id: $id}) WHERE $run IS NULL OR l.run = $run
         WITH l, l IS NOT NULL AS existed DETACH DELETE l RETURN existed`,
        { id, run: o.run ?? null },
      );
      return r?.get('existed') === true;
    }, Boolean);
  }
}

function linkOf(p: Record<string, unknown>): ProjectLink {
  let evidence: LinkEvidence[];
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
    ...(typeof p.run === 'string' && { run: p.run }),
    ...(p.sandbox === true && { sandbox: true as const }),
  };
}
