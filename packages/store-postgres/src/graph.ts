import {
  candidateProvenance,
  EXTERNAL_SOURCES,
  matchReport,
  redactDeep,
  MAX_CLASSIFY_ATTEMPTS,
  REPORT_MERGE_MINUTES,
  postmortemState,
  redactSecrets,
  redactStoredRow,
  REDACT_PAGE,
  sessionWork,
  trailingToolCalls,
  type Candidate,
  type CandidateDetail,
  type CandidateFilter,
  type CandidateStatus,
  type CallsAfter,
  type ClassifiableTurn,
  type ToolCall,
  type ExternalThread,
  type SessionSource,
  type WorkSession,
  type Classification,
  type Commit,
  type GraphStore,
  type HumanTurn,
  type ParsedSession,
  type PendingExternalItem,
  type PendingSessionItem,
  type Project,
  type StatsRow,
  type WorkerStatus,
} from '@fb/core';
import { iso, toJson, tx, type Db } from './db.ts';
import { refreshSessionStats } from './sessions.ts';
import { visibleToRun } from './vector.ts';

/** Labels that count as pushback in stats (repo.ts CANDIDATE_LABELS). */
const CANDIDATE_LABELS = ['pushback', 'correction'];

/**
 * Times without an offset are UTC, as Neo4j's datetime() reads them, whatever the server's TimeZone is. Every
 * transaction that turns caller-supplied text into timestamptz starts with this.
 */
export const UTC = `SET LOCAL TimeZone = 'UTC'`;

/** A caller's timestamp text, or null when Postgres could not read it (Neo4j stores any string; nothing reads these back). */
const maybeTime = (s: string | null | undefined): string | null => (s && !Number.isNaN(Date.parse(s)) ? s : null);

/**
 * The calendar day Neo4j's date(datetime(ts)) gives: the date in the offset the text was written in (UTC when it has
 * none, or says Z). Used for ISO weeks, which change at midnight local to the writer.
 */
export const LOCAL_TIME = (alias: string) =>
  `((${alias}.ts AT TIME ZONE 'UTC') + coalesce(substring(${alias}.ts_text from '([+-][0-9]{2}:[0-9]{2})$')::interval, interval '0'))`;

/** One entry per key, the last one given winning, as consecutive Neo4j MERGE ... SETs leave it (one INSERT cannot touch a row twice). */
function lastOf<T>(xs: T[], key: (x: T) => string): T[] {
  return [...new Map(xs.map((x) => [key(x), x])).values()];
}

/** Sessions, turns, the inbox of candidates, decisions, projects and aliases, the worker heartbeat. */
export class PgGraphStore implements GraphStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  private q(sql: string, params: unknown[] = []) {
    return this.db.pool.query(sql, params);
  }

  async upsertSession(project: Project, s: ParsedSession, commits: Commit[]): Promise<void> {
    const work = sessionWork(s.toolCalls ?? []);
    await tx(this.db, async (c) => {
      await c.query(UTC);
      await c.query(
        `INSERT INTO projects (key, name, repo_path, remote) VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, repo_path = EXCLUDED.repo_path,
                                         remote = coalesce(EXCLUDED.remote, projects.remote)`,
        [project.key, project.name ?? null, project.repoPath ?? null, project.remote ?? null],
      );
      await c.query(
        `INSERT INTO sessions (id, project_key, source, source_file, cwd, git_branch, started_at, ended_at, final_reply_text, final_reply_ts,
                               work_edits, work_commits, first_work_at, last_work_at, final_tool_calls, instruction_files)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11, $12, $13::timestamptz, $14::timestamptz, $15::jsonb, $16::jsonb)
         ON CONFLICT (id) DO UPDATE SET project_key = EXCLUDED.project_key, source = EXCLUDED.source,
           source_file = EXCLUDED.source_file, cwd = EXCLUDED.cwd, git_branch = EXCLUDED.git_branch,
           started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at,
           final_reply_text = EXCLUDED.final_reply_text, final_reply_ts = EXCLUDED.final_reply_ts,
           work_edits = EXCLUDED.work_edits, work_commits = EXCLUDED.work_commits,
           first_work_at = EXCLUDED.first_work_at, last_work_at = EXCLUDED.last_work_at, final_tool_calls = EXCLUDED.final_tool_calls,
           instruction_files = EXCLUDED.instruction_files`,
        [
          s.sessionId, project.key, s.source ?? 'claude', s.sourceFile ?? null, s.cwd ?? null, s.gitBranch ?? null, maybeTime(s.startedAt), maybeTime(s.endedAt),
          // Redacted by the parser, and again here: it is stored like a turn's text.
          s.finalReply ? redactSecrets(s.finalReply.text) : null,
          s.finalReply?.ts ?? null,
          work.edits, work.commits, work.firstAt, work.lastAt, toJson(trailingToolCalls(s)),
          s.instructionFiles ? toJson(s.instructionFiles) : null,
        ],
      );
      if (s.turns.length) {
        // Re-upserting overwrites what the transcript says, never the label, classification, attempts or pruning.
        await c.query(
          `INSERT INTO turns (uuid, session_id, project_key, ts, ts_text, idx, text, preceding_assistant_text, tool_calls)
           SELECT t.uuid, $2, $3, t.ts::timestamptz, t.ts, t.idx, t.text, t.pat, coalesce(t.tool_calls, '[]'::jsonb)
           FROM jsonb_to_recordset($1::jsonb) AS t(uuid text, ts text, idx integer, text text, pat text, tool_calls jsonb)
           ON CONFLICT (uuid) DO UPDATE SET session_id = EXCLUDED.session_id, project_key = EXCLUDED.project_key,
             ts = EXCLUDED.ts, ts_text = EXCLUDED.ts_text, idx = EXCLUDED.idx, text = EXCLUDED.text,
             preceding_assistant_text = EXCLUDED.preceding_assistant_text, tool_calls = EXCLUDED.tool_calls`,
          [
            toJson(
              lastOf(s.turns, (t) => t.uuid).map((t) => ({
                uuid: t.uuid,
                ts: t.ts,
                idx: t.index,
                text: t.text ?? null,
                pat: t.precedingAssistantText ?? null,
                tool_calls: t.precedingToolCalls ?? [],
              })),
            ),
            s.sessionId,
            project.key,
          ],
        );
      }
      if (commits.length) {
        const rows = toJson(lastOf(commits, (k) => k.sha).map((k) => ({ sha: k.sha, ts: k.ts, subject: k.subject ?? null })));
        await c.query(
          `INSERT INTO commits (sha, ts, ts_text, subject)
           SELECT k.sha, k.ts::timestamptz, k.ts, k.subject FROM jsonb_to_recordset($1::jsonb) AS k(sha text, ts text, subject text)
           ON CONFLICT (sha) DO UPDATE SET ts = EXCLUDED.ts, ts_text = EXCLUDED.ts_text, subject = EXCLUDED.subject`,
          [rows],
        );
        await c.query(
          `INSERT INTO session_commits (session_id, sha)
           SELECT $2::text, k.sha FROM jsonb_to_recordset($1::jsonb) AS k(sha text)
           ON CONFLICT DO NOTHING`,
          [rows, s.sessionId],
        );
      }
      await refreshSessionStats(c, s.sessionId, s.endedAt ?? null, s.turns.at(-1)?.ts ?? null);
    });
  }

  /**
   * The project a folder's sessions belong to. A folder that is not yet a project, whose remote an existing project
   * already has, is another clone of it: it becomes that project's alias. Projects that already exist are never
   * merged, so nothing recorded under a key moves.
   */
  async canonicalProject(folder: Project, o: { dryRun?: boolean } = {}): Promise<{ project: Project; aliasedNow: boolean }> {
    const alias = await this.projectByAlias(folder.key);
    if (alias) return { project: alias, aliasedNow: false };
    const own = await this.q('SELECT 1 FROM projects WHERE key = $1', [folder.key]);
    if (own.rowCount || !folder.remote) return { project: folder, aliasedNow: false };
    if (o.dryRun) {
      const { rows } = await this.q('SELECT * FROM projects WHERE remote = $2 AND key <> $1 ORDER BY key LIMIT 1', [folder.key, folder.remote]);
      return { project: rows[0] ? projectOf(rows[0]) : folder, aliasedNow: false };
    }
    // The alias check is repeated in the UPDATE, so two callers racing cannot both append it.
    const { rows } = await this.q(
      `UPDATE projects SET aliases = aliases || $1::text
       WHERE key = (SELECT key FROM projects WHERE remote = $2 AND key <> $1 AND NOT ($1 = ANY (aliases)) ORDER BY key LIMIT 1)
         AND NOT ($1 = ANY (aliases))
       RETURNING *`,
      [folder.key, folder.remote],
    );
    return rows[0] ? { project: projectOf(rows[0]), aliasedNow: true } : { project: folder, aliasedNow: false };
  }

  /** The project a folder key is an alias of, if any. */
  async projectByAlias(key: string): Promise<Project | null> {
    const { rows } = await this.q('SELECT * FROM projects WHERE $1 = ANY (aliases) ORDER BY key LIMIT 1', [key]);
    return rows[0] ? projectOf(rows[0]) : null;
  }

  /** Projects ingested before remotes were recorded (or whose folder had none yet). */
  async projectsMissingRemote(): Promise<Project[]> {
    const { rows } = await this.q('SELECT * FROM projects WHERE remote IS NULL AND repo_path IS NOT NULL ORDER BY key');
    return rows.map(projectOf);
  }

  async setProjectRemote(key: string, remote: string): Promise<void> {
    await this.q('UPDATE projects SET remote = $2 WHERE key = $1', [key, remote]);
  }

  /** Records with no remote or no folder path (scans, code maps and uploads make them with neither). */
  async projectsMissingFolder(): Promise<Project[]> {
    const { rows } = await this.q(`SELECT * FROM projects WHERE remote IS NULL OR coalesce(repo_path, '') = '' ORDER BY key`);
    return rows.map(projectOf);
  }

  /** Fill a record's folder path and remote where missing; one already set is never overwritten. */
  async fillProjectFolder(key: string, folder: { repoPath: string; remote: string | null }): Promise<void> {
    await this.q(
      `UPDATE projects SET repo_path = CASE WHEN coalesce(repo_path, '') = '' THEN $2 ELSE repo_path END, remote = coalesce(remote, $3)
       WHERE key = $1`,
      [key, folder.repoPath, folder.remote],
    );
  }

  /**
   * Turns still to classify, newest first so fresh feedback is not stuck behind the history backfill.
   * projectKeys undefined: every project; an empty list: none (nothing is selected).
   */
  async sessionInstructionFiles(sessionId: string): Promise<string[] | null> {
    const { rows } = await this.q('SELECT instruction_files FROM sessions WHERE id = $1', [sessionId]);
    const f = rows[0]?.instruction_files;
    return Array.isArray(f) ? f.filter((x): x is string => typeof x === 'string') : null;
  }

  async callsAfter(turnUuid: string): Promise<CallsAfter | null> {
    const { rows } = await this.q(
      `SELECT s.final_tool_calls, s.ended_at,
              (SELECT coalesce(jsonb_agg(n.tool_calls ORDER BY n.idx, n.uuid), '[]'::jsonb) FROM turns n WHERE n.session_id = t.session_id AND n.idx > t.idx) AS later
       FROM turns t JOIN sessions s ON s.id = t.session_id WHERE t.uuid = $1`,
      [turnUuid],
    );
    const r = rows[0];
    if (!r) return null;
    const later = (r.later ?? []) as ToolCall[][];
    return { calls: [...later.flat(), ...((r.final_tool_calls ?? []) as ToolCall[])], laterTurns: later.length, endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null };
  }

  async unclassifiedTurns(limit: number, projectKeys?: string[], excludeKeys?: string[]): Promise<ClassifiableTurn[]> {
    const { rows } = await this.q(
      `SELECT t.*, p.key AS project_key
       FROM turns t JOIN sessions s ON s.id = t.session_id JOIN projects p ON p.key = s.project_key
       WHERE t.label IS NULL AND t.idx > 0 AND ($2::text[] IS NULL OR p.key = ANY ($2)) AND NOT (p.key = ANY ($3::text[]))
         AND t.classify_attempts < $4
       ORDER BY t.ts DESC, t.uuid LIMIT $1`,
      [limit, projectKeys ?? null, excludeKeys ?? [], MAX_CLASSIFY_ATTEMPTS],
    );
    return rows.map((r) => ({ ...turnOf(r), projectKey: r.project_key }));
  }

  /** A classification that failed (timeout, unparseable answer). After MAX_CLASSIFY_ATTEMPTS the turn is skipped for good. */
  async recordClassifyFailure(turnUuid: string): Promise<void> {
    await this.q('UPDATE turns SET classify_attempts = classify_attempts + 1 WHERE uuid = $1', [turnUuid]);
  }

  async givenUpTurns(): Promise<number> {
    const { rows } = await this.q('SELECT count(*)::int AS n FROM turns WHERE label IS NULL AND classify_attempts >= $1', [MAX_CLASSIFY_ATTEMPTS]);
    return rows[0].n;
  }

  async requeueGivenUpTurns(): Promise<number> {
    const { rowCount } = await this.q('UPDATE turns SET classify_attempts = 0 WHERE label IS NULL AND classify_attempts >= $1', [MAX_CLASSIFY_ATTEMPTS]);
    return rowCount ?? 0;
  }

  async saveClassification(turnUuid: string, c: Classification, makeCandidate: boolean): Promise<string | null> {
    return tx(this.db, async (x) => {
      await x.query('UPDATE turns SET label = $2, confidence = $3, summary = $4, signals = $5 WHERE uuid = $1', [
        turnUuid,
        c.label,
        c.confidence,
        c.summary,
        c.signals,
      ]);
      if (!makeCandidate) return null;
      const merged = await mergeIntoReport(x, turnUuid);
      if (merged) return merged;
      // A decided candidate keeps its status, note and decision time when the turn is flagged again.
      await x.query(
        `INSERT INTO candidates (id, turn_uuid, session_id, project_key, ts, source, status, created_at)
         SELECT t.uuid, t.uuid, s.id, p.key, t.ts, coalesce(s.source, 'claude'), 'pending', $2
         FROM turns t JOIN sessions s ON s.id = t.session_id JOIN projects p ON p.key = s.project_key
         WHERE t.uuid = $1
         ON CONFLICT (id) DO UPDATE SET turn_uuid = EXCLUDED.turn_uuid, session_id = EXCLUDED.session_id,
           project_key = EXCLUDED.project_key, ts = EXCLUDED.ts, source = EXCLUDED.source`,
        [turnUuid, new Date()],
      );
      return turnUuid;
    });
  }

  async listCandidates(f: CandidateFilter = {}): Promise<Candidate[]> {
    const { rows } = await this.q(
      `SELECT ${CANDIDATE_COLUMNS}
       FROM candidates k JOIN turns t ON t.uuid = k.turn_uuid
       WHERE ($1::text IS NULL OR k.status = $1) AND ($2::text IS NULL OR k.project_key = $2)
         AND ($4::text[] IS NULL OR k.project_key = ANY($4)) AND ($5::text IS NULL OR coalesce(k.source, 'claude') = $5)
         AND ${visibleToRun('k', '$7')}
         AND ($8::text IS NULL OR t.external->>'thread' ~ ('#' || $8 || '$'))
         AND ($9::text IS NULL OR lower(t.external->>'author') = lower($9))
       ORDER BY t.ts DESC, k.id LIMIT $3 OFFSET $6`,
      [f.status ?? null, f.projectKey ?? null, f.limit ?? 200, f.projectKeys ?? null, f.source ?? null, Math.max(0, Math.floor(f.offset ?? 0)), f.run ?? null, f.pr ? String(f.pr) : null, f.author ?? null],
    );
    return rows.map(candidateOf);
  }

  async candidateDetail(id: string): Promise<CandidateDetail | null> {
    const { rows } = await this.q(
      `SELECT ${CANDIDATE_COLUMNS}, row_to_json(t) AS turn, t.session_id AS turn_session, t.idx AS turn_idx,
              f.id AS f_id, f.attempts AS f_attempts, f.last_error AS f_last_error, f.retry_at AS f_retry_at,
              EXISTS (SELECT 1 FROM misses m WHERE m.feedback_id = f.id) AS done
       FROM candidates k JOIN turns t ON t.uuid = k.turn_uuid JOIN sessions s ON s.id = t.session_id
       LEFT JOIN feedback f ON f.id = k.id
       WHERE k.id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    const [near, commits] = await Promise.all([
      this.q(
        `SELECT * FROM turns WHERE session_id = $1 AND idx >= $2::int - 2 AND idx <= $2::int + 2 AND uuid <> $3 ORDER BY idx, uuid`,
        [r.turn_session, r.turn_idx, r.turn_uuid],
      ),
      this.q(
        `SELECT c.sha, c.ts_text, c.subject FROM session_commits sc JOIN commits c ON c.sha = sc.sha
         WHERE sc.session_id = $1 ORDER BY c.ts, c.sha`,
        [r.turn_session],
      ),
    ]);
    const t = turnOf(r.turn);
    const around = near.rows.map(turnOf);
    const f = r.f_id ? { attempts: r.f_attempts, lastError: r.f_last_error ?? undefined, retryAt: iso(r.f_retry_at) ?? undefined } : undefined;
    return {
      candidate: candidateOf(r),
      turn: t,
      before: around.filter((n) => n.index < t.index),
      after: around.filter((n) => n.index > t.index),
      commits: commits.rows.map(commitOf),
      postmortem: postmortemState(f, r.done),
    };
  }

  async pendingExternalItems(q: { limit: number; afterId?: string | null }): Promise<PendingExternalItem[]> {
    const { rows } = await this.q(
      `SELECT k.id, k.turn_uuid, k.project_key, t.text, t.external
       FROM candidates k JOIN turns t ON t.uuid = k.turn_uuid
       WHERE k.status = 'pending' AND t.external IS NOT NULL AND t.text IS NOT NULL AND ($2::text IS NULL OR k.id > $2)
       ORDER BY k.id LIMIT $1`,
      [q.limit, q.afterId ?? null],
    );
    return rows.map((r) => ({ id: r.id, turnUuid: r.turn_uuid, projectKey: r.project_key, text: r.text, external: r.external }));
  }

  async setExternalLinks(turnUuid: string, linkedSessionIds: string[]): Promise<boolean> {
    const { rowCount } = await this.q(
      `UPDATE turns SET external = jsonb_set(external, '{linkedSessionIds}', $2::jsonb) WHERE uuid = $1 AND external IS NOT NULL`,
      [turnUuid, toJson(linkedSessionIds)],
    );
    return (rowCount ?? 0) > 0;
  }

  async redactStoredCandidates(): Promise<number> {
    let changed = 0;
    for (let after = ''; ;) {
      const { rows } = await this.q(
        `SELECT k.id, k.turn_uuid, k.note, k.agent_report, t.text, t.preceding_assistant_text, t.summary
           FROM candidates k LEFT JOIN turns t ON t.uuid = k.turn_uuid
          WHERE k.id > $1 ORDER BY k.id LIMIT $2`,
        [after, REDACT_PAGE],
      );
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      const page = rows.flatMap((r: Record<string, unknown>) => redactStoredRow(r, ['note', 'text', 'preceding_assistant_text', 'summary'], ['agent_report']) ?? []);
      if (!page.length) continue;
      await tx(this.db, async (c) => {
        const json = toJson(page);
        await c.query(
          `UPDATE candidates x SET note = c.note, agent_report = c.agent_report
           FROM jsonb_to_recordset($1::jsonb) AS c(id text, note text, agent_report jsonb) WHERE x.id = c.id`,
          [json],
        );
        await c.query(
          `UPDATE turns x SET text = c.text, preceding_assistant_text = c.preceding_assistant_text, summary = c.summary
           FROM jsonb_to_recordset($1::jsonb) AS c(turn_uuid text, text text, preceding_assistant_text text, summary text) WHERE x.uuid = c.turn_uuid`,
          [json],
        );
      });
      changed += page.length;
    }
    return changed;
  }

  async pendingSessionItems(q: { limit: number; afterId?: string | null }): Promise<PendingSessionItem[]> {
    const { rows } = await this.q(
      `SELECT k.id, k.turn_uuid, k.project_key, t.text, t.tool_calls
       FROM candidates k JOIN turns t ON t.uuid = k.turn_uuid
       WHERE k.status = 'pending' AND t.external IS NULL AND t.text IS NOT NULL AND NOT k.manual AND k.agent_report IS NULL
         AND ($2::text IS NULL OR k.id COLLATE "C" > $2)
       ORDER BY k.id COLLATE "C" LIMIT $1`,
      [q.limit, q.afterId ?? null],
    );
    return rows.map((r) => ({ id: r.id, turnUuid: r.turn_uuid, projectKey: r.project_key, text: r.text, precedingToolCalls: r.tool_calls ?? [] }));
  }

  async skipPendingItem(id: string, s: { rule: string; note: string; by: string }): Promise<boolean> {
    return tx(this.db, async (c) => {
      const { rows } = await c.query(
        `UPDATE candidates SET status = 'rejected', note = $2, decided_at = $3, decided_by = $4 WHERE id = $1 AND status = 'pending' RETURNING turn_uuid`,
        [id, s.note, new Date(), s.by],
      );
      if (!rows[0]) return false;
      const signal = `skip:${s.rule}`;
      await c.query(
        `UPDATE turns SET signals = CASE WHEN $2 = ANY(coalesce(signals, '{}')) THEN signals ELSE array_append(coalesce(signals, '{}'), $2) END WHERE uuid = $1`,
        [rows[0].turn_uuid, signal],
      );
      return true;
    });
  }

  async ruleSkippedItems(q: { rule: string; by: string; limit: number; afterId?: string | null }): Promise<PendingSessionItem[]> {
    const { rows } = await this.q(
      `SELECT k.id, k.turn_uuid, k.project_key, t.text, t.tool_calls
       FROM candidates k JOIN turns t ON t.uuid = k.turn_uuid
       WHERE k.status = 'rejected' AND k.decided_by = $3 AND $4 = ANY(coalesce(t.signals, '{}'))
         AND t.external IS NULL AND t.text IS NOT NULL AND NOT k.manual AND k.agent_report IS NULL
         AND ($2::text IS NULL OR k.id COLLATE "C" > $2)
       ORDER BY k.id COLLATE "C" LIMIT $1`,
      [q.limit, q.afterId ?? null, q.by, `skip:${q.rule}`],
    );
    return rows.map((r) => ({ id: r.id, turnUuid: r.turn_uuid, projectKey: r.project_key, text: r.text, precedingToolCalls: r.tool_calls ?? [] }));
  }

  async reopenRuleSkippedItem(id: string, s: { rule: string; by: string }): Promise<boolean> {
    return tx(this.db, async (c) => {
      const { rows } = await c.query(
        `UPDATE candidates SET status = 'pending', note = NULL, decided_at = NULL, decided_by = NULL
         WHERE id = $1 AND status = 'rejected' AND decided_by = $2 RETURNING turn_uuid`,
        [id, s.by],
      );
      if (!rows[0]) return false;
      await c.query(`UPDATE turns SET signals = array_remove(signals, $2) WHERE uuid = $1`, [rows[0].turn_uuid, `skip:${s.rule}`]);
      return true;
    });
  }

  async decide(id: string, status: 'confirmed' | 'rejected', note: string | null, by = 'you'): Promise<void> {
    const now = new Date();
    await tx(this.db, async (c) => {
      const { rowCount } = await c.query('UPDATE candidates SET status = $2, note = $3, decided_at = $4, decided_by = $5 WHERE id = $1', [id, status, note, now, by]);
      if (rowCount && status === 'confirmed') {
        // One Feedback per candidate: confirming again reopens one you rejected, and leaves any other status alone.
        await c.query(
          `INSERT INTO feedback (id, project_key, turn_uuid, status, text, created_at)
           SELECT k.id, k.project_key, t.uuid, 'open', t.text, $2 FROM candidates k JOIN turns t ON t.uuid = k.turn_uuid WHERE k.id = $1
           ON CONFLICT (id) DO UPDATE SET status = CASE feedback.status WHEN 'rejected' THEN 'open' ELSE feedback.status END`,
          [id, now],
        );
      }
      if (status === 'rejected') {
        // Changing your mind after confirming: stop the post-mortem and withdraw lessons you have not approved yet.
        await c.query(`UPDATE feedback SET status = 'rejected' WHERE id = $1`, [id]);
        await c.query(
          `UPDATE lessons SET status = 'rejected'
           WHERE status = 'proposed' AND miss_id IN (SELECT m.id FROM misses m WHERE m.feedback_id = $1)`,
          [id],
        );
      }
    });
  }

  /**
   * TURN_RETENTION_DAYS: drop the words of classified turns older than the cutoff that nothing points at.
   * Flagged turns and the turns around them stay (they are the evidence for candidates, feedback and post-mortems).
   */
  async pruneTurnText(before: Date, limit = 5000, o: { keepUnsummarized?: boolean } = {}): Promise<number> {
    const { rowCount } = await this.q(
      `UPDATE turns SET text = NULL, preceding_assistant_text = NULL, tool_calls = '[]', pruned_at = $3
       WHERE uuid IN (
         SELECT t.uuid FROM turns t JOIN sessions s ON s.id = t.session_id
         WHERE t.ts < $1 AND (t.label IS NOT NULL OR t.idx = 0) AND t.text IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM turns o JOIN candidates k ON k.turn_uuid = o.uuid WHERE o.session_id = t.session_id)
           AND (NOT $4 OR (t.idx <= s.summarized_through_idx AND NOT s.summary_rebuild))
         LIMIT $2)`,
      [before, limit, new Date(), !!o.keepUnsummarized],
    );
    // The agent's final reply goes with the session's turns: once the whole session is older than the cutoff, nothing
    // flagged it, and (keepUnsummarized) a summary covers its last turn.
    await this.q(
      `UPDATE sessions SET final_reply_text = NULL, final_reply_ts = NULL
       WHERE id IN (
         SELECT s.id FROM sessions s
         WHERE s.final_reply_text IS NOT NULL AND s.last_activity_at < $1
           AND NOT EXISTS (SELECT 1 FROM turns o JOIN candidates k ON k.turn_uuid = o.uuid WHERE o.session_id = s.id)
           AND (NOT $3 OR (s.last_turn_idx <= s.summarized_through_idx AND NOT s.summary_rebuild))
         LIMIT $2)`,
      [before, limit, !!o.keepUnsummarized],
    );
    return rowCount ?? 0;
  }

  async upsertExternalThread(project: Project, t: ExternalThread): Promise<number> {
    if (!t.items.length) return 0;
    const items = redactDeep(lastOf(t.items, (i) => i.uuid));
    const times = items.map((i) => i.ts).sort();
    return tx(this.db, async (c) => {
      await c.query(UTC);
      await c.query('INSERT INTO projects (key, name, repo_path) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING', [
        project.key, project.name ?? null, project.repoPath ?? null,
      ]);
      await c.query(
        `INSERT INTO sessions (id, project_key, source, source_file, started_at, ended_at, manual)
         VALUES ($1, $2, $3, $3, $4::timestamptz, $5::timestamptz, true)
         ON CONFLICT (id) DO UPDATE SET ended_at = greatest(sessions.ended_at, EXCLUDED.ended_at)`,
        [t.id, project.key, t.source, times[0], times.at(-1)],
      );
      // A comment already stored keeps its label and classification; (xmax = 0) tells a new row from an updated one.
      const { rows } = await c.query(
        `INSERT INTO turns (uuid, session_id, project_key, ts, ts_text, idx, text, preceding_assistant_text, tool_calls, external)
         SELECT i.uuid, $2, $3, i.ts::timestamptz, i.ts, i.idx, i.text, i.context, '[]'::jsonb, i.external
         FROM jsonb_to_recordset($1::jsonb) AS i(uuid text, ts text, idx integer, text text, context text, external jsonb)
         ON CONFLICT (uuid) DO UPDATE SET ts = EXCLUDED.ts, ts_text = EXCLUDED.ts_text, idx = EXCLUDED.idx, text = EXCLUDED.text,
           preceding_assistant_text = EXCLUDED.preceding_assistant_text, external = EXCLUDED.external
         RETURNING (xmax = 0) AS inserted`,
        [toJson(items.map((i) => ({ uuid: i.uuid, ts: i.ts, idx: i.index, text: i.text, context: i.context, external: i.external }))), t.id, project.key],
      );
      return rows.filter((r) => r.inserted).length;
    });
  }

  async workSessions(q: { projectKey: string; branch: string | null; before: string; after?: string | null; limit: number }): Promise<WorkSession[]> {
    const { rows } = await this.q(
      `SELECT s.id, s.source, s.git_branch, s.cwd, s.started_at, coalesce(s.last_activity_at, s.ended_at) AS last_at,
              s.work_edits, s.work_commits
       FROM sessions s
       WHERE s.project_key = $1 AND NOT s.manual AND s.started_at IS NOT NULL AND s.started_at <= $3::timestamptz
         AND s.work_edits + s.work_commits > 0 AND s.first_work_at <= $3::timestamptz
         AND CASE WHEN $2::text IS NULL
               THEN $4::timestamptz IS NOT NULL AND s.last_work_at >= $4::timestamptz
               ELSE s.git_branch = $2 END
       ORDER BY s.work_edits DESC, s.last_work_at DESC, s.id LIMIT $5`,
      [q.projectKey, q.branch, q.before, q.after ?? null, q.limit],
    );
    return rows.map((r) => ({
      id: r.id,
      source: (r.source as SessionSource) ?? 'claude',
      gitBranch: r.git_branch ?? null,
      cwd: r.cwd ?? null,
      startedAt: iso(r.started_at),
      lastActivityAt: iso(r.last_at),
      edits: Number(r.work_edits),
      commits: Number(r.work_commits),
    }));
  }

  async heartbeat(s: WorkerStatus): Promise<void> {
    await this.q(
      `INSERT INTO worker_status (id, status, updated_at) VALUES ('worker', $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
      [toJson(s)],
    );
  }

  async workerStatus(): Promise<WorkerStatus | null> {
    const { rows } = await this.q(`SELECT status FROM worker_status WHERE id = 'worker'`);
    return rows[0] ? (rows[0].status as WorkerStatus) : null;
  }

  async stats(): Promise<StatsRow[]> {
    const { rows } = await this.q(
      `SELECT p.key AS project_key, to_char(${LOCAL_TIME('t')}, 'IYYY-"W"IW') AS week,
              count(*) AS human_turns, count(*) FILTER (WHERE t.label = ANY ($1::text[])) AS pushback
       FROM turns t JOIN sessions s ON s.id = t.session_id JOIN projects p ON p.key = s.project_key
       WHERE t.idx > 0 AND NOT (coalesce(s.source, 'claude') = ANY ($2::text[]))
         -- A sandbox run's report is no one else's pushback.
         AND NOT EXISTS (SELECT 1 FROM candidates k WHERE k.turn_uuid = t.uuid AND k.sandbox)
       GROUP BY 1, 2 ORDER BY week, project_key`,
      [CANDIDATE_LABELS, EXTERNAL_SOURCES],
    );
    return rows.map((r) => ({ projectKey: r.project_key, week: r.week, humanTurns: r.human_turns, pushback: r.pushback }));
  }
}

/**
 * An agent already reported this miss (report_feedback, core dedupe.ts): a pending report moves onto this turn (the
 * post-mortem then sees the real session) and its manual stand-in session goes; a decided one only records the detector.
 * Returns the report's Inbox id if merged, else null.
 */
async function mergeIntoReport(x: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }> }, turnUuid: string): Promise<string | null> {
  const { rows: [turn] } = await x.query(
    `SELECT t.ts, t.ts_text, t.text, s.id AS session_id, s.project_key, coalesce(s.source, 'claude') AS source
     FROM turns t JOIN sessions s ON s.id = t.session_id
     WHERE t.uuid = $1 AND NOT EXISTS (SELECT 1 FROM candidates WHERE id = $1) AND t.external IS NULL`,
    [turnUuid],
  );
  if (!turn) return null;
  const { rows } = await x.query(
    `SELECT k.id, k.status, k.created_at, k.agent_report, mt.text, mt.preceding_assistant_text
     FROM candidates k JOIN turns mt ON mt.uuid = k.turn_uuid
     WHERE k.project_key = $1 AND k.manual AND NOT k.detected AND k.status <> 'rejected'
       AND k.created_at BETWEEN $2::timestamptz - make_interval(mins => $3) AND $2::timestamptz + make_interval(mins => $3)`,
    [turn.project_key, turn.ts, REPORT_MERGE_MINUTES],
  );
  const reports = rows.map((r) => {
    const { agentReport } = candidateProvenance({
      manual: true, detected: false, agentReport: r.agent_report ?? null,
      turnText: r.text, turnWhatWasDone: r.preceding_assistant_text, createdAt: iso(r.created_at) as string,
    });
    return { id: r.id as string, status: r.status as CandidateStatus, report: agentReport!, ts: iso(r.created_at) as string, text: agentReport!.text, sessionId: agentReport!.sessionId };
  });
  const hit = matchReport({ ts: (turn.ts as Date).toISOString(), text: turn.text ?? '', sessionId: turn.session_id }, reports);
  if (!hit) return null;
  if (hit.status !== 'pending') {
    await x.query('UPDATE candidates SET detected = true, detected_turn_uuid = $2 WHERE id = $1', [hit.id, turnUuid]);
    return hit.id;
  }
  const { rows: [old] } = await x.query(
    `UPDATE candidates k SET turn_uuid = $2, session_id = $3, ts = $4, source = $5, detected = true, agent_report = $6::jsonb
     FROM candidates prev WHERE k.id = $1 AND prev.id = k.id
     RETURNING prev.session_id AS old_session`,
    [hit.id, turnUuid, turn.session_id, turn.ts, turn.source, toJson(hit.report)],
  );
  if (old?.old_session) await x.query('DELETE FROM sessions WHERE id = $1 AND manual', [old.old_session]);
  return hit.id;
}

/** What candidateOf reads: the candidate's columns and the flagged turn's classification and words. */
const CANDIDATE_COLUMNS = `k.id, k.turn_uuid, k.session_id, k.project_key, k.source, k.status, k.created_at, k.decided_at, k.note, k.decided_by, k.run, k.sandbox,
  k.manual, k.detected, k.agent_report, t.text AS turn_text, t.preceding_assistant_text AS turn_done,
  t.label, t.confidence, t.summary, t.signals, t.external`;

type Row = Record<string, any>;

/** A turns row as the HumanTurn Neo4j returns; a pruned turn's text is absent, as a removed Neo4j property is. */
export function turnOf(r: Row): HumanTurn {
  return {
    uuid: r.uuid,
    sessionId: r.session_id,
    ts: r.ts_text,
    index: r.idx,
    text: r.text ?? undefined,
    precedingAssistantText: r.preceding_assistant_text ?? '',
    precedingToolCalls: r.tool_calls ?? [],
    ...(r.external ? { external: r.external } : {}),
  };
}

function candidateOf(r: Row): Candidate {
  return {
    id: r.id,
    turnUuid: r.turn_uuid,
    sessionId: r.session_id,
    projectKey: r.project_key,
    source: r.source ?? 'claude',
    ...(r.external ? { external: r.external } : {}),
    classification: {
      label: r.label ?? undefined,
      confidence: r.confidence ?? undefined,
      summary: r.summary ?? undefined,
      signals: r.signals ?? [],
    },
    status: r.status as CandidateStatus,
    createdAt: iso(r.created_at) as string,
    decidedAt: iso(r.decided_at),
    note: r.note ?? null,
    decidedBy: r.decided_by ?? null,
    ...candidateProvenance({
      manual: !!r.manual,
      detected: !!r.detected,
      agentReport: r.agent_report ?? null,
      turnText: r.turn_text,
      turnWhatWasDone: r.turn_done,
      createdAt: iso(r.created_at) as string,
    }),
    ...(r.run ? { run: r.run as string } : {}),
    ...(r.sandbox === true && { sandbox: true as const }),
  };
}

export function commitOf(r: Row): Commit {
  return { sha: r.sha, ts: r.ts_text, subject: r.subject ?? undefined };
}

export function projectOf(r: Row): Project {
  const key = r.key as string;
  return { key, name: r.name ?? key, repoPath: r.repo_path ?? '', remote: r.remote ?? null };
}
