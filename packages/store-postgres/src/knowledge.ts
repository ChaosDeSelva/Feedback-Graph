import { randomUUID } from 'node:crypto';
import {
  matchReport,
  REPORT_MERGE_MINUTES,
  MAX_POSTMORTEM_ATTEMPTS,
  OUTCOME_STATUS,
  contextItemId,
  postmortemRetryAt,
  redactDeep,
  redactSecrets,
  type Cause,
  type ContextItem,
  type KnowledgeStore,
  type Lesson,
  type LessonDetail,
  type LessonHit,
  type LessonInput,
  type LessonPatch,
  type LessonScope,
  type LessonStatus,
  type PostMortem,
  type PostMortemInput,
  type Project,
  type RelatedMiss,
} from '@fb/core';
import { iso, toJson, toVector, tx, type Db } from './db.ts';
import { commitOf, turnOf } from './graph.ts';
import { learnedIn, relatedMissesQuery, runSearch, searchLessonsQuery } from './vector.ts';

type Row = Record<string, any>;

/**
 * An embedding as a vector parameter. pgvector cannot hold an empty vector; Neo4j would store [] and no search could
 * ever match it (sizes differ), which is what null gives here too.
 */
const vectorOf = (v: number[] | null | undefined): string | null => (v && v.length ? toVector(v) : null);

/** Post-mortems (feedback, miss, cause, lesson, context items, fix commits) and lessons. */
export class PgKnowledgeStore implements KnowledgeStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  private q(sql: string, params: unknown[] = []) {
    return this.db.pool.query(sql, params);
  }

  async feedbackNeedingPostmortem(limit: number, now = new Date()): Promise<PostMortemInput[]> {
    const { rows } = await this.q(
      `SELECT f.id AS feedback_id, row_to_json(t) AS turn, s.id AS sid, s.cwd, s.source, p.key AS pkey, p.repo_path, k.note
       FROM feedback f JOIN turns t ON t.uuid = f.turn_uuid JOIN sessions s ON s.id = t.session_id
         JOIN projects p ON p.key = s.project_key LEFT JOIN candidates k ON k.id = f.id
       WHERE NOT EXISTS (SELECT 1 FROM misses m WHERE m.feedback_id = f.id) AND f.status <> 'rejected'
         AND f.attempts < $1 AND (f.retry_at IS NULL OR f.retry_at <= $2)
       ORDER BY f.created_at, f.id LIMIT $3`,
      [MAX_POSTMORTEM_ATTEMPTS, now, limit],
    );
    if (!rows.length) return [];
    const turns = await this.q('SELECT * FROM turns WHERE session_id = ANY ($1::text[]) ORDER BY session_id, idx, uuid', [
      [...new Set(rows.map((r) => r.sid))],
    ]);
    return rows.map((r) => ({
      feedbackId: r.feedback_id,
      projectKey: r.pkey,
      repoPath: r.repo_path ?? undefined,
      cwd: r.cwd ?? '',
      sessionId: r.sid,
      source: r.source ?? 'claude',
      feedback: turnOf(r.turn),
      turns: turns.rows.filter((t) => t.session_id === r.sid).map(turnOf),
      note: r.note ?? null,
    }));
  }

  /** Returns when the next attempt is due, or null when it has given up. */
  async recordPostmortemFailure(feedbackId: string, error: string, now = new Date()): Promise<{ attempts: number; retryAt: string | null }> {
    return tx(this.db, async (c) => {
      const { rows } = await c.query('UPDATE feedback SET attempts = attempts + 1, last_error = $2 WHERE id = $1 RETURNING attempts', [
        feedbackId,
        redactSecrets(error).slice(0, 2000),
      ]);
      const attempts: number = rows[0]?.attempts ?? MAX_POSTMORTEM_ATTEMPTS;
      const retryAt = postmortemRetryAt(attempts, now);
      await c.query('UPDATE feedback SET retry_at = $2 WHERE id = $1', [feedbackId, retryAt]);
      return { attempts, retryAt };
    });
  }

  /** Start a given-up (or waiting) post-mortem again now. */
  async retryPostmortem(feedbackId: string): Promise<boolean> {
    const { rowCount } = await this.q(
      `UPDATE feedback f SET attempts = 0, retry_at = NULL WHERE f.id = $1 AND NOT EXISTS (SELECT 1 FROM misses m WHERE m.feedback_id = f.id)`,
      [feedbackId],
    );
    return (rowCount ?? 0) > 0;
  }

  async savePostmortem(feedbackId: string, raw: PostMortem, embeddings: { miss: number[]; lesson: number[] }): Promise<void> {
    const pm = redactDeep(raw); // model output can quote secrets it read in the repo
    const now = new Date();
    await tx(this.db, async (c) => {
      const { rows } = await c.query(
        `SELECT f.id, t.uuid, s.id AS sid, p.key AS pkey
         FROM feedback f JOIN turns t ON t.uuid = f.turn_uuid JOIN sessions s ON s.id = t.session_id JOIN projects p ON p.key = s.project_key
         WHERE f.id = $1 FOR UPDATE OF f`,
        [feedbackId],
      );
      const r = rows[0];
      if (!r) return;
      const taskId = `task:${r.sid}`;
      const missId = `miss:${feedbackId}`;
      const lessonId = `lesson:${feedbackId}`;
      await c.query(
        `INSERT INTO tasks (id, project_key, session_id, title, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [taskId, r.pkey, r.sid, pm.taskTitle, now],
      );
      await c.query('UPDATE feedback SET status = $2, updated_at = $3, task_id = $4 WHERE id = $1', [feedbackId, OUTCOME_STATUS[pm.outcome], now, taskId]);
      await c.query('INSERT INTO causes (key) VALUES ($1) ON CONFLICT DO NOTHING', [pm.cause]);
      await c.query(
        `INSERT INTO misses (id, project_key, feedback_id, missed, cause, cause_explanation, outcome, created_at, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)
         ON CONFLICT (id) DO UPDATE SET project_key = EXCLUDED.project_key, feedback_id = EXCLUDED.feedback_id, missed = EXCLUDED.missed,
           cause = EXCLUDED.cause, cause_explanation = EXCLUDED.cause_explanation, outcome = EXCLUDED.outcome,
           created_at = EXCLUDED.created_at, embedding = EXCLUDED.embedding`,
        [missId, r.pkey, feedbackId, pm.missed, pm.cause, pm.causeExplanation, pm.outcome, now, vectorOf(embeddings.miss)],
      );
      // A re-saved post-mortem rewrites the lesson's text but keeps its status, creation time and source.
      await c.query(
        `INSERT INTO lessons (id, status, created_at, source, title, rule, applies_when, scope, paths, cause, miss_id,
                              project_key, origin_project_key, embedding)
         VALUES ($1, 'proposed', $2, 'postmortem', $3, $4, $5, $6, $7, $8, $9, CASE WHEN $6 = 'global' THEN NULL ELSE $10 END, $10, $11::vector)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, rule = EXCLUDED.rule, applies_when = EXCLUDED.applies_when,
           scope = EXCLUDED.scope, paths = EXCLUDED.paths, cause = EXCLUDED.cause, miss_id = EXCLUDED.miss_id,
           project_key = EXCLUDED.project_key, origin_project_key = EXCLUDED.origin_project_key, embedding = EXCLUDED.embedding`,
        [
          lessonId,
          now,
          pm.lesson.title,
          pm.lesson.rule,
          pm.lesson.appliesWhen,
          pm.lesson.scope,
          pm.lesson.paths ?? [],
          pm.cause,
          missId,
          r.pkey,
          vectorOf(embeddings.lesson),
        ],
      );
      // Fix commits: the session's commits made after the feedback, by real time (committers' offsets differ).
      await c.query(
        `INSERT INTO commit_feedback (sha, feedback_id)
         SELECT k.sha, $1 FROM session_commits sc JOIN commits k ON k.sha = sc.sha JOIN turns t ON t.uuid = $3
         WHERE sc.session_id = $2 AND k.ts > t.ts
         ON CONFLICT DO NOTHING`,
        [feedbackId, r.sid, r.uuid],
      );
      for (const it of pm.contextItems ?? []) {
        const id = contextItemId(feedbackId, it.kind, it.ref);
        await c.query(
          `INSERT INTO context_items (id, project_key, kind, ref, excerpt) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET project_key = EXCLUDED.project_key, kind = EXCLUDED.kind, ref = EXCLUDED.ref, excerpt = EXCLUDED.excerpt`,
          [id, r.pkey, it.kind, it.ref, it.excerpt ?? null],
        );
        await c.query(
          `INSERT INTO context_item_misses (context_item_id, miss_id, why) VALUES ($1, $2, $3)
           ON CONFLICT (context_item_id, miss_id) DO UPDATE SET why = EXCLUDED.why`,
          [id, missId, it.why ?? null],
        );
        if (it.wasAvailable) {
          await c.query('INSERT INTO context_item_sessions (context_item_id, session_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, r.sid]);
        }
      }
    });
  }

  async listLessons(f: { status?: LessonStatus; projectKey?: string; projectKeys?: string[]; limit?: number }): Promise<Lesson[]> {
    const { rows } = await this.q(
      `SELECT * FROM lessons
       WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR project_key = $2 OR project_key IS NULL)
         AND ${learnedIn('lessons', '$4')}
       ORDER BY created_at DESC, id LIMIT $3`,
      [f.status ?? null, f.projectKey ?? null, f.limit ?? 500, f.projectKeys ?? null],
    );
    return rows.map(lessonOf);
  }

  async lessonDetail(id: string): Promise<LessonDetail | null> {
    const { rows } = await this.q(
      `SELECT l.*, m.id AS m_id, m.missed AS m_missed, m.cause AS m_cause, m.cause_explanation AS m_cause_explanation,
              f.id AS f_id, f.status AS f_status, t.text AS t_text, t.session_id AS t_session_id, t.ts_text AS t_ts
       FROM lessons l
       LEFT JOIN (misses m JOIN feedback f ON f.id = m.feedback_id JOIN turns t ON t.uuid = f.turn_uuid) ON m.id = l.miss_id
       WHERE l.id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    const [items, commits, supersedes] = await Promise.all([
      r.m_id
        ? this.q(
            `SELECT ci.kind, ci.ref, ci.excerpt, w.why,
                    EXISTS (SELECT 1 FROM context_item_sessions av WHERE av.context_item_id = ci.id) AS available
             FROM context_item_misses w JOIN context_items ci ON ci.id = w.context_item_id
             WHERE w.miss_id = $1 ORDER BY ci.id`,
            [r.m_id],
          )
        : { rows: [] as Row[] },
      r.f_id
        ? this.q(
            `SELECT k.sha, k.ts_text, k.subject FROM commit_feedback cf JOIN commits k ON k.sha = cf.sha
             WHERE cf.feedback_id = $1 ORDER BY k.ts, k.sha`,
            [r.f_id],
          )
        : { rows: [] as Row[] },
      this.q('SELECT superseded_id FROM lesson_supersedes WHERE lesson_id = $1 ORDER BY superseded_id', [id]),
    ]);
    return {
      lesson: lessonOf(r),
      miss: r.m_id ? { id: r.m_id, missed: r.m_missed, cause: r.m_cause, causeExplanation: r.m_cause_explanation ?? undefined } : null,
      feedback: r.f_id ? { id: r.f_id, text: r.t_text ?? undefined, status: r.f_status, sessionId: r.t_session_id, ts: r.t_ts } : null,
      contextItems: items.rows.map((i) => ({
        kind: i.kind as ContextItem['kind'],
        ref: i.ref,
        excerpt: i.excerpt ?? undefined,
        why: i.why ?? undefined,
        wasAvailable: i.available,
      })),
      fixCommits: commits.rows.map(commitOf),
      supersedes: supersedes.rows.map((s) => s.superseded_id),
    };
  }

  /** `unscoped`: you narrowed it but its project is unknown, so it went back to proposed instead of serving everywhere. */
  async updateLesson(id: string, patch: LessonPatch, o: { reembed?: number[] }): Promise<{ unscoped: boolean }> {
    const now = new Date();
    const { supersedes, status, ...fields } = patch;
    if (supersedes !== undefined) {
      if (supersedes === id) throw new Error('a lesson cannot supersede itself');
      const found = await this.q('SELECT 1 FROM lessons WHERE id = $1', [supersedes]);
      if (!found.rowCount) throw new Error(`no lesson ${supersedes} to supersede`);
    }
    const has = (k: keyof typeof fields) => fields[k] !== undefined;
    return tx(this.db, async (c) => {
      const { rows } = await c.query(
        `UPDATE lessons SET
           title = CASE WHEN $2 THEN $3 ELSE title END,
           rule = CASE WHEN $4 THEN $5 ELSE rule END,
           applies_when = CASE WHEN $6 THEN $7 ELSE applies_when END,
           scope = CASE WHEN $8 THEN $9 ELSE scope END,
           paths = CASE WHEN $10 THEN $11::text[] ELSE paths END,
           decided_by_you = true,
           status = coalesce($12, status),
           decided_at = CASE WHEN $12::text IS NULL THEN decided_at ELSE $13 END,
           embedding = CASE WHEN $14::vector IS NULL THEN embedding ELSE $14::vector END
         WHERE id = $1
         RETURNING (SELECT coalesce(lessons.origin_project_key, f.project_key, lessons.project_key)
                    FROM (SELECT 1) one LEFT JOIN misses m ON m.id = lessons.miss_id LEFT JOIN feedback f ON f.id = m.feedback_id) AS origin`,
        [
          id,
          has('title'),
          fields.title ?? null,
          has('rule'),
          fields.rule ?? null,
          has('appliesWhen'),
          fields.appliesWhen ?? null,
          has('scope'),
          fields.scope ?? null,
          has('paths'),
          fields.paths ?? null,
          status ?? null,
          now,
          o.reembed ? vectorOf(o.reembed) : null,
        ],
      );
      if (!rows[0]) return { unscoped: false };
      const origin: string | null = rows[0].origin ?? null;
      const scope = fields.scope;
      const narrowed = scope === 'project' || scope === 'task';
      // Scope decides who sees it: global has no project; project/task go back to the project it came from.
      if (scope === 'global') await c.query('UPDATE lessons SET project_key = NULL WHERE id = $1', [id]);
      if (narrowed && origin !== null) {
        await c.query('UPDATE lessons SET project_key = $2, origin_project_key = $2 WHERE id = $1', [id, origin]);
        await c.query('INSERT INTO projects (key) VALUES ($1) ON CONFLICT DO NOTHING', [origin]);
      }
      // Fail closed: a narrowed lesson with no known project must not stay visible to every project.
      const unscoped = narrowed && origin === null;
      if (unscoped) await c.query(`UPDATE lessons SET status = 'proposed', project_key = NULL WHERE id = $1`, [id]);
      if (supersedes !== undefined) {
        const old = await c.query(
          `UPDATE lessons SET status = 'superseded', decided_at = $2, valid_to = $2 WHERE id = $1 RETURNING id`,
          [supersedes, now],
        );
        if (old.rowCount) {
          await c.query('INSERT INTO lesson_supersedes (lesson_id, superseded_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, supersedes]);
        }
      }
      return { unscoped };
    });
  }

  async searchLessons(q: { embedding: number[]; projectKey: string | null; k: number; status?: LessonStatus; projectKeys?: string[] }): Promise<LessonHit[]> {
    // This project's and the global lessons, nearest first, through the HNSW index when it pays (see vector.ts).
    const rows = await runSearch(this.db, searchLessonsQuery(this.db, q), q.k);
    return rows.map((r) => ({ lesson: lessonOf(r), score: r.score }));
  }

  async relatedMisses(q: { embedding: number[]; projectKey: string | null; k: number }): Promise<RelatedMiss[]> {
    const rows = await runSearch(this.db, relatedMissesQuery(this.db, q), q.k);
    return rows.map((r) => ({
      missId: r.id,
      missed: r.missed,
      cause: r.cause as Cause,
      feedbackText: r.text ?? undefined,
      sessionId: r.session_id,
      ts: r.ts_text,
      score: r.score,
    }));
  }

  /** The manual /postmortem path: queued for your decision, or added to the detector's item for the same miss. */
  async createManualFeedback(input: { project: Project; cwd: string; text: string; whatWasDone: string; sessionId?: string | null }): Promise<string> {
    const o = { ...input, text: redactDeep(input.text), whatWasDone: redactDeep(input.whatWasDone) };
    const now = new Date();
    const report = toJson({ text: o.text, whatWasDone: o.whatWasDone, reportedAt: now.toISOString(), sessionId: o.sessionId ?? null });
    const { rows: flagged } = await this.q(
      `SELECT k.id, k.session_id, t.ts, t.text FROM candidates k JOIN turns t ON t.uuid = k.turn_uuid
       WHERE k.project_key = $1 AND NOT k.manual AND k.agent_report IS NULL AND k.status <> 'rejected' AND t.external IS NULL
         AND t.ts BETWEEN $2::timestamptz - make_interval(mins => $3) AND $2::timestamptz + make_interval(mins => $3)`,
      [o.project.key, now, REPORT_MERGE_MINUTES],
    );
    const hit = matchReport(
      { ts: now.toISOString(), text: o.text, sessionId: o.sessionId },
      flagged.map((r) => ({ id: r.id as string, sessionId: r.session_id as string, ts: (r.ts as Date).toISOString(), text: r.text ?? '' })),
    );
    if (hit) {
      await this.q('UPDATE candidates SET agent_report = $2::jsonb WHERE id = $1', [hit.id, report]);
      return hit.id;
    }
    const id = `manual:${randomUUID()}`;
    await tx(this.db, async (c) => {
      await c.query('INSERT INTO projects (key, name, repo_path) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING', [
        o.project.key,
        o.project.name ?? null,
        o.project.repoPath ?? null,
      ]);
      await c.query(
        `INSERT INTO sessions (id, project_key, source_file, cwd, started_at, ended_at, manual) VALUES ($1, $2, 'manual', $3, $4, $4, true)`,
        [id, o.project.key, o.cwd ?? null, now],
      );
      await c.query(
        `INSERT INTO turns (uuid, session_id, project_key, ts, ts_text, idx, text, preceding_assistant_text, tool_calls,
                            label, confidence, summary, signals)
         VALUES ($1, $1, $2, $3, $4, 1, $5, $6, '[]', 'pushback', 1.0, $5, ARRAY['manual'])`,
        [id, o.project.key, now, now.toISOString(), o.text, o.whatWasDone],
      );
      await c.query(
        `INSERT INTO candidates (id, turn_uuid, session_id, project_key, ts, status, created_at, manual, agent_report)
         VALUES ($1, $1, $1, $2, $3, 'pending', $3, true, $4::jsonb)`,
        [id, o.project.key, now, report],
      );
    });
    return id;
  }

  async recordPreDoneCheck(c: { projectKey: string; task: string; checkedLessonIds: string[]; gapLessonIds: string[] }): Promise<void> {
    const id = randomUUID();
    await tx(this.db, async (x) => {
      await x.query('INSERT INTO predone_checks (id, project_key, ts, task, checked, gaps) VALUES ($1, $2, $3, $4, $5, $6)', [
        id,
        c.projectKey,
        new Date(),
        redactSecrets(c.task),
        c.checkedLessonIds.length,
        c.gapLessonIds.length,
      ]);
      // Lesson ids that do not exist are not linked.
      await x.query(
        `INSERT INTO predone_check_lessons (check_id, lesson_id, gap)
         SELECT $1, l.id, l.id = ANY ($3::text[]) FROM lessons l WHERE l.id = ANY ($2::text[])
         ON CONFLICT DO NOTHING`,
        [id, c.checkedLessonIds, c.gapLessonIds],
      );
    });
  }

  async upsertLesson(input: LessonInput): Promise<void> {
    const l = redactDeep(input);
    const now = new Date();
    await tx(this.db, async (c) => {
      // Once you have decided on or edited a lesson, re-importing its file never overrides you.
      await c.query(
        `INSERT INTO lessons (id, created_at, status, decided_at, source, project_key, origin_project_key,
                              title, rule, applies_when, scope, paths, embedding)
         VALUES ($1, $2::timestamptz, $3::text, CASE WHEN $3::text = 'proposed' THEN NULL ELSE $2::timestamptz END, $4, $5, $5, $6, $7, $8, $9, $10, $11::vector)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, rule = EXCLUDED.rule, applies_when = EXCLUDED.applies_when,
           scope = EXCLUDED.scope, paths = EXCLUDED.paths, embedding = EXCLUDED.embedding
         WHERE NOT lessons.decided_by_you`,
        [l.id, now, l.status, l.source, l.projectKey ?? null, l.title, l.rule, l.appliesWhen ?? null, l.scope, l.paths ?? [], vectorOf(l.embedding)],
      );
      if (l.projectKey != null) await c.query('INSERT INTO projects (key) VALUES ($1) ON CONFLICT DO NOTHING', [l.projectKey]);
    });
  }
}

function lessonOf(r: Row): Lesson {
  return {
    id: r.id,
    projectKey: r.project_key ?? null,
    origin: r.project_key ?? r.origin_project_key ?? null,
    title: r.title,
    rule: r.rule,
    appliesWhen: r.applies_when ?? '',
    scope: r.scope as LessonScope,
    paths: r.paths ?? [],
    status: r.status as LessonStatus,
    source: r.source ?? 'postmortem',
    cause: r.cause ?? null,
    missId: r.miss_id ?? null,
    createdAt: iso(r.created_at) as string,
    decidedAt: iso(r.decided_at),
  };
}
