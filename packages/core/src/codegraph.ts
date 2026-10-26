/**
 * The code knowledge graph as stored: one project's files, symbols, import and test edges (built by the worker's
 * codegraph parser), the files each session read and edited, and the views that link code to misses. Types and
 * pure helpers shared by both backends and the worker; the backend-specific part is CodeGraphReads.
 */
import { posix } from 'node:path';
import type { StoredFact } from './graph/facts.ts';
import type { ExportCodeFile } from './graph/portability.ts';
import { redactSecrets } from './redact.ts';
import { isSecretPath } from './secrets.ts';
import type { Cause, Lesson, ParsedSession, ToolCall } from './types.ts';

export const SYMBOL_KINDS = ['function', 'class', 'interface', 'type', 'const', 'method', 'other'] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/** A file of the map. hash: sha256 of its content (the parser's), not the scanner's sha1. */
export type MapFile = { path: string; lang: string; hash: string; loc: number; isTest: boolean };
/** id: `<path>#<name>` as the parser makes it (not unique: two classes may both have a `save` method). */
export type MapSymbol = { id: string; path: string; name: string; kind: SymbolKind; exported: boolean; lines: string };
/** to: a repo-relative path of a mapped file, or `pkg:<name>` for anything outside the repo. */
export type MapImport = { from: string; to: string; names: string[]; spec: string };
export type FileChurn = { commits: number; lastTs: string };

/**
 * The version of the rules a map is built by (what is resolved, which files are kept, what the index holds). Bump it
 * when they change: at start the worker rebuilds every map stamped with an older one (or none) from scratch, so a
 * new rule reaches maps built before it. 2: the import index past the cap, ranking by importers and churn, Python
 * imports counted when unresolved.
 */
export const CODE_MAP_VERSION = 2;

/** What the worker writes for one project: the whole map, replacing the previous one. */
export type CodeMapWrite = {
  /** The mapped files: they carry symbols. */
  files: MapFile[];
  /**
   * The import index past the cap: candidate files not in the map, kept with their import edges (to and from them)
   * but no symbols, so importer counts and the files a capped map left out are still known.
   */
  outside?: MapFile[];
  symbols: MapSymbol[];
  imports: MapImport[];
  /** TESTS edges: `test` imports `target` directly or through one file (codegraph testsFor). */
  tests: { test: string; target: string }[];
  /** Commits per path over the churn window; paths missing from it have 0. */
  churn: Record<string, FileChurn>;
  /** What the repo looked like when the map was built (git HEAD + dirty files); null when it cannot be told. */
  fingerprint: string | null;
  /** Files worth mapping before the cap (SCAN_MAX_FILES): more than files.length when the map is capped. */
  candidates?: number | null;
  /** Imports that look like they name a repo file (a path alias, a workspace package) but resolved to none. */
  unresolved?: number | null;
  /** CODE_MAP_VERSION of the worker that built it; null (absent) for a map from before maps were versioned. */
  version?: number | null;
};

export type CodeMapStats = { files: number; symbols: number; imports: number; tests: number };
/** candidates: files worth mapping before the cap; null for a map built before it was counted. */
/**
 * unresolved: imports the map could not follow to a file although they look local, so importer and test lists may be
 * short (null: not counted).
 */
export type CodeMapMeta = { fingerprint: string | null; builtAt: string; stats: CodeMapStats; candidates: number | null; unresolved?: number | null; /** CODE_MAP_VERSION it was built by; null before maps were versioned. */ version?: number | null };

/**
 * Whether what a map says about importers and tests may be short for a reason the map itself cannot count: it was
 * built by older map rules (the worker rebuilds it at start), or before unresolved imports were counted. Until it is
 * rebuilt, answers say the import graph is incomplete rather than that a file has no importers.
 */
export function mapIncomplete(meta: Pick<CodeMapMeta, 'unresolved' | 'version'> | null | undefined): boolean {
  if (!meta) return false;
  return meta.unresolved == null || (meta.version ?? 0) < CODE_MAP_VERSION;
}
/** The map's cap with SCAN_MAX_FILES unset: 40% of the candidates, at least MIN_MAP_FILES and at most MAX_AUTO_MAP_FILES. */
export const MIN_MAP_FILES = 400;
export const MAX_AUTO_MAP_FILES = 4000;

/**
 * Whether a map is capped. `of`: the files worth mapping, when the build counted them; null for a map built before
 * they were counted, which is called capped when it holds as many files as the cap allows: SCAN_MAX_FILES when set
 * (maxFiles), else MIN_MAP_FILES or more (an automatic cap above that is always below the count).
 */
export function mapCapped(meta: Pick<CodeMapMeta, 'stats' | 'candidates'> | null | undefined, maxFiles: number | null = null): { files: number; of: number | null } | null {
  if (!meta) return null;
  const files = meta.stats.files;
  if (meta.candidates != null) return meta.candidates > files ? { files, of: meta.candidates } : null;
  return files > 0 && files >= (maxFiles ?? MIN_MAP_FILES) ? { files, of: null } : null;
}

/** The stored map, in the parser's shape, so the next build can be incremental. Sorted by path (then position). */
export type StoredCodeMap = CodeMapMeta & {
  files: MapFile[];
  symbols: MapSymbol[];
  /** Every edge of the import index: from and to mapped and outside files alike. */
  imports: MapImport[];
  /** The import index past the cap (CodeMapWrite.outside), sorted by path. */
  outside: MapFile[];
};

/** One repo file a session touched. Times are ISO (Date.toISOString()); null when it was only read. */
export type SessionFile = { path: string; read: boolean; edited: boolean; firstEditAt: string | null; lastEditAt: string | null };

/** A miss whose session edited one of the files asked about. */
export type FileMiss = {
  missId: string;
  missed: string;
  cause: Cause;
  causeExplanation: string;
  feedbackId: string;
  feedbackText: string;
  sessionId: string;
  /** When the feedback was given (the turn's time, as stored). */
  ts: string;
  /** Which of the files asked about its session edited, sorted. */
  paths: string[];
  /** Some of those files were edited after the feedback: the fix landed there. */
  fixedHere: boolean;
  lessonId: string | null;
};

export type ModuleContext = {
  file: MapFile & { churn: FileChurn | null };
  symbols: MapSymbol[];
  /** Files that import this one, sorted. */
  importers: string[];
  imports: { to: string; names: string[] }[];
  /**
   * Tests to run when it changes, the same ones impact gives for it at MODULE_TESTS_DEPTH: test files among its
   * importers up to that many hops, and the tests covering any of them (TESTS edges). Nearest first.
   */
  tests: string[];
  /** Current facts from code scans about this file. */
  facts: StoredFact[];
  misses: FileMiss[];
  /** Approved lessons: derived from those misses, or whose paths cover this file. */
  lessons: Lesson[];
};

/** A file past the cap, in the import index: who imports it (sorted) and the tests among them (impact's one hop). */
export type OutsideFile = { path: string; importers: string[]; tests: string[] };

export type Impact = {
  /** The paths asked about that are in the map or its import index past the cap, sorted. */
  paths: string[];
  /** Files that import them, transitively up to the depth, nearest first. */
  dependents: { path: string; depth: number }[];
  /** Tests to run: test files among the paths and dependents, and tests covering any of them, nearest first. */
  tests: string[];
  misses: FileMiss[];
  lessons: Lesson[];
};

/** Where agents keep getting corrected: churn, misses and dependents of a file, and the score they make. */
export type Hotspot = { path: string; churn: number; misses: number; dependents: number; score: number };
/** includeTests: rank test files too (by default they are left out: a busy test file is rarely where agents struggle). */
/** missesOnly: only files a confirmed miss touched. run: the asking run (CodeGraphStore.moduleContext). */
export type HotspotOpts = { includeTests?: boolean; missesOnly?: boolean; run?: string | null };

/**
 * The code map drawn as a graph: the top `limit` files by hotspot score (tests left out unless included), their
 * direct neighbours by import or test edge (at most `limit` more, highest score first), the edges among them, and the
 * misses and approved lessons tied to those files.
 */
export type MapGraph = {
  files: (Hotspot & { lang: string; loc: number; isTest: boolean; /** One of the top files, not a neighbour. */ top: boolean })[];
  /** File-to-file imports among the files (packages left out). */
  imports: { from: string; to: string }[];
  tests: { test: string; target: string }[];
  /** paths: the files of the graph its session edited. */
  misses: FileMiss[];
  /** paths: the files of the graph it bears on. */
  lessons: { id: string; title: string; paths: string[] }[];
  /** How much was left out: files that could have been top files, and neighbours found. */
  cap: { limit: number; eligible: number; neighbors: number; neighborsFound: number };
};

// ── Paths ──────────────────────────────────────────────────────────────

/**
 * A path as the repo knows it (`src/a.ts`), or null when it is not strictly inside repoRoot. Relative paths resolve
 * against cwd. Never returns `..`, `.`, an absolute path or the root itself.
 */
export function repoRelative(file: string, repoRoot: string, cwd: string = repoRoot): string | null {
  if (!file || file.includes('\0') || !repoRoot) return null;
  const root = posix.normalize(repoRoot).replace(/\/+$/, '');
  const abs = posix.isAbsolute(file) ? posix.normalize(file) : posix.join(cwd, file);
  if (!root || !abs.startsWith(`${root}/`)) return null;
  const rel = abs.slice(root.length + 1).replace(/\/+$/, '');
  if (!rel || rel.split('/').some((s) => s === '..' || s === '.' || s === '')) return null;
  return rel;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Delete']);
const READ_TOOLS = new Set(['Read']);

const isoOf = (ts: string): string | null => {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

/** `git commit` as a command of its own in a shell line (after git's global options such as -C dir or -c k=v). */
const GIT_COMMIT = /(?:^|[;&|(\n])\s*git(?:\s+(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+commit(?![\w-])/;

export const isGitCommit = (command: string): boolean => GIT_COMMIT.test(command);

/**
 * Evidence that a session did work rather than only read: its file edits (Edit, Write, MultiEdit, NotebookEdit; Codex
 * apply_patch and file changes arrive as Edit / Write / Delete) and git commits it ran, with the times of the first and
 * last of them (ISO; null when none had a readable time). A review or a Q&A session has none.
 */
export type SessionWork = { edits: number; commits: number; firstAt: string | null; lastAt: string | null };

export function sessionWork(calls: ToolCall[]): SessionWork {
  const w: SessionWork = { edits: 0, commits: 0, firstAt: null, lastAt: null };
  for (const c of calls) {
    if (EDIT_TOOLS.has(c.name)) w.edits++;
    else if (c.name === 'Bash' && c.command && isGitCommit(c.command)) w.commits++;
    else continue;
    const at = isoOf(c.ts);
    if (!at) continue;
    if (!w.firstAt || at < w.firstAt) w.firstAt = at;
    if (!w.lastAt || at > w.lastAt) w.lastAt = at;
  }
  return w;
}

/** At most this many of the tool calls after a session's last human turn are kept on the session. */
export const MAX_TRAILING_TOOL_CALLS = 200;

/**
 * The tool calls after the session's last human turn (none takes them in as preceding calls), the newest
 * MAX_TRAILING_TOOL_CALLS: a push the agent ran right after an instruction not to, and then the session ended, is here.
 */
export function trailingToolCalls(s: Pick<ParsedSession, 'turns' | 'toolCalls'>): ToolCall[] {
  const last = s.turns.at(-1)?.ts;
  if (!last) return [];
  return (s.toolCalls ?? []).filter((c) => c.ts > last).slice(-MAX_TRAILING_TOOL_CALLS);
}

/**
 * The repo files a session read and edited, from its tool calls (Claude Code and Codex alike). Only paths inside
 * repoRoot (the project's folder on the machine the session ran on) count; secret files are left out. Sorted by path.
 */
export function sessionFiles(s: Pick<ParsedSession, 'cwd' | 'toolCalls'>, repoRoot: string): SessionFile[] {
  const out = new Map<string, SessionFile>();
  for (const c of s.toolCalls) {
    const edit = EDIT_TOOLS.has(c.name);
    if (!c.filePath || (!edit && !READ_TOOLS.has(c.name))) continue;
    const path = repoRelative(c.filePath, repoRoot, s.cwd || repoRoot);
    if (!path || isSecretPath(path)) continue;
    let f = out.get(path);
    if (!f) out.set(path, (f = { path, read: false, edited: false, firstEditAt: null, lastEditAt: null }));
    if (!edit) {
      f.read = true;
      continue;
    }
    f.edited = true;
    const at = isoOf(c.ts);
    if (!at) continue;
    if (!f.firstEditAt || at < f.firstEditAt) f.firstEditAt = at;
    if (!f.lastEditAt || at > f.lastEditAt) f.lastEditAt = at;
  }
  return [...out.values()].sort((a, b) => cmp(a.path, b.path));
}

/** Code-point order, as Neo4j and COLLATE "C" sort. */
export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A lesson path as stored: repo-relative, no `./`; null for absolute or escaping paths. */
export function cleanLessonPath(p: string): string | null {
  const t = p.trim().replace(/^(\.\/)+/, '');
  if (!t || t.startsWith('/') || t.includes('\0') || t.split('/').includes('..')) return null;
  return t;
}

const globCache = new Map<string, RegExp>();

function globRegex(glob: string): RegExp {
  let re = globCache.get(glob);
  if (re) return re;
  let src = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        src += '(?:.*/)?';
        i += 2;
      } else {
        src += '.*';
        i += 1;
      }
    } else if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp(`^${src}$`);
  if (globCache.size > 2000) globCache.clear();
  globCache.set(glob, re);
  return re;
}

/**
 * Whether a lesson path covers a repo file. A plain path covers the file itself and everything under it as a folder;
 * `*` stays within one folder, `**` crosses folders, and a pattern without `/` matches the file name anywhere.
 */
export function pathMatches(pattern: string, path: string): boolean {
  const p = cleanLessonPath(pattern)?.replace(/\/+$/, '');
  if (!p) return false;
  if (!/[*?]/.test(p)) return path === p || path.startsWith(`${p}/`);
  if (!p.includes('/')) return globRegex(p).test(path.split('/').pop()!);
  return globRegex(p).test(path);
}

/**
 * A session's edits around one piece of feedback: files edited before it (what the agent had done) and files edited
 * after it (where the fix landed). Feedback times from transcripts carry any offset; they are compared as instants.
 */
export function touchedAround(files: SessionFile[], feedbackTs: string): { edited: string[]; fixed: string[] } {
  const at = Date.parse(feedbackTs);
  const t = (s: string | null) => (s ? Date.parse(s) : NaN);
  const edits = files.filter((f) => f.edited);
  return {
    edited: edits.filter((f) => !(t(f.firstEditAt) > at)).map((f) => f.path).sort(cmp),
    fixed: edits.filter((f) => t(f.lastEditAt) > at).map((f) => f.path).sort(cmp),
  };
}

const MAX_EXACT_PATHS = 3;

/**
 * The paths a post-mortem's lesson should carry, narrowest first: the model's own paths when they cover a file the
 * session edited; else the files edited to fix the miss (or, with no fix edits, the files edited before it), as
 * themselves when there are a few or as their common folder; else nothing (project-wide). With no edits at all to go
 * on, the model's paths stand.
 */
export function suggestLessonPaths(modelPaths: string[], touched: { edited: string[]; fixed: string[] }): string[] {
  const clean = [...new Set(modelPaths.map(cleanLessonPath).filter((p): p is string => !!p))];
  const evidence = [...new Set([...touched.fixed, ...touched.edited])];
  if (!evidence.length) return clean;
  const supported = clean.filter((p) => evidence.some((f) => pathMatches(p, f)));
  if (supported.length) return supported;
  const base = [...new Set(touched.fixed.length ? touched.fixed : touched.edited)].sort(cmp);
  if (base.length <= MAX_EXACT_PATHS) return base;
  const dirs = base.map((f) => f.split('/').slice(0, -1));
  const common: string[] = [];
  for (let i = 0; dirs.every((d) => i < d.length && d[i] === dirs[0][i]); i++) common.push(dirs[0][i]);
  return common.length ? [`${common.join('/')}/**`] : [];
}

/** A symbol as written: its position in its file keeps the parser's order (ids repeat). */
export type OrderedSymbol = MapSymbol & { ord: number };

/**
 * The map exactly as a backend writes it: names, specifiers and package targets redacted (the parser does too; the
 * store does not rely on it), one entry per file, per (from, to) import and per (test, target) pair, symbols only of
 * mapped files, and only edges whose files are in the map or its import index (outside), so a write never refers to a
 * file it does not hold.
 */
export function normalizeCodeMap(map: CodeMapWrite): Omit<CodeMapWrite, 'symbols' | 'outside'> & { outside: MapFile[]; symbols: OrderedSymbol[]; stats: CodeMapStats } {
  const files = [...new Map(map.files.map((f) => [f.path, f])).values()].sort((a, b) => cmp(a.path, b.path));
  const mapped = new Set(files.map((f) => f.path));
  // A file is in the map or past it, never both.
  const outside = [...new Map((map.outside ?? []).filter((f) => !mapped.has(f.path)).map((f) => [f.path, f])).values()].sort((a, b) => cmp(a.path, b.path));
  const paths = new Set([...mapped, ...outside.map((f) => f.path)]);
  const ord = new Map<string, number>();
  const symbols = map.symbols
    .filter((x) => mapped.has(x.path))
    .map((x) => {
      const n = ord.get(x.path) ?? 0;
      ord.set(x.path, n + 1);
      return { ...x, id: redactSecrets(x.id), name: redactSecrets(x.name), ord: n };
    });
  const imports = new Map<string, MapImport>();
  for (const i of map.imports) {
    const to = i.to.startsWith('pkg:') ? redactSecrets(i.to) : i.to;
    if (!paths.has(i.from) || (!to.startsWith('pkg:') && !paths.has(to))) continue;
    const k = `${i.from}\0${to}`;
    const names = i.names.map(redactSecrets);
    const e = imports.get(k);
    if (!e) imports.set(k, { from: i.from, to, names: [...new Set(names)], spec: redactSecrets(i.spec) });
    else for (const n of names) if (!e.names.includes(n)) e.names.push(n);
  }
  const tests = [...new Map(map.tests.filter((t) => paths.has(t.test) && paths.has(t.target)).map((t) => [`${t.test}\0${t.target}`, t])).values()];
  const churn = Object.fromEntries(Object.entries(map.churn).filter(([p]) => mapped.has(p)));
  const fingerprint = map.fingerprint === null ? null : redactSecrets(map.fingerprint);
  const candidates = typeof map.candidates === 'number' && Number.isFinite(map.candidates) ? Math.max(files.length, Math.floor(map.candidates)) : null;
  const unresolved = typeof map.unresolved === 'number' && Number.isFinite(map.unresolved) ? Math.max(0, Math.floor(map.unresolved)) : null;
  const version = typeof map.version === 'number' && Number.isInteger(map.version) && map.version > 0 ? map.version : null;
  return {
    files, outside, symbols, imports: [...imports.values()], tests, churn, fingerprint, candidates, unresolved, version,
    stats: { files: files.length, symbols: symbols.length, imports: imports.size, tests: tests.length },
  };
}

/**
 * What a map write has to change against the stored map, so a rebuild where a handful of files changed rewrites a
 * handful of rows, not every symbol and edge. symbolPaths: files whose symbols differ (their stored symbols go and
 * `symbols` replace them); staleImports: (from, to) pairs whose edges go; newImports: edges to create.
 */
export function codeMapDiff(
  stored: { symbols: OrderedSymbol[]; imports: MapImport[] },
  next: { symbols: OrderedSymbol[]; imports: MapImport[] },
): { symbolPaths: string[]; symbols: OrderedSymbol[]; staleImports: { from: string; to: string }[]; newImports: MapImport[] } {
  const signatures = (xs: OrderedSymbol[]) => {
    const m = new Map<string, string[]>();
    for (const s of [...xs].sort((a, b) => a.ord - b.ord)) {
      const sig = m.get(s.path) ?? [];
      sig.push(JSON.stringify([s.ord, s.id, s.name, s.kind, s.exported, s.lines]));
      m.set(s.path, sig);
    }
    return new Map([...m].map(([p, sig]) => [p, sig.join('\n')]));
  };
  const before = signatures(stored.symbols);
  const after = signatures(next.symbols);
  const symbolPaths = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p));
  const changed = new Set(symbolPaths);

  const pair = (i: { from: string; to: string }) => `${i.from}\0${i.to}`;
  const edge = (i: MapImport) => JSON.stringify([i.spec, i.names]);
  const old = new Map<string, MapImport[]>();
  for (const i of stored.imports) old.set(pair(i), [...(old.get(pair(i)) ?? []), i]);
  const wanted = new Map(next.imports.map((i) => [pair(i), i]));
  const kept = new Set([...old].filter(([k, es]) => es.length === 1 && wanted.has(k) && edge(es[0]) === edge(wanted.get(k)!)).map(([k]) => k));
  return {
    symbolPaths,
    symbols: next.symbols.filter((s) => changed.has(s.path)),
    staleImports: [...old.entries()].filter(([k]) => !kept.has(k)).map(([, [i]]) => ({ from: i.from, to: i.to })),
    newImports: next.imports.filter((i) => !kept.has(pair(i))),
  };
}

// ── Scores and walks ───────────────────────────────────────────────────

/** Weight of one miss against log2 of churn and of dependents: a file agents got wrong once outranks busy files. */
export const MISS_WEIGHT = 4;

/** Map languages (MapFile.lang: a grammar name, an extension or a lowercased file name) that are docs, data or config. */
const NOT_CODE = new Set(['md', 'mdx', 'txt', 'json', 'yaml', 'yml', 'toml', 'gitignore', 'example', 'godot', 'dockerfile', 'makefile']);

/** Whether a mapped file is code: docs, data and config are mapped too, but are not where agents struggle by churning. */
export const isCodeLang = (lang: string): boolean => !NOT_CODE.has(lang.toLowerCase());

export function hotspotScore(p: { churn: number; misses: number; dependents: number }): number {
  const s = MISS_WEIGHT * p.misses + Math.log2(1 + p.churn) + Math.log2(1 + p.dependents);
  return Math.round(s * 100) / 100;
}

/** Files importing `start`, breadth first up to `depth` hops, nearest first and sorted within a depth (codegraph dependents). */
export async function expandDependents(
  start: string[],
  depth: number,
  importersOf: (paths: string[]) => Promise<Map<string, string[]>>,
): Promise<{ path: string; depth: number }[]> {
  const seen = new Set(start);
  const out: { path: string; depth: number }[] = [];
  let frontier = [...seen];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const found = await importersOf(frontier);
    const next: string[] = [];
    for (const p of frontier) {
      for (const from of found.get(p) ?? []) {
        if (seen.has(from)) continue;
        seen.add(from);
        next.push(from);
      }
    }
    next.sort(cmp);
    out.push(...next.map((path) => ({ path, depth: d })));
    frontier = next;
  }
  return out;
}

// ── Views, assembled the same way on every backend ─────────────────────

/** A miss linked to one file it edited: what a backend's missesOn returns, one row per (miss, file). */
export type FileMissRow = Omit<FileMiss, 'paths' | 'fixedHere'> & { path: string; fixedHere: boolean };

/** The few reads a backend implements; moduleContext, impact and hotspots are built from them by codeGraphViews. */
export interface CodeGraphReads {
  /** Mapped files with churn, sorted by path; only these paths when given. */
  mapFiles(projectKey: string, paths?: string[]): Promise<(MapFile & { churn: FileChurn | null })[]>;
  /** Files of the import index past the cap (not mapped), sorted by path; only these paths when given. */
  outsideFiles(projectKey: string, paths?: string[]): Promise<(MapFile & { churn: FileChurn | null })[]>;
  symbolsOf(projectKey: string, path: string): Promise<MapSymbol[]>;
  importsOf(projectKey: string, path: string): Promise<{ to: string; names: string[] }[]>;
  /** Direct importers of each path (every path is a key, with [] when none), mapped or in the index past the cap. */
  importersOf(projectKey: string, paths: string[]): Promise<Map<string, string[]>>;
  /** Test files with a TESTS edge to any of the paths. */
  testsOf(projectKey: string, paths: string[]): Promise<string[]>;
  /** How many files import each mapped file (only files with at least one importer). */
  importerCounts(projectKey: string): Promise<Map<string, number>>;
  /**
   * Misses of the project (feedback not rejected) whose session edited a file, for these paths or all of them. run
   * (here, in approvedLessons and currentFacts): the asking run; another run's sandbox records are left out.
   */
  missesOn(projectKey: string, paths: string[] | null, run?: string | null): Promise<FileMissRow[]>;
  /** File-to-file IMPORTS and TESTS edges with either end among the paths, sorted. */
  edgesTouching(projectKey: string, paths: string[]): Promise<{ imports: { from: string; to: string }[]; tests: { test: string; target: string }[] }>;
  /** Approved lessons for the project, global ones included. */
  approvedLessons(projectKey: string, run?: string | null): Promise<Lesson[]>;
  currentFacts(projectKey: string, path: string, run?: string | null): Promise<StoredFact[]>;
}

/** One FileMiss per miss, merging its rows; ordered by feedback time, then id. */
export function groupMisses(rows: FileMissRow[]): FileMiss[] {
  const by = new Map<string, FileMiss>();
  for (const { path, fixedHere, ...r } of rows) {
    const m = by.get(r.missId);
    if (!m) by.set(r.missId, { ...r, paths: [path], fixedHere });
    else {
      if (!m.paths.includes(path)) m.paths.push(path);
      m.fixedHere ||= fixedHere;
    }
  }
  for (const m of by.values()) m.paths.sort(cmp);
  return [...by.values()].sort((a, b) => cmp(a.ts, b.ts) || cmp(a.missId, b.missId));
}

/**
 * A path of a global lesson that names a file or folder of the project it was learned in (a literal path with a folder,
 * such as app/jobs/retention.ts), not a pattern or a root file name any project may have (**\/*.sql, Dockerfile).
 */
const originPath = (l: Lesson, p: string) => l.projectKey === null && !!l.origin && p.includes('/') && !/[*?]/.test(p);

/**
 * Approved lessons that bear on files: derived from one of the misses, or whose paths cover one of the files. With
 * `projectKey` (the project the files are in), a global lesson's paths in the project it was learned in (originPath)
 * cover files only there: elsewhere a file of the same name is not the one the lesson is about.
 */
export function lessonsFor(lessons: Lesson[], files: string[], misses: FileMiss[], projectKey: string | null = null): { lesson: Lesson; paths: string[] }[] {
  const byMiss = new Map(misses.map((m) => [m.missId, m.paths]));
  const out: { lesson: Lesson; paths: string[] }[] = [];
  for (const l of lessons) {
    const paths = projectKey === null || l.origin === projectKey ? l.paths : l.paths.filter((p) => !originPath(l, p));
    const matched = new Set(files.filter((f) => paths.some((p) => pathMatches(p, f))));
    for (const p of (l.missId && byMiss.get(l.missId)) || []) matched.add(p);
    if (matched.size) out.push({ lesson: l, paths: [...matched].sort(cmp) });
  }
  return out.sort((a, b) => cmp(a.lesson.id, b.lesson.id));
}

/** The start files, then the dependents one hop away, two hops, and so on. */
function byDepth(start: string[], dependents: { path: string; depth: number }[]): string[][] {
  const layers: string[][] = Array.from({ length: Math.max(0, ...dependents.map((d) => d.depth)) + 1 }, () => []);
  layers[0] = [...start];
  for (const d of dependents) layers[d.depth].push(d.path);
  return layers;
}

/** How many import hops moduleContext follows for its tests: impact's default depth, so the two agree. */
export const MODULE_TESTS_DEPTH = 3;

export function codeGraphViews(r: CodeGraphReads) {
  /**
   * Test files among the files, and the tests covering any of them, nearest first: `layers[d]` are the files d import
   * hops from the change, so a test file there is d away and a test covering one of them (a TESTS edge) d + 1. Ties
   * by path. A capped list then keeps the tests most likely to catch the change.
   */
  const testsFor = async (projectKey: string, layers: string[][]) => {
    const files = layers.flat();
    const known = (await Promise.all([r.mapFiles(projectKey, files), r.outsideFiles(projectKey, files)])).flat();
    const isTest = new Set(known.filter((f) => f.isTest).map((f) => f.path));
    const covering = await Promise.all(layers.map((ps) => (ps.length ? r.testsOf(projectKey, ps) : Promise.resolve([]))));
    const out = new Set<string>();
    for (let d = 0; d <= layers.length; d++) {
      for (const t of [...(layers[d] ?? []).filter((p) => isTest.has(p)), ...(covering[d - 1] ?? [])].sort(cmp)) out.add(t);
    }
    return [...out];
  };
  /** Every mapped file with its hotspot numbers, highest score first (ties by path), and the miss rows they came from. */
  const scored = async (projectKey: string, run: string | null) => {
    const [files, counts, rows] = await Promise.all([r.mapFiles(projectKey), r.importerCounts(projectKey), r.missesOn(projectKey, null, run)]);
    const missCount = new Map<string, Set<string>>();
    for (const m of rows) {
      let s = missCount.get(m.path);
      if (!s) missCount.set(m.path, (s = new Set()));
      s.add(m.missId);
    }
    const ranked = files
      .map((f) => {
        const parts = { churn: f.churn?.commits ?? 0, misses: missCount.get(f.path)?.size ?? 0, dependents: counts.get(f.path) ?? 0 };
        // Deploy manifests and docs churn constantly; they rank only once a miss touched them.
        const score = isCodeLang(f.lang) || parts.misses > 0 ? hotspotScore(parts) : 0;
        return { path: f.path, ...parts, score, lang: f.lang, loc: f.loc, isTest: f.isTest };
      })
      .sort((a, b) => b.score - a.score || cmp(a.path, b.path));
    return { ranked, rows };
  };
  const views = {
    async moduleContext(projectKey: string, path: string, run: string | null = null): Promise<ModuleContext | null> {
      const [file] = await r.mapFiles(projectKey, [path]);
      if (!file) return null;
      const [symbols, imports, importers, tests, facts, rows, lessons] = await Promise.all([
        r.symbolsOf(projectKey, path),
        r.importsOf(projectKey, path),
        r.importersOf(projectKey, [path]),
        // Through the importers, as impact does: a test reaching the file in several hops has no TESTS edge to it.
        expandDependents([path], MODULE_TESTS_DEPTH, (ps) => r.importersOf(projectKey, ps)).then((ds) => testsFor(projectKey, byDepth([path], ds))),
        r.currentFacts(projectKey, path, run),
        r.missesOn(projectKey, [path], run),
        r.approvedLessons(projectKey, run),
      ]);
      const misses = groupMisses(rows);
      return {
        file,
        symbols,
        importers: [...(importers.get(path) ?? [])].sort(cmp),
        imports,
        tests,
        facts,
        misses,
        lessons: lessonsFor(lessons, [path], misses, projectKey).map((x) => x.lesson),
      };
    },

    async impact(projectKey: string, paths: string[], depth: number, run: string | null = null): Promise<Impact> {
      const asked = [...new Set(paths)];
      // A file past the cap is a start too: the index knows who imports it.
      const mapped = (await Promise.all([r.mapFiles(projectKey, asked), r.outsideFiles(projectKey, asked)])).flat().map((f) => f.path).sort(cmp);
      const dependents = await expandDependents(mapped, Math.max(0, Math.floor(depth)), (ps) => r.importersOf(projectKey, ps));
      const all = [...mapped, ...dependents.map((d) => d.path)];
      const [tests, rows, lessons] = await Promise.all([testsFor(projectKey, byDepth(mapped, dependents)), r.missesOn(projectKey, all, run), r.approvedLessons(projectKey, run)]);
      const misses = groupMisses(rows);
      return {
        paths: mapped,
        dependents,
        tests,
        misses,
        lessons: lessonsFor(lessons, all, misses, projectKey).map((x) => x.lesson),
      };
    },

    /**
     * The asked paths that are past the cap (in the import index, not the map), with every file importing them and the
     * tests among those importers and theirs: what get_module_context says instead of "not in the code map".
     */
    async outsideMap(projectKey: string, paths: string[]): Promise<OutsideFile[]> {
      const files = await r.outsideFiles(projectKey, [...new Set(paths)]);
      if (!files.length) return [];
      const importers = await r.importersOf(projectKey, files.map((f) => f.path));
      return Promise.all(files.map(async (f) => {
        const direct = [...(importers.get(f.path) ?? [])].sort(cmp);
        return { path: f.path, importers: direct, tests: await testsFor(projectKey, [direct]) };
      }));
    },

    async hotspots(projectKey: string, limit: number, opts: HotspotOpts = {}): Promise<Hotspot[]> {
      const { ranked } = await scored(projectKey, opts.run ?? null);
      return ranked
        .filter((h) => (opts.includeTests || !h.isTest) && (!opts.missesOnly || h.misses > 0))
        .slice(0, Math.max(0, limit))
        .map(({ path, churn, misses, dependents, score }) => ({ path, churn, misses, dependents, score }));
    },

    async mapGraph(projectKey: string, opts: HotspotOpts & { limit: number }): Promise<MapGraph> {
      const limit = Math.max(0, Math.floor(opts.limit));
      const { ranked, rows } = await scored(projectKey, opts.run ?? null);
      const eligible = ranked.filter((h) => opts.includeTests || !h.isTest);
      const top = eligible.slice(0, limit);
      const topPaths = new Set(top.map((h) => h.path));
      const edges = top.length ? await r.edgesTouching(projectKey, [...topPaths]) : { imports: [], tests: [] };
      const near = new Set<string>();
      for (const e of edges.imports) for (const p of [e.from, e.to]) if (!topPaths.has(p)) near.add(p);
      for (const e of edges.tests) for (const p of [e.test, e.target]) if (!topPaths.has(p)) near.add(p);
      // ranked is in score order, so the neighbours kept are the hottest ones.
      const neighbors = ranked.filter((h) => near.has(h.path)).slice(0, limit);
      const shown = new Set([...topPaths, ...neighbors.map((h) => h.path)]);
      const misses = groupMisses(rows.filter((m) => shown.has(m.path)));
      const lessons = lessonsFor(await r.approvedLessons(projectKey, opts.run ?? null), [...shown].sort(cmp), misses, projectKey);
      return {
        files: [...top, ...neighbors].map((h) => ({ ...h, top: topPaths.has(h.path) })),
        imports: edges.imports.filter((e) => shown.has(e.from) && shown.has(e.to)),
        tests: edges.tests.filter((e) => shown.has(e.test) && shown.has(e.target)),
        misses,
        lessons: lessons.map(({ lesson, paths }) => ({ id: lesson.id, title: lesson.title, paths: paths.filter((p) => shown.has(p)) })).filter((l) => l.paths.length),
        cap: { limit, eligible: eligible.length, neighbors: neighbors.length, neighborsFound: near.size },
      };
    },

    /** The export's view of a project's map: each file with its hotspot numbers, by path. */
    async exportFiles(projectKey: string): Promise<ExportCodeFile[]> {
      const files = await r.mapFiles(projectKey);
      const hot = new Map((await views.hotspots(projectKey, files.length, { includeTests: true })).map((x) => [x.path, x]));
      return files.map((f) => {
        const { path: _, ...h } = hot.get(f.path)!;
        return { projectKey, path: f.path, lang: f.lang, loc: f.loc, isTest: f.isTest, ...h };
      });
    },

    async lessonsForPaths(projectKey: string, paths: string[], run: string | null = null): Promise<{ lesson: Lesson; paths: string[] }[]> {
      const files = [...new Set(paths)];
      if (!files.length) return [];
      const [rows, lessons] = await Promise.all([r.missesOn(projectKey, files, run), r.approvedLessons(projectKey, run)]);
      return lessonsFor(lessons, files, groupMisses(rows), projectKey);
    },
  };
  return views;
}

// ── Search: which symbols and files a question is about (Ask) ─────────

/** Words of a question that never name code. */
const STOPWORDS = new Set(
  (
    'the and for with how what where when why which who whom whose should would could can will does did doing done add adding added new ' +
    'create creating make making build building implement implementing want wants need needs use used uses using reuse have has had get ' +
    'put into onto from that this these those there here our ours your yours you are was were been being about like some any all every ' +
    'everywhere each other others more most many much also just only then than them they their its not but out way thing things one two ' +
    'code please help show tell find give look see know think let lets via per such very really still within without between ' +
    'over under above below after before again able goes going went come comes already yet exist exists existing currently ' +
    'anything something somewhere anywhere maybe'
  ).split(' '),
);
/**
 * Words that do name code, but so much of it that a hit on them alone says nothing: next to a more specific word of
 * the question, a symbol or file matching only these is no hit ("modal component" finds modals, not `components`).
 */
export const GENERIC = new Set(
  ('list item data value type util utils helper component element info base common core main index default config ' +
    'set get handle handler manager service model view state store result error').split(' '),
);
/** Words a question may use for the same thing a file is named by (both ways). */
const SYNONYMS: Record<string, string[]> = { modal: ['dialog'], dialog: ['modal'], popup: ['popover'], popover: ['popup'] };
const MIN_TERM = 3;
const MAX_TERMS = 24;

/** One word folded for matching: lower case, plural to singular ("modals" -> "modal", "entries" -> "entry", "classes" -> "class"). */
export function foldTerm(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 3 || /(ss|us|is)$/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(aches|iches)$/.test(w)) return w.slice(0, -1);
  if (/(sses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
  return w.endsWith('s') ? w.slice(0, -1) : w;
}

/** The words of an identifier or a path segment: camelCase, PascalCase, ACRONYMWord, snake_case and kebab-case split. */
const wordsOf = (s: string): string[] =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);

/**
 * The terms of a question that can name code: its words and identifiers (an identifier also as its parts), folded,
 * stopwords and words shorter than three letters dropped, unique, in order of appearance; at most `max` of them.
 */
export function codeTerms(text: string, max = MAX_TERMS): string[] {
  const out = new Set<string>();
  for (const raw of text.match(/[A-Za-z][A-Za-z0-9_]*/g) ?? []) {
    const parts = wordsOf(raw);
    for (const w of [raw.replace(/_/g, ''), ...(parts.length > 1 ? parts : [])]) {
      const t = foldTerm(w);
      if (t.length >= MIN_TERM && !STOPWORDS.has(t) && !STOPWORDS.has(w.toLowerCase())) out.add(t);
    }
  }
  return [...out].slice(0, max);
}

/** A symbol or a file a question is about, with where it is used and the tests that cover it. */
export type CodeMapHit = {
  kind: 'symbol' | 'file';
  path: string;
  /** The symbol's name; null for a file hit. */
  name: string | null;
  symbolKind: SymbolKind | null;
  lines: string | null;
  exported: boolean;
  /** The (folded) terms it matched. */
  matched: string[];
  /** Files importing it by name, then the other files importing its file (tests left out), at most maxUsages. */
  usages: string[];
  /** Files importing its file (tests left out). */
  dependents: number;
  /** Test files importing its file, directly or through one importer. Sorted. */
  tests: string[];
  /** How well it matched: 3 per exact name, 2 per word of its name, 1 per folder or synonym word. */
  score: number;
  /** A file past the cap (in the import index, not the map): its name and importers are known, its symbols are not. */
  outside: boolean;
};

export type FindOpts = { limit?: number; maxUsages?: number };

const FIND_LIMIT = 8;
const FIND_USAGES = 12;
/** Hits from one file, at most: a big file must not fill the list with its methods. */
const PER_FILE = 3;
/**
 * How a term matches a name: 3 the whole name, 2 one of its words (camelCase, snake_case and kebab-case split), 0 not
 * at all. Never inside a word: "already" is no match for a name whose word is "alreadymerged". A synonym (modal for
 * dialog) counts one less.
 */
function strength(term: string, name: string): number {
  const whole = foldTerm(name.replace(/[^A-Za-z0-9]/g, ''));
  const words = wordsOf(name).map(foldTerm);
  const of = (t: string) => (whole === t ? 3 : words.includes(t) ? 2 : 0);
  return Math.max(of(term), ...(SYNONYMS[term] ?? []).map((t) => Math.max(0, of(t) - 1)));
}

/**
 * The symbols and files of a code map a question's terms name (codeTerms; terms are folded here too). Symbols match by
 * name, files by basename or folder when none of their symbols did (files past the cap, in `outside`, too), by whole
 * words only; a hit matching only GENERIC words is dropped when the question has a more specific one. Ranked by how
 * well they matched (more terms and exact names first), then exported, then how many files depend on them, then path.
 * Test files, secret files and files that are not code are never hits: a hit lists its tests instead.
 */
export function findInCodeMap(map: Pick<StoredCodeMap, 'files' | 'symbols' | 'imports'> & { outside?: MapFile[] }, terms: string[], opts: FindOpts = {}): CodeMapHit[] {
  const want = [...new Set(terms.map(foldTerm).filter((t) => t.length >= MIN_TERM))];
  if (!want.length) return [];
  // Next to a specific word, a hit on generic words only is dropped.
  const specific = want.some((t) => !GENERIC.has(t));
  const tells = (matched: string[]) => !specific || matched.some((t) => !GENERIC.has(t));
  const limit = opts.limit ?? FIND_LIMIT;
  const maxUsages = opts.maxUsages ?? FIND_USAGES;
  // Files past the cap (the import index) have no symbols, but their names and importers are known.
  const allFiles = [...map.files, ...(map.outside ?? [])];
  const past = new Set((map.outside ?? []).map((f) => f.path));
  const byPath = new Map(allFiles.map((f) => [f.path, f]));
  const isTest = (p: string) => byPath.get(p)?.isTest ?? false;
  const importers = new Map<string, MapImport[]>();
  for (const i of map.imports) {
    if (i.to.startsWith('pkg:') || i.from === i.to) continue;
    const list = importers.get(i.to);
    if (list) list.push(i);
    else importers.set(i.to, [i]);
  }
  const importersOf = (p: string) => [...new Set((importers.get(p) ?? []).map((i) => i.from))].sort(cmp);
  const testsOf = (p: string) => {
    const direct = importersOf(p);
    const near = direct.filter((x) => !isTest(x)).flatMap(importersOf);
    return [...new Set([...direct, ...near].filter(isTest))].sort(cmp);
  };
  const usable = (f: MapFile | undefined): f is MapFile => !!f && !f.isTest && isCodeLang(f.lang) && !isSecretPath(f.path);
  const around = (p: string, name: string | null) => {
    const users = importersOf(p).filter((x) => !isTest(x));
    const byName = name ? [...new Set((importers.get(p) ?? []).filter((i) => i.names.includes(name)).map((i) => i.from))].filter((x) => !isTest(x)).sort(cmp) : [];
    return { usages: [...byName, ...users.filter((x) => !byName.includes(x))].slice(0, maxUsages), dependents: users.length, tests: testsOf(p) };
  };

  const hits: CodeMapHit[] = [];
  const withSymbols = new Set<string>();
  for (const s of map.symbols) {
    if (!usable(byPath.get(s.path))) continue;
    const matched = want.map((t) => [t, strength(t, s.name)] as const).filter(([, n]) => n > 0);
    if (!matched.length || !tells(matched.map(([t]) => t))) continue;
    withSymbols.add(s.path);
    hits.push({
      kind: 'symbol', path: s.path, name: s.name, symbolKind: s.kind, lines: s.lines, exported: s.exported,
      matched: matched.map(([t]) => t), score: matched.reduce((n, [, x]) => n + x, 0), outside: false, ...around(s.path, s.name),
    });
  }
  for (const f of allFiles) {
    if (!usable(f) || withSymbols.has(f.path)) continue;
    const segments = f.path.split('/');
    const name = segments.pop()!.replace(/\.[^.]+$/, '');
    const matched = want
      .map((t) => [t, Math.max(strength(t, name), ...segments.map((d) => Math.min(1, strength(t, d))))] as const)
      .filter(([, n]) => n > 0);
    if (!matched.length || !tells(matched.map(([t]) => t))) continue;
    hits.push({
      kind: 'file', path: f.path, name: null, symbolKind: null, lines: null, exported: false,
      matched: matched.map(([t]) => t), score: matched.reduce((n, [, x]) => n + x, 0), outside: past.has(f.path), ...around(f.path, null),
    });
  }
  hits.sort((a, b) => b.score - a.score || Number(b.exported) - Number(a.exported) || b.dependents - a.dependents || cmp(a.path, b.path) || cmp(a.name ?? '', b.name ?? ''));
  const perFile = new Map<string, number>();
  const out: CodeMapHit[] = [];
  for (const h of hits) {
    const n = perFile.get(h.path) ?? 0;
    if (n >= PER_FILE) continue;
    perFile.set(h.path, n + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}
