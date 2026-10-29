import { LegacyRunClaimError, runClaimExecutor, removedCounts, runItems, runRemoval, type RunItem, type RunItemKind, type RunOwner, type RunPrincipal, type RunRow, type RunsStore } from '@fb/core';
import { iso, tx, type Db } from './db.ts';
import { sandboxPresence } from './vector.ts';

/** Each kind's records with a run id, as RunRow columns. A document's facts go with it: only facts written on their own. */
const ITEMS = `
  SELECT 'feedback' AS kind, id, project_key, sandbox, detected AS merged FROM candidates WHERE run = $1
  UNION ALL SELECT 'lesson', id, coalesce(project_key, origin_project_key), sandbox, false FROM lessons WHERE run = $1
  UNION ALL SELECT 'miss', id, project_key, sandbox, false FROM misses WHERE run = $1
  UNION ALL SELECT 'predone_check', id, project_key, false, false FROM predone_checks WHERE run = $1
  UNION ALL SELECT 'fact', id, project_key, sandbox, false FROM facts WHERE run = $1 AND doc_id IS NULL
  UNION ALL SELECT 'doc', id, project_key, sandbox, false FROM docs WHERE run = $1
  UNION ALL SELECT 'link', id, a, sandbox, false FROM project_links WHERE run = $1
  UNION ALL SELECT 'chat', id, project_key, false, false FROM chat_conversations WHERE run = $1`;

/** What runs wrote (see RunsStore); the Neo4j twin is core's graph/runs.ts. */
export async function claimRunOwnerWith(query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>, run: string, principal: RunPrincipal, actor: string | null): Promise<RunOwner> {
  const legacy = ['candidates', 'lessons', 'misses', 'facts', 'docs', 'chunks', 'project_links', 'predone_checks', 'chat_conversations', 'activity', 'sessions', 'session_run_tags', 'feedback'].map(table => `EXISTS (SELECT 1 FROM ${table} WHERE run = $1)`).join(' OR ');
  await query(`INSERT INTO run_owners (run, principal, actor, first_seen) SELECT $1, $2, $3, $4 WHERE NOT (${legacy}) ON CONFLICT (run) DO NOTHING`, [run, principal, principal === 'operator' ? actor : null, new Date()]);
  const { rows } = await query('SELECT run, principal, actor, first_seen FROM run_owners WHERE run = $1', [run]);
  if (!rows[0]) throw new LegacyRunClaimError(run);
  return { run: rows[0].run, principal: rows[0].principal, actor: rows[0].actor ?? null, firstSeen: iso(rows[0].first_seen)! };
}

export class PgRunsStore implements RunsStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async sandbox(run: string): Promise<boolean> {
    const { rows } = await this.db.pool.query(
      `SELECT EXISTS (SELECT 1 FROM session_run_tags WHERE run = $1 AND sandbox) OR
              EXISTS (SELECT 1 FROM sessions WHERE run = $1 AND sandbox) OR
              EXISTS (SELECT 1 FROM activity WHERE run = $1 AND sandbox) AS sandbox`, [run]);
    return rows[0]?.sandbox === true || (await this.items(run)).some(x => x.sandbox);
  }

  async items(run: string): Promise<RunItem[]> {
    const { rows } = await this.db.pool.query(ITEMS, [run]);
    return runItems(rows.map((r): RunRow => ({ kind: r.kind, id: r.id, projectKey: r.project_key ?? null, sandbox: r.sandbox === true, merged: r.merged === true })));
  }

  async remove(run: string, keep: string[]): Promise<Record<RunItemKind, number>> {
    const ids = runRemoval(await this.items(run), keep);
    // The run's sandbox records may have been the last ones: the searches may skip the run filter again.
    const removed = await tx(this.db, async (c) => {
      // Each only while it still carries the run's id (an upload the owner replaced since is not the run's any more).
      const del = async (sql: string, list: string[]) => (list.length ? ((await c.query(sql, [run, list])).rowCount ?? 0) : 0);
      const lesson = await del('DELETE FROM lessons WHERE run = $1 AND id = ANY($2::text[])', ids.lesson);
      // Context items are the post-mortem's own (their ids come from the feedback id): they go with the miss.
      await del(
        `DELETE FROM context_items WHERE id IN (SELECT w.context_item_id FROM context_item_misses w JOIN misses m ON m.id = w.miss_id
                                                WHERE m.run = $1 AND m.id = ANY($2::text[]))`,
        ids.miss,
      );
      const miss = await del('DELETE FROM misses WHERE run = $1 AND id = ANY($2::text[])', ids.miss);
      // A report: its Inbox item, its feedback, and its stand-in session (turns and task go with it). Never a merged one,
      // whose turn is a real session's.
      const reports = ids.feedback.length
        ? (await c.query('DELETE FROM candidates WHERE run = $1 AND id = ANY($2::text[]) AND NOT detected RETURNING id', [run, ids.feedback])).rows.map((r) => r.id as string)
        : [];
      if (reports.length) {
        await c.query('DELETE FROM feedback WHERE id = ANY($1::text[])', [reports]);
        await c.query('DELETE FROM sessions WHERE id = ANY($1::text[]) AND manual', [reports]);
      }
      const predone = await del('DELETE FROM predone_checks WHERE run = $1 AND id = ANY($2::text[])', ids.predone_check);
      const fact = await del('DELETE FROM facts WHERE run = $1 AND doc_id IS NULL AND id = ANY($2::text[])', ids.fact);
      // Chunks, blobs and the facts read from it go with the document (ON DELETE CASCADE).
      const doc = await del('DELETE FROM docs WHERE run = $1 AND id = ANY($2::text[])', ids.doc);
      const link = await del('DELETE FROM project_links WHERE run = $1 AND id = ANY($2::text[])', ids.link);
      const chat = await del('DELETE FROM chat_conversations WHERE run = $1 AND id = ANY($2::text[])', ids.chat);
      return removedCounts({ feedback: reports.length, lesson, miss, predone_check: predone, fact, doc, link, chat });
    });
    sandboxPresence(this.db).recheck();
    return removed;
  }

  async claim(run: string, principal: RunPrincipal, actor: string | null = null): Promise<RunOwner> {
    const executor = runClaimExecutor(this.db);
    return executor ? executor(run, principal, actor) : claimRunOwnerWith(this.db.pool.query.bind(this.db.pool), run, principal, actor);
  }

  async owner(run: string): Promise<RunOwner | null> {
    const { rows } = await this.db.pool.query('SELECT run, principal, actor, first_seen FROM run_owners WHERE run = $1', [run]);
    return rows[0] ? { run: rows[0].run, principal: rows[0].principal, actor: rows[0].actor ?? null, firstSeen: iso(rows[0].first_seen)! } : null;
  }
}
