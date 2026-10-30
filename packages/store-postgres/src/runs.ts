import { archiveRunFileSelector, purgeRedactionOriginals } from '@fb/core';
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
    const tables = ['session_run_tags', 'sessions', 'activity', 'candidates', 'lessons', 'misses', 'facts', 'docs', 'project_links'];
    const { rows } = await this.db.pool.query(`SELECT ${tables.map(table => `EXISTS (SELECT 1 FROM ${table} WHERE run = $1 AND sandbox)`).join(' OR ')} AS sandbox`, [run]);
    return rows[0]?.sandbox === true;
  }

  async items(run: string): Promise<RunItem[]> {
    const { rows } = await this.db.pool.query(ITEMS, [run]);
    return runItems(rows.map((r): RunRow => ({ kind: r.kind, id: r.id, projectKey: r.project_key ?? null, sandbox: r.sandbox === true, merged: r.merged === true })));
  }

  async remove(run: string, keep: string[]): Promise<Record<RunItemKind, number>> {
    const ids = runRemoval(await this.items(run), keep);
    const { rows: files } = await this.db.pool.query('SELECT DISTINCT project_key, path FROM facts WHERE run = $1 AND id = ANY($2::text[])', [run, ids.fact]);
    // The run's sandbox records may have been the last ones: the searches may skip the run filter again.
    const actual: { kind: string; id: string }[] = [];
    const removed = await tx(this.db, async (c) => {
      // Each only while it still carries the run's id (an upload the owner replaced since is not the run's any more).
      const del = async (sql: string, list: string[]) => {
        if (!list.length) return 0;
        const table = /^DELETE FROM (\w+)/.exec(sql)?.[1] ?? '';
        const kind = ({ lessons: 'lesson', misses: 'miss', predone_checks: 'predone_check', facts: 'fact', docs: 'doc', project_links: 'link', chat_conversations: 'chat' } as Record<string, string>)[table];
        const result = await c.query(`${sql} RETURNING id`, [run, list]);
        if (kind) actual.push(...result.rows.map(row => ({ kind, id: String(row.id) })));
        return result.rowCount ?? 0;
      };
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
      actual.push(...reports.map(id => ({ kind: 'feedback', id })));
      if (reports.length) {
        await c.query('DELETE FROM feedback WHERE id = ANY($1::text[])', [reports]);
        await c.query('DELETE FROM sessions WHERE id = ANY($1::text[]) AND manual', [reports]);
      }
      const predone = await del('DELETE FROM predone_checks WHERE run = $1 AND id = ANY($2::text[])', ids.predone_check);
      const fact = await del('DELETE FROM facts WHERE run = $1 AND doc_id IS NULL AND id = ANY($2::text[])', ids.fact);
      // Chunks, blobs and the facts read from it go with the document (ON DELETE CASCADE).
      const { rows: childRows } = await c.query(`SELECT d.id AS doc, 'chunk' AS kind, x.id FROM docs d JOIN chunks x ON x.doc_id = d.id WHERE d.run = $1 AND d.id = ANY($2::text[])
        UNION ALL SELECT d.id, 'fact', x.id FROM docs d JOIN facts x ON x.doc_id = d.id WHERE d.run = $1 AND d.id = ANY($2::text[])`, [run, ids.doc]);
      const doc = await del('DELETE FROM docs WHERE run = $1 AND id = ANY($2::text[])', ids.doc);
      const actualDocs = new Set(actual.filter(row => row.kind === 'doc').map(row => row.id));
      actual.push(...childRows.filter(row => actualDocs.has(row.doc)).map(row => ({ kind: String(row.kind), id: String(row.id) })));
      const link = await del('DELETE FROM project_links WHERE run = $1 AND id = ANY($2::text[])', ids.link);
      const chat = await del('DELETE FROM chat_conversations WHERE run = $1 AND id = ANY($2::text[])', ids.chat);
      return removedCounts({ feedback: reports.length, lesson, miss, predone_check: predone, fact, doc, link, chat });
    });
    const fileSelectors: { kind: string; id: string }[] = [];
    for (const file of files) {
      const { rows } = await this.db.pool.query('SELECT count(*)::int AS n FROM facts WHERE run = $1 AND project_key = $2 AND path = $3', [run, file.project_key, file.path]);
      if (rows[0].n === 0) fileSelectors.push(archiveRunFileSelector(run, file.project_key, file.path));
    }
    await purgeRedactionOriginals([...fileSelectors, ...actual]);
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
