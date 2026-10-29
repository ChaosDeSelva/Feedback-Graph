import { randomUUID } from 'node:crypto';
import { REDACT_PAGE, redactDeep, redactStoredRow, type Activity, type ActivityInput, type ActivityKind, type ActivityQuery, type ActivityStore, prepareActivity } from '@fb/core';
import { iso, toJson, type Db } from './db.ts';

type Row = {
  id: string; ts: Date; kind: ActivityKind; actor: string; project_key: string | null;
  subject: string; why: string; details: Record<string, unknown> | null; targets: string[] | null; run: string | null; sandbox: boolean | null;
};

const activityOf = (r: Row): Activity => ({
  id: r.id, ts: iso(r.ts)!, kind: r.kind, actor: r.actor, projectKey: r.project_key ?? null,
  subject: r.subject, why: r.why, details: r.details ?? {}, targets: r.targets ?? [],
  ...(r.run ? { run: r.run } : {}), ...(r.sandbox === true && { sandbox: true as const }),
});

/**
 * The append-only provenance log (cleaning up a test run removes the entries made in it: removeRun). `seq` (an
 * identity column) orders it, as Neo4j's per-process monotonic `order` does; list() is newest first.
 */
export class PgActivityStore implements ActivityStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async record(input: ActivityInput): Promise<void> {
    const a = prepareActivity(input); // redacted, then cut
    await this.db.pool.query(
      `INSERT INTO activity (id, ts, kind, actor, project_key, subject, why, details, targets, run, sandbox)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::text[], $10, $11)`,
      [
        `act:${randomUUID()}`,
        new Date(), // the application's clock, as Neo4j's new Date().toISOString()
        a.kind,
        a.actor,
        a.projectKey ?? null,
        a.subject,
        a.why,
        toJson(redactDeep(a.details ?? {})), // redact values, not JSON text
        a.targets ?? [],
        a.run ?? null,
        !!a.run && !!a.sandbox,
      ],
    );
  }

  async redactStoredActivity(): Promise<number> {
    let changed = 0;
    for (let after = ''; ;) {
      const { rows } = await this.db.pool.query('SELECT id, subject, why, details FROM activity WHERE id > $1 ORDER BY id LIMIT $2', [after, REDACT_PAGE]);
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      const page = rows.flatMap((r: Record<string, unknown>) => redactStoredRow(r, ['subject', 'why'], ['details']) ?? []);
      if (!page.length) continue;
      await this.db.pool.query(
        `UPDATE activity x SET subject = c.subject, why = c.why, details = c.details
         FROM jsonb_to_recordset($1::jsonb) AS c(id text, subject text, why text, details jsonb) WHERE x.id = c.id`,
        [toJson(page)],
      );
      changed += page.length;
    }
    return changed;
  }

  async list(q: ActivityQuery): Promise<Activity[]> {
    // The JSON's length, not pg_column_size (compressed: a long repeated log is tiny on disk): details bigger than
    // maxDetailBytes never leave the database.
    const { rows } = await this.db.pool.query<Row & { omitted: boolean }>(
      `SELECT id, ts, kind, actor, project_key, subject, why, targets, run, sandbox,
              ($6::int IS NOT NULL AND octet_length(details::text) > $6) AS omitted,
              CASE WHEN $6::int IS NOT NULL AND octet_length(details::text) > $6 THEN NULL ELSE details END AS details
         FROM activity
        WHERE ($1::text IS NULL OR project_key = $1) AND ($2::text IS NULL OR kind = $2)
          AND ($3::text IS NULL OR targets @> ARRAY[$3::text])
          AND ($5::text[] IS NULL OR project_key IS NULL OR project_key = ANY($5))
          AND ($7::text IS NULL OR run = $7)
          AND (NOT $8 OR run IS NULL) AND (NOT $9 OR NOT sandbox)
          AND ($10::text IS NULL OR seq < (SELECT seq FROM activity WHERE id = $10))
        ORDER BY seq DESC
        LIMIT $4`,
      [q.projectKey ?? null, q.kind ?? null, q.target ?? null, q.limit ?? 200, q.projectKeys ?? null, q.maxDetailBytes ?? null, q.run ?? null, !!q.unlabelled, !!q.noSandbox, q.before ?? null],
    );
    return rows.map((r) => ({ ...activityOf(r), ...(r.omitted && { detailsOmitted: true }) }));
  }

  async get(id: string): Promise<Activity | null> {
    const { rows } = await this.db.pool.query<Row>(
      'SELECT id, ts, kind, actor, project_key, subject, why, details, targets, run, sandbox FROM activity WHERE id = $1',
      [id],
    );
    return rows[0] ? activityOf(rows[0]) : null;
  }

  async removeRun(run: string, keep: readonly ActivityKind[] = [], o: { ids?: readonly string[]; targets?: readonly string[] } = {}): Promise<number> {
    return (await this.db.pool.query(
      `DELETE FROM activity WHERE run = $1 AND NOT (kind = ANY($2::text[]))
         AND ($3::text[] IS NULL OR id = ANY($3::text[])) AND NOT (coalesce(targets, '{}') && $4::text[])`,
      [run, [...keep], o.ids ? [...o.ids] : null, [...(o.targets ?? [])]],
    )).rowCount ?? 0;
  }
}
