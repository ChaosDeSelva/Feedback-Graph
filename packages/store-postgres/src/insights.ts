import {
  evidenceNode, patternReport, REPEAT_SIMILARITY, REPEAT_WINDOW,
  type Cause, type EvidenceGraph, type GraphLink, type GraphNode, type GraphNodeKind, type InsightsStore, type PatternReport,
} from '@fb/core';
import { fromVector, type Db } from './db.ts';

type LinkRow = { type: string; a_kind: GraphNodeKind; a: Record<string, unknown>; b_kind: GraphNodeKind; b: Record<string, unknown> };

/**
 * Evidence graph and pattern views. The nodes carry the same fields as the Neo4j nodes evidenceNode() reads:
 * feedback {id, text, status}, miss {id, missed}, cause {key}, lesson {id, title, status}, context {id, kind, ref},
 * task {id, title}, commit {sha, subject}.
 */
export class PgInsightsStore implements InsightsStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** Evidence chains for the most recent misses in a project: feedback, miss, cause, lesson, context, task, fix commits. */
  async projectGraph(projectKey: string, limit = 150): Promise<EvidenceGraph> {
    const { rows } = await this.db.pool.query<LinkRow>(
      `WITH chosen AS (
         SELECT m.id AS miss_id, m.missed, m.cause, f.id AS feedback_id, f.text, f.status, f.task_id,
                row_number() OVER (ORDER BY m.created_at DESC, m.id) AS rank
           FROM misses m JOIN feedback f ON f.id = m.feedback_id
          WHERE m.project_key = $1 AND NOT m.sandbox
          ORDER BY m.created_at DESC, m.id
          LIMIT $2
       ),
       links AS (
         SELECT c.rank, 1 AS branch, '' AS other, 'EXPLAINS' AS type,
                'miss' AS a_kind, jsonb_build_object('id', c.miss_id, 'missed', c.missed) AS a,
                'feedback' AS b_kind, jsonb_build_object('id', c.feedback_id, 'text', c.text, 'status', c.status) AS b
           FROM chosen c
         UNION ALL
         SELECT c.rank, 2, x.key, 'CAUSED_BY',
                'miss', jsonb_build_object('id', c.miss_id, 'missed', c.missed),
                'cause', jsonb_build_object('key', x.key)
           FROM chosen c JOIN causes x ON x.key = c.cause
         UNION ALL
         SELECT c.rank, 3, l.id, 'DERIVED_FROM',
                'lesson', jsonb_build_object('id', l.id, 'title', l.title, 'status', l.status),
                'miss', jsonb_build_object('id', c.miss_id, 'missed', c.missed)
           FROM chosen c JOIN lessons l ON l.miss_id = c.miss_id AND NOT l.sandbox
         UNION ALL
         SELECT c.rank, 4, ci.id, 'WOULD_HAVE_PREVENTED',
                'context', jsonb_build_object('id', ci.id, 'kind', ci.kind, 'ref', ci.ref),
                'miss', jsonb_build_object('id', c.miss_id, 'missed', c.missed)
           FROM chosen c JOIN context_item_misses w ON w.miss_id = c.miss_id JOIN context_items ci ON ci.id = w.context_item_id
         UNION ALL
         SELECT c.rank, 5, t.id, 'CRITICIZES',
                'feedback', jsonb_build_object('id', c.feedback_id, 'text', c.text, 'status', c.status),
                'task', jsonb_build_object('id', t.id, 'title', t.title)
           FROM chosen c JOIN tasks t ON t.id = c.task_id
         UNION ALL
         SELECT c.rank, 6, k.sha, 'ADDRESSES',
                'commit', jsonb_build_object('sha', k.sha, 'subject', k.subject),
                'feedback', jsonb_build_object('id', c.feedback_id, 'text', c.text, 'status', c.status)
           FROM chosen c JOIN commit_feedback cf ON cf.feedback_id = c.feedback_id JOIN commits k ON k.sha = cf.sha
       )
       SELECT type, a_kind, a, b_kind, b FROM links ORDER BY rank, branch, other COLLATE "C"`,
      [projectKey, limit],
    );
    const nodes = new Map<string, GraphNode>();
    const links: GraphLink[] = [];
    for (const r of rows) {
      const a = evidenceNode(r.a_kind, r.a);
      const b = evidenceNode(r.b_kind, r.b);
      nodes.set(a.id, a);
      nodes.set(b.id, b);
      links.push({ source: a.id, target: b.id, type: r.type });
    }
    return { nodes: [...nodes.values()], links };
  }

  async patterns(q: { projectKey?: string; projectKeys?: string[]; threshold?: number }): Promise<PatternReport> {
    const projectKey = q.projectKey ?? null;
    const projectKeys = q.projectKeys ?? null;
    const pool = this.db.pool;
    const [causeRows, missRows, feedbackRows, preRows] = await Promise.all([
      pool.query<{ cause: Cause; count: number }>(
        `SELECT cause, count(*) AS count FROM misses WHERE ($1::text IS NULL OR project_key = $1) AND ($2::text[] IS NULL OR project_key = ANY($2)) AND NOT sandbox
          GROUP BY cause ORDER BY count DESC, cause COLLATE "C"`,
        [projectKey, projectKeys],
      ),
      pool.query<{ missed: string; cause: Cause; project_key: string; embedding: string; ts: string }>(
        // Repeat detection compares every pair, so only the most recent misses are loaded, then oldest first.
        `SELECT missed, cause, project_key, embedding, ts FROM (
           SELECT m.id, m.missed, m.cause, m.project_key, m.embedding::text AS embedding, t.ts_text AS ts, t.ts AS at
             FROM misses m JOIN feedback f ON f.id = m.feedback_id JOIN turns t ON t.uuid = f.turn_uuid
            WHERE ($1::text IS NULL OR m.project_key = $1) AND ($3::text[] IS NULL OR m.project_key = ANY($3)) AND m.embedding IS NOT NULL AND NOT m.sandbox
            ORDER BY t.ts DESC, m.id DESC
            LIMIT $2
         ) recent
         ORDER BY at, id`,
        [projectKey, REPEAT_WINDOW, projectKeys],
      ),
      pool.query<{ ts: string }>(
        `SELECT t.ts_text AS ts FROM feedback f JOIN turns t ON t.uuid = f.turn_uuid
          WHERE ($1::text IS NULL OR f.project_key = $1) AND ($2::text[] IS NULL OR f.project_key = ANY($2))
            AND NOT EXISTS (SELECT 1 FROM candidates k WHERE k.id = f.id AND k.sandbox)`,
        [projectKey, projectKeys],
      ),
      pool.query<{ checks: number; with_gaps: number; gaps_found: number }>(
        `SELECT count(*) AS checks, coalesce(sum(CASE WHEN gaps > 0 THEN 1 ELSE 0 END), 0) AS with_gaps,
                coalesce(sum(gaps), 0) AS gaps_found
           FROM predone_checks WHERE ($1::text IS NULL OR project_key = $1) AND ($2::text[] IS NULL OR project_key = ANY($2)) AND NOT sandbox`,
        [projectKey, projectKeys],
      ),
    ]);
    const pre = preRows.rows[0];

    return patternReport(
      {
        causes: causeRows.rows.map((r) => ({ cause: r.cause, count: r.count })),
        misses: missRows.rows.map((r) => ({
          missed: r.missed, cause: r.cause, projectKey: r.project_key, embedding: fromVector(r.embedding)!, ts: r.ts,
        })),
        feedbackTs: feedbackRows.rows.map((r) => r.ts),
        preDone: { checks: pre.checks, withGaps: pre.with_gaps, gapsFound: pre.gaps_found },
      },
      q.threshold ?? REPEAT_SIMILARITY,
    );
  }
}
