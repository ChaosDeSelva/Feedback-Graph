import { EXPORT_FORMAT, VERSION, type Cause, type ExportBundle, type Lesson, type PortabilityStore } from '@fb/core';
import type pg from 'pg';
import { PgCodeGraphStore } from './codegraph.ts';
import { iso, tx, type Db } from './db.ts';

/*
 * Ordering: Neo4j compares strings by code point, so every text ORDER BY here uses COLLATE "C" (byte order of UTF-8,
 * which is code-point order) rather than the database's locale collation.
 */

/**
 * deleteProject, child tables first, so each row is deleted (and counted) by its own statement rather than vanishing
 * through an ON DELETE CASCADE: the count then equals the nodes Neo4j's DETACH DELETEs remove. $1 is the project key.
 * Commits and sessions are matched through this project's sessions, as Neo4j matches them through (:Session)-[:IN].
 */
const DELETES: string[] = [
  `DELETE FROM chat_turns WHERE project_key = $1`,
  `DELETE FROM chat_conversations WHERE project_key = $1`,
  `DELETE FROM lessons WHERE project_key = $1 OR origin_project_key = $1`,
  `DELETE FROM activity WHERE project_key = $1`,
  `DELETE FROM predone_checks WHERE project_key = $1`,
  `DELETE FROM chunks WHERE project_key = $1`,
  `DELETE FROM facts WHERE project_key = $1 AND doc_id IS NOT NULL`,
  `DELETE FROM doc_blobs WHERE project_key = $1`,
  `DELETE FROM docs WHERE project_key = $1`,
  `DELETE FROM facts WHERE project_key = $1`,
  `DELETE FROM code_tests WHERE project_key = $1`,
  `DELETE FROM code_imports WHERE project_key = $1`,
  `DELETE FROM code_symbols WHERE project_key = $1`,
  `DELETE FROM code_maps WHERE project_key = $1`,
  `DELETE FROM code_files WHERE project_key = $1`,
  `DELETE FROM scan_jobs WHERE project_key = $1`,
  `DELETE FROM context_items WHERE project_key = $1`,
  `DELETE FROM misses WHERE project_key = $1`,
  `DELETE FROM candidates WHERE project_key = $1`,
  `DELETE FROM feedback WHERE project_key = $1`,
  `DELETE FROM tasks WHERE project_key = $1`,
  `DELETE FROM turns WHERE session_id IN (SELECT id FROM sessions WHERE project_key = $1)`,
  // Commits only this project's sessions saw; a commit another project's session also saw stays.
  `DELETE FROM commits c
   WHERE EXISTS (SELECT 1 FROM session_commits sc JOIN sessions s ON s.id = sc.session_id WHERE sc.sha = c.sha AND s.project_key = $1)
     AND NOT EXISTS (SELECT 1 FROM session_commits sc JOIN sessions s ON s.id = sc.session_id WHERE sc.sha = c.sha AND s.project_key <> $1)`,
  `DELETE FROM session_files WHERE project_key = $1`,
  `DELETE FROM sessions WHERE project_key = $1`,
  `DELETE FROM sync_cursors WHERE right(key, length($1) + 1) = ':' || $1`,
  `DELETE FROM project_links WHERE a = $1 OR b = $1`,
  `DELETE FROM projects WHERE key = $1`,
];

/** Export of derived knowledge, and deleting a project with everything learned from it. */
export class PgPortabilityStore implements PortabilityStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async exportData(o: { projectKey?: string; projectKeys?: string[]; approvedOnly?: boolean } = {}): Promise<ExportBundle> {
    const key = o.projectKey ?? null;
    // null: no list to apply (one project by key, or everything).
    const keys = key === null && o.projectKeys ? o.projectKeys : null;
    const approvedOnly = !!o.approvedOnly;
    // One snapshot for the whole bundle, so a write landing mid-export cannot leave it half old, half new.
    const [projects, lessons, misses, facts, docs] = await tx(this.db, async (c: pg.PoolClient) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const q = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows;
      return [
        await q(`SELECT key, remote FROM projects WHERE ($1::text IS NULL OR key = $1) AND ($2::text[] IS NULL OR key = ANY($2)) ORDER BY key COLLATE "C"`, [key, keys]),
        await q(
          `SELECT id, project_key, title, rule, applies_when, scope, paths, status, source, cause, miss_id, created_at, decided_at, checks
           FROM lessons
           WHERE ($1::text IS NULL OR project_key = $1 OR (project_key IS NULL AND origin_project_key = $1))
             AND ($3::text[] IS NULL OR coalesce(project_key, origin_project_key) IS NULL OR coalesce(project_key, origin_project_key) = ANY($3))
             AND (NOT $2 OR status = 'approved') AND NOT sandbox AND source <> 'demo'
           ORDER BY created_at, id COLLATE "C"`,
          [key, approvedOnly, keys],
        ),
        await q(
          `SELECT m.id, m.project_key, m.missed, m.cause, m.cause_explanation, f.text AS feedback_text, f.created_at AS ts,
                  coalesce((SELECT json_agg(json_build_object('kind', ci.kind, 'ref', ci.ref, 'excerpt', ci.excerpt, 'why', w.why)
                                             ORDER BY ci.ref COLLATE "C", ci.id COLLATE "C")
                            FROM context_item_misses w JOIN context_items ci ON ci.id = w.context_item_id
                            WHERE w.miss_id = m.id), '[]'::json) AS items
           FROM misses m JOIN feedback f ON f.id = m.feedback_id
           WHERE ($1::text IS NULL OR m.project_key = $1) AND ($2::text[] IS NULL OR m.project_key = ANY($2)) AND NOT m.sandbox
             AND m.id NOT LIKE 'miss:demo:%'
           ORDER BY f.created_at, m.id COLLATE "C"`,
          [key, keys],
        ),
        await q(
          `SELECT path, lines, kind, statement, why, confidence, source, created_at, project_key
           FROM facts WHERE current AND doc_id IS NULL AND ($1::text IS NULL OR project_key = $1) AND ($2::text[] IS NULL OR project_key = ANY($2)) AND NOT sandbox
             AND source IS DISTINCT FROM 'demo'
           ORDER BY project_key COLLATE "C", path COLLATE "C", statement COLLATE "C", id COLLATE "C"`,
          [key, keys],
        ),
        await q(
          `SELECT id, project_key, source, ref, title, url FROM docs WHERE ($1::text IS NULL OR project_key = $1) AND ($2::text[] IS NULL OR project_key = ANY($2)) AND NOT sandbox
           ORDER BY project_key COLLATE "C", id COLLATE "C"`,
          [key, keys],
        ),
      ];
    });
    const codegraph = new PgCodeGraphStore(this.db);
    const codeFiles = (await Promise.all(projects.map((r) => codegraph.exportFiles(r.key as string)))).flat();
    return {
      format: EXPORT_FORMAT,
      schemaVersion: 1,
      toolVersion: VERSION,
      exportedAt: new Date().toISOString(),
      projectKey: key,
      projects: projects.map((r) => ({ key: r.key as string, remote: (r.remote as string) ?? null })),
      lessons: lessons.map(
        (l): Lesson => ({
          id: l.id,
          projectKey: l.project_key ?? null,
          title: l.title,
          rule: l.rule,
          appliesWhen: l.applies_when ?? '',
          scope: l.scope,
          paths: l.paths ?? [],
          status: l.status,
          source: l.source,
          cause: (l.cause as Cause) ?? null,
          missId: l.miss_id ?? null,
          createdAt: iso(l.created_at) as string,
          decidedAt: iso(l.decided_at),
          ...(l.checks != null && { checks: l.checks }),
        }),
      ),
      misses: misses.map((m) => ({
        id: m.id,
        projectKey: m.project_key,
        missed: m.missed,
        cause: m.cause as Cause,
        causeExplanation: m.cause_explanation ?? '',
        feedbackText: m.feedback_text ?? '',
        ts: iso(m.ts) ?? '',
        contextItems: m.items as ExportBundle['misses'][number]['contextItems'],
      })),
      facts: facts.map((f) => ({
        path: f.path,
        lines: f.lines ?? null,
        kind: f.kind,
        statement: f.statement,
        why: f.why ?? '',
        confidence: f.confidence,
        source: f.source,
        createdAt: iso(f.created_at) as string,
        projectKey: f.project_key,
      })),
      docs: docs.map((d) => ({ id: d.id, projectKey: d.project_key, source: d.source, ref: d.ref, title: d.title, url: d.url ?? null })),
      codeFiles,
    };
  }

  /** Remove a project and everything learned from it, in one transaction. Returns how many records were deleted. */
  async deleteProject(key: string): Promise<number> {
    return tx(this.db, async (c) => {
      let removed = 0;
      for (const sql of DELETES) removed += (await c.query(sql, [key])).rowCount ?? 0;
      return removed;
    });
  }
}
