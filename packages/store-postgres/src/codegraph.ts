import { conditionalWrite } from './conditionalWrite.ts';
import {
  codeGraphViews,
  normalizeCodeMap,
  type Cause,
  type CodeGraphReads,
  type CodeGraphStore,
  type CodeMapMeta,
  type CodeMapStats,
  type CodeMapWrite,
  type FileChurn,
  type FileMissRow,
  type HotspotOpts,
  type MapFile,
  type MapSymbol,
  type SessionFile,
  type StoredCodeMap,
  type SymbolKind,
} from '@fb/core';
import { iso, toJson, tx, type Db } from './db.ts';
import { PgFactsStore } from './facts.ts';
import { PgKnowledgeStore } from './knowledge.ts';
import { visibleToRun } from './vector.ts';

/** The CodeFile id Neo4j uses: '<projectKey>:<path>'. */
const fileId = (projectKey: string, path: string) => `${projectKey}:${path}`;

/** Enough for any project's approved lessons; path matching happens after the read. */
const LESSON_LIMIT = 5000;

type Row = Record<string, any>;

/**
 * The code map on Postgres (migration 0002): map columns on code_files (the rows facts point at), code_symbols,
 * code_imports, code_tests, code_maps, and session_files for what each session touched. Files of the import index past
 * the cap are code_files rows with in_index (0026): their columns and edges, no symbols. Text is ordered with
 * COLLATE "C" to match Neo4j's code-point order.
 */
export class PgCodeGraphStore implements CodeGraphStore {
  readonly db: Db;
  private readonly views: ReturnType<typeof codeGraphViews>;

  constructor(db: Db) {
    this.db = db;
    const facts = new PgFactsStore(db);
    const knowledge = new PgKnowledgeStore(db);
    const reads: CodeGraphReads = {
      mapFiles: (key, paths) => this.mapFiles(key, paths),
      outsideFiles: (key, paths) => this.mapFiles(key, paths, 'in_index'),
      symbolsOf: (key, path) => this.symbolsOf(key, path),
      importsOf: (key, path) => this.importsOf(key, path),
      importersOf: (key, paths) => this.importersOf(key, paths),
      testsOf: (key, paths) => this.testsOf(key, paths),
      importerCounts: (key) => this.importerCounts(key),
      edgesTouching: (key, paths) => this.edgesTouching(key, paths),
      missesOn: (key, paths, run) => this.missesOn(key, paths, run ?? null),
      approvedLessons: (key, run) => knowledge.listLessons({ status: 'approved', projectKey: key, limit: LESSON_LIMIT, run }).then((lessons) => lessons.filter((l) => !l.checks?.some((c) => c.name === 'no-miss'))),
      currentFacts: (key, path, run) => facts.listFacts({ projectKey: key, path, run }),
    };
    this.views = codeGraphViews(reads);
  }

  private q(sql: string, params: unknown[] = []) {
    return this.db.pool.query(sql, params);
  }

  async replaceCodeMap(projectKey: string, raw: CodeMapWrite): Promise<CodeMapStats> {
    const map = normalizeCodeMap(raw);
    const key = projectKey;
    const now = new Date();
    const id = (p: string) => fileId(key, p);
    await tx(this.db, async (c) => {
      await c.query('INSERT INTO projects (key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
      await c.query('DELETE FROM code_tests WHERE project_key = $1', [key]);
      await c.query('DELETE FROM code_imports WHERE project_key = $1', [key]);
      await c.query('DELETE FROM code_symbols WHERE project_key = $1', [key]);
      await c.query(
        `UPDATE code_files SET in_map = false, lang = NULL, code_hash = NULL, loc = NULL, is_test = false,
                churn_commits = NULL, churn_last_ts = NULL, mapped_at = NULL
         WHERE project_key = $1 AND in_map AND NOT (path = ANY($2::text[]))`,
        [key, map.files.map((f) => f.path)],
      );
      await c.query(
        `UPDATE code_files SET in_index = false, lang = NULL, code_hash = NULL, loc = NULL, is_test = false, mapped_at = NULL
         WHERE project_key = $1 AND in_index AND NOT (path = ANY($2::text[]))`,
        [key, map.outside.map((f) => f.path)],
      );
      // A file that left the map and that nothing else refers to (never scanned, no fact about it) goes. Session
      // touches (session_files) need no code_files row.
      await c.query(
        `DELETE FROM code_files cf
         WHERE cf.project_key = $1 AND NOT cf.in_map AND NOT cf.in_index AND cf.hash IS NULL AND NOT (cf.path = ANY($2::text[]))
           AND NOT EXISTS (SELECT 1 FROM facts x WHERE x.code_file_id = cf.id)`,
        [key, [...map.files, ...map.outside].map((f) => f.path)],
      );
      await c.query(
        `INSERT INTO code_files (id, project_key, path, removed, in_map, lang, code_hash, loc, is_test, churn_commits, churn_last_ts, mapped_at)
         SELECT f.id, $1, f.path, false, true, f.lang, f.hash, f.loc, f.is_test, f.churn, f.last_ts, $2
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::boolean[], $9::int[], $10::text[])
              AS f(id, path, lang, hash, loc, is_test, churn, last_ts)
         ON CONFLICT (id) DO UPDATE SET in_map = true, in_index = false, lang = EXCLUDED.lang, code_hash = EXCLUDED.code_hash, loc = EXCLUDED.loc,
           is_test = EXCLUDED.is_test, churn_commits = EXCLUDED.churn_commits, churn_last_ts = EXCLUDED.churn_last_ts,
           mapped_at = EXCLUDED.mapped_at`,
        [
          key, now,
          map.files.map((f) => id(f.path)), map.files.map((f) => f.path), map.files.map((f) => f.lang), map.files.map((f) => f.hash),
          map.files.map((f) => f.loc), map.files.map((f) => f.isTest),
          map.files.map((f) => map.churn[f.path]?.commits ?? null), map.files.map((f) => map.churn[f.path]?.lastTs ?? null),
        ],
      );
      await c.query(
        `INSERT INTO code_files (id, project_key, path, removed, in_map, in_index, lang, code_hash, loc, is_test, mapped_at)
         SELECT f.id, $1, f.path, false, false, true, f.lang, f.hash, f.loc, f.is_test, $2
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::boolean[]) AS f(id, path, lang, hash, loc, is_test)
         ON CONFLICT (id) DO UPDATE SET in_map = false, in_index = true, lang = EXCLUDED.lang, code_hash = EXCLUDED.code_hash, loc = EXCLUDED.loc,
           is_test = EXCLUDED.is_test, churn_commits = NULL, churn_last_ts = NULL, mapped_at = EXCLUDED.mapped_at`,
        [
          key, now,
          map.outside.map((f) => id(f.path)), map.outside.map((f) => f.path), map.outside.map((f) => f.lang), map.outside.map((f) => f.hash),
          map.outside.map((f) => f.loc), map.outside.map((f) => f.isTest),
        ],
      );
      await c.query(
        `INSERT INTO code_symbols (code_file_id, ord, project_key, id, path, name, kind, exported, lines)
         SELECT s.file_id, s.ord, $1, s.id, s.path, s.name, s.kind, s.exported, s.lines
         FROM unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::boolean[], $9::text[])
              AS s(file_id, ord, id, path, name, kind, exported, lines)`,
        [
          key,
          map.symbols.map((s) => id(s.path)), map.symbols.map((s) => s.ord), map.symbols.map((s) => s.id), map.symbols.map((s) => s.path),
          map.symbols.map((s) => s.name), map.symbols.map((s) => s.kind), map.symbols.map((s) => s.exported), map.symbols.map((s) => s.lines),
        ],
      );
      // names travel as JSON: a text[][] parameter would need every row's names to be the same length.
      await c.query(
        `INSERT INTO code_imports (from_file_id, to_ref, to_file_id, project_key, names, spec)
         SELECT $1 || ':' || i.from_path, i.to_ref, CASE WHEN i.to_ref LIKE 'pkg:%' THEN NULL ELSE $1 || ':' || i.to_ref END, $1,
                ARRAY(SELECT jsonb_array_elements_text(i.names)), i.spec
         FROM jsonb_to_recordset($2::jsonb) AS i(from_path text, to_ref text, names jsonb, spec text)`,
        [key, toJson(map.imports.map((i) => ({ from_path: i.from, to_ref: i.to, names: i.names, spec: i.spec })))],
      );
      await c.query(
        `INSERT INTO code_tests (test_file_id, target_file_id, project_key)
         SELECT t.test, t.target, $1 FROM unnest($2::text[], $3::text[]) AS t(test, target)`,
        [key, map.tests.map((t) => id(t.test)), map.tests.map((t) => id(t.target))],
      );
      await c.query(
        `INSERT INTO code_maps (project_key, fingerprint, built_at, files, symbols, imports, tests, candidates, unresolved, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (project_key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, built_at = EXCLUDED.built_at, files = EXCLUDED.files,
           symbols = EXCLUDED.symbols, imports = EXCLUDED.imports, tests = EXCLUDED.tests, candidates = EXCLUDED.candidates, unresolved = EXCLUDED.unresolved,
           version = EXCLUDED.version`,
        [key, map.fingerprint, now, map.stats.files, map.stats.symbols, map.stats.imports, map.stats.tests, map.candidates, map.unresolved ?? null, map.version],
      );
    });
    return map.stats;
  }

  async purgeOrphanCodeFiles(limit: number, now = new Date()): Promise<number> {
    if (!Number.isFinite(limit) || limit < 1) return 0;
    const cutoff = new Date(now.getTime() - 24 * 60 * 60_000);
    // Retain deselected maps for a day so an accidental untick is reversible, then release derived map data.
    await tx(this.db, async (c) => {
      // Serialize against setTracked; re-evaluate selection only after acquiring its lock.
      await c.query("SELECT id FROM project_selection WHERE id = 'selection' FOR UPDATE");
      const { rows } = await c.query<{ project_key: string }>(
        `SELECT m.project_key FROM code_maps m JOIN project_selection s ON s.id = 'selection'
         WHERE s.initialized AND s.updated_at < $1
           AND NOT (m.project_key = ANY(s.tracked)) LIMIT 1`,
        [cutoff],
      );
      for (const { project_key: key } of rows) {
        await c.query('DELETE FROM code_symbols WHERE project_key = $1', [key]);
        await c.query('DELETE FROM code_imports WHERE project_key = $1', [key]);
        await c.query('DELETE FROM code_tests WHERE project_key = $1', [key]);
        await c.query('UPDATE code_files SET in_map = false, in_index = false, mapped_at = NULL, code_hash = NULL WHERE project_key = $1', [key]);
        await c.query('DELETE FROM code_maps WHERE project_key = $1', [key]);
      }
    });
    // Session touches (session_files) need no code_files row; map edges hang off map files only.
    const { rowCount } = await this.q(
      `DELETE FROM code_files WHERE id IN (
         SELECT cf.id FROM code_files cf
         WHERE NOT cf.in_map AND NOT cf.in_index AND (cf.removed OR cf.hash IS NULL OR NOT EXISTS (SELECT 1 FROM projects p WHERE p.key = cf.project_key)
           OR EXISTS (SELECT 1 FROM project_selection s WHERE s.id = 'selection' AND s.initialized
             AND s.updated_at < $2 AND NOT (cf.project_key = ANY(s.tracked))))
           AND NOT EXISTS (SELECT 1 FROM facts x WHERE x.code_file_id = cf.id)
         LIMIT $1)`,
      [Math.max(0, Math.floor(limit)), cutoff],
    );
    return rowCount ?? 0;
  }

  async requestCodeMapRebuild(projectKey: string): Promise<boolean> {
    return conditionalWrite(this.db, async query => {
      const { rowCount } = await query('UPDATE code_maps SET rebuild_requested_at = $2 WHERE project_key = $1', [projectKey, new Date()]);
      return (rowCount ?? 0) > 0;
    }, Boolean);
  }

  async codeMapRebuildsRequested(): Promise<{ projectKey: string; requestedAt: string }[]> {
    const { rows } = await this.q(
      `SELECT project_key, rebuild_requested_at FROM code_maps WHERE rebuild_requested_at > built_at
       ORDER BY rebuild_requested_at, project_key COLLATE "C"`,
    );
    return rows.map((r) => ({ projectKey: r.project_key as string, requestedAt: iso(r.rebuild_requested_at)! }));
  }

  async codeMapMeta(projectKey: string): Promise<CodeMapMeta | null> {
    const { rows: [m] } = await this.q('SELECT * FROM code_maps WHERE project_key = $1', [projectKey]);
    if (!m) return null;
    return { fingerprint: m.fingerprint ?? null, builtAt: iso(m.built_at)!, stats: { files: m.files, symbols: m.symbols, imports: m.imports, tests: m.tests }, candidates: m.candidates ?? null, unresolved: m.unresolved ?? null, version: m.version ?? null };
  }

  async codeMap(projectKey: string): Promise<StoredCodeMap | null> {
    const meta = await this.codeMapMeta(projectKey);
    if (!meta) return null;
    const [files, outside, symbols, imports] = await Promise.all([
      this.mapFiles(projectKey),
      this.mapFiles(projectKey, undefined, 'in_index'),
      this.q('SELECT * FROM code_symbols WHERE project_key = $1 ORDER BY path COLLATE "C", ord', [projectKey]),
      this.q(
        `SELECT f.path AS from_path, i.to_ref, i.names, i.spec FROM code_imports i JOIN code_files f ON f.id = i.from_file_id
         WHERE i.project_key = $1 ORDER BY f.path COLLATE "C", i.to_ref COLLATE "C"`,
        [projectKey],
      ),
    ]);
    return {
      ...meta,
      files: files.map(({ churn: _, ...f }) => f),
      outside: outside.map(({ churn: _, ...f }) => f),
      symbols: symbols.rows.map(symbolOf),
      imports: imports.rows.map((r) => ({ from: r.from_path, to: r.to_ref, names: r.names ?? [], spec: r.spec ?? '' })),
    };
  }

  async recordSessionFiles(sessionId: string, files: SessionFile[]): Promise<void> {
    await tx(this.db, async (c) => {
      const { rows: [s] } = await c.query('SELECT project_key FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);
      if (!s) return;
      await c.query('DELETE FROM session_files WHERE session_id = $1', [sessionId]);
      const fs = files.filter((f) => f.path && f.path !== '.');
      await c.query(
        `INSERT INTO session_files (session_id, path, project_key, read, edited, first_edit_at, last_edit_at)
         SELECT $1, f.path, $2, f.read, f.edited, f.first_at, f.last_at
         FROM unnest($3::text[], $4::boolean[], $5::boolean[], $6::timestamptz[], $7::timestamptz[]) AS f(path, read, edited, first_at, last_at)
         ON CONFLICT (session_id, path) DO NOTHING`,
        [sessionId, s.project_key, fs.map((f) => f.path), fs.map((f) => f.read), fs.map((f) => f.edited), fs.map((f) => f.firstEditAt), fs.map((f) => f.lastEditAt)],
      );
    });
  }

  async sessionFiles(sessionId: string): Promise<SessionFile[]> {
    const { rows } = await this.q('SELECT * FROM session_files WHERE session_id = $1 ORDER BY path COLLATE "C"', [sessionId]);
    return rows.map((r) => ({ path: r.path, read: r.read, edited: r.edited, firstEditAt: iso(r.first_edit_at), lastEditAt: iso(r.last_edit_at) }));
  }

  async editedPaths(projectKey: string, limit: number): Promise<string[]> {
    const { rows } = await this.q(
      `SELECT path FROM session_files WHERE project_key = $1 AND edited
       GROUP BY path ORDER BY max(last_edit_at) DESC NULLS LAST, path COLLATE "C" LIMIT $2`,
      [projectKey, Math.max(0, Math.floor(limit))],
    );
    return rows.map((r) => r.path as string);
  }

  moduleContext(projectKey: string, path: string, run?: string | null) {
    return this.views.moduleContext(projectKey, path, run ?? null);
  }

  impact(projectKey: string, paths: string[], depth: number, run?: string | null) {
    return this.views.impact(projectKey, paths, depth, run ?? null);
  }

  hotspots(projectKey: string, limit: number, opts?: HotspotOpts) {
    return this.views.hotspots(projectKey, limit, opts);
  }

  mapGraph(projectKey: string, opts: HotspotOpts & { limit: number }) {
    return this.views.mapGraph(projectKey, opts);
  }

  lessonsForPaths(projectKey: string, paths: string[], run?: string | null) {
    return this.views.lessonsForPaths(projectKey, paths, run ?? null);
  }

  outsideMap(projectKey: string, paths: string[]) {
    return this.views.outsideMap(projectKey, paths);
  }

  /** The export's per-file view of a project's map. */
  exportFiles(projectKey: string) {
    return this.views.exportFiles(projectKey);
  }

  // ── reads the views are built from ──

  /** Mapped files (in_map), or with `in_index` the files of the import index past the cap. */
  private async mapFiles(projectKey: string, paths?: string[], mark: 'in_map' | 'in_index' = 'in_map'): Promise<(MapFile & { churn: FileChurn | null })[]> {
    if (paths && !paths.length) return [];
    const { rows } = await this.q(
      `SELECT path, lang, code_hash, loc, is_test, churn_commits, churn_last_ts FROM code_files
       WHERE project_key = $1 AND ${mark} AND ($2::text[] IS NULL OR path = ANY($2::text[]))
       ORDER BY path COLLATE "C"`,
      [projectKey, paths ?? null],
    );
    return rows.map((f) => ({
      path: f.path,
      lang: f.lang,
      hash: f.code_hash,
      loc: f.loc,
      isTest: f.is_test,
      churn: f.churn_commits == null ? null : { commits: f.churn_commits, lastTs: f.churn_last_ts },
    }));
  }

  private async symbolsOf(projectKey: string, path: string): Promise<MapSymbol[]> {
    const { rows } = await this.q('SELECT * FROM code_symbols WHERE code_file_id = $1 ORDER BY ord', [fileId(projectKey, path)]);
    return rows.map(symbolOf);
  }

  private async importsOf(projectKey: string, path: string): Promise<{ to: string; names: string[] }[]> {
    const { rows } = await this.q('SELECT to_ref, names FROM code_imports WHERE from_file_id = $1 ORDER BY to_ref COLLATE "C"', [fileId(projectKey, path)]);
    return rows.map((r) => ({ to: r.to_ref, names: r.names ?? [] }));
  }

  private async importersOf(projectKey: string, paths: string[]): Promise<Map<string, string[]>> {
    const out = new Map(paths.map((p) => [p, [] as string[]]));
    if (!paths.length) return out;
    const { rows } = await this.q(
      `SELECT DISTINCT t.path AS path, f.path COLLATE "C" AS from_path
       FROM code_imports i JOIN code_files f ON f.id = i.from_file_id JOIN code_files t ON t.id = i.to_file_id
       WHERE i.to_file_id = ANY($1::text[]) ORDER BY from_path`,
      [paths.map((p) => fileId(projectKey, p))],
    );
    for (const r of rows) out.get(r.path)?.push(r.from_path);
    return out;
  }

  private async testsOf(projectKey: string, paths: string[]): Promise<string[]> {
    if (!paths.length) return [];
    const { rows } = await this.q(
      `SELECT DISTINCT f.path COLLATE "C" AS path FROM code_tests t JOIN code_files f ON f.id = t.test_file_id
       WHERE t.target_file_id = ANY($1::text[]) ORDER BY path`,
      [paths.map((p) => fileId(projectKey, p))],
    );
    return rows.map((r) => r.path);
  }

  private async edgesTouching(projectKey: string, paths: string[]) {
    if (!paths.length) return { imports: [], tests: [] };
    const ids = paths.map((p) => fileId(projectKey, p));
    const [imports, tests] = await Promise.all([
      this.q(
        `SELECT DISTINCT a.path COLLATE "C" AS a, b.path COLLATE "C" AS b
         FROM code_imports i JOIN code_files a ON a.id = i.from_file_id JOIN code_files b ON b.id = i.to_file_id
         WHERE i.project_key = $1 AND (i.from_file_id = ANY($2::text[]) OR i.to_file_id = ANY($2::text[])) ORDER BY a, b`,
        [projectKey, ids],
      ),
      this.q(
        `SELECT DISTINCT a.path COLLATE "C" AS a, b.path COLLATE "C" AS b
         FROM code_tests t JOIN code_files a ON a.id = t.test_file_id JOIN code_files b ON b.id = t.target_file_id
         WHERE t.project_key = $1 AND (t.test_file_id = ANY($2::text[]) OR t.target_file_id = ANY($2::text[])) ORDER BY a, b`,
        [projectKey, ids],
      ),
    ]);
    return {
      imports: imports.rows.map((r) => ({ from: r.a as string, to: r.b as string })),
      tests: tests.rows.map((r) => ({ test: r.a as string, target: r.b as string })),
    };
  }

  private async importerCounts(projectKey: string): Promise<Map<string, number>> {
    const { rows } = await this.q(
      `SELECT t.path, count(DISTINCT i.from_file_id) AS n FROM code_imports i JOIN code_files t ON t.id = i.to_file_id
       WHERE i.project_key = $1 GROUP BY t.path`,
      [projectKey],
    );
    return new Map(rows.map((r) => [r.path, r.n]));
  }

  private async missesOn(projectKey: string, paths: string[] | null, run: string | null): Promise<FileMissRow[]> {
    if (paths && !paths.length) return [];
    const { rows } = await this.q(
      `SELECT m.id, m.missed, m.cause, m.cause_explanation, f.id AS feedback_id, coalesce(t.text, f.text, '') AS text,
              t.session_id, t.ts_text, sf.path, (sf.last_edit_at IS NOT NULL AND sf.last_edit_at > t.ts) AS fixed,
              (SELECT min(l.id COLLATE "C") FROM lessons l WHERE l.miss_id = m.id) AS lesson_id
       FROM misses m
       JOIN feedback f ON f.id = m.feedback_id
       JOIN turns t ON t.uuid = f.turn_uuid
       JOIN session_files sf ON sf.session_id = t.session_id AND sf.edited
       WHERE m.project_key = $1 AND f.status <> 'rejected' AND m.subject IS NULL AND ($2::text[] IS NULL OR sf.path = ANY($2::text[]))
         AND ${visibleToRun('m', '$3')}
       ORDER BY m.id COLLATE "C", sf.path COLLATE "C"`,
      [projectKey, paths, run],
    );
    return rows.map((r: Row) => ({
      missId: r.id,
      missed: r.missed,
      cause: r.cause as Cause,
      causeExplanation: r.cause_explanation ?? '',
      feedbackId: r.feedback_id,
      feedbackText: r.text,
      sessionId: r.session_id,
      ts: r.ts_text,
      path: r.path,
      fixedHere: r.fixed === true,
      lessonId: r.lesson_id ?? null,
    }));
  }
}

function symbolOf(r: Row): MapSymbol {
  return { id: r.id, path: r.path, name: r.name, kind: r.kind as SymbolKind, exported: r.exported, lines: r.lines ?? '' };
}
