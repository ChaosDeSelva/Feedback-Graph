import { randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import { FACT_EVIDENCE, FACT_ORIGINS, type CodeFact, type FactEvidence, type FactKind, type FactOrigin, type Project, type ProjectSummary, type RelevanceBy, type ScanJob, type ScanShards, type ScanStatus } from '../types.ts';
import { factOrigin } from '../relevance.ts';
import { redactDeep, redactSecrets } from '../redact.ts';
import type { FactScope, FactsStore, ScanJobPatch } from '../store.ts';
import type { GraphRepo } from './repo.ts';

/** A stored fact with its provenance: which model, which scan, which version of the file. */
export type StoredFact = Omit<CodeFact, 'relevance' | 'evidence'> & {
  id: string; source: string; createdAt: string; scanJobId: string | null; fileHash: string | null; fileSummary: string | null;
  relevance: number | null; relevanceBy: RelevanceBy | null;
  /** How its citation was checked when saved; null on facts saved before that was recorded. */
  evidence?: FactEvidence | null;
  /** Set for a fact read from an uploaded document (path is then the document's name); null for code facts. */
  docId: string | null;
};
/** A current fact with no relevance yet, for the background scorer. */
export type UnscoredFact = { id: string; projectKey: string; kind: FactKind; statement: string; path: string; why: string };
/** projectKey: only a fact of that project is changed. */
export type RelevanceUpdate = { id: string; relevance: number; by: RelevanceBy; projectKey?: string };
/** 0..1, so a model's or a request's stray number cannot skew ranking. */
export const clampRelevance = (r: number) => (Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5);
/** Store form of an extracted fact's relevance: a number in range, or null (not scored). */
export const relevanceOf = (f: Pick<CodeFact, 'relevance'>) => (typeof f.relevance === 'number' ? clampRelevance(f.relevance) : null);
/** Store form of a fact's origin and evidence: known values, or null (Neo4j and Postgres both refuse undefined). */
export const provenanceOf = (f: Pick<CodeFact, 'origin' | 'evidence'>) => ({
  origin: f.origin && FACT_ORIGINS.includes(f.origin) ? f.origin : null,
  evidence: f.evidence && FACT_EVIDENCE.includes(f.evidence) ? f.evidence : null,
});
export type FactHit = { fact: StoredFact; score: number };
export type EmbeddedFact = CodeFact & { embedding: number[] };

/** The reason the manifest reader gives, as a whole-string regex (Cypher =~, Postgres ~): marks older manifest facts. */
export const MANIFEST_WHY_RE = '^Read directly from \\S+; no model involved\\.$';

/** The path facts about the whole project (not one file) are filed under. */
export const PROJECT_PATH = '.';

/** Real failures a scan job gets before it is failed for good. */
export const MAX_SCAN_ATTEMPTS = 3;
/** Wait 5, then 10 minutes between attempts, so a passing problem does not use them up. */
const SCAN_BACKOFF_MINUTES = 5;
/** A model that could not be asked is tried again after this, without counting an attempt. */
export const SCAN_UNAVAILABLE_WAIT_MS = 2 * 60_000;

/** When a scan that has now failed `attempts` times is due again, or null when it has given up. */
export function scanRetryAt(attempts: number, now: Date): string | null {
  return attempts >= MAX_SCAN_ATTEMPTS ? null : new Date(now.getTime() + SCAN_BACKOFF_MINUTES * 2 ** (attempts - 1) * 60_000).toISOString();
}

export class FactsRepo implements FactsStore {
  readonly g: GraphRepo;

  constructor(g: GraphRepo) {
    this.g = g;
  }

  async fileHashes(projectKey: string): Promise<Map<string, string>> {
    const rows = await this.g.run(
      `MATCH (f:CodeFile {projectKey: $projectKey}) WHERE coalesce(f.removed, false) = false AND f.path <> $root AND f.hash IS NOT NULL
       RETURN f.path AS path, f.hash AS hash`,
      { projectKey, root: PROJECT_PATH },
    );
    return new Map(rows.map((r) => [r.get('path'), r.get('hash')]));
  }

  /** Replace the current facts of one file (old facts are closed, not deleted). */
  async saveFileFacts(projectKey: string, rawFile: { path: string; hash: string; summary: string }, rawFacts: EmbeddedFact[], source: string, scanJobId: string | null = null) {
    // Facts are model output about code that may contain credentials: redact at the door.
    const file = redactDeep(rawFile);
    const facts = redactDeep(rawFacts);
    const now = new Date().toISOString();
    await this.g.run(
      `MERGE (p:Project {key: $projectKey})
       MERGE (cf:CodeFile {id: $projectKey + ':' + $file.path})
       SET cf.projectKey = $projectKey, cf.path = $file.path, cf.hash = $file.hash, cf.summary = $file.summary,
           cf.scannedAt = $now, cf.removed = false
       MERGE (cf)-[:IN]->(p)
       WITH cf
       OPTIONAL MATCH (old:Fact {current: true})-[:ABOUT]->(cf) WHERE coalesce(old.origin, '') <> 'you'
       SET old.current = false, old.validTo = $now
       WITH DISTINCT cf
       UNWIND $facts AS fx
         CREATE (n:Fact {id: randomUUID(), projectKey: $projectKey, kind: fx.kind, statement: fx.statement, path: fx.path,
                         lines: fx.lines, confidence: fx.confidence, why: fx.why, embedding: fx.embedding, source: $source,
                         origin: fx.origin, evidence: fx.evidence,
                         relevance: fx.relevance, relevanceBy: CASE WHEN fx.relevance IS NULL THEN null ELSE 'model' END,
                         scanJobId: $scanJobId, fileHash: $file.hash, current: true, createdAt: $now, validFrom: $now})
         CREATE (n)-[:ABOUT]->(cf)`,
      { projectKey, file, facts: facts.map((fx) => ({ ...fx, ...provenanceOf(fx), relevance: relevanceOf(fx) })), source, now, scanJobId },
    );
  }

  async markFilesRemoved(projectKey: string, paths: string[]) {
    if (!paths.length) return;
    await this.g.run(
      `MATCH (cf:CodeFile {projectKey: $projectKey}) WHERE cf.path IN $paths
       SET cf.removed = true
       WITH cf
       OPTIONAL MATCH (x:Fact {current: true})-[:ABOUT]->(cf) WHERE coalesce(x.origin, '') <> 'you'
       SET x.current = false, x.validTo = $now`,
      { projectKey, paths, now: new Date().toISOString() },
    );
  }

  /**
   * Agentic scans see the whole repo at once: close every current fact from `source`
   * in the project, then attach the new ones to their files (or to the project root).
   */
  async replaceProjectFacts(projectKey: string, rawFacts: EmbeddedFact[], source: string, files: { path: string; hash: string }[], scanJobId: string | null = null) {
    await this.replaceScopeFacts(projectKey, { prefixes: [''], except: [] }, rawFacts, source, files, scanJobId);
  }

  /** One shard of an agentic scan: only the current facts in `scope` are closed (FactsStore.replaceScopeFacts). */
  async replaceScopeFacts(projectKey: string, scope: FactScope, rawFacts: EmbeddedFact[], source: string, files: { path: string; hash: string }[], scanJobId: string | null = null) {
    const facts = redactDeep(rawFacts);
    const now = new Date().toISOString();
    // One transaction: if writing the new facts fails, the old ones stay current and the hashes stay stale,
    // so the next scan tries again instead of finding "nothing changed" over an empty project.
    await this.g.runInTransaction([
      // Facts read from your documents, and facts you wrote, are not the code's: a scan never closes them.
      [`MATCH (x:Fact {projectKey: $projectKey, current: true}) WHERE x.docId IS NULL AND coalesce(x.origin, '') <> 'you'
          AND any(pre IN $prefixes WHERE pre = '' OR x.path = pre OR x.path STARTS WITH pre + '/')
          AND none(ex IN $except WHERE x.path = ex OR x.path STARTS WITH ex + '/')
        SET x.current = false, x.validTo = $now`, { projectKey, now, prefixes: scope.prefixes, except: scope.except }],
      [`MERGE (p:Project {key: $projectKey})
       WITH p
       UNWIND $files AS fl
         MERGE (cf:CodeFile {id: $projectKey + ':' + fl.path})
         SET cf.projectKey = $projectKey, cf.path = fl.path, cf.hash = fl.hash, cf.scannedAt = $now, cf.removed = false
         MERGE (cf)-[:IN]->(p)`,
        { projectKey, files, now },
      ],
      [`MERGE (p:Project {key: $projectKey})
       WITH p
       UNWIND $facts AS fx
         MERGE (cf:CodeFile {id: $projectKey + ':' + fx.path})
           ON CREATE SET cf.projectKey = $projectKey, cf.path = fx.path, cf.removed = false
         MERGE (cf)-[:IN]->(p)
         CREATE (n:Fact {id: randomUUID(), projectKey: $projectKey, kind: fx.kind, statement: fx.statement, path: fx.path,
                         lines: fx.lines, confidence: fx.confidence, why: fx.why, embedding: fx.embedding, source: $source,
                         origin: fx.origin, evidence: fx.evidence,
                         relevance: fx.relevance, relevanceBy: CASE WHEN fx.relevance IS NULL THEN null ELSE 'model' END,
                         scanJobId: $scanJobId, fileHash: cf.hash, current: true, createdAt: $now, validFrom: $now})
         CREATE (n)-[:ABOUT]->(cf)`,
        { projectKey, facts: facts.map((f) => ({ ...f, ...provenanceOf(f), path: f.path || PROJECT_PATH, relevance: relevanceOf(f) })), source, now, scanJobId },
      ],
    ]);
  }

  /** Your fact: under the project, about no code file, so a scan has nothing of it to close. */
  async addOwnerFact(projectKey: string, rawFact: EmbeddedFact, by: RelevanceBy): Promise<StoredFact> {
    const fx = redactDeep(rawFact);
    const id = randomUUID();
    const now = new Date().toISOString();
    const relevance = relevanceOf(fx);
    const [r] = await this.g.run(
      `MERGE (p:Project {key: $projectKey})
       CREATE (n:Fact {id: $id, projectKey: $projectKey, kind: $fx.kind, statement: $fx.statement, path: $fx.path,
                       lines: $fx.lines, confidence: $fx.confidence, why: $fx.why, embedding: $fx.embedding, source: $by,
                       origin: 'you', evidence: null, relevance: $relevance, relevanceBy: CASE WHEN $relevance IS NULL THEN null ELSE $by END,
                       scanJobId: null, fileHash: null, current: true, createdAt: $now, validFrom: $now})
       RETURN n`,
      { projectKey, id, fx: { ...fx, path: fx.path || PROJECT_PATH, lines: fx.lines ?? null }, by, relevance, now },
    );
    return factOf(r.get('n').properties);
  }

  /** Which models wrote the project's current facts; a scan with a different one rescans every file. */
  async currentSources(projectKey: string): Promise<string[]> {
    const rows = await this.g.run(
      `MATCH (x:Fact {projectKey: $projectKey, current: true}) WHERE x.docId IS NULL AND coalesce(x.origin, '') <> 'you'
       RETURN DISTINCT x.source AS s ORDER BY s`,
      { projectKey },
    );
    return rows.map((r) => r.get('s'));
  }

  async listFacts(q: { projectKey: string; kind?: FactKind; path?: string; limit?: number }): Promise<StoredFact[]> {
    const rows = await this.g.run(
      `MATCH (x:Fact {projectKey: $projectKey, current: true})
       WHERE ($kind IS NULL OR x.kind = $kind) AND ($path IS NULL OR (x.path = $path AND x.docId IS NULL))
       OPTIONAL MATCH (x)-[:ABOUT]->(cf:CodeFile)
       RETURN x, cf.summary AS fileSummary ORDER BY x.path, x.createdAt LIMIT $limit`,
      { projectKey: q.projectKey, kind: q.kind ?? null, path: q.path ?? null, limit: neo4j.int(q.limit ?? 500) },
    );
    return rows.map((r) => factOf(r.get('x').properties, r.get('fileSummary')));
  }

  async searchFacts(q: { embedding: number[]; projectKey: string; k: number }): Promise<FactHit[]> {
    const rows = await this.g.run(
      `MATCH (node:Fact {projectKey: $projectKey, current: true}) WHERE node.embedding IS NOT NULL AND size(node.embedding) = size($embedding)
       WITH node, vector.similarity.cosine(node.embedding, $embedding) AS score
       ORDER BY score DESC LIMIT $k
       OPTIONAL MATCH (node)-[:ABOUT]->(cf:CodeFile)
       RETURN node, score, cf.summary AS fileSummary ORDER BY score DESC`,
      { embedding: q.embedding, k: neo4j.int(q.k), projectKey: q.projectKey },
    );
    return rows.map((r) => ({ fact: factOf(r.get('node').properties, r.get('fileSummary')), score: r.get('score') }));
  }

  async unscoredFacts(q: { projectKeys: string[]; limit: number }): Promise<UnscoredFact[]> {
    const rows = await this.g.run(
      `MATCH (x:Fact {current: true}) WHERE x.projectKey IN $keys AND x.relevance IS NULL
       RETURN x ORDER BY x.projectKey, x.path, x.createdAt, x.id LIMIT $limit`,
      { keys: q.projectKeys, limit: neo4j.int(q.limit) },
    );
    return rows.map((r) => {
      const p = r.get('x').properties;
      return { id: p.id, projectKey: p.projectKey, kind: p.kind, statement: p.statement, path: p.path, why: p.why ?? '' };
    });
  }

  /** A model's score never replaces yours or an agent's (the operator token). Returns how many facts changed. */
  async setFactRelevance(updates: RelevanceUpdate[]): Promise<number> {
    if (!updates.length) return 0;
    const [r] = await this.g.run(
      `UNWIND $updates AS u
       MATCH (x:Fact {id: u.id}) WHERE (u.projectKey IS NULL OR x.projectKey = u.projectKey) AND (u.by <> 'model' OR coalesce(x.relevanceBy, 'model') = 'model')
       SET x.relevance = u.relevance, x.relevanceBy = u.by
       RETURN count(x) AS n`,
      { updates: updates.map((u) => ({ ...u, projectKey: u.projectKey ?? null, relevance: clampRelevance(u.relevance) })) },
    );
    return Number(r.get('n'));
  }

  async requestScan(project: Project, provider: string | null): Promise<ScanJob> {
    // Repeat clicks or scripted POSTs must not queue the same paid full-repo scan twice.
    const [open] = await this.g.run(
      `MATCH (j:ScanJob {projectKey: $key}) WHERE j.status IN ['queued', 'running'] RETURN j.id AS id ORDER BY j.requestedAt DESC LIMIT 1`,
      { key: project.key },
    );
    // Asking again is the owner saying "now": a queued job waiting out a backoff runs at the next poll.
    if (open) {
      await this.g.run(`MATCH (j:ScanJob {id: $id}) WHERE j.status = 'queued' SET j.retryAt = null`, { id: open.get('id') });
      return (await this.scanJob(open.get('id')))!;
    }
    const id = `scan:${randomUUID()}`;
    const now = new Date().toISOString();
    await this.g.run(
      `MERGE (p:Project {key: $project.key}) ON CREATE SET p.name = $project.name, p.repoPath = $project.repoPath
       CREATE (j:ScanJob {id: $id, projectKey: $project.key, repoPath: $project.repoPath, provider: $provider,
                          status: 'queued', requestedAt: $now, filesScanned: 0, factsAdded: 0, attempts: 0})-[:FOR]->(p)`,
      { id, project, provider, now },
    );
    return (await this.scanJob(id))!;
  }

  async scanJob(id: string): Promise<ScanJob | null> {
    const [r] = await this.g.run('MATCH (j:ScanJob {id: $id}) RETURN j', { id });
    return r ? jobOf(r.get('j').properties) : null;
  }

  async nextScanJob(now = new Date(), exclude: string[] = []): Promise<ScanJob | null> {
    const [r] = await this.g.run(
      `MATCH (j:ScanJob {status: 'queued'}) WHERE coalesce(j.retryAt, '') <= $now AND NOT j.id IN $exclude
       RETURN j ORDER BY j.requestedAt, j.id LIMIT 1`,
      { now: now.toISOString(), exclude },
    );
    return r ? jobOf(r.get('j').properties) : null;
  }

  async recordScanFailure(id: string, error: string, o: { counted: boolean }, now = new Date()): Promise<{ attempts: number; retryAt: string | null }> {
    const [r] = await this.g.run('MATCH (j:ScanJob {id: $id}) RETURN coalesce(j.attempts, 0) AS attempts', { id });
    const attempts: number = (r?.get('attempts') ?? 0) + (o.counted ? 1 : 0);
    const retryAt = o.counted ? scanRetryAt(attempts, now) : new Date(now.getTime() + SCAN_UNAVAILABLE_WAIT_MS).toISOString();
    await this.g.run(
      `MATCH (j:ScanJob {id: $id})
       SET j.attempts = $attempts, j.retryAt = $retryAt, j.error = $error, j.status = $status
       FOREACH (_ IN CASE WHEN $status = 'failed' THEN [1] ELSE [] END | SET j.finishedAt = $now)`,
      { id, attempts, retryAt, error: redactSecrets(error), status: retryAt ? 'queued' : 'failed', now: now.toISOString() },
    );
    return { attempts, retryAt };
  }

  async updateScanJob(id: string, raw: ScanJobPatch) {
    const now = new Date().toISOString();
    // A failure's error can quote model output, so it is redacted like everything else stored.
    // A node property cannot be a map: the shard counts are kept as JSON text.
    const { shards, ...rest } = raw;
    const patch: Record<string, unknown> = { ...rest, ...(typeof raw.error === 'string' ? { error: redactSecrets(raw.error) } : {}), ...(shards !== undefined ? { shards: shards ? JSON.stringify(shards) : null } : {}) };
    await this.g.run(
      `MATCH (j:ScanJob {id: $id})
       SET j += $patch
       FOREACH (_ IN CASE WHEN $patch.status = 'running' THEN [1] ELSE [] END | SET j.startedAt = $now)
       FOREACH (_ IN CASE WHEN $patch.status IN ['done', 'failed'] THEN [1] ELSE [] END | SET j.finishedAt = $now)`,
      { id, patch, now },
    );
  }

  /** Scans left running by a worker that died are re-queued on startup. */
  async requeueStaleScans() {
    await this.g.run(`MATCH (j:ScanJob {status: 'running'}) SET j.status = 'queued'`);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const rows = await this.g.run(
      `MATCH (p:Project)
       OPTIONAL MATCH (p)<-[:IN]-(s:Session)
       WITH p, count(s) AS sessions
       OPTIONAL MATCH (f:Feedback {projectKey: p.key})
       WITH p, sessions, count(f) AS feedback
       OPTIONAL MATCH (l:Lesson {projectKey: p.key})
       WITH p, sessions, feedback, count(l) AS lessons
       OPTIONAL MATCH (x:Fact {projectKey: p.key, current: true})
       WITH p, sessions, feedback, lessons, count(x) AS facts,
            count(CASE WHEN x.docId IS NOT NULL THEN 1 END) AS documentFacts,
            count(CASE WHEN x.docId IS NULL AND (x.origin = 'manifest' OR (x.origin IS NULL AND x.why =~ $manifestWhy)) THEN 1 END) AS manifestFacts,
            count(CASE WHEN x.docId IS NULL AND x.origin = 'you' THEN 1 END) AS yourFacts
       OPTIONAL MATCH (j:ScanJob {projectKey: p.key})
       WITH p, sessions, feedback, lessons, facts, documentFacts, manifestFacts, yourFacts, j ORDER BY j.requestedAt DESC
       WITH p, sessions, feedback, lessons, facts, documentFacts, manifestFacts, yourFacts, collect(j)[0] AS last
       RETURN p, sessions, feedback, lessons, facts, documentFacts, manifestFacts, yourFacts, last
       ORDER BY p.key`,
      { manifestWhy: MANIFEST_WHY_RE },
    );
    return rows.map((r) => ({
      key: r.get('p').properties.key,
      repoPath: r.get('p').properties.repoPath ?? '',
      remote: r.get('p').properties.remote ?? null,
      aliases: r.get('p').properties.aliases ?? [],
      sessions: r.get('sessions'),
      feedback: r.get('feedback'),
      lessons: r.get('lessons'),
      facts: r.get('facts'),
      factsByOrigin: {
        model: r.get('facts') - r.get('documentFacts') - r.get('manifestFacts') - r.get('yourFacts'),
        manifest: r.get('manifestFacts'), document: r.get('documentFacts'), you: r.get('yourFacts'),
      },
      lastScan: r.get('last') ? jobOf(r.get('last').properties) : null,
      pinned: r.get('p').properties.pinned === true,
    }));
  }

  async setPinned(project: Project, pinned: boolean) {
    await this.g.run(
      `MERGE (p:Project {key: $key})
       SET p.pinned = $pinned, p.name = coalesce(p.name, $name), p.repoPath = coalesce(p.repoPath, $repoPath)`,
      { key: project.key, name: project.name, repoPath: project.repoPath, pinned },
    );
  }
}

function factOf(p: Record<string, unknown>, fileSummary: string | null = null): StoredFact {
  return {
    id: p.id as string,
    kind: p.kind as FactKind,
    statement: p.statement as string,
    path: p.path as string,
    lines: (p.lines as string) ?? null,
    confidence: p.confidence as number,
    why: (p.why as string) ?? '',
    relevance: typeof p.relevance === 'number' ? p.relevance : null,
    relevanceBy: (p.relevanceBy as RelevanceBy) ?? null,
    docId: (p.docId as string) ?? null,
    origin: factOrigin({ origin: p.origin as FactOrigin | null, docId: (p.docId as string) ?? null, why: (p.why as string) ?? '' }),
    evidence: (p.evidence as FactEvidence) ?? null,
    source: p.source as string,
    scanJobId: (p.scanJobId as string) ?? null,
    fileHash: (p.fileHash as string) ?? null,
    fileSummary: fileSummary ?? null,
    createdAt: p.createdAt as string,
  };
}

function jobOf(p: Record<string, unknown>): ScanJob {
  return {
    id: p.id as string,
    projectKey: p.projectKey as string,
    repoPath: p.repoPath as string,
    provider: (p.provider as string) ?? null,
    status: p.status as ScanStatus,
    requestedAt: p.requestedAt as string,
    startedAt: (p.startedAt as string) ?? null,
    finishedAt: (p.finishedAt as string) ?? null,
    filesScanned: (p.filesScanned as number) ?? 0,
    factsAdded: (p.factsAdded as number) ?? 0,
    error: (p.error as string) ?? null,
    attempts: Number(p.attempts ?? 0),
    retryAt: (p.retryAt as string) ?? null,
    shards: typeof p.shards === 'string' ? (JSON.parse(p.shards) as ScanShards) : null,
  };
}
