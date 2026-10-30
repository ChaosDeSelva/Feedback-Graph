import { conditionalWrite } from './conditionalWrite.ts';
import { archiveBeforeRedaction, archiveRedactionInput } from '@fb/core';
import { reviewPatterns } from '@fb/core';
import { randomUUID } from 'node:crypto';
import {
  matchReport,
  REPORT_MERGE_MINUTES,
  MAX_POSTMORTEM_ATTEMPTS,
  OUTCOME_STATUS,
  contextItemId,
  LESSON_CHECKS_VERSION,
  feedbackAuthorOf,
  postmortemRetryAt,
  REDACT_PAGE,
  redactDeep,
  redactSecrets,
  redactStoredLesson,
  redactStoredRow,
  type Cause,
  type CommentLesson,
  type ExternalRef,
  type ContextItem,
  DEMO_SOURCE,
  demoPrefix,
  type DemoMiss,
  type DemoRemoved,
  type KnowledgeStore,
  type Lesson,
  type LessonCheck,
  type LessonDetail,
  type LessonDraft,
  type DecidedLesson,
  type DecidedLessonsQuery,
  draftOf,
  editedDraft,
  ownerDecided,
  OWNER_DECIDED_SQL,
  type LessonFilter,
  type LessonFrom,
  type LessonHit,
  type LessonInput,
  type LessonPatch,
  type LessonScope,
  type LessonStatus,
  type PostMortem,
  type PostMortemInput,
  type Project,
  type RelatedMiss,
  type RunTag,
  type UnsortedMiss,
  type SimilarLesson,
} from '@fb/core';
import type pg from 'pg';
import { iso, toJson, toVector, tx, type Db } from './db.ts';
import { commitOf, turnOf } from './graph.ts';
import { learnedIn, relatedMissesQuery, runSearch, sandboxPresence, searchLessonsQuery, visibleToRun } from './vector.ts';

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

  async postmortemBacklog(): Promise<number> {
    const { rows } = await this.q(
      `SELECT count(*)::int AS n
       FROM feedback f JOIN turns t ON t.uuid = f.turn_uuid JOIN sessions s ON s.id = t.session_id JOIN projects p ON p.key = s.project_key
       WHERE NOT EXISTS (SELECT 1 FROM misses m WHERE m.feedback_id = f.id) AND f.status <> 'rejected' AND f.attempts < $1`,
      [MAX_POSTMORTEM_ATTEMPTS],
    );
    return rows[0].n;
  }

  async postmortemQueue(): Promise<{ waiting: number; oldestAt: string | null }> {
    const { rows } = await this.q(
      `SELECT count(*)::int AS n, min(f.created_at) AS oldest
       FROM feedback f JOIN turns t ON t.uuid = f.turn_uuid JOIN sessions s ON s.id = t.session_id JOIN projects p ON p.key = s.project_key
       WHERE NOT EXISTS (SELECT 1 FROM misses m WHERE m.feedback_id = f.id) AND f.status <> 'rejected' AND f.attempts < $1`,
      [MAX_POSTMORTEM_ATTEMPTS],
    );
    return { waiting: rows[0].n, oldestAt: iso(rows[0].oldest) };
  }

  async feedbackNeedingPostmortem(limit: number, now = new Date()): Promise<PostMortemInput[]> {
    const { rows } = await this.q(
      `SELECT f.id AS feedback_id, f.run AS source_run, f.sandbox AS source_sandbox, row_to_json(t) AS turn, s.id AS sid, s.cwd, s.source, p.key AS pkey, p.repo_path, k.note, k.decided_by AS note_by
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
      ...(r.source_run ? { run: r.source_run as string } : {}),
      ...(r.source_sandbox === true ? { sandbox: true as const } : {}),
      projectKey: r.pkey,
      repoPath: r.repo_path ?? undefined,
      cwd: r.cwd ?? '',
      sessionId: r.sid,
      source: r.source ?? 'claude',
      feedback: turnOf(r.turn),
      turns: turns.rows.filter((t) => t.session_id === r.sid).map(turnOf),
      note: r.note ?? null,
      noteBy: r.note_by ?? null,
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
    return conditionalWrite(this.db, async query => {
      const { rowCount } = await query(
        `UPDATE feedback f SET attempts = 0, retry_at = NULL WHERE f.id = $1 AND NOT EXISTS (SELECT 1 FROM misses m WHERE m.feedback_id = f.id)`,
        [feedbackId],
      );
      return (rowCount ?? 0) > 0;
    }, Boolean);
  }

  async savePostmortem(feedbackId: string, raw: PostMortem, embeddings: { miss: number[]; lesson: number[] }): Promise<boolean> {
    const pm = redactDeep(raw);
    await archiveRedactionInput('postmortem', feedbackId, raw, pm); // model output can quote secrets it read in the repo
    const now = new Date();
    return tx(this.db, async (c) => {
      // The report's run (RunTag), carried to the miss and lesson so a sandbox one is served only to its run.
      const { rows } = await c.query(
        `SELECT f.id, t.uuid, s.id AS sid, p.key AS pkey, k.run, coalesce(k.sandbox, false) AS sandbox
         FROM feedback f JOIN turns t ON t.uuid = f.turn_uuid JOIN sessions s ON s.id = t.session_id JOIN projects p ON p.key = s.project_key
           LEFT JOIN candidates k ON k.id = f.id
         WHERE f.id = $1 FOR UPDATE OF f`,
        [feedbackId],
      );
      const r = rows[0];
      if (!r) return false;
      // A sandbox report's miss and lesson are sandbox records (this may be the worker, whose searches have not seen it).
      sandboxPresence(this.db).wrote(r.sandbox ?? true);
      const taskId = `task:${r.sid}`;
      const missId = `miss:${feedbackId}`;
      const lessonId = `lesson:${feedbackId}`;
      await c.query(
        `INSERT INTO tasks (id, project_key, session_id, title, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [taskId, r.pkey, r.sid, pm.taskTitle, now],
      );
      await c.query('UPDATE feedback SET status = $2, updated_at = $3, task_id = $4 WHERE id = $1', [feedbackId, OUTCOME_STATUS[pm.outcome], now, taskId]);
      if (pm.noMiss) {
        await c.query("UPDATE feedback SET status = 'rejected' WHERE id = $1", [feedbackId]);
        await c.query('DELETE FROM misses WHERE feedback_id = $1', [feedbackId]);
        return true; // A false/disputed claim must not become a served miss.
      }
      await c.query('INSERT INTO causes (key) VALUES ($1) ON CONFLICT DO NOTHING', [pm.cause]);
      await c.query(
        `INSERT INTO misses (id, project_key, feedback_id, missed, cause, cause_explanation, outcome, created_at, embedding, subject, run, sandbox)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10, $11, $12)
         ON CONFLICT (id) DO UPDATE SET project_key = EXCLUDED.project_key, feedback_id = EXCLUDED.feedback_id, missed = EXCLUDED.missed,
           cause = EXCLUDED.cause, cause_explanation = EXCLUDED.cause_explanation, outcome = EXCLUDED.outcome,
           created_at = EXCLUDED.created_at, embedding = EXCLUDED.embedding, subject = EXCLUDED.subject, run = EXCLUDED.run, sandbox = EXCLUDED.sandbox`,
        [missId, r.pkey, feedbackId, pm.missed, pm.cause, pm.causeExplanation, pm.outcome, now, vectorOf(embeddings.miss), pm.subject ?? null, r.run ?? null, r.sandbox === true],
      );
      // A re-saved post-mortem rewrites the lesson's text but keeps its status, creation time and source; one the owner
      // edited (proposed_as kept) keeps the owner's words, paths, scope and their checks. A dropped lesson (no rule even
      // after the retry) is not written: the miss is.
      if (!pm.lessonDropped) await c.query(
        `INSERT INTO lessons (id, status, created_at, source, title, rule, applies_when, scope, paths, cause, miss_id,
                              project_key, origin_project_key, embedding, checks, checks_version, run, sandbox)
         VALUES ($1, 'proposed', $2, 'postmortem', $3, $4, $5, $6, $7, $8, $9, CASE WHEN $6 = 'global' THEN NULL ELSE $10 END, $10, $11::vector, $12::jsonb,
                 CASE WHEN $12::jsonb IS NULL THEN NULL ELSE $13::integer END, $14, $15)
         ON CONFLICT (id) DO UPDATE SET
           title = CASE WHEN lessons.proposed_as IS NULL THEN EXCLUDED.title ELSE lessons.title END,
           rule = CASE WHEN lessons.proposed_as IS NULL THEN EXCLUDED.rule ELSE lessons.rule END,
           applies_when = CASE WHEN lessons.proposed_as IS NULL THEN EXCLUDED.applies_when ELSE lessons.applies_when END,
           scope = CASE WHEN lessons.proposed_as IS NULL THEN EXCLUDED.scope ELSE lessons.scope END,
           paths = CASE WHEN lessons.proposed_as IS NULL THEN EXCLUDED.paths ELSE lessons.paths END,
           project_key = CASE WHEN lessons.proposed_as IS NULL THEN EXCLUDED.project_key ELSE lessons.project_key END,
           embedding = CASE WHEN lessons.proposed_as IS NULL THEN EXCLUDED.embedding ELSE lessons.embedding END,
           checks = CASE WHEN lessons.proposed_as IS NULL THEN EXCLUDED.checks ELSE lessons.checks END,
           checks_version = CASE WHEN lessons.proposed_as IS NULL THEN EXCLUDED.checks_version ELSE lessons.checks_version END,
           cause = EXCLUDED.cause, miss_id = EXCLUDED.miss_id, origin_project_key = EXCLUDED.origin_project_key,
           run = EXCLUDED.run, sandbox = EXCLUDED.sandbox`,
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
          pm.lessonChecks ? toJson(pm.lessonChecks) : null,
          LESSON_CHECKS_VERSION,
          r.run ?? null,
          r.sandbox === true,
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
      return true;
    });
  }

  async listLessons(f: LessonFilter): Promise<Lesson[]> {
    const { rows } = await this.q(
      `SELECT l.*, ${FROM} AS from_kind FROM lessons l ${FEEDBACK_TURN}
       WHERE ($1::text IS NULL OR l.status = $1) AND ($2::text IS NULL OR l.project_key = $2 OR l.project_key IS NULL)
         AND ${learnedIn('l', '$4')}
         AND ($5::text IS NULL OR l.checks @> jsonb_build_array(jsonb_build_object('name', $5::text)))
         AND ($6::text IS NULL OR ${FROM} = $6) AND ${visibleToRun('l', '$7')}
         AND ($8::text IS NULL OR t.external->>'thread' ~ ('#' || $8 || '$') OR concat_ws(E'\n', t.text, t.preceding_assistant_text, t.summary, l.title, l.rule, l.applies_when) ~* $10)
         AND ($9::text IS NULL OR lower(t.external->>'author') = lower($9))
       ORDER BY l.created_at DESC, l.id COLLATE "C" LIMIT $3`,
      [f.status ?? null, f.projectKey ?? null, f.limit ?? 500, f.projectKeys ?? null, f.flag ?? null, f.from ?? null, f.run ?? null, f.pr ? String(f.pr) : null, f.author ?? null, reviewPatterns(f.pr).pr],
    );
    return rows.map(lessonOf);
  }

  async staleLessonChecks(version: number, limit: number): Promise<Lesson[]> {
    const { rows } = await this.q(
      `SELECT l.*, ${FROM} AS from_kind FROM lessons l ${FEEDBACK_TURN}
       WHERE l.status IN ('proposed', 'approved') AND coalesce(l.checks_version, 0) < $1
       ORDER BY l.created_at, l.id LIMIT $2`,
      [version, limit],
    );
    return rows.map(lessonOf);
  }

  async commentLessons(q: { status: LessonStatus; limit: number; afterId?: string | null }): Promise<CommentLesson[]> {
    const { rows } = await this.q(
      `SELECT l.id, f.id AS feedback_id, coalesce(m.project_key, l.origin_project_key, l.project_key) AS project_key, t.text,
              t.external, l.checks, m.missed, m.cause_explanation, l.proposed_as IS NOT NULL AS owner_edited
       FROM lessons l JOIN misses m ON m.id = l.miss_id JOIN feedback f ON f.id = m.feedback_id JOIN turns t ON t.uuid = f.turn_uuid
       WHERE l.status = $1 AND t.external IS NOT NULL AND ($2::text IS NULL OR l.id COLLATE "C" > $2)
       ORDER BY l.id COLLATE "C" LIMIT $3`,
      [q.status, q.afterId ?? null, q.limit],
    );
    return rows.map((r) => ({
      id: r.id,
      feedbackId: r.feedback_id,
      projectKey: r.project_key,
      text: r.text ?? '',
      external: r.external as ExternalRef,
      checks: (r.checks as LessonCheck[] | null) ?? null,
      missed: r.missed ?? '',
      causeExplanation: r.cause_explanation ?? '',
      ownerEdited: r.owner_edited === true,
    }));
  }

  async requestLessonRecheck(): Promise<number> {
    const { rowCount } = await this.q(`UPDATE lessons SET checks_version = 0 WHERE status IN ('proposed', 'approved')`);
    return rowCount ?? 0;
  }

  async similarLessons(id: string, k: number): Promise<SimilarLesson[]> {
    // <=> is the cosine distance: the true cosine is 1 - distance. Same project as the lesson (where it was learned).
    const { rows } = await this.q(
      `SELECT o.id, 1 - (o.embedding <=> l.embedding) AS cosine, o.status, o.created_at
       FROM lessons l JOIN lessons o ON o.id <> l.id AND o.embedding IS NOT NULL AND vector_dims(o.embedding) = vector_dims(l.embedding)
         AND coalesce(o.project_key, o.origin_project_key) IS NOT DISTINCT FROM coalesce(l.project_key, l.origin_project_key)
       WHERE l.id = $1 AND l.embedding IS NOT NULL
       ORDER BY cosine DESC, o.id LIMIT $2`,
      [id, k],
    );
    return rows.map((r) => ({ id: r.id, cosine: Number(r.cosine), status: r.status as LessonStatus, createdAt: iso(r.created_at) as string }));
  }

  async backfillProposedAs(id: string, draft: LessonDraft): Promise<boolean> {
    await archiveRedactionInput('lesson-draft', id, draftOf(draft), redactDeep(draftOf(draft)));
    const { rowCount } = await this.q(
      `UPDATE lessons SET proposed_as = $2 WHERE id = $1 AND source = 'postmortem' AND proposed_as IS NULL`,
      [id, toJson(redactDeep(draftOf(draft)))],
    );
    return (rowCount ?? 0) > 0;
  }

  async decidedLessons(q: DecidedLessonsQuery): Promise<DecidedLesson[]> {
    // <=> is the cosine distance: the true cosine is 1 - distance.
    const { rows } = await this.q(
      `SELECT l.*, CASE WHEN $4::vector IS NOT NULL AND l.embedding IS NOT NULL AND vector_dims(l.embedding) = vector_dims($4::vector)
                        THEN 1 - (l.embedding <=> $4::vector) END AS score
       FROM lessons l
       WHERE l.source = 'postmortem' AND l.status IN ('approved', 'rejected') AND l.decided_at IS NOT NULL AND l.decided_at >= $1
         AND NOT coalesce(l.sandbox, false) AND coalesce(l.project_key, l.origin_project_key) IS NOT NULL
         AND ($2::text[] IS NULL OR coalesce(l.project_key, l.origin_project_key) = ANY($2::text[]))
         AND ${OWNER_DECIDED_SQL('l.decided_by')}
         AND ($5::text IS NULL OR ($5 = 'rejected' AND l.status = 'rejected')
              OR ($5 = 'edited' AND l.status = 'approved' AND l.proposed_as IS NOT NULL)
              OR ($5 = 'unedited' AND l.status = 'approved' AND l.proposed_as IS NULL))
       ORDER BY l.decided_at DESC, l.id DESC LIMIT $3`,
      [q.since, q.projectKeys, q.limit, vectorOf(q.embedding), q.outcome ?? null],
    );
    return rows.map((r) => ({ lesson: lessonOf(r), score: r.score == null ? null : Number(r.score) }));
  }

  async lessonDetail(id: string): Promise<LessonDetail | null> {
    const { rows } = await this.q(
      `SELECT l.*, m.id AS m_id, m.missed AS m_missed, m.cause AS m_cause, m.cause_explanation AS m_cause_explanation,
              f.id AS f_id, f.status AS f_status, t.text AS t_text, t.session_id AS t_session_id, t.ts_text AS t_ts, ${FROM} AS from_kind, t.external AS t_external
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
      feedback: r.f_id ? { id: r.f_id, text: r.t_text ?? undefined, status: r.f_status, sessionId: r.t_session_id, ts: r.t_ts, external: feedbackAuthorOf(r.t_external) } : null,
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
  async updateLesson(id: string, patch: LessonPatch, o: { reembed?: number[]; by?: string; note?: string }): Promise<{ unscoped: boolean }> {
    const safePatch = redactDeep(patch);
    await archiveRedactionInput('lesson-edit', id, patch, safePatch);
    patch = safePatch;
    const now = new Date();
    const { supersedes, status, projectKey, ...fields } = patch;
    if (status === 'revoked') {
      const { rows } = await this.q('SELECT status FROM lessons WHERE id = $1', [id]);
      if (rows[0]?.status !== 'approved') throw new Error('only a previously approved lesson can be revoked');
    }
    if (supersedes !== undefined) {
      if (supersedes === id) throw new Error('a lesson cannot supersede itself');
      const found = await this.q('SELECT 1 FROM lessons WHERE id = $1', [supersedes]);
      if (!found.rowCount) throw new Error(`no lesson ${supersedes} to supersede`);
    }
    const has = (k: keyof typeof fields) => fields[k] !== undefined;
    return tx(this.db, async (c) => {
      // The writer's version, kept on the first edit of a proposed lesson (read under the row lock, so it is the first).
      if (Object.values(fields).some((v) => v !== undefined)) {
        const cur = await c.query('SELECT * FROM lessons WHERE id = $1 FOR UPDATE', [id]);
        const draft = cur.rows[0] ? editedDraft(lessonOf(cur.rows[0]), fields) : null;
        if (draft) await archiveRedactionInput('lesson-draft', id, draft, redactDeep(draft));
        if (draft) await c.query('UPDATE lessons SET proposed_as = $2 WHERE id = $1 AND proposed_as IS NULL', [id, toJson(redactDeep(draft))]);
      }
      const { rows } = await c.query(
        `UPDATE lessons SET
           title = CASE WHEN $2 THEN $3 ELSE title END,
           rule = CASE WHEN $4 THEN $5 ELSE rule END,
           applies_when = CASE WHEN $6 THEN $7 ELSE applies_when END,
           scope = CASE WHEN $8 THEN $9 ELSE scope END,
           paths = CASE WHEN $10 THEN $11::text[] ELSE paths END,
           decided_by_you = decided_by_you OR $17,
           status = coalesce($12, status),
           decided_at = CASE WHEN $12::text IS NULL THEN decided_at ELSE $13 END,
           decided_by = CASE WHEN $12::text IS NULL THEN decided_by ELSE $15 END,
           decision_note = CASE WHEN $12::text IS NULL THEN decision_note ELSE $16::text END,
           embedding = CASE WHEN $14::vector IS NULL THEN embedding ELSE $14::vector END,
           -- New words are checked again at the worker's next round: a flag on the old words (broken-rule) must not stay.
           checks_version = CASE WHEN $2 OR $4 OR $6 OR $8 OR $10 THEN 0 ELSE checks_version END
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
          o.by ?? 'you',
          o.note ? redactSecrets(o.note) : null,
          // Only the owner's decision or edit makes it yours (a memory file's re-import then leaves it); a machine's does not.
          ownerDecided(o.by ?? 'you'),
        ],
      );
      if (!rows[0]) return { unscoped: false };
      // A project named in the patch (narrowing a global lesson) wins over the one it was learned in.
      const origin: string | null = projectKey ?? rows[0].origin ?? null;
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

  async setLessonPaths(id: string, paths: string[]): Promise<boolean> {
    const { rowCount } = await this.q(`UPDATE lessons SET paths = $2::text[] WHERE id = $1 AND status = 'proposed' AND proposed_as IS NULL`, [id, paths]);
    return (rowCount ?? 0) > 0;
  }

  async clearMachineOwnerMarks(): Promise<string[]> {
    const { rows } = await this.q(
      `UPDATE lessons SET decided_by_you = false
       WHERE decided_by_you AND decided_by IS NOT NULL AND NOT ${OWNER_DECIDED_SQL('decided_by')} AND proposed_as IS NULL
       RETURNING id`,
    );
    return rows.map((r) => r.id as string).sort();
  }

  async setLessonChecks(id: string, checks: LessonCheck[], version = LESSON_CHECKS_VERSION): Promise<boolean> {
    const { rowCount } = await this.q('UPDATE lessons SET checks = $2::jsonb, checks_version = $3 WHERE id = $1', [id, toJson(redactDeep(checks)), version]);
    return (rowCount ?? 0) > 0;
  }

  async searchLessons(q: { embedding: number[]; projectKey: string | null; k: number; status?: LessonStatus; projectKeys?: string[]; run?: string | null }): Promise<LessonHit[]> {
    // This project's and the global lessons, nearest first, through the HNSW index when it pays (see vector.ts).
    const rows = await runSearch(this.db, searchLessonsQuery(this.db, q, { sandbox: await sandboxPresence(this.db).any() }), q.k);
    return rows.map((r) => ({ lesson: lessonOf(r), score: r.score }));
  }

  async missesWithoutSubject(q: { limit: number; afterId?: string | null }): Promise<UnsortedMiss[]> {
    return this.missesBySubject(null, q);
  }

  async processMisses(q: { limit: number; afterId?: string | null }): Promise<UnsortedMiss[]> {
    return this.missesBySubject('process', q);
  }

  private async missesBySubject(subject: 'process' | null, q: { limit: number; afterId?: string | null }): Promise<UnsortedMiss[]> {
    const { rows } = await this.q(
      `SELECT m.id, m.project_key, coalesce(t.text, f.text, '') AS text, t.external->>'path' AS comment_path, l.rule, l.paths
       FROM misses m JOIN feedback f ON f.id = m.feedback_id JOIN turns t ON t.uuid = f.turn_uuid
       LEFT JOIN LATERAL (SELECT l.rule, l.paths FROM lessons l WHERE l.miss_id = m.id ORDER BY l.id COLLATE "C" LIMIT 1) l ON true
       WHERE m.subject IS NOT DISTINCT FROM $3::text AND ($2::text IS NULL OR m.id COLLATE "C" > $2)
       ORDER BY m.id COLLATE "C" LIMIT $1`,
      [q.limit, q.afterId ?? null, subject],
    );
    return rows.map((r) => ({ missId: r.id, projectKey: r.project_key, feedbackText: r.text, rule: r.rule ?? null, commentPath: r.comment_path ?? null, paths: r.paths ?? [] }));
  }

  async setMissSubject(missId: string, subject: 'process' | null): Promise<boolean> {
    const { rowCount } = await this.q(
      subject ? 'UPDATE misses SET subject = $2 WHERE id = $1 AND subject IS NULL' : `UPDATE misses SET subject = NULL WHERE id = $1 AND subject = 'process'`,
      subject ? [missId, subject] : [missId],
    );
    return (rowCount ?? 0) > 0;
  }

  async relatedMisses(q: { embedding: number[]; projectKey: string | null; k: number; run?: string | null }): Promise<RelatedMiss[]> {
    const rows = await runSearch(this.db, relatedMissesQuery(this.db, q, { sandbox: await sandboxPresence(this.db).any() }), q.k);
    return rows.map((r) => ({
      missId: r.id,
      missed: r.missed,
      cause: r.cause as Cause,
      feedbackText: r.text ?? undefined,
      sessionId: r.session_id,
      ts: r.ts_text,
      score: r.score,
      rejectedWrongSession: r.wrong_session === true,
    }));
  }

  /** The manual /postmortem path: queued for your decision, or added to the detector's item for the same miss. */
  async createManualFeedback(input: { project: Project; cwd: string; text: string; whatWasDone: string; sessionId?: string | null; run?: RunTag | null }): Promise<string> {
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
    sandboxPresence(this.db).wrote(o.run);
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
        `INSERT INTO candidates (id, turn_uuid, session_id, project_key, ts, status, created_at, manual, agent_report, run, sandbox)
         VALUES ($1, $1, $1, $2, $3, 'pending', $3, true, $4::jsonb, $5, $6)`,
        [id, o.project.key, now, report, o.run?.id ?? null, !!o.run?.sandbox],
      );
    });
    return id;
  }

  async recordPreDoneCheck(c: { projectKey: string; task: string; checkedLessonIds: string[]; gapLessonIds: string[]; status?: string; run?: RunTag | null; sessionId?: string | null }): Promise<void> {
    const id = randomUUID();
    sandboxPresence(this.db).wrote(c.run);
    await tx(this.db, async (x) => {
      await x.query('INSERT INTO predone_checks (id, project_key, ts, task, checked, gaps, run, sandbox, session_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [
        id,
        c.projectKey,
        new Date(),
        redactSecrets(c.task),
        c.checkedLessonIds.length,
        c.gapLessonIds.length,
        c.run?.id ?? null,
        !!c.run?.sandbox,
        c.sessionId ?? null,
        c.status ?? 'lesson_judged',
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

  async redactStoredLessons(): Promise<{ redacted: number; flagged: number }> {
    let redacted = 0;
    let flagged = 0;
    for (let after = ''; ;) {
      const { rows } = await this.q('SELECT id, status, title, rule, applies_when, checks FROM lessons WHERE id > $1 ORDER BY id LIMIT $2', [after, REDACT_PAGE]);
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      const page = rows.flatMap((r: { id: string; status: string; title: string; rule: string; applies_when: string | null; checks: LessonCheck[] | null }) => {
        const x = redactStoredLesson({ status: r.status, title: r.title, rule: r.rule, appliesWhen: r.applies_when, checks: r.checks });
        if (!x) return [];
        if (x.flagged) flagged++;
        if (x.title !== r.title || x.rule !== r.rule || x.appliesWhen !== r.applies_when) redacted++;
        return [{ id: r.id, title: x.title, rule: x.rule, applies_when: x.appliesWhen, checks: x.checks }];
      });
      if (!page.length) continue;
      for (const r of rows) if (page.some(c => c.id === r.id)) await archiveBeforeRedaction('lesson', r.id, r);
      await this.q(
        `UPDATE lessons x SET title = c.title, rule = c.rule, applies_when = c.applies_when, checks = c.checks
         FROM jsonb_to_recordset($1::jsonb) AS c(id text, title text, rule text, applies_when text, checks jsonb) WHERE x.id = c.id`,
        [toJson(page)],
      );
    }
    return { redacted, flagged };
  }

  /** Feedback text, then what each miss missed and why. The words of the turn a miss quotes are the Inbox item's. */
  async redactStoredMisses(): Promise<number> {
    let changed = 0;
    for (const [table, fields] of [['feedback', ['text']], ['misses', ['missed', 'cause_explanation']]] as const) {
      for (let after = ''; ;) {
        const { rows } = await this.q(`SELECT id, ${fields.join(', ')} FROM ${table} WHERE id > $1 ORDER BY id LIMIT $2`, [after, REDACT_PAGE]);
        if (!rows.length) break;
        after = rows[rows.length - 1].id;
        const page = rows.flatMap((r: Record<string, unknown>) => redactStoredRow(r, fields) ?? []);
        if (!page.length) continue;
        await this.q(
          `UPDATE ${table} x SET ${fields.map((f) => `${f} = c.${f}`).join(', ')}
           FROM jsonb_to_recordset($1::jsonb) AS c(id text, ${fields.map((f) => `${f} text`).join(', ')}) WHERE x.id = c.id`,
          [toJson(page)],
        );
        changed += page.length;
      }
    }
    return changed;
  }

  async saveDemoMiss(input: DemoMiss): Promise<string> {
    if (!input.id.startsWith(demoPrefix(input.project.key))) throw new Error(`a demo miss id starts with ${demoPrefix(input.project.key)}`);
    const m = { ...input, feedbackText: redactSecrets(input.feedbackText), whatWasDone: redactSecrets(input.whatWasDone), missed: redactSecrets(input.missed), causeExplanation: redactSecrets(input.causeExplanation) };
    const ts = new Date(m.ts);
    const missId = `miss:${m.id}`;
    sandboxPresence(this.db).wrote(m.run);
    await tx(this.db, async (c) => {
      // A project the demo creates is marked so: removeDemo takes it back once nothing else is stored under it.
      await c.query('INSERT INTO projects (key, name, repo_path, demo_created) VALUES ($1, $2, $3, true) ON CONFLICT (key) DO NOTHING', [m.project.key, m.project.name ?? null, m.project.repoPath ?? null]);
      await c.query(
        `INSERT INTO sessions (id, project_key, source_file, cwd, started_at, ended_at, manual) VALUES ($1, $2, 'demo', $3, $4, $4, true)
         ON CONFLICT (id) DO NOTHING`,
        [m.id, m.project.key, m.project.repoPath ?? null, ts],
      );
      await c.query(
        `INSERT INTO turns (uuid, session_id, project_key, ts, ts_text, idx, text, preceding_assistant_text, tool_calls, label, confidence, summary, signals)
         VALUES ($1, $1, $2, $3, $4, 1, $5, $6, '[]', 'pushback', 1.0, $5, ARRAY['demo'])
         ON CONFLICT (uuid) DO UPDATE SET text = EXCLUDED.text, preceding_assistant_text = EXCLUDED.preceding_assistant_text, summary = EXCLUDED.summary`,
        [m.id, m.project.key, ts, ts.toISOString(), m.feedbackText, m.whatWasDone],
      );
      await c.query(
        `INSERT INTO candidates (id, turn_uuid, session_id, project_key, ts, status, created_at, decided_at, decided_by, manual, run, sandbox)
         VALUES ($1, $1, $1, $2, $3, 'confirmed', $3, $3, 'demo', true, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [m.id, m.project.key, ts, m.run?.id ?? null, !!m.run?.sandbox],
      );
      await c.query(
        `INSERT INTO feedback (id, project_key, turn_uuid, status, text, created_at) VALUES ($1, $2, $1, 'addressed', $3, $4)
         ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text`,
        [m.id, m.project.key, m.feedbackText, ts],
      );
      await c.query('INSERT INTO causes (key) VALUES ($1) ON CONFLICT DO NOTHING', [m.cause]);
      await c.query(
        `INSERT INTO misses (id, project_key, feedback_id, missed, cause, cause_explanation, outcome, created_at, embedding, run, sandbox)
         VALUES ($1, $2, $3, $4, $5, $6, 'addressed', $7, $8::vector, $9, $10)
         ON CONFLICT (id) DO UPDATE SET missed = EXCLUDED.missed, cause = EXCLUDED.cause, cause_explanation = EXCLUDED.cause_explanation,
           embedding = EXCLUDED.embedding`,
        [missId, m.project.key, m.id, m.missed, m.cause, m.causeExplanation, ts, vectorOf(m.embedding), m.run?.id ?? null, !!m.run?.sandbox],
      );
    });
    return missId;
  }

  async removeDemo(projectKey: string, run: RunTag | null = null): Promise<DemoRemoved> {
    const like = `${(demoPrefix(projectKey) + (run ? `run:${run.id}:` : "")).replace(/[\\%_]/g, '\\$&')}%`;
    return tx(this.db, async (c) => {
      const misses = await c.query(
        `SELECT count(*)::int AS n FROM misses m JOIN feedback f ON f.id = m.feedback_id JOIN turns t ON t.uuid = f.turn_uuid
         WHERE t.session_id LIKE $1 AND m.project_key = $2`,
        [like, projectKey],
      );
      // Turns, Inbox items, feedback, misses, tasks and touched files all hang off the session (ON DELETE CASCADE).
      await c.query('DELETE FROM sessions WHERE id LIKE $1 AND project_key = $2 AND manual', [like, projectKey]);
      const lessons = await c.query(`DELETE FROM lessons WHERE source = 'demo' AND (project_key = $1 OR (project_key IS NULL AND origin_project_key = $1)) AND ($2::text IS NULL OR run = $2)`, [projectKey, run?.id ?? null]);
      const facts = await c.query(`DELETE FROM facts WHERE project_key = $1 AND source = 'demo' AND ($2::text IS NULL OR run = $2)`, [projectKey, run?.id ?? null]);
      // The file rows the demo added (hash DEMO_SOURCE: a scan that read the file since gave it a real one): unscanned
      // again, and gone unless the code map or other facts hold them.
      const added = await c.query(
        `UPDATE code_files SET hash = NULL, summary = NULL, scanned_at = NULL, scan_version = NULL, hash_changed_at = NULL
         WHERE project_key = $1 AND hash = $2 AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.code_file_id = code_files.id AND f.current) RETURNING id`,
        [projectKey, DEMO_SOURCE],
      );
      if (added.rows.length) {
        await c.query(
          `DELETE FROM code_files cf WHERE cf.id = ANY($1::text[]) AND NOT cf.in_map AND NOT cf.in_index
             AND NOT EXISTS (SELECT 1 FROM facts x WHERE x.code_file_id = cf.id)`,
          [added.rows.map((r) => r.id)],
        );
      }
      // The project, when the seed created it (saveDemoMiss) and nothing at all is stored under its key now: every
      // table with a project key column, read from the schema so a table added later counts too (keyedColumns).
      const keyed = await keyedColumns(c);
      const project = await c.query(
        `DELETE FROM projects p WHERE p.key = $1 AND p.demo_created AND NOT p.pinned AND p.aliases = '{}'
           AND NOT EXISTS (SELECT 1 FROM project_links WHERE a = $1 OR b = $1)
           AND NOT EXISTS (SELECT 1 FROM project_selection WHERE $1 = ANY(tracked))
           ${keyed.map(({ table, column }) => `AND NOT EXISTS (SELECT 1 FROM ${table} WHERE ${column} = $1)`).join('\n           ')}`,
        [projectKey],
      );
      return { lessons: lessons.rowCount ?? 0, misses: misses.rows[0].n, facts: facts.rowCount ?? 0, projectRemoved: (project.rowCount ?? 0) > 0 };
    });
  }

  async upsertLesson(input: LessonInput): Promise<void> {
    const l = redactDeep(input);
    await archiveRedactionInput('lesson', input.id, input, l);
    const now = new Date();
    sandboxPresence(this.db).wrote(input.run);
    await tx(this.db, async (c) => {
      // Once you have decided on or edited a lesson, re-importing its file never overrides you.
      await c.query(
        `INSERT INTO lessons (id, created_at, status, decided_at, source, project_key, origin_project_key,
                              title, rule, applies_when, scope, paths, embedding, run, sandbox, checks)
         VALUES ($1, $2::timestamptz, $3::text, CASE WHEN $3::text = 'proposed' THEN NULL ELSE $2::timestamptz END, $4, $5, $5, $6, $7, $8, $9, $10, $11::vector, $12, $13, $14::jsonb)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, rule = EXCLUDED.rule, applies_when = EXCLUDED.applies_when,
           scope = EXCLUDED.scope, paths = EXCLUDED.paths, embedding = EXCLUDED.embedding, checks = coalesce(EXCLUDED.checks, lessons.checks)
         WHERE NOT lessons.decided_by_you`,
        [l.id, now, l.status, l.source, l.projectKey ?? null, l.title, l.rule, l.appliesWhen ?? null, l.scope, l.paths ?? [], vectorOf(l.embedding), input.run?.id ?? null, !!input.run?.sandbox, l.checks == null ? null : toJson(l.checks)],
      );
      if (l.projectKey != null) await c.query('INSERT INTO projects (key) VALUES ($1) ON CONFLICT DO NOTHING', [l.projectKey]);
    });
  }
}

/**
 * Every column that names a project by its key (project_key, origin_project_key), in every table of the schema:
 * removeDemo keeps a project any row holds. Activity is the log, not data under the key (the seed itself logs there).
 */
/** Tables that must be among the project-keyed ones: if the schema read misses any, removeDemo refuses rather than delete. */
const KEYED_AT_LEAST = ['sessions', 'candidates', 'misses', 'lessons', 'facts', 'code_files', 'scan_jobs', 'docs', 'predone_checks', 'chat_conversations'];

async function keyedColumns(c: pg.PoolClient): Promise<{ table: string; column: string }[]> {
  // Quoted by the server; and only plain names are ever used, so the guard never runs a name it did not expect.
  const { rows } = await c.query<{ name: string; table: string; column: string }>(
    `SELECT table_name AS name, quote_ident(table_name) AS table, quote_ident(column_name) AS column FROM information_schema.columns
     WHERE table_schema = current_schema() AND column_name IN ('project_key', 'origin_project_key') AND table_name NOT IN ('projects', 'activity')
     ORDER BY table_name, column_name`,
  );
  const names = new Set(rows.map((r) => r.name));
  const missing = KEYED_AT_LEAST.filter((t) => !names.has(t));
  if (missing.length || rows.some((r) => !/^[a-z_][a-z0-9_]*$/.test(r.name))) {
    throw new Error(`the demo project was kept: the schema read did not list ${missing.join(', ') || 'only plain table names'}`);
  }
  return rows.map(({ table, column }) => ({ table, column }));
}

/** The lesson's feedback turn (`t`), for Lesson.from; none for memory and manual lessons. */
const FEEDBACK_TURN = 'LEFT JOIN (misses m JOIN feedback f ON f.id = m.feedback_id JOIN turns t ON t.uuid = f.turn_uuid) ON m.id = l.miss_id';
/** Lesson.from, for lessons `l` and their feedback turn `t`. */
const FROM = `(CASE WHEN l.source IN ('memory', 'manual', 'demo') THEN l.source WHEN t.external IS NULL THEN 'session'
  WHEN t.external->>'source' = 'linear' THEN 'linear' ELSE 'github' END)`;

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
    decidedBy: r.decided_by ?? null,
    decisionNote: r.decision_note ?? null,
    checks: (r.checks as LessonCheck[] | null) ?? null,
    checksVersion: r.checks_version ?? null,
    ...(r.from_kind && { from: r.from_kind as LessonFrom }),
    ...(r.run ? { run: r.run as string } : {}),
    ...(r.sandbox === true && { sandbox: true as const }),
    ...(r.proposed_as && { proposedAs: r.proposed_as as LessonDraft }),
  };
}
