import { conditionalWrite } from './conditionalWrite.ts';
import neo4j from 'neo4j-driver';
import {
  cmp,
  codeGraphViews,
  codeMapDiff,
  normalizeCodeMap,
  type CodeGraphReads,
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
} from '../codegraph.ts';
import type { CodeGraphStore } from '../store.ts';
import type { Cause } from '../types.ts';
import { FactsRepo, PROJECT_PATH } from './facts.ts';
import { KnowledgeRepo } from './knowledge.ts';
import type { GraphRepo } from './repo.ts';
import { VISIBLE_TO_RUN } from './runs.ts';

/** Rows per UNWIND statement: big repos are written in slices, each its own transaction (replaceCodeMap). */
const SLICE = 5000;
/** Files per symbol-delete statement: a file can define many symbols, so fewer of them per transaction. */
const PATH_SLICE = 500;
const slices = <T>(xs: T[], size = SLICE): T[][] => (xs.length ? Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size)) : []);

/** Enough for any project's approved lessons; path matching happens after the read. */
const LESSON_LIMIT = 5000;

type Props = Record<string, unknown>;

/**
 * The code map on Neo4j. Files are the CodeFile nodes facts are ABOUT (id `<projectKey>:<path>`), marked inMap with
 * the map's own properties (codeHash, lang, loc, isTest, churn), next to the scanner's hash/summary/removed. Files of
 * the import index past the cap are marked inIndex instead (lang, codeHash, loc, isTest; no symbols, no churn).
 * (:CodeFile)-[:DEFINES]->(:Symbol), (:CodeFile)-[:IMPORTS {names, spec}]->(:CodeFile | :Module),
 * (:CodeFile)-[:TESTS]->(:CodeFile), (:CodeMap {projectKey}) for the build's fingerprint and size, and
 * (:Session)-[:TOUCHED {read, edited, firstEditAt, lastEditAt}]->(:CodeFile) for the files a session touched.
 */
export class CodeGraphRepo implements CodeGraphStore {
  readonly g: GraphRepo;
  private readonly views: ReturnType<typeof codeGraphViews>;

  constructor(g: GraphRepo) {
    this.g = g;
    const facts = new FactsRepo(g);
    const knowledge = new KnowledgeRepo(g);
    const reads: CodeGraphReads = {
      mapFiles: (key, paths) => this.mapFiles(key, paths),
      outsideFiles: (key, paths) => this.outsideFiles(key, paths),
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

  /**
   * Written as a diff against the stored map, one statement per transaction (each at most one slice): a 4000-file map
   * no longer holds 100k created and deleted rows in one transaction (Neo4j's transaction memory limit), and a rebuild
   * where a few files changed rewrites a few files' symbols and edges. The fingerprint is cleared first and written
   * last, so a write cut short is never taken for a current map (and the stage reparses it from scratch).
   */
  async replaceCodeMap(projectKey: string, raw: CodeMapWrite): Promise<CodeMapStats> {
    const map = normalizeCodeMap(raw);
    const key = projectKey;
    const now = new Date().toISOString();
    const files = map.files.map((f) => ({ ...f, churnCommits: map.churn[f.path]?.commits ?? null, churnLastTs: map.churn[f.path]?.lastTs ?? null }));
    const mapped = files.map((f) => f.path);
    const outsidePaths = map.outside.map((f) => f.path);
    const paths = [...mapped, ...outsidePaths];
    const [storedSymbols, storedImports] = await Promise.all([
      this.g.run('MATCH (s:Symbol {projectKey: $key}) RETURN s', { key }),
      this.g.run(
        `MATCH (a:CodeFile {projectKey: $key})-[r:IMPORTS]->(b)
         RETURN a.path AS from, coalesce(b.path, b.name) AS to, r.names AS names, r.spec AS spec`,
        { key },
      ),
    ]);
    const diff = codeMapDiff(
      {
        symbols: storedSymbols.map((r) => {
          const p = r.get('s').properties;
          return { ...symbolOf(p), ord: p.ord == null ? -1 : neo4j.integer.toNumber(p.ord) };
        }),
        imports: storedImports.map((r) => ({ from: r.get('from'), to: r.get('to'), names: r.get('names') ?? [], spec: r.get('spec') ?? '' })),
      },
      map,
    );
    const fileImports = diff.newImports.filter((i) => !i.to.startsWith('pkg:'));
    const pkgImports = diff.newImports.filter((i) => i.to.startsWith('pkg:'));
    const statements: [string, Props][] = [
      // The project exists even for a map with no files, as in Postgres (the file slices below MERGE it otherwise).
      [`MERGE (:Project {key: $key})`, { key }],
      [`MATCH (m:CodeMap {projectKey: $key}) SET m.fingerprint = null`, { key }],
      ...slices(diff.staleImports).map((part): [string, Props] => [
        `UNWIND $pairs AS e
           MATCH (a:CodeFile {id: $key + ':' + e.from})-[r:IMPORTS]->(b)
           WHERE coalesce(b.path, b.name) = e.to
           DELETE r`,
        { key, pairs: part },
      ]),
      [`MATCH (:CodeFile {projectKey: $key})-[r:TESTS]->() DELETE r`, { key }],
      ...slices(diff.symbolPaths, PATH_SLICE).map((part): [string, Props] => [
        `MATCH (s:Symbol {projectKey: $key}) WHERE s.path IN $paths DETACH DELETE s`,
        { key, paths: part },
      ]),
      [
        `MATCH (cf:CodeFile {projectKey: $key}) WHERE cf.inMap = true AND NOT cf.path IN $paths
         SET cf.inMap = false
         REMOVE cf.lang, cf.codeHash, cf.loc, cf.isTest, cf.churnCommits, cf.churnLastTs, cf.mappedAt`,
        { key, paths: mapped },
      ],
      [
        `MATCH (cf:CodeFile {projectKey: $key}) WHERE cf.inIndex = true AND NOT cf.path IN $paths
         REMOVE cf.inIndex
         WITH cf WHERE coalesce(cf.inMap, false) = false
         REMOVE cf.lang, cf.codeHash, cf.loc, cf.isTest, cf.mappedAt`,
        { key, paths: outsidePaths },
      ],
      // A file that left the map and that nothing else refers to (never scanned, no fact about it, no session touched
      // it) goes: its symbols and edges are gone already, only its IN edge is left.
      [
        `MATCH (cf:CodeFile {projectKey: $key}) WHERE coalesce(cf.inMap, false) = false AND NOT cf.path IN $paths AND cf.hash IS NULL
           AND COUNT { (cf)-[r]-() WHERE type(r) <> 'IN' } = 0
         DETACH DELETE cf`,
        { key, paths },
      ],
      ...slices(files).map((part): [string, Props] => [
        `MERGE (p:Project {key: $key})
         WITH p
         UNWIND $files AS f
           MERGE (cf:CodeFile {id: $key + ':' + f.path})
             ON CREATE SET cf.projectKey = $key, cf.path = f.path, cf.removed = false
           SET cf.inMap = true, cf.lang = f.lang, cf.codeHash = f.hash, cf.loc = f.loc, cf.isTest = f.isTest,
               cf.churnCommits = f.churnCommits, cf.churnLastTs = f.churnLastTs, cf.mappedAt = $now
           REMOVE cf.inIndex
           MERGE (cf)-[:IN]->(p)`,
        { key, files: part, now },
      ]),
      ...slices(map.outside).map((part): [string, Props] => [
        `MERGE (p:Project {key: $key})
         WITH p
         UNWIND $files AS f
           MERGE (cf:CodeFile {id: $key + ':' + f.path})
             ON CREATE SET cf.projectKey = $key, cf.path = f.path, cf.removed = false
           SET cf.inMap = false, cf.inIndex = true, cf.lang = f.lang, cf.codeHash = f.hash, cf.loc = f.loc, cf.isTest = f.isTest,
               cf.mappedAt = $now
           REMOVE cf.churnCommits, cf.churnLastTs
           MERGE (cf)-[:IN]->(p)`,
        { key, files: part, now },
      ]),
      ...slices(diff.symbols).map((part): [string, Props] => [
        `UNWIND $symbols AS s
           MATCH (cf:CodeFile {id: $key + ':' + s.path})
           CREATE (cf)-[:DEFINES]->(:Symbol {projectKey: $key, id: s.id, path: s.path, ord: s.ord, name: s.name, kind: s.kind,
                                             exported: s.exported, lines: s.lines})`,
        { key, symbols: part },
      ]),
      ...slices(fileImports).map((part): [string, Props] => [
        `UNWIND $imports AS i
           MATCH (a:CodeFile {id: $key + ':' + i.from})
           MATCH (b:CodeFile {id: $key + ':' + i.to})
           CREATE (a)-[:IMPORTS {names: i.names, spec: i.spec}]->(b)`,
        { key, imports: part },
      ]),
      ...slices(pkgImports).map((part): [string, Props] => [
        `UNWIND $imports AS i
           MATCH (a:CodeFile {id: $key + ':' + i.from})
           MERGE (m:Module {id: $key + ':' + i.to}) ON CREATE SET m.projectKey = $key, m.name = i.to
           CREATE (a)-[:IMPORTS {names: i.names, spec: i.spec}]->(m)`,
        { key, imports: part },
      ]),
      // A package nothing imports any more.
      [`MATCH (m:Module {projectKey: $key}) WHERE NOT EXISTS { ()-[:IMPORTS]->(m) } DETACH DELETE m`, { key }],
      ...slices(map.tests).map((part): [string, Props] => [
        `UNWIND $tests AS t
           MATCH (a:CodeFile {id: $key + ':' + t.test})
           MATCH (b:CodeFile {id: $key + ':' + t.target})
           CREATE (a)-[:TESTS]->(b)`,
        { key, tests: part },
      ]),
      [
        `MERGE (m:CodeMap {projectKey: $key})
         SET m.fingerprint = $fingerprint, m.builtAt = $now, m.files = $stats.files, m.symbols = $stats.symbols,
             m.imports = $stats.imports, m.tests = $stats.tests, m.candidates = $candidates, m.unresolved = $unresolved,
             m.version = $version`,
        { key, fingerprint: map.fingerprint, now, stats: map.stats, candidates: map.candidates, unresolved: map.unresolved ?? null, version: map.version },
      ],
    ];
    for (const [cypher, params] of statements) await this.g.run(cypher, params);
    return map.stats;
  }

  async purgeOrphanCodeFiles(limit: number, now = new Date()): Promise<number> {
    if (!Number.isFinite(limit) || limit < 1) return 0;
    const cutoff = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    // Hold the selection's write lock through map removal: a concurrent reselection cannot interleave its deletes.
    await this.g.runInTransaction([
      [`MATCH (s:ProjectSelection {id: 'selection'}) SET s.mapPurgeLock = true REMOVE s.mapPurgeLock`, {}],
      [`MATCH (s:ProjectSelection {id: 'selection'}), (m:CodeMap)
        WHERE s.initialized = true AND s.updatedAt < $cutoff AND NOT m.projectKey IN s.tracked
        WITH m LIMIT 1
        CALL (m) { MATCH (symbol:Symbol {projectKey: m.projectKey}) DETACH DELETE symbol }
        CALL (m) { MATCH (cf:CodeFile {projectKey: m.projectKey})-[r:IMPORTS|TESTS]-() DELETE r }
        CALL (m) { MATCH (cf:CodeFile {projectKey: m.projectKey}) SET cf.inMap = false, cf.inIndex = false
          REMOVE cf.lang, cf.codeHash, cf.loc, cf.isTest, cf.churnCommits, cf.churnLastTs, cf.mappedAt }
        CALL (m) { MATCH (module:Module {projectKey: m.projectKey}) WHERE NOT EXISTS { ()-[:IMPORTS]->(module) } DETACH DELETE module }
        DETACH DELETE m`, { cutoff }],
    ]);
    const [r] = await this.g.run(
      // inMap is unset (not false) on a file that was never mapped: a session's touch creates the node, and when the
      // session is read again without it nothing refers to it. Never mapped and never scanned (no hash, the scan's
      // memory of the file), it goes whatever its project; scanned files also expire when their project is deselected.
      `MATCH (cf:CodeFile) WHERE coalesce(cf.inMap, false) = false AND coalesce(cf.inIndex, false) = false
         AND (cf.removed = true OR cf.hash IS NULL OR NOT EXISTS { (cf)-[:IN]->(:Project) }
           OR EXISTS { MATCH (selection:ProjectSelection {id: 'selection'})
             WHERE selection.initialized = true AND selection.updatedAt < $cutoff AND NOT cf.projectKey IN selection.tracked })
         AND NOT EXISTS { (cf)-[r]-() WHERE type(r) <> 'IN' }
       WITH cf LIMIT $limit
       DETACH DELETE cf
       RETURN count(*) AS n`,
      { limit: neo4j.int(Math.max(0, Math.floor(limit))), cutoff },
    );
    return r ? neo4j.integer.toNumber(r.get('n')) : 0;
  }

  async requestCodeMapRebuild(projectKey: string): Promise<boolean> {
    return conditionalWrite(this.g, async query => {
      const rows = await query('MATCH (m:CodeMap {projectKey: $key}) SET m.rebuildRequestedAt = $now RETURN m.projectKey AS key', {
        key: projectKey,
        now: new Date().toISOString(),
      });
      return rows.length > 0;
    }, Boolean);
  }

  async codeMapRebuildsRequested(): Promise<{ projectKey: string; requestedAt: string }[]> {
    const rows = await this.g.run(
      `MATCH (m:CodeMap) WHERE m.rebuildRequestedAt IS NOT NULL AND (m.builtAt IS NULL OR m.rebuildRequestedAt > m.builtAt)
       RETURN m.projectKey AS projectKey, m.rebuildRequestedAt AS requestedAt ORDER BY requestedAt, projectKey`,
    );
    return rows.map((r) => ({ projectKey: r.get('projectKey') as string, requestedAt: r.get('requestedAt') as string }));
  }

  async codeMapMeta(projectKey: string): Promise<CodeMapMeta | null> {
    const [r] = await this.g.run('MATCH (m:CodeMap {projectKey: $key}) RETURN m', { key: projectKey });
    if (!r) return null;
    const m = r.get('m').properties;
    return {
      fingerprint: m.fingerprint ?? null,
      builtAt: m.builtAt,
      stats: { files: m.files ?? 0, symbols: m.symbols ?? 0, imports: m.imports ?? 0, tests: m.tests ?? 0 },
      candidates: m.candidates ?? null,
      unresolved: m.unresolved ?? null,
      version: m.version == null ? null : Number(m.version),
    };
  }

  async codeMap(projectKey: string): Promise<StoredCodeMap | null> {
    const meta = await this.codeMapMeta(projectKey);
    if (!meta) return null;
    const [files, outside, symbols, imports] = await Promise.all([
      this.mapFiles(projectKey),
      this.outsideFiles(projectKey),
      this.g.run('MATCH (s:Symbol {projectKey: $key}) RETURN s ORDER BY s.path, s.ord', { key: projectKey }),
      this.g.run(
        `MATCH (a:CodeFile {projectKey: $key})-[r:IMPORTS]->(b)
         RETURN a.path AS from, coalesce(b.path, b.name) AS to, r.names AS names, r.spec AS spec ORDER BY from, to`,
        { key: projectKey },
      ),
    ]);
    return {
      ...meta,
      files: files.map(({ churn: _, ...f }) => f),
      outside: outside.map(({ churn: _, ...f }) => f),
      symbols: symbols.map((r) => symbolOf(r.get('s').properties)),
      imports: imports.map((r) => ({ from: r.get('from'), to: r.get('to'), names: r.get('names') ?? [], spec: r.get('spec') ?? '' })),
    };
  }

  async recordSessionFiles(sessionId: string, files: SessionFile[]): Promise<void> {
    await this.g.run(
      `MATCH (s:Session {id: $id})-[:IN]->(p:Project)
       OPTIONAL MATCH (s)-[old:TOUCHED]->()
       DELETE old
       WITH DISTINCT s, p
       UNWIND $files AS f
         MERGE (cf:CodeFile {id: p.key + ':' + f.path})
           ON CREATE SET cf.projectKey = p.key, cf.path = f.path, cf.removed = false
         MERGE (cf)-[:IN]->(p)
         CREATE (s)-[:TOUCHED {read: f.read, edited: f.edited, firstEditAt: f.firstEditAt, lastEditAt: f.lastEditAt}]->(cf)`,
      { id: sessionId, files: files.filter((f) => f.path && f.path !== PROJECT_PATH) },
    );
  }

  async sessionFiles(sessionId: string): Promise<SessionFile[]> {
    const rows = await this.g.run(
      `MATCH (:Session {id: $id})-[r:TOUCHED]->(cf:CodeFile)
       RETURN cf.path AS path, r.read AS read, r.edited AS edited, r.firstEditAt AS firstEditAt, r.lastEditAt AS lastEditAt
       ORDER BY path`,
      { id: sessionId },
    );
    return rows.map((r) => ({
      path: r.get('path'),
      read: r.get('read') === true,
      edited: r.get('edited') === true,
      firstEditAt: r.get('firstEditAt') ?? null,
      lastEditAt: r.get('lastEditAt') ?? null,
    }));
  }

  async editedPaths(projectKey: string, limit: number): Promise<string[]> {
    const rows = await this.g.run(
      `MATCH (s:Session)-[r:TOUCHED]->(cf:CodeFile {projectKey: $key}) WHERE r.edited = true
       WITH cf.path AS path, max(coalesce(r.lastEditAt, '')) AS last
       RETURN path ORDER BY last DESC, path LIMIT $limit`,
      { key: projectKey, limit: neo4j.int(Math.max(0, Math.floor(limit))) },
    );
    return rows.map((r) => r.get('path'));
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

  private outsideFiles(projectKey: string, paths?: string[]) {
    return this.mapFiles(projectKey, paths, 'inIndex');
  }

  /** Mapped files (inMap), or with `inIndex` the files of the import index past the cap. */
  private async mapFiles(projectKey: string, paths?: string[], mark: 'inMap' | 'inIndex' = 'inMap'): Promise<(MapFile & { churn: FileChurn | null })[]> {
    if (paths && !paths.length) return [];
    const rows = await this.g.run(
      `MATCH (cf:CodeFile {projectKey: $key}) WHERE cf.${mark} = true AND ($paths IS NULL OR cf.path IN $paths)
       RETURN cf ORDER BY cf.path`,
      { key: projectKey, paths: paths ?? null },
    );
    return rows.map((r) => {
      const f = r.get('cf').properties;
      return {
        path: f.path,
        lang: f.lang,
        hash: f.codeHash,
        loc: f.loc,
        isTest: f.isTest === true,
        churn: f.churnCommits == null ? null : { commits: f.churnCommits, lastTs: f.churnLastTs },
      };
    });
  }

  private async symbolsOf(projectKey: string, path: string): Promise<MapSymbol[]> {
    const rows = await this.g.run('MATCH (s:Symbol {projectKey: $key, path: $path}) RETURN s ORDER BY s.ord', { key: projectKey, path });
    return rows.map((r) => symbolOf(r.get('s').properties));
  }

  private async importsOf(projectKey: string, path: string): Promise<{ to: string; names: string[] }[]> {
    const rows = await this.g.run(
      `MATCH (:CodeFile {id: $id})-[r:IMPORTS]->(b) RETURN coalesce(b.path, b.name) AS to, r.names AS names ORDER BY to`,
      { id: `${projectKey}:${path}` },
    );
    return rows.map((r) => ({ to: r.get('to'), names: r.get('names') ?? [] }));
  }

  private async importersOf(projectKey: string, paths: string[]): Promise<Map<string, string[]>> {
    const out = new Map(paths.map((p) => [p, [] as string[]]));
    if (!paths.length) return out;
    const rows = await this.g.run(
      `MATCH (a:CodeFile)-[:IMPORTS]->(b:CodeFile) WHERE b.id IN $ids
       WITH b.path AS path, a.path AS from ORDER BY from
       RETURN path, collect(DISTINCT from) AS froms`,
      { ids: paths.map((p) => `${projectKey}:${p}`) },
    );
    for (const r of rows) out.set(r.get('path'), r.get('froms'));
    return out;
  }

  private async testsOf(projectKey: string, paths: string[]): Promise<string[]> {
    if (!paths.length) return [];
    const rows = await this.g.run(
      `MATCH (t:CodeFile)-[:TESTS]->(b:CodeFile) WHERE b.id IN $ids RETURN DISTINCT t.path AS path ORDER BY path`,
      { ids: paths.map((p) => `${projectKey}:${p}`) },
    );
    return rows.map((r) => r.get('path'));
  }

  private async edgesTouching(projectKey: string, paths: string[]) {
    if (!paths.length) return { imports: [], tests: [] };
    const rows = await this.g.run(
      `MATCH (a:CodeFile {projectKey: $key})-[r:IMPORTS|TESTS]->(b:CodeFile {projectKey: $key})
       WHERE a.path IN $paths OR b.path IN $paths
       RETURN DISTINCT type(r) AS type, a.path AS from, b.path AS to ORDER BY from, to`,
      { key: projectKey, paths },
    );
    const of = (t: string) => rows.filter((r) => r.get('type') === t).map((r) => [r.get('from') as string, r.get('to') as string] as const);
    return {
      imports: of('IMPORTS').map(([from, to]) => ({ from, to })),
      tests: of('TESTS').map(([test, target]) => ({ test, target })),
    };
  }

  private async importerCounts(projectKey: string): Promise<Map<string, number>> {
    const rows = await this.g.run(
      `MATCH (a:CodeFile {projectKey: $key})-[:IMPORTS]->(b:CodeFile) RETURN b.path AS path, count(DISTINCT a) AS n`,
      { key: projectKey },
    );
    return new Map(rows.map((r) => [r.get('path'), r.get('n')]));
  }

  /** A process miss (m.subject 'process': branches, pushes, pull requests) is about no file, so it is on none. */
  private async missesOn(projectKey: string, paths: string[] | null, run: string | null): Promise<FileMissRow[]> {
    if (paths && !paths.length) return [];
    const rows = await this.g.run(
      `MATCH (m:Miss {projectKey: $key})-[:EXPLAINS]->(f:Feedback)-[:FROM_TURN]->(t:Turn)<-[:HAS_TURN]-(s:Session)-[r:TOUCHED]->(cf:CodeFile)
       WHERE r.edited = true AND f.status <> 'rejected' AND m.subject IS NULL AND ($paths IS NULL OR cf.path IN $paths) AND ${VISIBLE_TO_RUN('m')}
       OPTIONAL MATCH (l:Lesson)-[:DERIVED_FROM]->(m)
       RETURN m, f.id AS feedbackId, coalesce(t.text, f.text, '') AS text, s.id AS sessionId, t.ts AS ts, cf.path AS path,
              r.lastEditAt IS NOT NULL AND datetime(r.lastEditAt) > datetime(t.ts) AS fixedHere, min(l.id) AS lessonId`,
      { key: projectKey, paths, run },
    );
    return rows
      .map((r) => {
        const m = r.get('m').properties;
        return {
          missId: m.id as string,
          missed: m.missed as string,
          cause: m.cause as Cause,
          causeExplanation: (m.causeExplanation as string) ?? '',
          feedbackId: r.get('feedbackId'),
          feedbackText: r.get('text'),
          sessionId: r.get('sessionId'),
          ts: r.get('ts'),
          path: r.get('path'),
          fixedHere: r.get('fixedHere') === true,
          lessonId: r.get('lessonId') ?? null,
        };
      })
      .sort((a, b) => cmp(a.missId, b.missId) || cmp(a.path, b.path));
  }
}

function symbolOf(p: Record<string, unknown>): MapSymbol {
  return { id: p.id as string, path: p.path as string, name: p.name as string, kind: p.kind as SymbolKind, exported: p.exported === true, lines: (p.lines as string) ?? '' };
}
