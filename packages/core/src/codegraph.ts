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
import type { Cause, Lesson, ParsedSession } from './types.ts';

export const SYMBOL_KINDS = ['function', 'class', 'interface', 'type', 'const', 'method', 'other'] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/** A file of the map. hash: sha256 of its content (the parser's), not the scanner's sha1. */
export type MapFile = { path: string; lang: string; hash: string; loc: number; isTest: boolean };
/** id: `<path>#<name>` as the parser makes it (not unique: two classes may both have a `save` method). */
export type MapSymbol = { id: string; path: string; name: string; kind: SymbolKind; exported: boolean; lines: string };
/** to: a repo-relative path of a mapped file, or `pkg:<name>` for anything outside the repo. */
export type MapImport = { from: string; to: string; names: string[]; spec: string };
export type FileChurn = { commits: number; lastTs: string };

/** What the worker writes for one project: the whole map, replacing the previous one. */
export type CodeMapWrite = {
  files: MapFile[];
  symbols: MapSymbol[];
  imports: MapImport[];
  /** TESTS edges: `test` imports `target` directly or through one file (codegraph testsFor). */
  tests: { test: string; target: string }[];
  /** Commits per path over the churn window; paths missing from it have 0. */
  churn: Record<string, FileChurn>;
  /** What the repo looked like when the map was built (git HEAD + dirty files); null when it cannot be told. */
  fingerprint: string | null;
};

export type CodeMapStats = { files: number; symbols: number; imports: number; tests: number };
export type CodeMapMeta = { fingerprint: string | null; builtAt: string; stats: CodeMapStats };
/** The stored map, in the parser's shape, so the next build can be incremental. Sorted by path (then position). */
export type StoredCodeMap = CodeMapMeta & { files: MapFile[]; symbols: MapSymbol[]; imports: MapImport[] };

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
   * importers up to that many hops, and the tests covering any of them (TESTS edges). Sorted.
   */
  tests: string[];
  /** Current facts from code scans about this file. */
  facts: StoredFact[];
  misses: FileMiss[];
  /** Approved lessons: derived from those misses, or whose paths cover this file. */
  lessons: Lesson[];
};

export type Impact = {
  /** The paths asked about that are in the map, sorted. */
  paths: string[];
  /** Files that import them, transitively up to the depth, nearest first. */
  dependents: { path: string; depth: number }[];
  /** Tests to run: test files among the paths and dependents, and tests covering any of them. Sorted. */
  tests: string[];
  misses: FileMiss[];
  lessons: Lesson[];
};

/** Where agents keep getting corrected: churn, misses and dependents of a file, and the score they make. */
export type Hotspot = { path: string; churn: number; misses: number; dependents: number; score: number };
/** includeTests: rank test files too (by default they are left out: a busy test file is rarely where agents struggle). */
export type HotspotOpts = { includeTests?: boolean };

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
 * store does not rely on it), one entry per file, per (from, to) import and per (test, target) pair, and only
 * symbols and edges whose files are in the map, so a write never refers to a file it does not hold.
 */
export function normalizeCodeMap(map: CodeMapWrite): Omit<CodeMapWrite, 'symbols'> & { symbols: OrderedSymbol[]; stats: CodeMapStats } {
  const files = [...new Map(map.files.map((f) => [f.path, f])).values()].sort((a, b) => cmp(a.path, b.path));
  const paths = new Set(files.map((f) => f.path));
  const ord = new Map<string, number>();
  const symbols = map.symbols
    .filter((x) => paths.has(x.path))
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
  const churn = Object.fromEntries(Object.entries(map.churn).filter(([p]) => paths.has(p)));
  const fingerprint = map.fingerprint === null ? null : redactSecrets(map.fingerprint);
  return {
    files, symbols, imports: [...imports.values()], tests, churn, fingerprint,
    stats: { files: files.length, symbols: symbols.length, imports: imports.size, tests: tests.length },
  };
}

// ── Scores and walks ───────────────────────────────────────────────────

/** Weight of one miss against log2 of churn and of dependents: a file agents got wrong once outranks busy files. */
export const MISS_WEIGHT = 4;

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
  symbolsOf(projectKey: string, path: string): Promise<MapSymbol[]>;
  importsOf(projectKey: string, path: string): Promise<{ to: string; names: string[] }[]>;
  /** Direct importers of each path (every path is a key, with [] when none). */
  importersOf(projectKey: string, paths: string[]): Promise<Map<string, string[]>>;
  /** Test files with a TESTS edge to any of the paths. */
  testsOf(projectKey: string, paths: string[]): Promise<string[]>;
  /** How many files import each mapped file (only files with at least one importer). */
  importerCounts(projectKey: string): Promise<Map<string, number>>;
  /** Misses of the project (feedback not rejected) whose session edited a file, for these paths or all of them. */
  missesOn(projectKey: string, paths: string[] | null): Promise<FileMissRow[]>;
  /** File-to-file IMPORTS and TESTS edges with either end among the paths, sorted. */
  edgesTouching(projectKey: string, paths: string[]): Promise<{ imports: { from: string; to: string }[]; tests: { test: string; target: string }[] }>;
  /** Approved lessons for the project, global ones included. */
  approvedLessons(projectKey: string): Promise<Lesson[]>;
  currentFacts(projectKey: string, path: string): Promise<StoredFact[]>;
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

/** Approved lessons that bear on files: derived from one of the misses, or whose paths cover one of the files. */
export function lessonsFor(lessons: Lesson[], files: string[], misses: FileMiss[]): { lesson: Lesson; paths: string[] }[] {
  const byMiss = new Map(misses.map((m) => [m.missId, m.paths]));
  const out: { lesson: Lesson; paths: string[] }[] = [];
  for (const l of lessons) {
    const matched = new Set(files.filter((f) => l.paths.some((p) => pathMatches(p, f))));
    for (const p of (l.missId && byMiss.get(l.missId)) || []) matched.add(p);
    if (matched.size) out.push({ lesson: l, paths: [...matched].sort(cmp) });
  }
  return out.sort((a, b) => cmp(a.lesson.id, b.lesson.id));
}

/** How many import hops moduleContext follows for its tests: impact's default depth, so the two agree. */
export const MODULE_TESTS_DEPTH = 3;

export function codeGraphViews(r: CodeGraphReads) {
  /** Test files among `files`, and the tests covering any of them. Sorted. */
  const testsFor = async (projectKey: string, files: string[]) => {
    const isTest = new Set((await r.mapFiles(projectKey, files)).filter((f) => f.isTest).map((f) => f.path));
    const covering = await r.testsOf(projectKey, files);
    return [...new Set([...files.filter((p) => isTest.has(p)), ...covering])].sort(cmp);
  };
  /** Every mapped file with its hotspot numbers, highest score first (ties by path), and the miss rows they came from. */
  const scored = async (projectKey: string) => {
    const [files, counts, rows] = await Promise.all([r.mapFiles(projectKey), r.importerCounts(projectKey), r.missesOn(projectKey, null)]);
    const missCount = new Map<string, Set<string>>();
    for (const m of rows) {
      let s = missCount.get(m.path);
      if (!s) missCount.set(m.path, (s = new Set()));
      s.add(m.missId);
    }
    const ranked = files
      .map((f) => {
        const parts = { churn: f.churn?.commits ?? 0, misses: missCount.get(f.path)?.size ?? 0, dependents: counts.get(f.path) ?? 0 };
        return { path: f.path, ...parts, score: hotspotScore(parts), lang: f.lang, loc: f.loc, isTest: f.isTest };
      })
      .sort((a, b) => b.score - a.score || cmp(a.path, b.path));
    return { ranked, rows };
  };
  const views = {
    async moduleContext(projectKey: string, path: string): Promise<ModuleContext | null> {
      const [file] = await r.mapFiles(projectKey, [path]);
      if (!file) return null;
      const [symbols, imports, importers, tests, facts, rows, lessons] = await Promise.all([
        r.symbolsOf(projectKey, path),
        r.importsOf(projectKey, path),
        r.importersOf(projectKey, [path]),
        // Through the importers, as impact does: a test reaching the file in several hops has no TESTS edge to it.
        expandDependents([path], MODULE_TESTS_DEPTH, (ps) => r.importersOf(projectKey, ps)).then((ds) => testsFor(projectKey, [path, ...ds.map((d) => d.path)])),
        r.currentFacts(projectKey, path),
        r.missesOn(projectKey, [path]),
        r.approvedLessons(projectKey),
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
        lessons: lessonsFor(lessons, [path], misses).map((x) => x.lesson),
      };
    },

    async impact(projectKey: string, paths: string[], depth: number): Promise<Impact> {
      const mapped = (await r.mapFiles(projectKey, [...new Set(paths)])).map((f) => f.path);
      const dependents = await expandDependents(mapped, Math.max(0, Math.floor(depth)), (ps) => r.importersOf(projectKey, ps));
      const all = [...mapped, ...dependents.map((d) => d.path)];
      const [tests, rows, lessons] = await Promise.all([testsFor(projectKey, all), r.missesOn(projectKey, all), r.approvedLessons(projectKey)]);
      const misses = groupMisses(rows);
      return {
        paths: mapped,
        dependents,
        tests,
        misses,
        lessons: lessonsFor(lessons, all, misses).map((x) => x.lesson),
      };
    },

    async hotspots(projectKey: string, limit: number, opts: HotspotOpts = {}): Promise<Hotspot[]> {
      const { ranked } = await scored(projectKey);
      return ranked
        .filter((h) => opts.includeTests || !h.isTest)
        .slice(0, Math.max(0, limit))
        .map(({ path, churn, misses, dependents, score }) => ({ path, churn, misses, dependents, score }));
    },

    async mapGraph(projectKey: string, opts: HotspotOpts & { limit: number }): Promise<MapGraph> {
      const limit = Math.max(0, Math.floor(opts.limit));
      const { ranked, rows } = await scored(projectKey);
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
      const lessons = lessonsFor(await r.approvedLessons(projectKey), [...shown].sort(cmp), misses);
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

    async lessonsForPaths(projectKey: string, paths: string[]): Promise<{ lesson: Lesson; paths: string[] }[]> {
      const files = [...new Set(paths)];
      if (!files.length) return [];
      const [rows, lessons] = await Promise.all([r.missesOn(projectKey, files), r.approvedLessons(projectKey)]);
      return lessonsFor(lessons, files, groupMisses(rows));
    },
  };
  return views;
}
