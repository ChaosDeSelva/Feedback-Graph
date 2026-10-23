import { randomUUID } from 'node:crypto';
import { redactDeep, redactSecrets, type Activity, type ActivityInput, type ActivityKind, type ActivityStore } from '@fb/core';
import { iso, toJson, type Db } from './db.ts';

type Row = {
  id: string; ts: Date; kind: ActivityKind; actor: string; project_key: string | null;
  subject: string; why: string; details: Record<string, unknown> | null; targets: string[] | null;
};

/**
 * The append-only provenance log. `seq` (an identity column) orders it, as Neo4j's per-process monotonic `order`
 * does; list() is newest first.
 */
export class PgActivityStore implements ActivityStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async record(a: ActivityInput): Promise<void> {
    await this.db.pool.query(
      `INSERT INTO activity (id, ts, kind, actor, project_key, subject, why, details, targets)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::text[])`,
      [
        `act:${randomUUID()}`,
        new Date(), // the application's clock, as Neo4j's new Date().toISOString()
        a.kind,
        a.actor,
        a.projectKey ?? null,
        // Subjects and details quote feedback, PR titles and model output: redact before it is stored.
        redactSecrets(a.subject),
        redactSecrets(a.why),
        toJson(redactDeep(a.details ?? {})), // redact values, not JSON text
        a.targets ?? [],
      ],
    );
  }

  async list(q: { projectKey?: string; kind?: ActivityKind; target?: string; limit?: number }): Promise<Activity[]> {
    const { rows } = await this.db.pool.query<Row>(
      `SELECT id, ts, kind, actor, project_key, subject, why, details, targets
         FROM activity
        WHERE ($1::text IS NULL OR project_key = $1) AND ($2::text IS NULL OR kind = $2)
          AND ($3::text IS NULL OR targets @> ARRAY[$3::text])
        ORDER BY seq DESC
        LIMIT $4`,
      [q.projectKey ?? null, q.kind ?? null, q.target ?? null, q.limit ?? 200],
    );
    return rows.map((r) => ({
      id: r.id, ts: iso(r.ts)!, kind: r.kind, actor: r.actor, projectKey: r.project_key ?? null,
      subject: r.subject, why: r.why, details: r.details ?? {}, targets: r.targets ?? [],
    }));
  }
}
