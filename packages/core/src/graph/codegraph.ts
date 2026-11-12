import { conditionalWrite } from './conditionalWrite.ts';
import { randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import {
  cmp,
  CODE_MAP_LEASE_RENEW_MS,
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
import { redactSecrets } from '../redact.ts';
import type { Cause } from '../types.ts';
import { FactsRepo, PROJECT_PATH } from './facts.ts';
import { KnowledgeRepo } from './knowledge.ts';
import type { GraphRepo } from './repo.ts';
import { VISIBLE_TO_RUN } from './runs.ts';

/**
 * Rows per UNWIND statement: big repos are written in slices, each its own transaction (replaceCodeMap). Sized for the
 * small profile's 32 MiB per transaction (docker-compose.small.yml) with room to spare: on a 7,000-file monorepo
 * 10,000 symbols overran it.
 */
const SLICE = 2000;
/** Files per MERGE statement: a file row MERGEs its node and its project link, about 9 KiB each (4,000 overran 32 MiB). */
const FILE_SLICE = 1000;
/** Files per symbol-delete statement: a file can define many symbols, so fewer of them per transaction. */
const PATH_SLICE = 500;
/** Relationships/nodes per cleanup transaction; deletes retain more transaction memory than UNWIND writes. */
const DELETE_SLICE = 250;
const slices = <T>(xs: T[], size = SLICE): T[][] => (xs.length ? Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size)) : []);

/** Enough for any project's approved lessons; path matching happens after the read. */
const LESSON_LIMIT = 5000;

type Props = Record<string, unknown>;

/** Mark the old test graph in bounded transactions before a replacement revives the current generation. */
export async function markTestsPending(g: Pick<GraphRepo, 'run'>, key: string, now: string): Promise<void> {
  for (;;) {
    const [row] = await g.run(
      `MATCH (:CodeFile {projectKey: $key})-[r:TESTS]->()
       WHERE r.pendingRemoval IS NULL
       WITH r LIMIT $limit
       SET r.pendingRemoval = $now
       RETURN count(r) AS marked`,
      { key, now, limit: neo4j.int(DELETE_SLICE) },
    );
    const marked = row ? neo4j.integer.toNumber(row.get('marked')) : 0;
    if (marked < DELETE_SLICE) return;
  }
}

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
    // `mappedAt` is user-visible build metadata, not a safe generation key: two small maps can be replaced in the
    // same millisecond. A per-write nonce makes stale-file detection exact even then.
    const generation = randomUUID();
    const files = map.files.map((f) => ({ ...f, namespaces: f.namespaces ?? null, churnCommits: map.churn[f.path]?.commits ?? null, churnLastTs: map.churn[f.path]?.lastTs ?? null }));
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
    /** Runs `cypher` (bounded by $limit, returning `removed`) until a run finds fewer than $limit rows. */
    const drain = async (cypher: string, params: Props = {}): Promise<void> => {
      for (;;) {
        const [row] = await this.g.run(cypher, { ...params, key, limit: neo4j.int(DELETE_SLICE) });
        const removed = row ? neo4j.integer.toNumber(row.get('removed')) : 0;
        if (removed < DELETE_SLICE) return;
      }
    };
    // Clear the generation marker before any destructive work. Every statement below is bounded (slices, or drained in
    // batches): one over the whole project exceeded Neo4j's transaction-memory budget on large repositories.
    // writingAt tells a write in progress from one cut short (codeMapMeta, /api/status); writingBeat is its lease, renewed
    // by a timer while this runs, so a write whose worker was killed reads as interrupted within CODE_MAP_LEASE_MS.
    await this.g.run('MATCH (m:CodeMap {projectKey: $key}) SET m.fingerprint = null, m.writingAt = $now, m.writingBeat = $now', { key, now });
    const lease = setInterval(() => {
      this.g.run('MATCH (m:CodeMap {projectKey: $key}) WHERE m.fingerprint IS NULL SET m.writingBeat = $beat', { key, beat: new Date().toISOString() })
        .catch(() => {});
    }, CODE_MAP_LEASE_RENEW_MS);
    lease.unref();
    try {
      // Keep the last good TESTS graph visible until the replacement has been written. Mark old edges, revive the ones
      // present in this generation below, and delete only the remainder after every slice succeeds. A failed rebuild
      // therefore cannot empty test reachability.
      await markTestsPending(this.g, key, now);
      const statements: [string, Props][] = [
        // The project exists even for a map with no files, as in Postgres (the file slices below MERGE it otherwise).
        [`MERGE (:Project {key: $key})`, { key }],
        ...slices(diff.staleImports).map((part): [string, Props] => [
          `UNWIND $pairs AS e
             MATCH (a:CodeFile {id: $key + ':' + e.from})-[r:IMPORTS]->(b)
             WHERE coalesce(b.path, b.name) = e.to
             DELETE r`,
          { key, pairs: part },
        ]),
        ...slices(diff.symbolPaths, PATH_SLICE).map((part): [string, Props] => [
          `MATCH (s:Symbol {projectKey: $key}) WHERE s.path IN $paths DETACH DELETE s`,
          { key, paths: part },
        ]),
        ...slices(files, FILE_SLICE).map((part): [string, Props] => [
          `MERGE (p:Project {key: $key})
           WITH p
           UNWIND $files AS f
             MERGE (cf:CodeFile {id: $key + ':' + f.path})
               ON CREATE SET cf.projectKey = $key, cf.path = f.path, cf.removed = false
             SET cf.inMap = true, cf.lang = f.lang, cf.codeHash = f.hash, cf.loc = f.loc, cf.isTest = f.isTest, cf.csNamespaces = f.namespaces,
                 cf.churnCommits = f.churnCommits, cf.churnLastTs = f.churnLastTs, cf.mappedAt = $now,
                 cf.mapGeneration = $generation
            REMOVE cf.mapUnselectedAt
             REMOVE cf.inIndex
             MERGE (cf)-[:IN]->(p)`,
          { key, files: part, now, generation },
        ]),
        ...slices(map.outside.map((f) => ({ ...f, namespaces: f.namespaces ?? null })), FILE_SLICE).map((part): [string, Props] => [
          `MERGE (p:Project {key: $key})
           WITH p
           UNWIND $files AS f
             MERGE (cf:CodeFile {id: $key + ':' + f.path})
               ON CREATE SET cf.projectKey = $key, cf.path = f.path, cf.removed = false
             SET cf.inMap = false, cf.inIndex = true, cf.lang = f.lang, cf.codeHash = f.hash, cf.loc = f.loc, cf.isTest = f.isTest,
                 cf.csNamespaces = f.namespaces, cf.mappedAt = $now, cf.mapGeneration = $generation
            REMOVE cf.mapUnselectedAt
             REMOVE cf.churnCommits, cf.churnLastTs
             MERGE (cf)-[:IN]->(p)`,
          { key, files: part, now, generation },
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
        ...slices(map.tests).map((part): [string, Props] => [
          `UNWIND $tests AS t
             MATCH (a:CodeFile {id: $key + ':' + t.test})
             MATCH (b:CodeFile {id: $key + ':' + t.target})
             MERGE (a)-[r:TESTS]->(b)
             REMOVE r.pendingRemoval`,
          { key, tests: part },
        ]),
        [
          `MERGE (m:CodeMap {projectKey: $key})
           SET m.fingerprint = $fingerprint, m.builtAt = $now, m.files = $stats.files, m.symbols = $stats.symbols,
               m.imports = $stats.imports, m.tests = $stats.tests, m.candidates = $candidates, m.unresolved = $unresolved,
               m.version = $version
           REMOVE m.lastFailureAt, m.lastFailure, m.writingAt, m.writingBeat`,
          { key, fingerprint: map.fingerprint, now, stats: map.stats, candidates: map.candidates, unresolved: map.unresolved ?? null, version: map.version },
        ],
      ];
      // Publish metadata only after every bounded cleanup and write succeeds. A partial build therefore remains stale.
      const publish = statements.pop()!;
      for (const [cypher, params] of statements) await this.g.run(cypher, params);
      // Retire old files only after all fallible writes above have succeeded. Until this point a failed rebuild keeps
      // the previous files mapped, so its retained TESTS graph remains usable. The nonce, rather than mappedAt, avoids
      // treating two replacements in the same millisecond as one generation.
      await drain(`MATCH (cf:CodeFile {projectKey: $key}) WHERE cf.inMap = true AND coalesce(cf.mapGeneration, '') <> $generation
        WITH cf LIMIT $limit SET cf.inMap = false
        REMOVE cf.lang, cf.codeHash, cf.loc, cf.isTest, cf.csNamespaces, cf.churnCommits, cf.churnLastTs, cf.mappedAt
        RETURN count(*) AS removed`, { generation });
      await drain(`MATCH (cf:CodeFile {projectKey: $key}) WHERE cf.inIndex = true AND coalesce(cf.mapGeneration, '') <> $generation
        WITH cf LIMIT $limit REMOVE cf.inIndex
        FOREACH (_ IN CASE WHEN coalesce(cf.inMap, false) THEN [] ELSE [1] END | REMOVE cf.lang, cf.codeHash, cf.loc, cf.isTest, cf.csNamespaces, cf.mappedAt)
        RETURN count(*) AS removed`, { generation });
      await drain(`MATCH (:CodeFile {projectKey: $key})-[r:TESTS]->() WHERE r.pendingRemoval IS NOT NULL
        WITH r LIMIT $limit DELETE r RETURN count(*) AS removed`);
      // TESTS edges deliberately protected the prior graph during the build. Once stale ones are gone, delete files
      // that left the map and have no independent facts, scans or session references.
      await drain(`MATCH (cf:CodeFile {projectKey: $key}) WHERE coalesce(cf.inMap, false) = false
        AND coalesce(cf.inIndex, false) = false AND cf.hash IS NULL
        AND COUNT { (cf)-[r]-() WHERE type(r) <> 'IN' } = 0
        WITH cf LIMIT $limit DETACH DELETE cf RETURN count(*) AS removed`);
      await drain(`MATCH (m:Module {projectKey: $key}) WHERE NOT EXISTS { ()-[:IMPORTS]->(m) }
        WITH m LIMIT $limit DETACH DELETE m RETURN count(*) AS removed`);
      await drain(`MATCH (cf:CodeFile {projectKey: $key}) WHERE cf.mapGeneration IS NOT NULL
        WITH cf LIMIT $limit REMOVE cf.mapGeneration RETURN count(*) AS removed`);
      await this.g.run(publish[0], publish[1]);
      return map.stats;
    } finally {
      clearInterval(lease);
    }
  }

  async markCodeMapChecked(projectKey: string, now = new Date()): Promise<void> {
    await this.g.run('MATCH (m:CodeMap {projectKey: $key}) SET m.checkedAt = $now', { key: projectKey, now: now.toISOString() });
  }

  async recordCodeMapFailure(projectKey: string, error: string, now = new Date()): Promise<void> {
    await this.g.run(`MATCH (m:CodeMap {projectKey: $key})
      SET m.lastFailureAt = $now, m.lastFailure = $error`, { key: projectKey, now: now.toISOString(), error: redactSecrets(error).slice(0, 500) });
  }

  async purgeOrphanCodeFiles(limit: number, now = new Date()): Promise<number> {
    if (!Number.isFinite(limit) || limit < 1) return 0;
    const cutoff = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    // Every phase is bounded, including symbols/edges of a large deselected map. Keep the
    // metadata until the last batch so a subsequent retention pass resumes unfinished work.
    const batch = neo4j.int(Math.min(250, Math.floor(limit)));
    const selectedMap = `MATCH (s:ProjectSelection {id: 'selection'}), (m:CodeMap)
      WHERE s.initialized = true AND coalesce(m.unselectedAt, s.updatedAt) < $cutoff AND NOT m.projectKey IN s.tracked
      WITH m ORDER BY m.projectKey LIMIT 1`;
    await this.g.runInTransaction([
      [`MATCH (s:ProjectSelection {id: 'selection'}) SET s.mapPurgeLock = true REMOVE s.mapPurgeLock`, {}],
      [`${selectedMap} SET m.rebuildRequestedAt = $now`, { cutoff, now: now.toISOString() }],
      [`${selectedMap} MATCH (symbol:Symbol {projectKey: m.projectKey})
        WITH symbol LIMIT $batch DETACH DELETE symbol`, { cutoff, batch }],
      [`${selectedMap} MATCH (cf:CodeFile {projectKey: m.projectKey})-[r:IMPORTS|TESTS]->()
        WITH r LIMIT $batch DELETE r`, { cutoff, batch }],
      [`${selectedMap} MATCH (cf:CodeFile {projectKey: m.projectKey})
        WHERE coalesce(cf.inMap, false) OR coalesce(cf.inIndex, false) OR cf.codeHash IS NOT NULL
        WITH cf, m LIMIT $batch SET cf.inMap = false, cf.inIndex = false,
          cf.mapUnselectedAt = coalesce(m.unselectedAt, $now)
        REMOVE cf.lang, cf.codeHash, cf.loc, cf.isTest, cf.csNamespaces, cf.churnCommits, cf.churnLastTs, cf.mappedAt`, { cutoff, batch, now: now.toISOString() }],
      [`${selectedMap} MATCH (module:Module {projectKey: m.projectKey})
        WHERE NOT EXISTS { ()-[:IMPORTS]->(module) }
        WITH module LIMIT $batch DETACH DELETE module`, { cutoff, batch }],
      [`${selectedMap} WITH m
        WHERE NOT EXISTS { (:Symbol {projectKey: m.projectKey}) }
          AND NOT EXISTS { (:CodeFile {projectKey: m.projectKey})-[:IMPORTS|TESTS]->() }
          AND NOT EXISTS { MATCH (cf:CodeFile {projectKey: m.projectKey})
            WHERE coalesce(cf.inMap, false) OR coalesce(cf.inIndex, false) OR cf.codeHash IS NOT NULL }
          AND NOT EXISTS { MATCH (module:Module {projectKey: m.projectKey}) WHERE NOT EXISTS { ()-[:IMPORTS]->(module) } }
        DETACH DELETE m`, { cutoff }],
    ]);
    const [r] = await this.g.run(
      // inMap is unset (not false) on a file that was never mapped: a session's touch creates the node, and when the
      // session is read again without it nothing refers to it. Never mapped and never scanned (no hash, the scan's
      // memory of the file), it goes whatever its project; scanned files also expire when their project is deselected.
      `MATCH (cf:CodeFile) WHERE coalesce(cf.inMap, false) = false AND coalesce(cf.inIndex, false) = false
         AND (cf.removed = true OR cf.hash IS NULL OR NOT EXISTS { (cf)-[:IN]->(:Project) }
           OR EXISTS { MATCH (selection:ProjectSelection {id: 'selection'})
             WHERE selection.initialized = true AND coalesce(cf.mapUnselectedAt, selection.updatedAt) < $cutoff
               AND NOT cf.projectKey IN selection.tracked })
         AND NOT EXISTS { (cf)-[r]-() WHERE type(r) <> 'IN' }
       WITH cf LIMIT $limit
       DETACH DELETE cf
       RETURN count(*) AS n`,
      { limit: batch, cutoff },
    );
    return r ? neo4j.integer.toNumber(r.get('n')) : 0;
  }

  /** Drop only derived map data; source facts and immutable session evidence stay. */
  async dropCodeMap(projectKey: string): Promise<boolean> {
    if (!(await this.codeMapMeta(projectKey))) return false;
    const phases = [
      'MATCH (x:Symbol {projectKey: $key}) WITH x LIMIT 250 DETACH DELETE x RETURN count(*) AS n',
      'MATCH (f:CodeFile {projectKey: $key})-[x:IMPORTS|TESTS]->() WITH x LIMIT 250 DELETE x RETURN count(*) AS n',
      `MATCH (x:CodeFile {projectKey: $key}) WHERE coalesce(x.inMap, false) OR coalesce(x.inIndex, false) OR x.codeHash IS NOT NULL
       WITH x LIMIT 250 SET x.inMap = false, x.inIndex = false, x.mapUnselectedAt = $now
       REMOVE x.lang, x.codeHash, x.loc, x.isTest, x.csNamespaces, x.churnCommits, x.churnLastTs, x.mappedAt RETURN count(*) AS n`,
      'MATCH (x:Module {projectKey: $key}) WITH x LIMIT 250 DETACH DELETE x RETURN count(*) AS n',
    ];
    const now = new Date().toISOString();
    for (const query of phases) { for (;;) { const [row] = await this.g.run(query, { key: projectKey, now }); if (Number(row?.get('n') ?? 0) < 250) break; } }
    await this.g.run('MATCH (m:CodeMap {projectKey: $key}) DETACH DELETE m', { key: projectKey });
    return true;
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
      // ISO strings of one format, so the later one is the greater.
      checkedAt: m.checkedAt > m.builtAt ? m.checkedAt : m.builtAt,
      stats: { files: m.files ?? 0, symbols: m.symbols ?? 0, imports: m.imports ?? 0, tests: m.tests ?? 0 },
      candidates: m.candidates ?? null,
      unresolved: m.unresolved ?? null,
      version: m.version == null ? null : Number(m.version),
      lastFailureAt: m.lastFailureAt ?? null,
      lastFailure: m.lastFailure ?? null,
      ...(m.writingAt ? { writingAt: m.writingAt as string } : {}),
      ...(m.writingBeat ? { writingBeat: m.writingBeat as string } : {}),
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
        ...(f.csNamespaces != null && { namespaces: f.csNamespaces as string[] }),
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
