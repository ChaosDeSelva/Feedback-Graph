import {
  latestTime,
  readSummary,
  redactDeep,
  redactSecrets,
  redactStoredRow,
  REDACT_PAGE,
  summaryRetryAt,
  summarySnippet,
  type RunTag,
  type CandidateStatus,
  type HumanTurn,
  type LessonStatus,
  type SessionCursor,
  type SessionDetail,
  type SessionListItem,
  type SessionsStore,
  type SessionState,
  type SummaryCursor,
  type SummaryWork,
  type SummaryWorkQuery,
  type SummaryWrite,
  type TurnEvidence,
  type TurnLabel,
} from '@fb/core';
import { iso, toJson, tx, type Db } from './db.ts';
import { sandboxPresence } from './vector.ts';
import { turnOf } from './graph.ts';

const ERROR_CHARS = 500;
/** Updates kept per session, the newest (Neo4j keeps the same number). */
const HISTORY_KEEP = 200;

type Row = Record<string, any>;
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }> };

/**
 * After a session's turns were written (upsertSession, inside its transaction): its turn count, last turn and last
 * activity, which only moves forward. `activity` is the session's own last event time.
 */
export async function refreshSessionStats(c: Queryable, sessionId: string, endedAt: string | null, lastTurnTs: string | null): Promise<void> {
  await c.query(
    `UPDATE sessions s SET turn_count = x.n, last_turn_idx = x.idx, last_turn_ts = x.ts, last_turn_ts_text = x.ts_text,
       last_activity_at = GREATEST(s.last_activity_at, $2::timestamptz)
     FROM (SELECT count(*) AS n, (array_agg(idx ORDER BY idx DESC))[1] AS idx, (array_agg(ts ORDER BY idx DESC))[1] AS ts,
                  (array_agg(ts_text ORDER BY idx DESC))[1] AS ts_text
           FROM turns WHERE session_id = $1) x
     WHERE s.id = $1`,
    [sessionId, latestTime(endedAt, lastTurnTs)],
  );
}

const cursorOf = (idx: number | null, ts: string | null): SummaryCursor | null => (idx === null || idx === undefined ? null : { index: idx, ts: ts ?? '' });

function listItem(r: Row): SessionListItem {
  const summary = readSummary(r.summary);
  const through = cursorOf(r.summarized_through_idx, r.summarized_through_ts);
  return {
    id: r.id,
    ...(r.run ? { run: r.run } : {}),
    ...(r.sandbox ? { sandbox: true as const } : {}),
    projectKey: r.project_key,
    source: r.source ?? 'claude',
    cwd: r.cwd ?? null,
    gitBranch: r.git_branch ?? null,
    startedAt: iso(r.started_at),
    lastActivityAt: iso(r.last_activity_at),
    turnCount: r.turn_count ?? 0,
    state: (r.state as SessionState) ?? 'active',
    snippet: summarySnippet(summary),
    summarizedThrough: through,
    summaryUpdatedAt: iso(r.summary_updated_at),
    summaryVersion: r.summary_version ?? 0,
    pendingTurns: Math.max(0, (r.last_turn_idx ?? -1) - (through?.index ?? -1)),
  };
}

/** The list's order: newest activity first (none counts as oldest), then id. */
const ACT = `coalesce(s.last_activity_at, 'epoch'::timestamptz)`;

export class PgSessionsStore implements SessionsStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  private q(sql: string, params: unknown[] = []) {
    return this.db.pool.query(sql, params);
  }

  async claimRun(sessionId: string, run: RunTag): Promise<boolean> {
    const claimed = await tx(this.db, async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('session-run:' || $1, 0))", [sessionId]);
      const { rows: bound } = await c.query('SELECT run, sandbox FROM session_run_tags WHERE session_id = $1', [sessionId]);
      if (bound[0]) return bound[0].run === run.id && bound[0].sandbox === run.sandbox;
      const { rows: existing } = await c.query('SELECT id FROM sessions WHERE id = $1', [sessionId]);
      if (existing.length) return false;
      await c.query('INSERT INTO session_run_tags (session_id, run, sandbox) VALUES ($1, $2, $3)', [sessionId, run.id, run.sandbox]);
      return true;
    });
    if (claimed) sandboxPresence(this.db).wrote(run);
    return claimed;
  }

  async runFor(sessionId: string): Promise<RunTag | null> {
    const { rows } = await this.q('SELECT run, sandbox FROM session_run_tags WHERE session_id = $1', [sessionId]);
    return rows[0] ? { id: rows[0].run, sandbox: rows[0].sandbox } : null;
  }

  async list(q: { projectKeys: string[]; state?: SessionState; limit: number; after?: SessionCursor | null; summarizedOnly?: boolean; run?: string | null }) {
    const afterAt = q.after ? (q.after.at ? q.after.at : 'epoch') : null;
    const { rows } = await this.q(
      `SELECT s.* FROM sessions s
       WHERE s.project_key = ANY ($1::text[]) AND (NOT coalesce(s.sandbox, false) OR s.run = $7) AND NOT s.manual AND s.last_turn_idx IS NOT NULL
         AND ($2::text IS NULL OR coalesce(s.state, 'active') = $2)
         AND (NOT $3 OR s.summary IS NOT NULL)
         AND ($4::timestamptz IS NULL OR ${ACT} < $4 OR (${ACT} = $4 AND s.id > $5))
       ORDER BY ${ACT} DESC, s.id LIMIT $6`,
      [q.projectKeys, q.state ?? null, !!q.summarizedOnly, afterAt, q.after?.id ?? '', q.limit + 1, q.run ?? null],
    );
    const items = rows.map(listItem);
    const page = items.slice(0, q.limit);
    const last = page.at(-1);
    return { sessions: page, next: items.length > q.limit && last ? { at: last.lastActivityAt ?? '', id: last.id } : null };
  }

  async detail(id: string): Promise<SessionDetail | null> {
    const { rows } = await this.q('SELECT s.* FROM sessions s WHERE s.id = $1 AND NOT s.manual', [id]);
    const s = rows[0];
    if (!s) return null;
    const [history, pruned, inbox] = await Promise.all([
      this.q('SELECT * FROM session_summary_updates WHERE session_id = $1 ORDER BY version', [id]),
      this.q('SELECT count(*) AS n FROM turns WHERE session_id = $1 AND pruned_at IS NOT NULL', [id]),
      this.q(
        `SELECT k.id, k.status, t.label, t.summary, l.id AS lesson_id, l.status AS lesson_status
         FROM candidates k JOIN turns t ON t.uuid = k.turn_uuid
         LEFT JOIN misses m ON m.feedback_id = k.id
         LEFT JOIN lessons l ON l.miss_id = m.id
         WHERE k.session_id = $1 ORDER BY t.ts, k.id`,
        [id],
      ),
    ]);
    return {
      ...listItem(s),
      summary: readSummary(s.summary),
      summaryModel: s.summary_model ?? null,
      history: history.rows.map((h) => ({
        version: h.version,
        from: cursorOf(h.from_idx, h.from_ts),
        to: { index: h.to_idx, ts: h.to_ts },
        deltaTurns: h.delta_turns,
        model: h.model,
        at: iso(h.at) as string,
        rebuild: h.rebuild,
      })),
      rebuildRequested: s.summary_rebuild,
      prunedTurns: pruned.rows[0].n,
      summaryError: s.summary_error ?? null,
      summaryRetryAt: iso(s.summary_retry_at),
      inbox: inbox.rows.map((k) => ({
        id: k.id,
        status: k.status as CandidateStatus,
        label: k.label ?? null,
        summary: k.summary ?? null,
        lessonId: k.lesson_id ?? null,
        lessonStatus: (k.lesson_status as LessonStatus) ?? null,
      })),
    };
  }

  async work(q: SummaryWorkQuery): Promise<SummaryWork[]> {
    const { rows } = await this.q(
      `SELECT * FROM (
         SELECT s.*, s.last_turn_idx - coalesce(s.summarized_through_idx, -1) AS pending, ${ACT} AS act,
                (s.summary_retry_at IS NULL OR s.summary_retry_at <= $3) AS due,
                (s.summarized_through_idx IS NULL AND NOT s.summary_rebuild AND ${ACT} < $5) AS history,
                (s.final_reply_text IS NOT NULL AND NOT s.summary_rebuild AND s.summarized_through_idx IS NOT NULL
                 AND s.last_turn_idx <= s.summarized_through_idx
                 AND (s.final_reply_summarized_ts IS NULL OR s.final_reply_summarized_ts <> coalesce(s.final_reply_ts, ''))) AS reply
         FROM sessions s
         WHERE s.project_key = ANY ($1::text[]) AND NOT (s.project_key = ANY ($2::text[])) AND NOT s.manual AND s.last_turn_idx IS NOT NULL
       ) s
       WHERE CASE WHEN $7 THEN s.history AND s.due
             ELSE NOT s.history AND (
               ((s.summary_rebuild OR s.pending > 0) AND s.due AND (s.summary_rebuild OR s.act < $4 OR s.pending >= $6 OR s.state = 'idle'))
               OR (s.pending > 0 AND s.state = 'idle')
               OR (s.reply AND s.due AND (s.act < $4 OR s.state = 'idle'))
               OR (s.pending <= 0 AND coalesce(s.state, 'active') = 'active' AND s.act < $5))
             END
       ORDER BY s.act DESC, s.id LIMIT $8`,
      [q.projectKeys, q.excludeKeys ?? [], q.now ?? new Date(), q.quietBefore, q.idleBefore, q.maxDeltaTurns, q.backfill, q.limit],
    );
    return rows.map((r) => ({
      id: r.id,
        ...(r.run ? { run: r.run as string } : {}),
        ...(r.sandbox === true ? { sandbox: true as const } : {}),
      projectKey: r.project_key,
      source: r.source ?? 'claude',
      cwd: r.cwd ?? null,
      lastTurn: { index: r.last_turn_idx, ts: r.last_turn_ts_text ?? '' },
      lastActivityAt: iso(r.last_activity_at),
      turnCount: r.turn_count ?? 0,
      state: (r.state as SessionState) ?? null,
      summary: readSummary(r.summary),
      summarizedThrough: cursorOf(r.summarized_through_idx, r.summarized_through_ts),
      summaryVersion: r.summary_version,
      rebuild: r.summary_rebuild,
      retryAt: iso(r.summary_retry_at),
      pending: Math.max(0, r.pending),
      finalReply: typeof r.final_reply_text === 'string' ? { text: r.final_reply_text, ts: r.final_reply_ts ?? '' } : null,
      finalReplySummarizedTs: r.final_reply_summarized_ts ?? null,
    }));
  }

  async turns(sessionId: string, afterIndex: number, limit: number): Promise<HumanTurn[]> {
    const { rows } = await this.q('SELECT * FROM turns WHERE session_id = $1 AND idx > $2 ORDER BY idx, uuid LIMIT $3', [sessionId, afterIndex, limit]);
    return rows.map((r) => ({ ...turnOf(r), text: r.text ?? '' }));
  }

  async save(sessionId: string, w: SummaryWrite): Promise<boolean> {
    const at = w.at ?? new Date();
    const version = w.prevVersion + 1;
    return tx(this.db, async (c) => {
      const { rows } = await c.query(
        `UPDATE sessions SET summary = $4::jsonb, summarized_through_idx = $5, summarized_through_ts = $6, summary_updated_at = $7,
           summary_model = $8, summary_version = $9, state = $10, summary_rebuild = false, summary_attempts = 0,
           summary_retry_at = NULL, summary_error = NULL,
           final_reply_summarized_ts = CASE WHEN $11::text IS NOT NULL THEN $11::text WHEN $3 THEN NULL ELSE final_reply_summarized_ts END
         WHERE id = $1 AND summary_version = $2 AND summary_rebuild = $3
         RETURNING project_key`,
        [sessionId, w.prevVersion, w.rebuild, toJson(redactDeep(w.summary)), w.to.index, w.to.ts, at, w.model, version, w.state, w.finalReplyTs ?? null],
      );
      if (!rows[0]) return false;
      await c.query(
        `INSERT INTO session_summary_updates (session_id, version, project_key, from_idx, from_ts, to_idx, to_ts, delta_turns, model, rebuild, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [sessionId, version, rows[0].project_key, w.from?.index ?? null, w.from?.ts ?? null, w.to.index, w.to.ts, w.deltaTurns, w.model, w.rebuild, at],
      );
      await c.query('DELETE FROM session_summary_updates WHERE session_id = $1 AND version <= $2', [sessionId, version - HISTORY_KEEP]);
      return true;
    });
  }

  async recordFailure(sessionId: string, error: string, now: Date = new Date()) {
    const { rows } = await this.q(
      'UPDATE sessions SET summary_attempts = summary_attempts + 1, summary_error = $2 WHERE id = $1 RETURNING summary_attempts',
      [sessionId, redactSecrets(error).slice(0, ERROR_CHARS)],
    );
    const attempts = rows[0]?.summary_attempts ?? 1;
    const retryAt = summaryRetryAt(attempts, now);
    await this.q('UPDATE sessions SET summary_retry_at = $2 WHERE id = $1', [sessionId, retryAt]);
    return { attempts, retryAt };
  }

  async setState(sessionId: string, state: SessionState) {
    await this.q('UPDATE sessions SET state = $2 WHERE id = $1', [sessionId, state]);
  }

  async requestRebuild(sessionId: string): Promise<boolean> {
    const { rowCount } = await this.q(
      `UPDATE sessions SET summary_rebuild = true, summary_attempts = 0, summary_retry_at = NULL, summary_error = NULL
       WHERE id = $1 AND NOT manual`,
      [sessionId],
    );
    return !!rowCount;
  }

  async redactStoredSummaries(): Promise<number> {
    let changed = 0;
    for (let after = ''; ;) {
      const { rows } = await this.q(
        `SELECT id, summary, final_reply_text FROM sessions
          WHERE id > $1 AND (summary IS NOT NULL OR final_reply_text IS NOT NULL) ORDER BY id LIMIT $2`,
        [after, REDACT_PAGE],
      );
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      const page = rows.flatMap((r: Record<string, unknown>) => redactStoredRow(r, ['final_reply_text'], ['summary']) ?? []);
      if (!page.length) continue;
      await this.q(
        `UPDATE sessions x SET summary = c.summary, final_reply_text = c.final_reply_text
         FROM jsonb_to_recordset($1::jsonb) AS c(id text, summary jsonb, final_reply_text text) WHERE x.id = c.id`,
        [toJson(page)],
      );
      changed += page.length;
    }
    return changed;
  }

  async turnEvidence(sessionId: string): Promise<TurnEvidence[]> {
    const { rows } = await this.q(
      `SELECT t.uuid, t.idx, t.ts_text, t.label, t.confidence, t.summary, coalesce(t.signals, '{}') AS signals, t.classify_attempts, k.id AS candidate_id
       FROM turns t LEFT JOIN LATERAL (SELECT min(c.id) AS id FROM candidates c WHERE c.turn_uuid = t.uuid) k ON true
       WHERE t.session_id = $1 ORDER BY t.idx, t.uuid`,
      [sessionId],
    );
    return rows.map((r) => ({
      uuid: r.uuid, index: r.idx, ts: r.ts_text, label: (r.label as TurnLabel) ?? null, confidence: r.confidence ?? null, summary: r.summary ?? null,
      signals: r.signals ?? [], classifyAttempts: r.classify_attempts ?? 0, candidateId: r.candidate_id ?? null,
    }));
  }
}
