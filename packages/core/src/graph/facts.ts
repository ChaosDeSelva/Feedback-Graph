import { randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import { FACT_EVIDENCE, FACT_ORIGINS, type CodeFact, type FactEvidence, type FactKind, type FactOrigin, type Project, type ProjectSummary, type RelevanceBy, type ScanJob, type ScanQueueEntry, type ScanShards, type ScanStatus, type RunTag } from '../types.ts';
import { factOrigin } from '../relevance.ts';
import { holdsCredential, REDACT_PAGE, redactDeep, redactSecrets, redactStoredFact, reopensAsFact } from '../redact.ts';
import { DEMO_SOURCE, type FactCheck, type FactScope, type FactsStore, type ScanJobPatch, type ScannedFile } from '../store.ts';
import type { GraphRepo } from './repo.ts';
import { nearest, visibleToRun } from './nearest.ts';
import { VISIBLE_TO_RUN } from './runs.ts';

/**
 * A stored fact with its provenance: which model, which scan, which version of the file. `createdAt` is when a scan
 * (or you) wrote it, so when it was last refreshed: a rescan writes new facts, a recheck keeps the time. `fileHash`:
 * the file's hash as that scan read it. `fileChangedAt`: when a scan first saw the file at its current hash (null:
 * not recorded, or not a code file), so a fact refreshed after a session started from a file that changed after it
 * started is about that session's own change.
 */
export type StoredFact = Omit<CodeFact, 'relevance' | 'evidence'> & {
  id: string; source: string; createdAt: string; scanJobId: string | null; fileHash: string | null; fileSummary: string | null;
  fileChangedAt?: string | null;
  relevance: number | null; relevanceBy: RelevanceBy | null;
  /** How its citation was checked when saved; null on facts saved before that was recorded. */
  evidence?: FactEvidence | null;
  /** Set for a fact read from an uploaded document (path is then the document's name); null for code facts. */
  docId: string | null;
};
/** A current fact with no relevance yet, for the background scorer. */
export type UnscoredFact = { id: string; projectKey: string; kind: FactKind; statement: string; path: string; why: string };
/**
 * projectKey: only a fact of that project is changed. run: a decision made in that run changes only a fact the run
 * wrote; null: the owner's decision, which makes a run's fact the owner's; unset (the scorer): ownership is left alone.
 */
export type RelevanceUpdate = { id: string; relevance: number; by: RelevanceBy; projectKey?: string; run?: string | null };
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

/**
 * A manifest's dependency list (package.json, go.mod, pyproject.toml, Cargo.toml read without a model): long, and in
 * the file an agent can read itself, so task context names the manifest instead of printing the list (one was 22% of
 * an answer).
 */
export const isManifestDependency = (f: { kind: string; origin?: FactOrigin | null; docId?: string | null; why?: string | null }) =>
  f.kind === 'dependency' && factOrigin(f) === 'manifest';

/** Files one requestFilesScan call queues at most; more are left out. */
export const MAX_SCAN_REQUESTS = 50;
/** The paths requestFilesScan keeps: repo-relative, no '..', not empty, at most MAX_SCAN_REQUESTS, each once. */
export function scanRequestPaths(paths: string[]): string[] {
  const ok = paths
    .map((p) => p.trim().replace(/^\.\//, ''))
    .filter((p) => p && p !== PROJECT_PATH && p.length <= 500 && !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\0'));
  return [...new Set(ok)].slice(0, MAX_SCAN_REQUESTS);
}

/** Each path's request time, one millisecond apart from now on, so one call's files queue in the order they were named. */
export function requestTimes(paths: string[], now = Date.now()): [string, string][] {
  return paths.map((p, i) => [p, new Date(now + i).toISOString()]);
}

/**
 * Cypher after a MATCH of (j:ScanJob): adds waitingSince. A job that gave up its slot waits from then (servedAt), so it
 * goes behind every job queued before it gave way, whatever its project's files an agent asked for earlier: a file
 * request only moves up a job not served since. A job never served waits from when it was requested, or from its
 * project's oldest file request not read yet when that is older. ISO strings, so they compare as times.
 */
const WAITING_SINCE = `OPTIONAL MATCH (cf:CodeFile {projectKey: j.projectKey}) WHERE j.servedAt IS NULL AND cf.scanRequestedAt IS NOT NULL
       WITH j, min(cf.scanRequestedAt) AS asked
       WITH j, CASE WHEN j.servedAt IS NOT NULL THEN j.servedAt WHEN asked IS NOT NULL AND asked < j.requestedAt THEN asked ELSE j.requestedAt END AS waitingSince`;

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

  async fileScanVersions(projectKey: string): Promise<Map<string, string | null>> {
    const rows = await this.g.run(
      `MATCH (f:CodeFile {projectKey: $projectKey}) WHERE coalesce(f.removed, false) = false AND f.path <> $root AND f.hash IS NOT NULL
       RETURN f.path AS path, f.scanVersion AS version`,
      { projectKey, root: PROJECT_PATH },
    );
    return new Map(rows.map((r) => [r.get('path'), r.get('version') ?? null]));
  }

  async olderScannerFiles(version: string): Promise<Map<string, number>> {
    const rows = await this.g.run(
      `MATCH (f:CodeFile) WHERE coalesce(f.removed, false) = false AND f.path <> $root AND f.hash IS NOT NULL AND coalesce(f.scanVersion, '') <> $version
       RETURN f.projectKey AS projectKey, count(f) AS n`,
      { version, root: PROJECT_PATH },
    );
    return new Map(rows.map((r) => [r.get('projectKey'), Number(r.get('n'))]));
  }

  /** Replace the current facts of one file (old facts are closed, not deleted). */
  async saveFileFacts(projectKey: string, rawFile: ScannedFile & { summary: string }, rawFacts: EmbeddedFact[], source: string, scanJobId: string | null = null) {
    // Facts are model output about code that may contain credentials: redact at the door.
    const file = redactDeep(rawFile);
    const facts = redactDeep(rawFacts);
    const now = new Date().toISOString();
    const fields = `cf.projectKey = $projectKey, cf.path = $file.path, cf.hash = $file.hash, cf.summary = $file.summary,
           cf.scannedAt = $now, cf.removed = false, cf.scanVersion = $file.version`;
    // The demo seed only adds a file that is not recorded yet (FactsStore.saveFileFacts).
    const setFile = source === DEMO_SOURCE
      ? `ON CREATE SET ${fields}, cf.hashChangedAt = $now`
      : `SET cf.hashChangedAt = CASE WHEN cf.hash = $file.hash AND cf.hashChangedAt IS NOT NULL THEN cf.hashChangedAt ELSE $now END
       SET ${fields}`;
    await this.g.run(
      `MERGE (p:Project {key: $projectKey})
       MERGE (cf:CodeFile {id: $projectKey + ':' + $file.path})
       ${setFile}
       MERGE (cf)-[:IN]->(p)
       WITH cf
       OPTIONAL MATCH (old:Fact {current: true})-[:ABOUT]->(cf) WHERE coalesce(old.origin, '') <> 'you'
       SET old.current = false, old.validTo = $now
       WITH DISTINCT cf
       UNWIND $facts AS fx
         CREATE (n:Fact {id: randomUUID(), projectKey: $projectKey, kind: fx.kind, statement: fx.statement, path: fx.path,
                         lines: fx.lines, confidence: fx.confidence, why: fx.why, embedding: fx.embedding, source: $source,
                         origin: fx.origin, evidence: fx.evidence, checkVersion: fx.checkVersion,
                         relevance: fx.relevance, relevanceBy: CASE WHEN fx.relevance IS NULL THEN null ELSE 'model' END,
                         scanJobId: $scanJobId, fileHash: $file.hash, current: true, createdAt: $now, validFrom: $now})
         CREATE (n)-[:ABOUT]->(cf)`,
      { projectKey, file: { ...file, version: file.version ?? null }, facts: facts.map((fx) => ({ ...fx, ...provenanceOf(fx), checkVersion: fx.checkVersion ?? null, relevance: relevanceOf(fx) })), source, now, scanJobId },
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
  async replaceProjectFacts(projectKey: string, rawFacts: EmbeddedFact[], source: string, files: ScannedFile[], scanJobId: string | null = null) {
    await this.replaceScopeFacts(projectKey, { prefixes: [''], except: [] }, rawFacts, source, files, scanJobId);
  }

  /** One shard of an agentic scan: only the current facts in `scope` are closed (FactsStore.replaceScopeFacts). */
  async replaceScopeFacts(projectKey: string, scope: FactScope, rawFacts: EmbeddedFact[], source: string, rawFiles: ScannedFile[], scanJobId: string | null = null) {
    const files = rawFiles.map((fl) => ({ path: fl.path, hash: fl.hash, version: fl.version ?? null }));
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
         SET cf.hashChangedAt = CASE WHEN cf.hash = fl.hash AND cf.hashChangedAt IS NOT NULL THEN cf.hashChangedAt ELSE $now END
         SET cf.projectKey = $projectKey, cf.path = fl.path, cf.hash = fl.hash, cf.scannedAt = $now, cf.removed = false, cf.scanVersion = fl.version
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
                         origin: fx.origin, evidence: fx.evidence, checkVersion: fx.checkVersion,
                         relevance: fx.relevance, relevanceBy: CASE WHEN fx.relevance IS NULL THEN null ELSE 'model' END,
                         scanJobId: $scanJobId, fileHash: cf.hash, current: true, createdAt: $now, validFrom: $now})
         CREATE (n)-[:ABOUT]->(cf)`,
        { projectKey, facts: facts.map((f) => ({ ...f, ...provenanceOf(f), checkVersion: f.checkVersion ?? null, path: f.path || PROJECT_PATH, relevance: relevanceOf(f) })), source, now, scanJobId },
      ],
    ]);
  }

  /** Your fact: under the project, about no code file, so a scan has nothing of it to close. */
  async addOwnerFact(projectKey: string, rawFact: EmbeddedFact, by: RelevanceBy, run?: RunTag | null): Promise<StoredFact> {
    const fx = redactDeep(rawFact);
    const id = randomUUID();
    const now = new Date().toISOString();
    const relevance = relevanceOf(fx);
    this.g.sandbox.wrote(run);
    const [r] = await this.g.run(
      `MERGE (p:Project {key: $projectKey})
       CREATE (n:Fact {id: $id, projectKey: $projectKey, kind: $fx.kind, statement: $fx.statement, path: $fx.path,
                       lines: $fx.lines, confidence: $fx.confidence, why: $fx.why, embedding: $fx.embedding, source: $by,
                       origin: 'you', evidence: null, relevance: $relevance, relevanceBy: CASE WHEN $relevance IS NULL THEN null ELSE $by END,
                       scanJobId: null, fileHash: null, current: true, createdAt: $now, validFrom: $now, run: $run, sandbox: $sandbox})
       RETURN n`,
      { projectKey, id, fx: { ...fx, path: fx.path || PROJECT_PATH, lines: fx.lines ?? null }, by, relevance, now, run: run?.id ?? null, sandbox: !!run?.sandbox },
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

  async listFacts(q: { projectKey: string; kind?: FactKind; path?: string; origin?: FactOrigin; limit?: number; offset?: number; run?: string | null }): Promise<StoredFact[]> {
    const rows = await this.g.run(
      `MATCH (x:Fact {projectKey: $projectKey, current: true})
       WHERE ($kind IS NULL OR x.kind = $kind) AND ($path IS NULL OR (x.path = $path AND x.docId IS NULL))
         AND ($origin IS NULL OR ${ORIGIN_CYPHER} = $origin) AND ${VISIBLE_TO_RUN('x')}
       OPTIONAL MATCH (x)-[:ABOUT]->(cf:CodeFile)
       RETURN x, cf.summary AS fileSummary, cf.hashChangedAt AS fileChangedAt ORDER BY x.path, x.createdAt, x.id SKIP $offset LIMIT $limit`,
      {
        projectKey: q.projectKey, kind: q.kind ?? null, path: q.path ?? null, origin: q.origin ?? null, manifestWhy: MANIFEST_WHY_RE,
        offset: neo4j.int(Math.max(0, Math.floor(q.offset ?? 0))), limit: neo4j.int(q.limit ?? 500), run: q.run ?? null,
      },
    );
    return rows.map((r) => factOf(r.get('x').properties, r.get('fileSummary'), r.get('fileChangedAt')));
  }

  async factsToRecheck(q: { projectKey: string; version: string; limit: number }): Promise<StoredFact[]> {
    const rows = await this.g.run(
      `MATCH (x:Fact {projectKey: $projectKey, current: true})
       WHERE x.docId IS NULL AND coalesce(x.origin, '') <> 'you' AND coalesce(x.checkVersion, '') <> $version
       OPTIONAL MATCH (x)-[:ABOUT]->(cf:CodeFile)
       RETURN x, cf.summary AS fileSummary, cf.hashChangedAt AS fileChangedAt ORDER BY x.path, x.createdAt, x.id LIMIT $limit`,
      { projectKey: q.projectKey, version: q.version, limit: neo4j.int(Math.max(0, Math.floor(q.limit))) },
    );
    return rows.map((r) => factOf(r.get('x').properties, r.get('fileSummary'), r.get('fileChangedAt')));
  }

  /** Checked again in place: a kept fact keeps its createdAt (when it was read), so its freshness does not move. */
  async applyFactChecks(version: string, checks: FactCheck[]): Promise<number> {
    if (!checks.length) return 0;
    const [r] = await this.g.run(
      `UNWIND $checks AS c
       MATCH (x:Fact {id: c.id, current: true})
       SET x.checkVersion = $version,
           x.lines = CASE WHEN c.keep THEN c.lines ELSE x.lines END,
           x.evidence = CASE WHEN c.keep THEN c.evidence ELSE x.evidence END,
           x.statement = CASE WHEN c.keep AND c.statement IS NOT NULL THEN c.statement ELSE x.statement END,
           x.embedding = CASE WHEN c.keep AND c.embedding IS NOT NULL THEN c.embedding ELSE x.embedding END,
           x.validTo = CASE WHEN c.keep THEN x.validTo ELSE $now END,
           x.current = c.keep
       RETURN count(CASE WHEN c.keep THEN null ELSE 1 END) AS closed`,
      {
        version, now: new Date().toISOString(),
        checks: checks.map((c) => ({
          id: c.id, keep: c.keep, lines: c.lines ?? null, evidence: c.evidence && FACT_EVIDENCE.includes(c.evidence) ? c.evidence : null,
          statement: c.statement ? redactSecrets(c.statement) : null, embedding: c.embedding?.length ? c.embedding : null,
        })),
      },
    );
    return r ? Number(r.get('closed')) : 0;
  }

  async redactStoredFacts(): Promise<{ redacted: number; closed: number; owner: number; instructions: number }> {
    let redacted = 0;
    let closed = 0;
    let owner = 0;
    let instructions = 0;
    for (let after = ''; ;) {
      const rows = await this.g.run(
        `MATCH (f:Fact) WHERE f.id > $after
         RETURN f.id AS id, f.statement AS statement, f.why AS why, f.current AS current, f.origin AS origin, f.docId IS NOT NULL AS fromDoc ORDER BY f.id LIMIT $page`,
        { after, page: neo4j.int(REDACT_PAGE) },
      );
      if (!rows.length) break;
      after = rows[rows.length - 1].get('id');
      const changed = rows.flatMap((r) => {
        const was = {
          statement: (r.get('statement') ?? '') as string, why: (r.get('why') ?? null) as string | null, current: r.get('current') === true,
          origin: (r.get('origin') ?? null) as string | null, fromDoc: r.get('fromDoc') === true,
        };
        const x = { id: r.get('id') as string, owner: was.origin === 'you', ...redactStoredFact(was) };
        return x.statement !== was.statement || x.why !== was.why || x.close ? [x] : [];
      });
      if (!changed.length) continue;
      await this.g.run(
        // closeReason: why it was closed, so a later rule can serve a fact it no longer reads as an instruction again.
        `UNWIND $changed AS c MATCH (f:Fact {id: c.id})
         SET f.statement = c.statement, f.why = c.why,
             f.validTo = CASE WHEN c.close THEN $now ELSE f.validTo END,
             f.closeReason = CASE WHEN c.close THEN (CASE WHEN c.instruction THEN 'instruction' ELSE 'credential' END) ELSE f.closeReason END,
             f.current = CASE WHEN c.close THEN false ELSE f.current END`,
        { changed, now: new Date().toISOString() },
      );
      redacted += changed.filter((c) => !c.instruction).length;
      closed += changed.filter((c) => c.close && !c.instruction).length;
      owner += changed.filter((c) => c.owner).length;
      instructions += changed.filter((c) => c.instruction).length;
    }
    return { redacted, closed, owner, instructions };
  }

  async redactionRepairCandidates(after: string, limit: number) {
    const rows = await this.g.run(`MATCH (f:Fact) WHERE f.id > $after AND coalesce(f.sandbox, false) = false AND
      (f.closeReason = 'credential' OR f.statement CONTAINS '[REDACTED]' OR f.why CONTAINS '[REDACTED]')
      RETURN f.id AS id, f.projectKey AS projectKey, f.path AS path, f.docId AS docId ORDER BY f.id LIMIT $limit`,
      { after, limit: neo4j.int(limit) });
    return rows.map((r) => ({ id: r.get('id') as string, projectKey: r.get('projectKey') as string,
      path: r.get('path') as string, docId: (r.get('docId') ?? null) as string | null }));
  }

  async reopenInstructionFacts(): Promise<number> {
    let reopened = 0;
    for (let after = ''; ;) {
      // Only the re-run closes a document fact (a re-read deletes and rewrites them; a scan never touches them).
      const rows = await this.g.run(
        `MATCH (f:Fact) WHERE f.id > $after AND f.docId IS NOT NULL AND f.current = false AND coalesce(f.origin, '') <> 'you'
         RETURN f.id AS id, f.statement AS statement, f.closeReason AS closeReason ORDER BY f.id LIMIT $page`,
        { after, page: neo4j.int(REDACT_PAGE) },
      );
      if (!rows.length) break;
      after = rows[rows.length - 1].get('id');
      const ids = rows
        .filter((r) => reopensAsFact({ statement: (r.get('statement') ?? '') as string, closeReason: (r.get('closeReason') ?? null) as string | null }))
        .map((r) => r.get('id') as string);
      if (!ids.length) continue;
      const [n] = await this.g.run(
        'UNWIND $ids AS id MATCH (f:Fact {id: id}) WHERE f.current = false SET f.current = true, f.validTo = null, f.closeReason = null RETURN count(f) AS n',
        { ids },
      );
      reopened += Number(n?.get('n') ?? 0);
    }
    return reopened;
  }

  /** A request is a mark on the file's CodeFile (one with no hash yet when it was never scanned). */
  async requestFilesScan(projectKey: string, paths: string[]): Promise<number> {
    const unique = scanRequestPaths(paths);
    if (!unique.length) return 0;
    const [r] = await this.g.run(
      `MERGE (p:Project {key: $projectKey})
       WITH p
       UNWIND $asked AS a
         MERGE (cf:CodeFile {id: $projectKey + ':' + a.path})
           ON CREATE SET cf.projectKey = $projectKey, cf.path = a.path, cf.removed = false
         MERGE (cf)-[:IN]->(p)
         WITH cf, a, cf.scanRequestedAt IS NULL AS fresh
         SET cf.scanRequestedAt = coalesce(cf.scanRequestedAt, a.at)
         RETURN count(CASE WHEN fresh THEN 1 END) AS n`,
      // One millisecond apart, so files asked for in one call keep the order they were named in.
      { projectKey, asked: requestTimes(unique).map(([path, at]) => ({ path, at })) },
    );
    return r ? Number(r.get('n')) : 0;
  }

  async scanRequests(projectKey: string): Promise<string[]> {
    const rows = await this.g.run(
      `MATCH (cf:CodeFile {projectKey: $projectKey}) WHERE cf.scanRequestedAt IS NOT NULL
       RETURN cf.path AS path ORDER BY cf.scanRequestedAt, cf.path`,
      { projectKey },
    );
    return rows.map((r) => r.get('path'));
  }

  async clearScanRequests(projectKey: string, paths: string[]): Promise<void> {
    if (!paths.length) return;
    await this.g.run(`MATCH (cf:CodeFile {projectKey: $projectKey}) WHERE cf.path IN $paths REMOVE cf.scanRequestedAt`, { projectKey, paths });
  }

  async searchFacts(q: { embedding: number[]; projectKey: string; k: number; run?: string | null }): Promise<FactHit[]> {
    const rows = await nearest(this.g, {
      index: 'fact_embedding', label: 'Fact', embedding: q.embedding, k: q.k,
      where: `node.projectKey = $projectKey AND node.current = true AND ${await visibleToRun(this.g, 'node')}`,
      tail: `WITH node, score ORDER BY score DESC LIMIT $k
       OPTIONAL MATCH (node)-[:ABOUT]->(cf:CodeFile)
       RETURN node, score, cf.summary AS fileSummary, cf.hashChangedAt AS fileChangedAt ORDER BY score DESC`,
      params: { projectKey: q.projectKey, run: q.run ?? null },
    });
    return rows.map((r) => ({ fact: factOf(r.get('node').properties, r.get('fileSummary'), r.get('fileChangedAt')), score: r.get('score') }));
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
         AND (u.run IS NULL OR x.run = u.run)
       SET x.relevance = u.relevance, x.relevanceBy = u.by
       FOREACH (_ IN CASE WHEN u.owner THEN [1] ELSE [] END | SET x.run = null, x.sandbox = false)
       RETURN count(x) AS n`,
      { updates: updates.map((u) => ({ id: u.id, by: u.by, projectKey: u.projectKey ?? null, relevance: clampRelevance(u.relevance), run: u.run ?? null, owner: u.run === null })) },
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
       ${WAITING_SINCE}
       RETURN j ORDER BY waitingSince, j.requestedAt, j.id LIMIT 1`,
      { now: now.toISOString(), exclude },
    );
    return r ? jobOf(r.get('j').properties) : null;
  }

  async requeueScanJob(id: string, now = new Date()): Promise<void> {
    await this.g.run(`MATCH (j:ScanJob {id: $id}) WHERE j.status IN ['queued', 'running'] SET j.status = 'queued', j.servedAt = $now`, { id, now: now.toISOString() });
  }

  async scanQueue(): Promise<ScanQueueEntry[]> {
    const rows = await this.g.run(
      `MATCH (j:ScanJob) WHERE j.status IN ['queued', 'running']
       ${WAITING_SINCE}
       RETURN j, waitingSince ORDER BY CASE j.status WHEN 'running' THEN 0 ELSE 1 END, CASE j.status WHEN 'running' THEN j.startedAt END, waitingSince, j.requestedAt, j.id`,
    );
    return rows.map((r) => ({ ...jobOf(r.get('j').properties), waitingSince: r.get('waitingSince') }));
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
       // A sandbox run's feedback, lessons and facts are counted for no one (they are served only to that run).
       OPTIONAL MATCH (f:Feedback {projectKey: p.key}) WHERE NOT EXISTS { MATCH (k:Candidate {id: f.id}) WHERE k.sandbox = true }
       WITH p, sessions, count(f) AS feedback
       OPTIONAL MATCH (l:Lesson {projectKey: p.key}) WHERE NOT coalesce(l.sandbox, false)
       WITH p, sessions, feedback, count(l) AS lessons
       OPTIONAL MATCH (x:Fact {projectKey: p.key, current: true}) WHERE NOT coalesce(x.sandbox, false)
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

/**
 * A fact's origin in Cypher, as factOrigin reads it: as recorded, else a document's by its docId, a manifest's by the
 * reason the manifest reader gives (needs $manifestWhy), else a model's.
 */
const ORIGIN_CYPHER = `CASE WHEN x.origin IS NOT NULL THEN x.origin WHEN x.docId IS NOT NULL THEN 'document' WHEN coalesce(x.why, '') =~ $manifestWhy THEN 'manifest' ELSE 'model' END`;

function factOf(p: Record<string, unknown>, fileSummary: string | null = null, fileChangedAt: string | null = null): StoredFact {
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
    checkVersion: (p.checkVersion as string) ?? null,
    source: p.source as string,
    scanJobId: (p.scanJobId as string) ?? null,
    fileHash: (p.fileHash as string) ?? null,
    fileSummary: fileSummary ?? null,
    fileChangedAt: fileChangedAt ?? null,
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
    servedAt: (p.servedAt as string) ?? null,
  };
}
