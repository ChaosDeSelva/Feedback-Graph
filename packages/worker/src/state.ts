import { DatabaseSync } from 'node:sqlite';

type HeadRow = { size: number; cwd: string | null; human: number };

function list(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Bump when ingest starts storing something new about a session, so transcripts read before are read once more
 * (re-ingesting is idempotent). 1: touched files (recordSessionFiles).
 */
export const INGEST_VERSION = 1;

/**
 * The worker's own bookkeeping (never in the graph): which memory files and session transcripts were read
 * (by size + mtime), and each session file's head (its cwd), so candidates are counted without re-reading files.
 */
export class FileState {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER, mtime REAL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
    // Transcripts (Claude Code and Codex) read for a selected project. Kept apart from `files`: before project
    // selection, every transcript was marked read whether or not it was ingested, so those marks mean nothing now.
    this.db.exec('CREATE TABLE IF NOT EXISTS ingested (path TEXT PRIMARY KEY, size INTEGER, mtime REAL, read_at REAL, version INTEGER NOT NULL DEFAULT 0)');
    this.addColumn('ingested', 'version', 'INTEGER NOT NULL DEFAULT 0');
    // The folder keys a transcript held (JSON), and those of them skipped as out of scope: a skipped folder that is
    // selected later gets the file read again, and forgetting a folder (its data deleted) finds its files.
    this.addColumn('ingested', 'keys', 'TEXT');
    this.addColumn('ingested', 'skipped', 'TEXT');
    // The project key a memory file was read for.
    this.addColumn('files', 'key', 'TEXT');
    this.db.exec('CREATE TABLE IF NOT EXISTS heads (path TEXT PRIMARY KEY, size INTEGER, cwd TEXT, human INTEGER)');
    // Codex rollouts: every cwd the session switched to (JSON), and the byte offset scanned so far.
    this.db.exec('CREATE TABLE IF NOT EXISTS cwds (path TEXT PRIMARY KEY, scanned INTEGER, cwds TEXT)');
  }

  private addColumn(table: string, column: string, type: string) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  close() {
    this.db.close();
  }

  /** Memory files: changed since last marked? */
  changed(path: string, size: number, mtimeMs: number): boolean {
    const row = this.db.prepare('SELECT size, mtime FROM files WHERE path = ?').get(path) as
      | { size: number; mtime: number }
      | undefined;
    return !row || row.size !== size || row.mtime !== mtimeMs;
  }

  /** `key`: the project key the memory file was read for. */
  mark(path: string, size: number, mtimeMs: number, key: string | null = null) {
    this.db
      .prepare('INSERT INTO files (path, size, mtime, key) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, key = excluded.key')
      .run(path, size, mtimeMs, key);
  }

  /**
   * A transcript: never read, or changed since it was read. `readAt` is when it was last read (ms), if ever;
   * `skipped` the folder keys in it that were out of scope then.
   */
  ingestState(path: string, size: number, mtimeMs: number): { changed: boolean; readAt: number | null; skipped: string[] } {
    const row = this.db.prepare('SELECT size, mtime, read_at, version, skipped FROM ingested WHERE path = ?').get(path) as
      | { size: number; mtime: number; read_at: number | null; version: number; skipped: string | null }
      | undefined;
    return {
      changed: !row || row.size !== size || row.mtime !== mtimeMs || row.version < INGEST_VERSION,
      readAt: row?.read_at ?? null,
      skipped: list(row?.skipped),
    };
  }

  markIngested(path: string, size: number, mtimeMs: number, readAt: number, o: { keys?: string[]; skipped?: string[] } = {}) {
    this.db
      .prepare(
        `INSERT INTO ingested (path, size, mtime, read_at, version, keys, skipped) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, read_at = excluded.read_at,
           version = excluded.version, keys = excluded.keys, skipped = excluded.skipped`,
      )
      .run(path, size, mtimeMs, readAt, INGEST_VERSION, o.keys ? JSON.stringify(o.keys) : null, JSON.stringify(o.skipped ?? []));
  }

  /**
   * Forget reading the transcripts and memory files of these folders (their data was deleted), so they are read in
   * full when selected again. Rows from before folder keys were kept ask `legacyKeys` whose they are. Returns rows dropped.
   */
  forget(folderKeys: Iterable<string>, legacyKeys: (path: string, kind: 'transcript' | 'memory') => string[] | null): number {
    const gone = new Set(folderKeys);
    if (!gone.size) return 0;
    const hit = (keys: string[]) => keys.some((k) => gone.has(k));
    let n = 0;
    const del = this.db.prepare('DELETE FROM ingested WHERE path = ?');
    for (const r of this.db.prepare('SELECT path, keys, skipped FROM ingested').all() as { path: string; keys: string | null; skipped: string | null }[]) {
      const keys = r.keys === null ? (legacyKeys(r.path, 'transcript') ?? []) : list(r.keys);
      if (hit(keys) || hit(list(r.skipped))) n += Number(del.run(r.path).changes);
    }
    const delFile = this.db.prepare('DELETE FROM files WHERE path = ?');
    for (const r of this.db.prepare('SELECT path, key FROM files').all() as { path: string; key: string | null }[]) {
      const keys = r.key === null ? (legacyKeys(r.path, 'memory') ?? []) : [r.key];
      if (hit(keys)) n += Number(delFile.run(r.path).changes);
    }
    return n;
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** A Codex rollout's cwds seen so far (after its head), and the byte offset scanned. */
  getCwds(path: string): { scanned: number; cwds: string[] } | null {
    const row = this.db.prepare('SELECT scanned, cwds FROM cwds WHERE path = ?').get(path) as { scanned: number; cwds: string } | undefined;
    return row ? { scanned: row.scanned, cwds: list(row.cwds) } : null;
  }

  putCwds(path: string, scanned: number, cwds: string[]) {
    this.db
      .prepare('INSERT INTO cwds (path, scanned, cwds) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET scanned = excluded.scanned, cwds = excluded.cwds')
      .run(path, scanned, JSON.stringify(cwds));
  }

  getHead(path: string): { size: number; cwd: string | null; human: boolean } | null {
    const row = this.db.prepare('SELECT size, cwd, human FROM heads WHERE path = ?').get(path) as HeadRow | undefined;
    return row ? { size: row.size, cwd: row.cwd, human: !!row.human } : null;
  }

  putHead(path: string, size: number, head: { cwd: string | null; human: boolean }) {
    this.db
      .prepare('INSERT INTO heads (path, size, cwd, human) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, cwd = excluded.cwd, human = excluded.human')
      .run(path, size, head.cwd, head.human ? 1 : 0);
  }
}
