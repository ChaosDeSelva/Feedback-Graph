import { randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import type { CodeFact, FactKind, Project, ProjectSummary, ScanJob, ScanStatus } from '../types.ts';
import { redactDeep, redactSecrets } from '../redact.ts';
import type { FactsStore } from '../store.ts';
import type { GraphRepo } from './repo.ts';

/** A stored fact with its provenance: which model, which scan, which version of the file. */
export type StoredFact = CodeFact & { id: string; source: string; createdAt: string; scanJobId: string | null; fileHash: string | null; fileSummary: string | null };
export type FactHit = { fact: StoredFact; score: number };
export type EmbeddedFact = CodeFact & { embedding: number[] };

/** The path facts about the whole project (not one file) are filed under. */
export const PROJECT_PATH = '.';

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
       OPTIONAL MATCH (old:Fact {current: true})-[:ABOUT]->(cf)
       SET old.current = false, old.validTo = $now
       WITH DISTINCT cf
       UNWIND $facts AS fx
         CREATE (n:Fact {id: randomUUID(), projectKey: $projectKey, kind: fx.kind, statement: fx.statement, path: fx.path,
                         lines: fx.lines, confidence: fx.confidence, why: fx.why, embedding: fx.embedding, source: $source,
                         scanJobId: $scanJobId, fileHash: $file.hash, current: true, createdAt: $now, validFrom: $now})
         CREATE (n)-[:ABOUT]->(cf)`,
      { projectKey, file, facts, source, now, scanJobId },
    );
  }

  async markFilesRemoved(projectKey: string, paths: string[]) {
    if (!paths.length) return;
    await this.g.run(
      `MATCH (cf:CodeFile {projectKey: $projectKey}) WHERE cf.path IN $paths
       SET cf.removed = true
       WITH cf
       OPTIONAL MATCH (x:Fact {current: true})-[:ABOUT]->(cf)
       SET x.current = false, x.validTo = $now`,
      { projectKey, paths, now: new Date().toISOString() },
    );
  }

  /**
   * Agentic scans see the whole repo at once: close every current fact from `source`
   * in the project, then attach the new ones to their files (or to the project root).
   */
  async replaceProjectFacts(projectKey: string, rawFacts: EmbeddedFact[], source: string, files: { path: string; hash: string }[], scanJobId: string | null = null) {
    const facts = redactDeep(rawFacts);
    const now = new Date().toISOString();
    // One transaction: if writing the new facts fails, the old ones stay current and the hashes stay stale,
    // so the next scan tries again instead of finding "nothing changed" over an empty project.
    await this.g.runInTransaction([
      [`MATCH (x:Fact {projectKey: $projectKey, current: true}) SET x.current = false, x.validTo = $now`, { projectKey, now }],
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
                         scanJobId: $scanJobId, fileHash: cf.hash, current: true, createdAt: $now, validFrom: $now})
         CREATE (n)-[:ABOUT]->(cf)`,
        { projectKey, facts: facts.map((f) => ({ ...f, path: f.path || PROJECT_PATH })), source, now, scanJobId },
      ],
    ]);
  }

  /** Which models wrote the project's current facts; a scan with a different one rescans every file. */
  async currentSources(projectKey: string): Promise<string[]> {
    const rows = await this.g.run(
      `MATCH (x:Fact {projectKey: $projectKey, current: true}) RETURN DISTINCT x.source AS s ORDER BY s`,
      { projectKey },
    );
    return rows.map((r) => r.get('s'));
  }

  async listFacts(q: { projectKey: string; kind?: FactKind; path?: string; limit?: number }): Promise<StoredFact[]> {
    const rows = await this.g.run(
      `MATCH (x:Fact {projectKey: $projectKey, current: true})
       WHERE ($kind IS NULL OR x.kind = $kind) AND ($path IS NULL OR x.path = $path)
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

  async requestScan(project: Project, provider: string | null): Promise<ScanJob> {
    // Repeat clicks or scripted POSTs must not queue the same paid full-repo scan twice.
    const [open] = await this.g.run(
      `MATCH (j:ScanJob {projectKey: $key}) WHERE j.status IN ['queued', 'running'] RETURN j.id AS id ORDER BY j.requestedAt DESC LIMIT 1`,
      { key: project.key },
    );
    if (open) return (await this.scanJob(open.get('id')))!;
    const id = `scan:${randomUUID()}`;
    const now = new Date().toISOString();
    await this.g.run(
      `MERGE (p:Project {key: $project.key}) ON CREATE SET p.name = $project.name, p.repoPath = $project.repoPath
       CREATE (j:ScanJob {id: $id, projectKey: $project.key, repoPath: $project.repoPath, provider: $provider,
                          status: 'queued', requestedAt: $now, filesScanned: 0, factsAdded: 0})-[:FOR]->(p)`,
      { id, project, provider, now },
    );
    return (await this.scanJob(id))!;
  }

  async scanJob(id: string): Promise<ScanJob | null> {
    const [r] = await this.g.run('MATCH (j:ScanJob {id: $id}) RETURN j', { id });
    return r ? jobOf(r.get('j').properties) : null;
  }

  async nextScanJob(): Promise<ScanJob | null> {
    const [r] = await this.g.run(
      `MATCH (j:ScanJob {status: 'queued'}) RETURN j ORDER BY j.requestedAt LIMIT 1`,
    );
    return r ? jobOf(r.get('j').properties) : null;
  }

  async updateScanJob(id: string, patch: Partial<Pick<ScanJob, 'filesScanned' | 'factsAdded' | 'error'>> & { status?: ScanStatus }) {
    const now = new Date().toISOString();
    // A failure's error can quote model output, so it is redacted like everything else stored.
    if (typeof patch.error === 'string') patch = { ...patch, error: redactSecrets(patch.error) };
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
       WITH p, sessions, feedback, lessons, count(x) AS facts
       OPTIONAL MATCH (j:ScanJob {projectKey: p.key})
       WITH p, sessions, feedback, lessons, facts, j ORDER BY j.requestedAt DESC
       WITH p, sessions, feedback, lessons, facts, collect(j)[0] AS last
       RETURN p, sessions, feedback, lessons, facts, last
       ORDER BY p.key`,
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
      lastScan: r.get('last') ? jobOf(r.get('last').properties) : null,
    }));
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
  };
}
