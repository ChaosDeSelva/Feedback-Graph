import { randomUUID } from 'node:crypto';
import {
  EMPTY_SELECTION, initialSelection, projectScope, selectionSeededActivity, SELECTION_ID, toSelection, withClones,
  type ActivityStore, type CandidateSnapshot, type Config, type ProjectScope, type ProjectSelection, type SelectionStore,
} from '@fb/core';
import { iso, toJson, tx, type Db } from './db.ts';

/** Any fixed number, distinct from the migration lock's. */
const INGEST_LOCK_KEY = 0x4642_696e; // "FBin"

type SelectionRow = { tracked: string[] | null; initialized: boolean; updated_at: Date | null };

const fromRow = (r: SelectionRow): ProjectSelection =>
  toSelection({ tracked: r.tracked ?? [], initialized: r.initialized, updatedAt: iso(r.updated_at) });

/** The project selection and the worker's candidate folders, each a single row with id SELECTION_ID. */
export class PgSelectionStore implements SelectionStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async get(): Promise<ProjectSelection | null> {
    const { rows } = await this.db.pool.query<SelectionRow>(
      'SELECT tracked, initialized, updated_at FROM project_selection WHERE id = $1',
      [SELECTION_ID],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  /** The stored selection, or the empty one (nothing tracked) when none was stored yet. */
  async current(): Promise<ProjectSelection> {
    return (await this.get()) ?? EMPTY_SELECTION;
  }

  /**
   * First start: store the initial selection (INGEST_PROJECTS, or nothing) and log it. Safe to call from both
   * services at once: only the call whose INSERT created the row logs (Neo4j's createdBy token).
   */
  async ensure(env: Pick<Config, 'ingestProjects' | 'excludeProjects'>, activity?: Pick<ActivityStore, 'record'>): Promise<{ selection: ProjectSelection; seeded: boolean }> {
    const stored = await this.get();
    if (stored) return { selection: stored, seeded: false };
    const seed = initialSelection(env, env.ingestProjects.length ? [] : await this.investedKeys());
    const token = randomUUID();
    const inserted = await this.db.pool.query<SelectionRow>(
      `INSERT INTO project_selection (id, tracked, initialized, updated_at, created_by)
       VALUES ($1, $2::text[], $3, $4, $5)
       ON CONFLICT (id) DO NOTHING
       RETURNING tracked, initialized, updated_at`,
      [SELECTION_ID, seed.tracked, seed.initialized, new Date(), token],
    );
    const seeded = inserted.rows.length > 0;
    // A conflict waits for the creating transaction to commit, so the row is there to read.
    const selection = seeded ? fromRow(inserted.rows[0]) : ((await this.get()) ?? EMPTY_SELECTION);
    if (seeded && activity) {
      const { rows } = await this.db.pool.query<{ n: number }>('SELECT count(*) AS n FROM projects');
      await activity.record(selectionSeededActivity(seed, Number(rows[0]?.n ?? 0), env.ingestProjects.length > 0));
    }
    return { selection, seeded };
  }

  /** Project keys you invested in (approved lessons, confirmed feedback, docs, scans): Neo4j's investedKeys. */
  async investedKeys(): Promise<string[]> {
    const { rows } = await this.db.pool.query<{ key: string }>(
      `SELECT key FROM (
         SELECT coalesce(project_key, origin_project_key) AS key FROM lessons WHERE status = 'approved'
         UNION SELECT project_key FROM feedback WHERE status <> 'rejected'
         UNION SELECT project_key FROM docs
         UNION SELECT project_key FROM scan_jobs
       ) k
       WHERE key IS NOT NULL
       ORDER BY key COLLATE "C"`,
    );
    return rows.map((r) => r.key);
  }

  /** Replace the tracked folders. Returns the previous list (as stored) so the caller can log what changed. */
  async setTracked(tracked: string[]): Promise<{ before: string[]; selection: ProjectSelection }> {
    const next = [...new Set(tracked)].sort();
    return tx(this.db, async (c) => {
      const old = await c.query<{ tracked: string[] | null }>(
        'SELECT tracked FROM project_selection WHERE id = $1 FOR UPDATE',
        [SELECTION_ID],
      );
      const { rows } = await c.query<SelectionRow>(
        `INSERT INTO project_selection (id, tracked, initialized, updated_at)
         VALUES ($1, $2::text[], true, $3)
         ON CONFLICT (id) DO UPDATE SET tracked = EXCLUDED.tracked, initialized = true, updated_at = EXCLUDED.updated_at
         RETURNING tracked, initialized, updated_at`,
        [SELECTION_ID, next, new Date()],
      );
      return { before: old.rows[0]?.tracked ?? [], selection: fromRow(rows[0]) };
    });
  }

  /** Alias folder key → the project key it is a clone of. An alias claimed by two projects goes to the first key. */
  async aliases(): Promise<Map<string, string>> {
    const { rows } = await this.db.pool.query<{ a: string; key: string }>(
      // COLLATE "C": code point order, as Neo4j sorts strings.
      `SELECT a, p.key FROM projects p, unnest(p.aliases) WITH ORDINALITY AS u(a, n)
        ORDER BY p.key COLLATE "C", u.n`,
    );
    const out = new Map<string, string>();
    for (const r of rows) if (!out.has(r.a)) out.set(r.a, r.key);
    return withClones(out, await this.candidates());
  }

  /** A transaction-scoped advisory lock, held by its own connection until fn settles. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return tx(this.db, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [INGEST_LOCK_KEY]);
      return fn();
    });
  }

  async forgetReads(folderKeys: string[]): Promise<void> {
    if (!folderKeys.length) return;
    await this.db.pool.query('INSERT INTO read_resets (keys, at) VALUES ($1::text[], $2)', [[...new Set(folderKeys)], new Date()]);
  }

  async forgottenReads(after: number): Promise<{ seq: number; keys: string[] }> {
    const { rows } = await this.db.pool.query<{ seq: number; keys: string[] }>('SELECT seq, keys FROM read_resets ORDER BY seq');
    const max = rows.reduce((m, r) => Math.max(m, Number(r.seq)), 0);
    const from = max < after ? 0 : after;
    const keys = new Set<string>();
    for (const r of rows) if (Number(r.seq) > from) for (const k of r.keys) keys.add(k);
    return { seq: max, keys: [...keys] };
  }

  async scope(env: Pick<Config, 'excludeProjects'>): Promise<ProjectScope> {
    const [selection, aliases] = await Promise.all([this.current(), this.aliases()]);
    return projectScope(selection, env, aliases);
  }

  async saveCandidates(s: CandidateSnapshot): Promise<void> {
    // built_at is a timestamptz: a builtAt that is not a time is kept in the snapshot only, never a failed save.
    const built = Date.parse(s.builtAt);
    await this.db.pool.query(
      `INSERT INTO project_candidates (id, snapshot, built_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET snapshot = EXCLUDED.snapshot, built_at = EXCLUDED.built_at`,
      [SELECTION_ID, toJson(s), Number.isNaN(built) ? null : new Date(built)],
    );
  }

  async candidates(): Promise<CandidateSnapshot | null> {
    const { rows } = await this.db.pool.query<{ snapshot: CandidateSnapshot }>(
      'SELECT snapshot FROM project_candidates WHERE id = $1',
      [SELECTION_ID],
    );
    return rows[0]?.snapshot ?? null;
  }

  /** Project keys that hold anything: sessions, lessons, facts, docs, feedback, scans. The activity log does not count. */
  async keysWithData(): Promise<string[]> {
    const { rows } = await this.db.pool.query<{ key: string }>(
      `SELECT key FROM (
         SELECT key FROM projects
         UNION SELECT project_key FROM lessons WHERE project_key IS NOT NULL
         UNION SELECT project_key FROM docs
         UNION SELECT project_key FROM feedback
         UNION SELECT project_key FROM scan_jobs
         UNION SELECT project_key FROM code_files
       ) k
       WHERE key IS NOT NULL
       ORDER BY key COLLATE "C"`,
    );
    return rows.map((r) => r.key);
  }
}
