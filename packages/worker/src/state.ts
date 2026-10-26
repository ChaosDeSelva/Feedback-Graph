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
 * (re-ingesting is idempotent). 1: touched files (recordSessionFiles). 2: a session's work (edits and git commits,
 * sessionWork()), without which it is never linked to a GitHub or Linear comment. 3: Claude Code conversations'
 * fingerprints (ingest/fingerprint.ts), so a Codex import of one is recognised. 4: the branch the files were changed on
 * (not the one the session started on), and the tool calls after the last human turn (trailingToolCalls), the
 * evidence an instruction about git was broken. 5: the instruction files the transcript shows the agent had
 * (ingest/instructions.ts), the evidence a post-mortem judges "did not load AGENTS.md" against.
 */
export const INGEST_VERSION = 5;

/**
 * Bump when the rule that drops a Codex session as a copy of a Claude Code conversation changes, so Codex rollouts are
 * read once more under the new one (migrateCodexCopyRule). 1: a Codex session is judged once, the first time it is
 * read; before, a session read at one turn (too short to judge) was dropped once it grew and matched, frozen at that turn.
 */
export const CODEX_COPY_RULE = 1;

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
    // Claude Code conversations by fingerprint: a Codex session with the same one is an import of it.
    this.db.exec('CREATE TABLE IF NOT EXISTS conversations (fingerprint TEXT PRIMARY KEY, session_id TEXT NOT NULL)');
    // Codex sessions, judged once: a copy of this Claude Code session (copy_of), or Codex's own (null).
    this.db.exec('CREATE TABLE IF NOT EXISTS codex_sessions (session_id TEXT PRIMARY KEY, copy_of TEXT)');
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

  /** Remember a Claude Code conversation's fingerprint (the first session to have it keeps it). */
  rememberConversation(fingerprint: string, sessionId: string) {
    this.db.prepare('INSERT INTO conversations (fingerprint, session_id) VALUES (?, ?) ON CONFLICT(fingerprint) DO NOTHING').run(fingerprint, sessionId);
  }

  /** The Claude Code session with this fingerprint, or null. */
  conversation(fingerprint: string): string | null {
    const row = this.db.prepare('SELECT session_id FROM conversations WHERE fingerprint = ?').get(fingerprint) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  /** A Codex session's verdict: a copy of a Claude Code session (its id), Codex's own (null), or undefined: not judged yet. */
  codexVerdict(sessionId: string): string | null | undefined {
    const row = this.db.prepare('SELECT copy_of FROM codex_sessions WHERE session_id = ?').get(sessionId) as { copy_of: string | null } | undefined;
    return row ? row.copy_of : undefined;
  }

  /** Judged once: the first verdict stands (a session read as Codex's own is never later dropped as a copy). */
  judgeCodexSession(sessionId: string, copyOf: string | null) {
    this.db.prepare('INSERT INTO codex_sessions (session_id, copy_of) VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING').run(sessionId, copyOf);
  }

  /**
   * The copy rule changed (CODEX_COPY_RULE): the Codex rollouts under `dir` are read once more, so a session the old
   * rule froze is judged again (cycle.ts). Once per rule version; returns how many files were put back.
   */
  migrateCodexCopyRule(dir: string): number {
    if (Number(this.getSetting('codex_copy_rule') ?? 0) >= CODEX_COPY_RULE) return 0;
    // An empty or root folder would put back every file the worker has read, not only Codex's.
    if (!dir.trim() || dir.replace(/\/+$/, '') === '') return 0;
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const r = this.db.prepare('UPDATE ingested SET version = 0 WHERE substr(path, 1, length(?)) = ?').run(prefix, prefix);
    this.setSetting('codex_copy_rule', String(CODEX_COPY_RULE));
    return Number(r.changes);
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
