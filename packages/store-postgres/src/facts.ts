import { conditionalWrite } from './conditionalWrite.ts';
import { archiveBeforeRedaction, archiveRedactionInput } from '@fb/core';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { clampRelevance, DEMO_SOURCE, FACT_EVIDENCE, factOrigin, requestTimes, scanRequestPaths, MANIFEST_WHY_RE, PROJECT_PATH, provenanceOf, holdsCredential, REDACT_PAGE, redactDeep, redactSecrets, relevanceOf, SCAN_UNAVAILABLE_WAIT_MS, scanRetryAt, redactStoredFact, reopensAsFact } from '@fb/core';
import type { EmbeddedFact, FactCheck, FactHit, FactKind, FactOrigin, FactScope, FactsStore, Project, ScannedFile, ProjectSummary, RelevanceBy, ScanJob, ScanJobPatch, ScanQueueEntry, ScanStatus, StoredFact, RelevanceUpdate, UnscoredFact, RunTag } from '@fb/core';
import { iso, toJson, toVector, tx, type Db } from './db.ts';
import { runSearch, sandboxPresence, searchFactsQuery, visibleToRun } from './vector.ts';

type Exec = Pick<pg.PoolClient, 'query'>;

/** The CodeFile id Neo4j uses: '<projectKey>:<path>'. */
const fileId = (projectKey: string, path: string) => `${projectKey}:${path}`;

const FACT_COLUMNS = `x.id, x.kind, x.statement, x.path, x.lines, x.confidence, x.why, x.relevance, x.relevance_by, x.source,
                      x.scan_job_id, x.file_hash, x.created_at, x.doc_id, x.origin, x.evidence, x.check_version`;

/** A fact's origin in SQL, as factOrigin reads it (the manifest reader's reason is parameter `$manifestWhy`). */
const originSql = (manifestWhy: string) =>
  `CASE WHEN x.origin IS NOT NULL THEN x.origin WHEN x.doc_id IS NOT NULL THEN 'document' WHEN coalesce(x.why, '') ~ ${manifestWhy} THEN 'manifest' ELSE 'model' END`;

/** A code_files upsert's hash_changed_at: kept while the hash stays the same, else the scan's time. */
const HASH_CHANGED = `hash_changed_at = CASE WHEN code_files.hash IS NOT DISTINCT FROM EXCLUDED.hash AND code_files.hash_changed_at IS NOT NULL
                        THEN code_files.hash_changed_at ELSE EXCLUDED.scanned_at END`;

/** Code facts, the files they are about, scan jobs and the per-project summary. */
export class PgFactsStore implements FactsStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async fileHashes(projectKey: string): Promise<Map<string, string>> {
    const { rows } = await this.db.pool.query(
      `SELECT path, hash FROM code_files WHERE project_key = $1 AND NOT removed AND path <> $2 AND hash IS NOT NULL`,
      [projectKey, PROJECT_PATH],
    );
    return new Map(rows.map((r) => [r.path, r.hash]));
  }

  async fileScanVersions(projectKey: string): Promise<Map<string, string | null>> {
    const { rows } = await this.db.pool.query(
      `SELECT path, scan_version FROM code_files WHERE project_key = $1 AND NOT removed AND path <> $2 AND hash IS NOT NULL`,
      [projectKey, PROJECT_PATH],
    );
    return new Map(rows.map((r) => [r.path, r.scan_version ?? null]));
  }

  async olderScannerFiles(version: string): Promise<Map<string, number>> {
    const { rows } = await this.db.pool.query(
      `SELECT project_key, count(*)::int AS n FROM code_files
       WHERE NOT removed AND path <> $2 AND hash IS NOT NULL AND scan_version IS DISTINCT FROM $1
       GROUP BY project_key`,
      [version, PROJECT_PATH],
    );
    return new Map(rows.map((r) => [r.project_key, r.n]));
  }

  /** Replace the current facts of one file (old facts are closed, not deleted). */
  async saveFileFacts(projectKey: string, rawFile: ScannedFile & { summary: string }, rawFacts: EmbeddedFact[], source: string, scanJobId: string | null = null): Promise<void> {
    // Facts are model output about code that may contain credentials: redact at the door.
    const file = redactDeep(rawFile);
    const facts = redactDeep(rawFacts);
    await archiveRedactionInput('facts', projectKey, { file: rawFile, facts: rawFacts }, { file, facts });
    const now = new Date();
    const cf = fileId(projectKey, file.path);
    // One Cypher statement in Neo4j, so all or nothing here too.
    await tx(this.db, async (c) => {
      await c.query('INSERT INTO projects (key) VALUES ($1) ON CONFLICT DO NOTHING', [projectKey]);
      await c.query(
        `INSERT INTO code_files (id, project_key, path, hash, summary, scanned_at, removed, scan_version, hash_changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, false, $7, $6)
         ON CONFLICT (id) DO ${source === DEMO_SOURCE ? 'NOTHING' : `UPDATE SET project_key = EXCLUDED.project_key, path = EXCLUDED.path, hash = EXCLUDED.hash,
           summary = EXCLUDED.summary, scanned_at = EXCLUDED.scanned_at, removed = false, scan_version = EXCLUDED.scan_version,
           ${HASH_CHANGED}`}`,
        [cf, projectKey, file.path, file.hash, file.summary, now, file.version ?? null],
      );
      await c.query(`UPDATE facts SET current = false, valid_to = $2 WHERE code_file_id = $1 AND current AND origin IS DISTINCT FROM 'you'`, [cf, now]);
      await insertFacts(c, projectKey, facts.map((fx) => ({ ...fx, codeFileId: cf })), source, scanJobId, now, file.hash);
    });
  }

  async markFilesRemoved(projectKey: string, paths: string[]): Promise<void> {
    if (!paths.length) return;
    const now = new Date();
    await tx(this.db, async (c) => {
      const { rows } = await c.query(
        'UPDATE code_files SET removed = true WHERE project_key = $1 AND path = ANY($2::text[]) RETURNING id',
        [projectKey, paths],
      );
      if (!rows.length) return;
      await c.query(`UPDATE facts SET current = false, valid_to = $2 WHERE code_file_id = ANY($1::text[]) AND current AND origin IS DISTINCT FROM 'you'`, [rows.map((r) => r.id), now]);
    });
  }

  /**
   * Agentic scans see the whole repo at once: close every current fact in the project, then attach the new ones to
   * their files (or to the project root). One transaction: a failure leaves the old facts current and hashes stale.
   */
  async replaceProjectFacts(projectKey: string, rawFacts: EmbeddedFact[], source: string, files: ScannedFile[], scanJobId: string | null = null): Promise<void> {
    await this.replaceScopeFacts(projectKey, { prefixes: [''], except: [] }, rawFacts, source, files, scanJobId);
  }

  /** One shard of an agentic scan: only the current facts in `scope` are closed (FactsStore.replaceScopeFacts). */
  async replaceScopeFacts(projectKey: string, scope: FactScope, rawFacts: EmbeddedFact[], source: string, files: ScannedFile[], scanJobId: string | null = null): Promise<void> {
    const facts = redactDeep(rawFacts).map((f) => ({ ...f, path: f.path || PROJECT_PATH }));
    await archiveRedactionInput('facts', projectKey, rawFacts, redactDeep(rawFacts));
    const now = new Date();
    // Neo4j MERGEs file by file, so a path listed twice ends with the last hash.
    const latest = new Map(files.map((fl) => [fl.path, fl]));
    await tx(this.db, async (c) => {
      // Facts read from your documents, and facts you wrote, are not the code's: a scan never closes them.
      await c.query(
        `UPDATE facts x SET current = false, valid_to = $2 WHERE x.project_key = $1 AND x.current AND x.doc_id IS NULL AND x.origin IS DISTINCT FROM 'you'
           AND EXISTS (SELECT 1 FROM unnest($3::text[]) AS p(pre) WHERE p.pre = '' OR x.path = p.pre OR left(x.path, length(p.pre) + 1) = p.pre || '/')
           AND NOT EXISTS (SELECT 1 FROM unnest($4::text[]) AS e(ex) WHERE x.path = e.ex OR left(x.path, length(e.ex) + 1) = e.ex || '/')`,
        [projectKey, now, scope.prefixes, scope.except],
      );
      await c.query('INSERT INTO projects (key) VALUES ($1) ON CONFLICT DO NOTHING', [projectKey]);
      if (latest.size) {
        await c.query(
          `INSERT INTO code_files (id, project_key, path, hash, scanned_at, removed, scan_version, hash_changed_at)
           SELECT $1 || ':' || f.path, $1, f.path, f.hash, $4, false, f.version, $4 FROM unnest($2::text[], $3::text[], $5::text[]) AS f(path, hash, version)
           ON CONFLICT (id) DO UPDATE SET project_key = EXCLUDED.project_key, path = EXCLUDED.path, hash = EXCLUDED.hash,
             scanned_at = EXCLUDED.scanned_at, removed = false, scan_version = EXCLUDED.scan_version, ${HASH_CHANGED}`,
          [projectKey, [...latest.keys()], [...latest.values()].map((fl) => fl.hash), now, [...latest.values()].map((fl) => fl.version ?? null)],
        );
      }
      if (!facts.length) return;
      // A fact about a file the scan did not list still gets a CodeFile (no hash, no summary), as MERGE ... ON CREATE does.
      await c.query(
        `INSERT INTO code_files (id, project_key, path, removed)
         SELECT $1 || ':' || p, $1, p, false FROM unnest($2::text[]) AS p
         ON CONFLICT (id) DO NOTHING`,
        [projectKey, [...new Set(facts.map((f) => f.path))]],
      );
      // The fact's file hash is its CodeFile's hash as it now stands.
      await insertFacts(c, projectKey, facts.map((fx) => ({ ...fx, codeFileId: fileId(projectKey, fx.path) })), source, scanJobId, now, null);
    });
  }

  /** Your fact: under the project, about no code file, so a scan has nothing of it to close. */
  async addOwnerFact(projectKey: string, rawFact: EmbeddedFact, by: RelevanceBy, run?: RunTag | null): Promise<StoredFact> {
    const fx = redactDeep(rawFact);
    await archiveRedactionInput('fact', projectKey, rawFact, fx);
    const relevance = relevanceOf(fx);
    sandboxPresence(this.db).wrote(run);
    return tx(this.db, async (c) => {
      await c.query('INSERT INTO projects (key) VALUES ($1) ON CONFLICT DO NOTHING', [projectKey]);
      const { rows } = await c.query(
        `INSERT INTO facts (id, project_key, kind, statement, path, lines, confidence, why, source, current, created_at, valid_from,
                            embedding, relevance, relevance_by, origin, run, sandbox)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text, true, $10, $10, $11::vector, $12::float8, CASE WHEN $12::float8 IS NULL THEN NULL ELSE $9::text END, 'you', $13, $14)
         RETURNING ${FACT_COLUMNS.replace(/x\./g, '')}`,
        [randomUUID(), projectKey, fx.kind, fx.statement, fx.path || PROJECT_PATH, fx.lines ?? null, fx.confidence ?? null, fx.why ?? null, by,
          new Date(), toVector(fx.embedding), relevance, run?.id ?? null, !!run?.sandbox],
      );
      return factOf(rows[0]);
    });
  }

  /** Which models wrote the project's current facts; a scan with a different one rescans every file. */
  async currentSources(projectKey: string): Promise<string[]> {
    const { rows } = await this.db.pool.query(
      `SELECT DISTINCT source COLLATE "C" AS s FROM facts WHERE project_key = $1 AND current AND doc_id IS NULL AND origin IS DISTINCT FROM 'you' ORDER BY s`,
      [projectKey],
    );
    return rows.map((r) => r.s);
  }

  async listFacts(q: { projectKey: string; kind?: FactKind; path?: string; origin?: FactOrigin; limit?: number; offset?: number; run?: string | null }): Promise<StoredFact[]> {
    const { rows } = await this.db.pool.query(
      `SELECT ${FACT_COLUMNS}, cf.summary AS file_summary, cf.hash_changed_at AS file_changed_at
       FROM facts x LEFT JOIN code_files cf ON cf.id = x.code_file_id
       WHERE x.project_key = $1 AND x.current AND ($2::text IS NULL OR x.kind = $2) AND ($3::text IS NULL OR (x.path = $3 AND x.doc_id IS NULL))
         AND ($6::text IS NULL OR ${originSql('$7')} = $6) AND ${visibleToRun('x', '$8')}
       ORDER BY x.path COLLATE "C", x.created_at, x.id
       LIMIT $4 OFFSET $5`,
      [q.projectKey, q.kind ?? null, q.path ?? null, q.limit ?? 500, Math.max(0, Math.floor(q.offset ?? 0)), q.origin ?? null, MANIFEST_WHY_RE, q.run ?? null],
    );
    return rows.map(factOf);
  }

  async factsToRecheck(q: { projectKey: string; version: string; limit: number }): Promise<StoredFact[]> {
    const { rows } = await this.db.pool.query(
      `SELECT ${FACT_COLUMNS}, cf.summary AS file_summary, cf.hash_changed_at AS file_changed_at
       FROM facts x LEFT JOIN code_files cf ON cf.id = x.code_file_id
       WHERE x.project_key = $1 AND x.current AND x.doc_id IS NULL AND x.origin IS DISTINCT FROM 'you' AND x.check_version IS DISTINCT FROM $2
       ORDER BY x.path COLLATE "C", x.created_at, x.id
       LIMIT $3`,
      [q.projectKey, q.version, Math.max(0, Math.floor(q.limit))],
    );
    return rows.map(factOf);
  }

  /** Checked again in place: a kept fact keeps its created_at (when it was read), so its freshness does not move. */
  async applyFactChecks(version: string, checks: FactCheck[]): Promise<number> {
    if (!checks.length) return 0;
    const { rows: [r] } = await this.db.pool.query(
      `WITH c AS (SELECT * FROM unnest($2::text[], $3::boolean[], $4::text[], $5::text[], $7::text[], $8::text[]) AS c(id, keep, lines, evidence, statement, embedding)),
            u AS (
              UPDATE facts x SET check_version = $1,
                lines = CASE WHEN c.keep THEN c.lines ELSE x.lines END,
                evidence = CASE WHEN c.keep THEN c.evidence ELSE x.evidence END,
                statement = CASE WHEN c.keep AND c.statement IS NOT NULL THEN c.statement ELSE x.statement END,
                embedding = CASE WHEN c.keep AND c.embedding IS NOT NULL THEN c.embedding::vector ELSE x.embedding END,
                current = c.keep,
                valid_to = CASE WHEN c.keep THEN x.valid_to ELSE $6::timestamptz END
              FROM c WHERE x.id = c.id AND x.current
              RETURNING c.keep)
       SELECT count(*) FILTER (WHERE NOT keep)::int AS closed FROM u`,
      [version, checks.map((c) => c.id), checks.map((c) => c.keep), checks.map((c) => c.lines ?? null),
        checks.map((c) => (c.evidence && FACT_EVIDENCE.includes(c.evidence) ? c.evidence : null)), new Date(),
        checks.map((c) => (c.statement ? redactSecrets(c.statement) : null)), checks.map((c) => (c.embedding?.length ? toVector(c.embedding) : null))],
    );
    return r?.closed ?? 0;
  }

  async redactStoredFacts(): Promise<{ redacted: number; closed: number; owner: number; instructions: number }> {
    let redacted = 0;
    let closed = 0;
    let owner = 0;
    let instructions = 0;
    for (let after = ''; ;) {
      const { rows } = await this.db.pool.query(
        'SELECT id, statement, why, current, origin, doc_id IS NOT NULL AS "fromDoc" FROM facts WHERE id > $1 ORDER BY id LIMIT $2',
        [after, REDACT_PAGE],
      );
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      const changed = rows.flatMap((r: { id: string; statement: string; why: string | null; current: boolean; origin: string | null; fromDoc: boolean }) => {
        const x = { id: r.id, owner: r.origin === 'you', ...redactStoredFact(r) };
        return x.statement !== r.statement || x.why !== r.why || x.close ? [x] : [];
      });
      if (!changed.length) continue;
      for (const r of rows) if (changed.some(c => c.id === r.id)) await archiveBeforeRedaction('fact', r.id, r);
      // close_reason: why it was closed, so a later rule can serve a fact it no longer reads as an instruction again.
      await this.db.pool.query(
        `UPDATE facts x SET statement = c.statement, why = c.why,
           current = x.current AND NOT c.close, valid_to = CASE WHEN c.close THEN $5::timestamptz ELSE x.valid_to END,
           close_reason = CASE WHEN c.close THEN c.reason ELSE x.close_reason END
         FROM unnest($1::text[], $2::text[], $3::text[], $4::boolean[], $6::text[]) AS c(id, statement, why, close, reason) WHERE x.id = c.id`,
        [changed.map((c) => c.id), changed.map((c) => c.statement), changed.map((c) => c.why), changed.map((c) => c.close), new Date(),
          changed.map((c) => (c.instruction ? 'instruction' : 'credential'))],
      );
      redacted += changed.filter((c) => !c.instruction).length;
      closed += changed.filter((c) => c.close && !c.instruction).length;
      owner += changed.filter((c) => c.owner).length;
      instructions += changed.filter((c) => c.instruction).length;
    }
    return { redacted, closed, owner, instructions };
  }

  async redactionRepairCandidates(after: string, limit: number) {
    const { rows } = await this.db.pool.query(`SELECT id, project_key, path, doc_id FROM facts WHERE id > $1 AND NOT coalesce(sandbox, false) AND
      (close_reason = 'credential' OR statement LIKE '%[REDACTED]%' OR why LIKE '%[REDACTED]%') ORDER BY id LIMIT $2`, [after, limit]);
    return rows.map((r) => ({ id: r.id as string, projectKey: r.project_key as string, path: r.path as string, docId: (r.doc_id ?? null) as string | null }));
  }

  async reopenInstructionFacts(): Promise<number> {
    let reopened = 0;
    for (let after = ''; ;) {
      // Only the re-run closes a document fact (a re-read deletes and rewrites them; a scan never touches them).
      const { rows } = await this.db.pool.query(
        `SELECT id, statement, close_reason AS "closeReason" FROM facts
         WHERE id > $1 AND doc_id IS NOT NULL AND NOT current AND origin IS DISTINCT FROM 'you' ORDER BY id LIMIT $2`,
        [after, REDACT_PAGE],
      );
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      const ids = rows.filter((r: { statement: string; closeReason: string | null }) => reopensAsFact(r)).map((r: { id: string }) => r.id);
      if (!ids.length) continue;
      const { rowCount } = await this.db.pool.query('UPDATE facts SET current = true, valid_to = NULL, close_reason = NULL WHERE id = ANY($1::text[]) AND NOT current', [ids]);
      reopened += rowCount ?? 0;
    }
    return reopened;
  }

  /** A request is a mark on the file's code_files row (one with no hash yet when it was never scanned). */
  async requestFilesScan(projectKey: string, paths: string[]): Promise<number> {
    const unique = scanRequestPaths(paths);
    if (!unique.length) return 0;
    return tx(this.db, async (c) => {
      await c.query('INSERT INTO projects (key) VALUES ($1) ON CONFLICT DO NOTHING', [projectKey]);
      await c.query(
        `INSERT INTO code_files (id, project_key, path, removed) SELECT $1 || ':' || p, $1, p, false FROM unnest($2::text[]) AS p
         ON CONFLICT (id) DO NOTHING`,
        [projectKey, unique],
      );
      const { rowCount } = await c.query(
        // One millisecond apart, so files asked for in one call keep the order they were named in.
        `UPDATE code_files cf SET scan_requested_at = a.at
           FROM unnest($2::text[], $3::timestamptz[]) AS a(path, at)
          WHERE cf.id = $1 || ':' || a.path AND cf.scan_requested_at IS NULL`,
        [projectKey, unique, requestTimes(unique).map(([, at]) => at)],
      );
      return rowCount ?? 0;
    });
  }

  async scanRequests(projectKey: string): Promise<string[]> {
    const { rows } = await this.db.pool.query(
      `SELECT path FROM code_files WHERE project_key = $1 AND scan_requested_at IS NOT NULL ORDER BY scan_requested_at, path COLLATE "C"`,
      [projectKey],
    );
    return rows.map((r) => r.path);
  }

  async clearScanRequests(projectKey: string, paths: string[]): Promise<void> {
    if (!paths.length) return;
    await this.db.pool.query('UPDATE code_files SET scan_requested_at = NULL WHERE project_key = $1 AND path = ANY($2::text[])', [projectKey, paths]);
  }

  async searchFacts(q: { embedding: number[]; projectKey: string; k: number; run?: string | null }): Promise<FactHit[]> {
    // The project's current facts, nearest first, through the HNSW index when it pays (see vector.ts).
    const rows = await runSearch(this.db, searchFactsQuery(this.db, q, FACT_COLUMNS, { sandbox: await sandboxPresence(this.db).any() }), q.k);
    return rows.map((r) => ({ fact: factOf(r), score: r.score }));
  }

  async unscoredFacts(q: { projectKeys: string[]; limit: number }): Promise<UnscoredFact[]> {
    const { rows } = await this.db.pool.query(
      `SELECT id, project_key, kind, statement, path, why FROM facts
       WHERE current AND relevance IS NULL AND project_key = ANY($1::text[])
       ORDER BY project_key COLLATE "C", path COLLATE "C", created_at, id LIMIT $2`,
      [q.projectKeys, q.limit],
    );
    return rows.map((r) => ({ id: r.id, projectKey: r.project_key, kind: r.kind, statement: r.statement, path: r.path, why: r.why ?? '' }));
  }

  /** A model's score never replaces yours or an agent's (the operator token). Returns how many facts changed. */
  async setFactRelevance(updates: RelevanceUpdate[]): Promise<number> {
    return conditionalWrite(this.db, async query => {
      if (!updates.length) return 0;
      const { rowCount } = await query(
        `UPDATE facts x SET relevance = u.relevance, relevance_by = u.by,
           run = CASE WHEN u.owner THEN NULL ELSE x.run END, sandbox = CASE WHEN u.owner THEN false ELSE x.sandbox END
         FROM unnest($1::text[], $2::float8[], $3::text[], $4::text[], $5::text[], $6::boolean[]) AS u(id, relevance, by, project_key, run, owner)
         WHERE x.id = u.id AND (u.project_key IS NULL OR x.project_key = u.project_key)
           AND (u.by <> 'model' OR coalesce(x.relevance_by, 'model') = 'model')
           AND (u.run IS NULL OR x.run = u.run)`,
        [updates.map((u) => u.id), updates.map((u) => clampRelevance(u.relevance)), updates.map((u) => u.by), updates.map((u) => u.projectKey ?? null), updates.map((u) => u.run ?? null), updates.map((u) => u.run === null)],
      );
      return rowCount ?? 0;
    }, result => result > 0);
  }

  async requestScan(project: Project, provider: string | null): Promise<ScanJob> {
    // Repeat clicks or scripted POSTs must not queue the same paid full-repo scan twice. The lock makes the
    // check-then-insert atomic per project (Neo4j's two statements are not; this only closes that race).
    const id = await tx(this.db, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('scan_jobs:' || $1, 0))`, [project.key]);
      const { rows: [open] } = await c.query(
        `SELECT id FROM scan_jobs WHERE project_key = $1 AND status IN ('queued', 'running')
         ORDER BY requested_at DESC, id DESC LIMIT 1`,
        [project.key],
      );
      // Asking again is the owner saying "now": a queued job waiting out a backoff runs at the next poll.
      if (open) {
        await c.query(`UPDATE scan_jobs SET retry_at = NULL WHERE id = $1 AND status = 'queued'`, [open.id]);
        return open.id as string;
      }
      const fresh = `scan:${randomUUID()}`;
      await c.query('INSERT INTO projects (key, name, repo_path) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [project.key, project.name, project.repoPath]);
      await c.query(
        `INSERT INTO scan_jobs (id, project_key, repo_path, provider, status, requested_at, files_scanned, facts_added)
         VALUES ($1, $2, $3, $4, 'queued', $5, 0, 0)`,
        [fresh, project.key, project.repoPath, provider, new Date()],
      );
      return fresh;
    });
    return (await this.scanJob(id))!;
  }

  async scanJob(id: string): Promise<ScanJob | null> {
    const { rows: [r] } = await this.db.pool.query('SELECT * FROM scan_jobs WHERE id = $1', [id]);
    return r ? jobOf(r) : null;
  }

  async nextScanJob(now = new Date(), exclude: string[] = []): Promise<ScanJob | null> {
    const { rows: [r] } = await this.db.pool.query(
      `SELECT j.*, ${WAITING_SINCE} AS waiting_since FROM scan_jobs j
        WHERE j.status = 'queued' AND (j.retry_at IS NULL OR j.retry_at <= $1) AND NOT (j.id = ANY($2::text[]))
        ORDER BY waiting_since, j.requested_at, j.id LIMIT 1`,
      [now, exclude],
    );
    return r ? jobOf(r) : null;
  }

  async requeueScanJob(id: string, now = new Date()): Promise<void> {
    await this.db.pool.query(`UPDATE scan_jobs SET status = 'queued', served_at = $2 WHERE id = $1 AND status IN ('queued', 'running')`, [id, now]);
  }

  async scanQueue(): Promise<ScanQueueEntry[]> {
    const { rows } = await this.db.pool.query(
      `SELECT j.*, ${WAITING_SINCE} AS waiting_since FROM scan_jobs j WHERE j.status IN ('queued', 'running')
        ORDER BY (j.status = 'running') DESC, CASE WHEN j.status = 'running' THEN j.started_at END, waiting_since, j.requested_at, j.id`,
    );
    return rows.map((r) => ({ ...jobOf(r), waitingSince: iso(new Date(r.waiting_since))! }));
  }

  async recordScanFailure(id: string, error: string, o: { counted: boolean }, now = new Date()): Promise<{ attempts: number; retryAt: string | null }> {
    return tx(this.db, async (c) => {
      const { rows: [r] } = await c.query('SELECT attempts FROM scan_jobs WHERE id = $1 FOR UPDATE', [id]);
      const attempts: number = (r?.attempts ?? 0) + (o.counted ? 1 : 0);
      const retryAt = o.counted ? scanRetryAt(attempts, now) : new Date(now.getTime() + SCAN_UNAVAILABLE_WAIT_MS).toISOString();
      await c.query(
        `UPDATE scan_jobs SET attempts = $2, retry_at = $3, error = $4, status = $5::text,
           finished_at = CASE WHEN $5::text = 'failed' THEN $6::timestamptz ELSE finished_at END
         WHERE id = $1`,
        [id, attempts, retryAt, redactSecrets(error), retryAt ? 'queued' : 'failed', now],
      );
      return { attempts, retryAt };
    });
  }

  async updateScanJob(id: string, patch: ScanJobPatch): Promise<void> {
    // Neo4j's `SET j += $patch`: only the keys present change; a key set to null removes the property, which reads
    // back as 0 for the counters and null for the error.
    const has = (k: keyof typeof patch) => Object.hasOwn(patch, k);
    const status = patch.status ?? null;
    await this.db.pool.query(
      `UPDATE scan_jobs SET
         status = coalesce($2::text, status),
         files_scanned = CASE WHEN $3::boolean THEN coalesce($4::integer, 0) ELSE files_scanned END,
         facts_added = CASE WHEN $5::boolean THEN coalesce($6::integer, 0) ELSE facts_added END,
         error = CASE WHEN $7::boolean THEN $8::text ELSE error END,
         started_at = CASE WHEN $2::text = 'running' THEN $9 ELSE started_at END,
         finished_at = CASE WHEN $2::text IN ('done', 'failed') THEN $9 ELSE finished_at END,
         shards = CASE WHEN $10::boolean THEN $11::jsonb ELSE shards END,
         retry_at = CASE WHEN $12::boolean THEN $13::timestamptz ELSE retry_at END
       WHERE id = $1`,
      [id, status, has('filesScanned'), patch.filesScanned ?? null, has('factsAdded'), patch.factsAdded ?? null, has('error'), patch.error == null ? null : redactSecrets(patch.error), new Date(),
        has('shards') && patch.shards !== undefined, patch.shards ? toJson(patch.shards) : null, has('retryAt'), patch.retryAt ?? null],
    );
  }

  /** Scans left running by a worker that died are re-queued on startup. */
  async requeueStaleScans(): Promise<void> {
    await this.db.pool.query(`UPDATE scan_jobs SET status = 'queued' WHERE status = 'running'`);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const { rows } = await this.db.pool.query(
      `SELECT p.key, p.repo_path, p.remote, p.aliases, p.pinned,
              (SELECT count(*) FROM sessions s WHERE s.project_key = p.key) AS sessions,
              -- A sandbox run's feedback, lessons and facts are counted for no one (they are served only to that run).
              (SELECT count(*) FROM feedback f WHERE f.project_key = p.key AND NOT EXISTS (SELECT 1 FROM candidates k WHERE k.id = f.id AND k.sandbox)) AS feedback,
              (SELECT count(*) FROM lessons l WHERE l.project_key = p.key AND NOT l.sandbox) AS lessons,
              (SELECT count(*) FROM facts x WHERE x.project_key = p.key AND x.current AND NOT x.sandbox) AS facts,
              (SELECT count(*) FROM facts x WHERE x.project_key = p.key AND x.current AND NOT x.sandbox AND x.doc_id IS NOT NULL) AS document_facts,
              (SELECT count(*) FROM facts x WHERE x.project_key = p.key AND x.current AND NOT x.sandbox AND x.doc_id IS NULL
                 AND (x.origin = 'manifest' OR (x.origin IS NULL AND x.why ~ $1))) AS manifest_facts,
              (SELECT count(*) FROM facts x WHERE x.project_key = p.key AND x.current AND NOT x.sandbox AND x.doc_id IS NULL AND x.origin = 'you') AS your_facts,
              to_jsonb(last) AS last
       FROM projects p
       LEFT JOIN LATERAL (SELECT * FROM scan_jobs j WHERE j.project_key = p.key ORDER BY j.requested_at DESC, j.id DESC LIMIT 1) last ON true
       ORDER BY p.key COLLATE "C"`,
      [MANIFEST_WHY_RE],
    );
    return rows.map((r) => ({
      key: r.key,
      repoPath: r.repo_path ?? '',
      remote: r.remote ?? null,
      aliases: r.aliases ?? [],
      sessions: r.sessions,
      feedback: r.feedback,
      lessons: r.lessons,
      facts: r.facts,
      factsByOrigin: { model: r.facts - r.document_facts - r.manifest_facts - r.your_facts, manifest: r.manifest_facts, document: r.document_facts, you: r.your_facts },
      lastScan: r.last ? jobOf(r.last) : null,
      pinned: r.pinned === true,
    }));
  }

  async setPinned(project: Project, pinned: boolean): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO projects (key, name, repo_path, pinned) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET pinned = EXCLUDED.pinned, name = coalesce(projects.name, EXCLUDED.name),
         repo_path = coalesce(projects.repo_path, EXCLUDED.repo_path)`,
      [project.key, project.name, project.repoPath, pinned],
    );
  }
}

type FactRow = EmbeddedFact & { codeFileId: string };

/**
 * Insert new current facts in one statement. fileHash null takes each fact's CodeFile hash as it stands
 * (replaceProjectFacts' `fileHash: cf.hash`); otherwise every fact gets that hash.
 */
async function insertFacts(c: Exec, projectKey: string, facts: FactRow[], source: string, scanJobId: string | null, now: Date, fileHash: string | null) {
  if (!facts.length) return;
  await c.query(
    `INSERT INTO facts (id, project_key, code_file_id, kind, statement, path, lines, confidence, why, source, scan_job_id,
                        file_hash, current, created_at, valid_from, embedding, relevance, relevance_by, origin, evidence, check_version)
     SELECT n.id, $1, n.code_file_id, n.kind, n.statement, n.path, n.lines, n.confidence, n.why, $2, $3,
            CASE WHEN $4::boolean THEN $5 ELSE cf.hash END, true, $6, $6, n.embedding::vector,
            n.relevance, CASE WHEN n.relevance IS NULL THEN NULL ELSE 'model' END, n.origin, n.evidence, n.check_version
     FROM unnest($7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::float8[], $14::text[], $15::text[], $16::float8[], $17::text[], $18::text[], $19::text[])
            WITH ORDINALITY AS n(id, code_file_id, kind, statement, path, lines, confidence, why, embedding, relevance, origin, evidence, check_version, ord)
     LEFT JOIN code_files cf ON cf.id = n.code_file_id
     ORDER BY n.ord`,
    [
      projectKey, source, scanJobId, fileHash !== null, fileHash, now,
      facts.map(() => randomUUID()),
      facts.map((f) => f.codeFileId),
      facts.map((f) => f.kind),
      facts.map((f) => f.statement),
      facts.map((f) => f.path),
      facts.map((f) => f.lines ?? null),
      facts.map((f) => f.confidence ?? null),
      facts.map((f) => f.why ?? null),
      facts.map((f) => toVector(f.embedding)),
      facts.map((f) => relevanceOf(f)),
      facts.map((f) => provenanceOf(f).origin),
      facts.map((f) => provenanceOf(f).evidence),
      facts.map((f) => f.checkVersion ?? null),
    ],
  );
}

function factOf(r: Record<string, any>): StoredFact {
  return {
    id: r.id,
    kind: r.kind,
    statement: r.statement,
    path: r.path,
    lines: r.lines ?? null,
    confidence: r.confidence,
    why: r.why ?? '',
    relevance: r.relevance ?? null,
    relevanceBy: r.relevance_by ?? null,
    docId: r.doc_id ?? null,
    origin: factOrigin({ origin: r.origin, docId: r.doc_id, why: r.why }),
    evidence: r.evidence ?? null,
    checkVersion: r.check_version ?? null,
    source: r.source,
    scanJobId: r.scan_job_id ?? null,
    fileHash: r.file_hash ?? null,
    fileSummary: r.file_summary ?? null,
    fileChangedAt: r.file_changed_at ? iso(new Date(r.file_changed_at)) : null,
    createdAt: iso(r.created_at)!,
  };
}

/**
 * A scan job's place in the queue (SQL over scan_jobs j). A job that gave up its slot waits from then (served_at), so
 * it goes behind every job queued before it gave way, whatever its project's files an agent asked for earlier: a file
 * request only moves up a job not served since. A job never served waits from when it was requested, or from its
 * project's oldest file request not read yet when that is older (least() skips the null of a project with none).
 */
const WAITING_SINCE = `coalesce(j.served_at, least(j.requested_at,
  (SELECT min(cf.scan_requested_at) FROM code_files cf WHERE cf.project_key = j.project_key AND cf.scan_requested_at IS NOT NULL)))`;

/** A scan_jobs row, from a query (Date values) or from to_jsonb (ISO text values). */
function jobOf(r: Record<string, any>): ScanJob {
  const t = (v: Date | string | null | undefined) => (v == null ? null : iso(new Date(v)));
  return {
    id: r.id,
    projectKey: r.project_key,
    repoPath: r.repo_path,
    provider: r.provider ?? null,
    status: r.status,
    requestedAt: t(r.requested_at)!,
    startedAt: t(r.started_at),
    finishedAt: t(r.finished_at),
    filesScanned: r.files_scanned ?? 0,
    factsAdded: r.facts_added ?? 0,
    error: r.error ?? null,
    attempts: r.attempts ?? 0,
    retryAt: t(r.retry_at),
    shards: r.shards ?? null,
    servedAt: t(r.served_at),
  };
}
