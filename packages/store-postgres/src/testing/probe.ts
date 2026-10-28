import type { EmbeddedSeed, PreDoneCheckRow, ProbeKind, StaleTextSeed, StoreProbe } from '@fb/core/testing';
import { fromVector, toJson, toVector, type Db } from '../db.ts';

/** Where each record kind (Neo4j label) lives, and its identity column. */
export const TABLES: Record<ProbeKind, { table: string; id: string }> = {
  Project: { table: 'projects', id: 'key' },
  Session: { table: 'sessions', id: 'id' },
  Turn: { table: 'turns', id: 'uuid' },
  Commit: { table: 'commits', id: 'sha' },
  Candidate: { table: 'candidates', id: 'id' },
  Feedback: { table: 'feedback', id: 'id' },
  Task: { table: 'tasks', id: 'id' },
  Miss: { table: 'misses', id: 'id' },
  Cause: { table: 'causes', id: 'key' },
  Lesson: { table: 'lessons', id: 'id' },
  ContextItem: { table: 'context_items', id: 'id' },
  PreDoneCheck: { table: 'predone_checks', id: 'id' },
  CodeFile: { table: 'code_files', id: 'id' },
  Symbol: { table: 'code_symbols', id: 'id' },
  Fact: { table: 'facts', id: 'id' },
  ScanJob: { table: 'scan_jobs', id: 'id' },
  Doc: { table: 'docs', id: 'id' },
  Chunk: { table: 'chunks', id: 'id' },
  Activity: { table: 'activity', id: 'id' },
  SyncCursor: { table: 'sync_cursors', id: 'key' },
};

/** Placeholder parents for seeded records, filed under a project no test uses. */
const PROBE_PROJECT = '__probe__';

/** Reads and seeds Postgres directly for the contract suites. Complete: implementers do not change it. */
export class PostgresProbe implements StoreProbe {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  private q(sql: string, params: unknown[] = []) {
    return this.db.pool.query(sql, params);
  }

  async wipe() {
    const { rows } = await this.q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`);
    if (rows.length) await this.q(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  }

  async count(kind: ProbeKind): Promise<number> {
    const { rows } = await this.q(`SELECT count(*)::int AS n FROM ${TABLES[kind].table}`);
    return rows[0].n;
  }

  async ids(kind: ProbeKind): Promise<string[]> {
    const t = TABLES[kind];
    const { rows } = await this.q(`SELECT ${t.id} AS id FROM ${t.table} ORDER BY ${t.id}`);
    return rows.map((r) => r.id);
  }

  async rows(kind: ProbeKind): Promise<Record<string, unknown>[]> {
    const { rows } = await this.q(`SELECT to_jsonb(t) - 'embedding' AS r FROM ${TABLES[kind].table} t`);
    return rows.map((r) => r.r);
  }

  async project(key: string) {
    const { rows } = await this.q('SELECT key, remote, aliases, repo_path FROM projects WHERE key = $1', [key]);
    return rows[0] ? { key: rows[0].key, remote: rows[0].remote ?? null, aliases: rows[0].aliases ?? [], repoPath: rows[0].repo_path || null } : null;
  }

  async sessionSource(id: string): Promise<string | null> {
    const { rows } = await this.q('SELECT source FROM sessions WHERE id = $1', [id]);
    return rows[0]?.source ?? null;
  }

  async turn(uuid: string) {
    const { rows } = await this.q('SELECT text, preceding_assistant_text FROM turns WHERE uuid = $1', [uuid]);
    return rows[0] ? { text: rows[0].text ?? null, precedingAssistantText: rows[0].preceding_assistant_text ?? null } : null;
  }

  async feedbackStatus(id: string): Promise<string | null> {
    const { rows } = await this.q('SELECT status FROM feedback WHERE id = $1', [id]);
    return rows[0]?.status ?? null;
  }

  async factVersions(statement: string) {
    const { rows } = await this.q('SELECT current, valid_to IS NOT NULL AS closed FROM facts WHERE statement = $1 ORDER BY created_at', [statement]);
    return rows.map((r) => ({ current: r.current, closed: r.closed }));
  }

  async preDoneChecks(): Promise<PreDoneCheckRow[]> {
    const { rows } = await this.q(
      `SELECT x.project_key, x.task, x.checked, x.gaps, x.session_id,
              coalesce(jsonb_agg(jsonb_build_object('lessonId', c.lesson_id, 'gap', c.gap) ORDER BY c.lesson_id)
                       FILTER (WHERE c.lesson_id IS NOT NULL), '[]') AS lessons
       FROM predone_checks x LEFT JOIN predone_check_lessons c ON c.check_id = x.id
       GROUP BY x.id ORDER BY x.ts`,
    );
    return rows.map((r) => ({ projectKey: r.project_key, task: r.task, checked: r.checked, gaps: r.gaps, lessons: r.lessons, ...(r.session_id ? { sessionId: r.session_id } : {}) }));
  }

  async filedUnder(key: string): Promise<ProbeKind[]> {
    const parts = (Object.entries(TABLES) as [ProbeKind, { table: string }][])
      .filter(([kind]) => !['Project', 'Commit', 'Cause', 'SyncCursor', 'Lesson'].includes(kind))
      .map(([kind, t]) => `SELECT '${kind}' AS kind FROM ${t.table} WHERE project_key = $1`);
    parts.push(`SELECT 'Project' FROM projects WHERE key = $1`, `SELECT 'Lesson' FROM lessons WHERE project_key = $1 OR origin_project_key = $1`);
    const { rows } = await this.q(`SELECT DISTINCT kind FROM (${parts.join(' UNION ALL ')}) x ORDER BY kind`, [key]);
    return rows.map((r) => r.kind);
  }

  async embeddings(): Promise<Record<string, number[] | null>> {
    const { rows } = await this.q(
      `SELECT id, embedding::text AS v FROM lessons UNION ALL SELECT id, embedding::text FROM misses
       UNION ALL SELECT id, embedding::text FROM facts UNION ALL SELECT id, embedding::text FROM chunks ORDER BY id`,
    );
    return Object.fromEntries(rows.map((r) => [r.id, fromVector(r.v)]));
  }

  async setProject(key: string, fields: { remote?: string | null; aliases?: string[] }) {
    if ('remote' in fields) await this.q('UPDATE projects SET remote = $2 WHERE key = $1', [key, fields.remote ?? null]);
    if ('aliases' in fields) await this.q('UPDATE projects SET aliases = $2 WHERE key = $1', [key, fields.aliases ?? []]);
  }

  async setLessonCreatedAt(ids: string[], at: string) {
    await this.q('UPDATE lessons SET created_at = $2::timestamptz WHERE id = ANY($1::text[])', [ids, at]);
  }

  async seedOrphan(row: { kind: 'Lesson' | 'Doc'; id: string; projectKey: string }) {
    if (row.kind === 'Lesson') {
      await this.q(
        `INSERT INTO lessons (id, project_key, title, rule, scope, status, source, created_at)
         VALUES ($1, $2, '', '', 'project', 'approved', 'postmortem', now())`,
        [row.id, row.projectKey],
      );
    } else {
      await this.q(`INSERT INTO docs (id, project_key, source, ref, title, added_at) VALUES ($1, $2, 'upload', $1, '', now())`, [row.id, row.projectKey]);
    }
  }

  async seedEmbedded(row: EmbeddedSeed) {
    const v = toVector(row.embedding);
    const p = `probe:${row.id}`;
    switch (row.kind) {
      case 'Lesson':
        await this.q(
          `INSERT INTO lessons (id, title, rule, applies_when, scope, status, source, created_at, embedding)
           VALUES ($1, $2, $3, $4, 'global', $6, 'postmortem', now(), $5::vector)`,
          [row.id, row.title, row.rule, row.appliesWhen ?? null, v, row.status ?? 'proposed'],
        );
        return;
      case 'Miss':
        await this.q(`INSERT INTO sessions (id, project_key) VALUES ($1, $2)`, [p, PROBE_PROJECT]);
        await this.q(`INSERT INTO turns (uuid, session_id, project_key, ts, ts_text, idx) VALUES ($1, $1, $2, now(), now()::text, 1)`, [p, PROBE_PROJECT]);
        await this.q(`INSERT INTO feedback (id, project_key, turn_uuid, status, created_at) VALUES ($1, $2, $1, 'open', now())`, [p, PROBE_PROJECT]);
        await this.q(
          `INSERT INTO misses (id, project_key, feedback_id, missed, cause_explanation, created_at, embedding)
           VALUES ($1, $2, $3, $4, $5, now(), $6::vector)`,
          [row.id, PROBE_PROJECT, p, row.missed, row.causeExplanation, v],
        );
        return;
      case 'Fact':
        // A fact you wrote hangs off no file (facts_about_one).
        if (row.origin !== 'you' && !row.docId) await this.q(`INSERT INTO code_files (id, project_key, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [`${PROBE_PROJECT}:${row.path}`, PROBE_PROJECT, row.path]);
        // A fact read from an upload hangs off its document.
        if (row.docId) await this.q(`INSERT INTO docs (id, project_key, source, ref, title, added_at) VALUES ($1, $2, 'upload', $3, '', now()) ON CONFLICT (id) DO NOTHING`, [row.docId, PROBE_PROJECT, row.path]);
        await this.q(
          `INSERT INTO facts (id, project_key, code_file_id, kind, statement, path, source, current, created_at, valid_from, embedding, origin, doc_id)
           VALUES ($1, $2, $3, 'convention', $4, $5, 'probe', $6, now(), now(), $7::vector, $8, $9)`,
          [row.id, PROBE_PROJECT, row.origin === 'you' || row.docId ? null : `${PROBE_PROJECT}:${row.path}`, row.statement, row.path, row.current, v, row.origin ?? null, row.docId ?? null],
        );
        return;
      case 'Chunk':
        await this.q(`INSERT INTO docs (id, project_key, source, ref, title, added_at) VALUES ($1, $2, 'upload', $1, '', now())`, [p, PROBE_PROJECT]);
        await this.q(`INSERT INTO chunks (id, doc_id, project_key, idx, text, embedding) VALUES ($1, $2, $3, 0, $4, $5::vector)`, [row.id, p, PROBE_PROJECT, row.text, v]);
        return;
    }
  }

  async seedOwnerMark(lessonId: string) {
    await this.q('UPDATE lessons SET decided_by_you = true WHERE id = $1', [lessonId]);
  }

  async seedStaleText(row: StaleTextSeed) {
    switch (row.kind) {
      case 'InboxItem':
        await this.q(`INSERT INTO sessions (id, project_key) VALUES ($1, $2)`, [row.id, PROBE_PROJECT]);
        await this.q(
          `INSERT INTO turns (uuid, session_id, project_key, ts, ts_text, idx, text, preceding_assistant_text, summary)
           VALUES ($1, $1, $2, now(), now()::text, 1, $3, $4, $5)`,
          [row.id, PROBE_PROJECT, row.text, row.context, row.summary],
        );
        await this.q(
          `INSERT INTO candidates (id, turn_uuid, session_id, project_key, status, created_at, note, agent_report)
           VALUES ($1, $1, $1, $2, 'pending', now(), $3, $4::jsonb)`,
          [row.id, PROBE_PROJECT, row.note, row.agentReport ? toJson(row.agentReport) : null],
        );
        await this.q(`INSERT INTO feedback (id, project_key, turn_uuid, status, text, created_at) VALUES ($1, $2, $1, 'open', $3, now())`, [row.id, PROBE_PROJECT, row.feedbackText]);
        await this.q(
          `INSERT INTO misses (id, project_key, feedback_id, missed, cause_explanation, created_at) VALUES ($1, $2, $3, $4, $5, now())`,
          [`miss:${row.id}`, PROBE_PROJECT, row.id, row.missed, row.causeExplanation],
        );
        return;
      case 'Session':
        await this.q(`INSERT INTO sessions (id, project_key, summary, final_reply_text) VALUES ($1, $2, $3::jsonb, $4)`, [row.id, PROBE_PROJECT, toJson(row.summary), row.finalReply]);
        return;
      case 'Activity':
        await this.q(
          `INSERT INTO activity (id, ts, kind, actor, subject, why, details) VALUES ($1, now(), 'doc_added', 'probe', $2, $3, $4::jsonb)`,
          [row.id, row.subject, row.why, toJson(row.details)],
        );
        return;
      case 'ChatTurns':
        await this.q(`INSERT INTO chat_conversations (id, project_key, title, next_seq, created_at, updated_at) VALUES ($1, $2, 't', 3, now(), now())`, [row.id, PROBE_PROJECT]);
        await this.q(
          `INSERT INTO chat_turns (id, conversation_id, project_key, seq, role, text, status, sources, context, created_at, finished_at)
           VALUES ($1 || ':q', $1, $2, 1, 'user', $3, 'done', '[]', $4, now(), now())`,
          [row.id, PROBE_PROJECT, row.question, row.context],
        );
        await this.q(
          `INSERT INTO chat_turns (id, conversation_id, project_key, seq, role, text, status, answer, sources, created_at)
           VALUES ($1 || ':a', $1, $2, 2, 'assistant', '', 'pending', $3::jsonb, $4::jsonb, now())`,
          [row.id, PROBE_PROJECT, toJson(row.answer), toJson(row.sources)],
        );
        return;
    }
  }
}
