import { beforeAll, expect, test } from 'vitest';
import { CODE_MAP_VERSION, MODULE_TESTS_DEPTH, sessionFiles, type CodeMapWrite } from '../codegraph.ts';
import type { Store } from '../store.ts';
import { describeStores, type StoreProbe } from '../testing/index.ts';
import type { Classification, ParsedSession, PostMortem, Project, ToolCall } from '../types.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const pushback: Classification = { label: 'pushback', confidence: 0.9, summary: 's', signals: [] };
const demo: Project = { key: 'demo', name: 'demo', repoPath: '/projects/demo' };
const HOST = '/Users/me/Vibe/demo';

const file = (path: string, isTest = false) => ({ path, lang: 'typescript', hash: `sha-${path}`, loc: 10, isTest });

/**
 * main.ts -> api.ts -> db.ts <- cli.ts; api.test.ts -> api.ts; db.test.ts -> db.ts; db.ts -> pkg:pg.
 */
function codeMap(o: Partial<CodeMapWrite> = {}): CodeMapWrite {
  return {
    files: [file('src/api.ts'), file('src/cli.ts'), file('src/db.ts'), file('src/main.ts'), file('test/api.test.ts', true), file('test/db.test.ts', true)],
    symbols: [
      { id: 'src/db.ts#Db', path: 'src/db.ts', name: 'Db', kind: 'class', exported: true, lines: '1-20' },
      { id: 'src/db.ts#Db.query', path: 'src/db.ts', name: 'Db.query', kind: 'method', exported: true, lines: '5-9' },
      { id: 'src/api.ts#route', path: 'src/api.ts', name: 'route', kind: 'function', exported: true, lines: '1-4' },
    ],
    imports: [
      { from: 'src/main.ts', to: 'src/api.ts', names: ['route'], spec: './api.ts' },
      { from: 'src/api.ts', to: 'src/db.ts', names: ['Db'], spec: './db.ts' },
      { from: 'src/cli.ts', to: 'src/db.ts', names: ['Db'], spec: './db.ts' },
      { from: 'src/db.ts', to: 'pkg:pg', names: ['Pool'], spec: 'pg' },
      { from: 'test/api.test.ts', to: 'src/api.ts', names: ['route'], spec: '../src/api.ts' },
      { from: 'test/db.test.ts', to: 'src/db.ts', names: ['Db'], spec: '../src/db.ts' },
    ],
    tests: [
      { test: 'test/api.test.ts', target: 'src/api.ts' },
      { test: 'test/api.test.ts', target: 'src/db.ts' },
      { test: 'test/db.test.ts', target: 'src/db.ts' },
    ],
    churn: { 'src/db.ts': { commits: 7, lastTs: '2026-10-20T10:00:00.000Z' }, 'src/api.ts': { commits: 1, lastTs: '2026-10-01T09:00:00.000Z' } },
    fingerprint: 'head:abc',
    ...o,
  };
}

const edit = (path: string, ts: string): ToolCall => ({ name: 'Edit', ts, filePath: `${HOST}/${path}` });

/** A session whose turn 1 is pushback at 10:01; edits before it and (the fix) after it. */
function session(id: string, calls: ToolCall[]): ParsedSession {
  const turns = [0, 1, 2].map((i) => ({
    uuid: `${id}-t${i}`, sessionId: id, ts: `2026-10-01T10:0${i * 2}:00Z`, index: i, text: `turn ${i}`, precedingAssistantText: 'r', precedingToolCalls: [],
  }));
  return { sessionId: id, sourceFile: 'f', cwd: HOST, gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[2].ts, turns, toolCalls: calls };
}

const pm = (missed: string, paths: string[] = []): PostMortem => ({
  taskTitle: 't', missed, cause: 'context_available_ignored', causeExplanation: 'it was in CLAUDE.md', outcome: 'addressed',
  lesson: { title: `lesson for ${missed}`, rule: 'r', appliesWhen: 'a', scope: 'project', paths },
  contextItems: [],
});

describeStores('CodeGraphStore', (h) => {
  let store: Store;
  let probe: StoreProbe;
  beforeAll(() => {
    store = h.store;
    probe = h.probe;
  });

  /** Ingest a session with its touched files and run its post-mortem; returns the feedback id. */
  async function miss(id: string, calls: ToolCall[], missed = `missed in ${id}`, o: { reject?: boolean; paths?: string[]; subject?: 'process' } = {}) {
    const s = session(id, calls);
    await store.graph.upsertSession(demo, s, []);
    await store.codegraph.recordSessionFiles(id, sessionFiles(s, HOST));
    await store.graph.saveClassification(`${id}-t1`, pushback, true);
    await store.graph.decide(`${id}-t1`, 'confirmed', null);
    await store.knowledge.savePostmortem(`${id}-t1`, { ...pm(missed, o.paths), ...(o.subject && { subject: o.subject }) }, { miss: vec(1), lesson: vec(1) });
    if (o.reject) await store.graph.decide(`${id}-t1`, 'rejected', null);
    return `${id}-t1`;
  }

  test('replaceCodeMap stores the map and reads it back in the parser\'s shape, with its fingerprint and size', async () => {
    expect(await store.codegraph.codeMap('demo')).toBeNull();
    expect(await store.codegraph.codeMapMeta('demo')).toBeNull();
    const stats = await store.codegraph.replaceCodeMap('demo', codeMap());
    expect(stats).toEqual({ files: 6, symbols: 3, imports: 6, tests: 3 });
    const m = (await store.codegraph.codeMap('demo'))!;
    expect(m).toMatchObject({ fingerprint: 'head:abc', stats, builtAt: expect.any(String) });
    expect(m.files).toEqual(codeMap().files);
    expect(m.symbols).toEqual(codeMap().symbols.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
    expect(m.imports.toSorted((a, b) => `${a.from} ${a.to}`.localeCompare(`${b.from} ${b.to}`))).toEqual(
      codeMap().imports.toSorted((a, b) => `${a.from} ${a.to}`.localeCompare(`${b.from} ${b.to}`)),
    );
    expect(await store.codegraph.codeMapMeta('demo')).toEqual({ fingerprint: 'head:abc', builtAt: m.builtAt, stats, candidates: null, unresolved: null, version: null });
    expect(m.outside).toEqual([]);
    expect(await store.codegraph.codeMap('other')).toBeNull();
  });

  test('a map keeps the version of the map rules it was built by; one without (an older worker) reads back null', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap({ version: CODE_MAP_VERSION }));
    expect((await store.codegraph.codeMapMeta('demo'))?.version).toBe(CODE_MAP_VERSION);
    expect((await store.codegraph.codeMap('demo'))?.version).toBe(CODE_MAP_VERSION);
    await store.codegraph.replaceCodeMap('demo', codeMap());
    expect((await store.codegraph.codeMapMeta('demo'))?.version).toBeNull();
  });

  test('the import index past the cap: outside files keep their edges, count as importers, and are never mapped files', async () => {
    // A capped map: src/utils/log.ts and two importers of db.ts are past the cap, in the index only.
    const capped = codeMap({
      outside: [file('src/jobs/sync.ts'), file('src/utils/log.ts'), file('test/sync.test.ts', true)],
      imports: [
        ...codeMap().imports,
        { from: 'src/jobs/sync.ts', to: 'src/db.ts', names: ['Db'], spec: '../db.ts' },
        { from: 'src/jobs/sync.ts', to: 'src/utils/log.ts', names: ['log'], spec: '../utils/log.ts' },
        { from: 'src/api.ts', to: 'src/utils/log.ts', names: ['log'], spec: './utils/log.ts' },
        { from: 'test/sync.test.ts', to: 'src/jobs/sync.ts', names: [], spec: '../src/jobs/sync.ts' },
      ],
      candidates: 9,
    });
    expect(await store.codegraph.replaceCodeMap('demo', capped)).toEqual({ files: 6, symbols: 3, imports: 10, tests: 3 });
    const m = (await store.codegraph.codeMap('demo'))!;
    expect(m.files.map((f) => f.path)).toEqual(codeMap().files.map((f) => f.path));
    expect(m.outside).toEqual([file('src/jobs/sync.ts'), file('src/utils/log.ts'), file('test/sync.test.ts', true)]);
    expect(m.imports).toHaveLength(10);
    // Importers past the cap count: db.ts has three importers, one of them outside the map.
    expect((await store.codegraph.moduleContext('demo', 'src/db.ts'))!.importers).toEqual(['src/api.ts', 'src/cli.ts', 'src/jobs/sync.ts', 'test/db.test.ts']);
    expect((await store.codegraph.hotspots('demo', 10)).find((h) => h.path === 'src/db.ts')?.dependents).toBe(4);
    // A file past the cap has no module context, but the index says who imports it.
    expect(await store.codegraph.moduleContext('demo', 'src/utils/log.ts')).toBeNull();
    expect(await store.codegraph.outsideMap('demo', ['src/utils/log.ts', 'src/db.ts', 'src/nowhere.ts'])).toEqual([
      // api.test.ts covers api.ts, which imports it
      { path: 'src/utils/log.ts', importers: ['src/api.ts', 'src/jobs/sync.ts'], tests: ['test/api.test.ts'] },
    ]);
    expect(await store.codegraph.outsideMap('demo', ['src/jobs/sync.ts'])).toEqual([{ path: 'src/jobs/sync.ts', importers: ['test/sync.test.ts'], tests: ['test/sync.test.ts'] }]);
    const impact = await store.codegraph.impact('demo', ['src/utils/log.ts'], 2);
    expect(impact.paths).toEqual(['src/utils/log.ts']);
    expect(impact.dependents.map((d) => d.path)).toEqual(['src/api.ts', 'src/jobs/sync.ts', 'src/main.ts', 'test/api.test.ts', 'test/sync.test.ts']);
    // Index files are not orphans.
    expect(await store.codegraph.purgeOrphanCodeFiles(100)).toBe(0);
    // A file moving into the map leaves the index (one record), and a map without the index drops it and its edges.
    await store.codegraph.replaceCodeMap('demo', codeMap({ files: [...codeMap().files, file('src/utils/log.ts')], outside: [file('src/jobs/sync.ts')], imports: capped.imports }));
    const moved = (await store.codegraph.codeMap('demo'))!;
    expect(moved.files.map((f) => f.path)).toContain('src/utils/log.ts');
    expect(moved.outside.map((f) => f.path)).toEqual(['src/jobs/sync.ts']);
    expect(moved.imports.some((i) => i.from === 'test/sync.test.ts')).toBe(false);
    await store.codegraph.replaceCodeMap('demo', codeMap());
    const plain = (await store.codegraph.codeMap('demo'))!;
    expect(plain.outside).toEqual([]);
    expect(plain.imports).toHaveLength(6);
    expect(await store.codegraph.outsideMap('demo', ['src/jobs/sync.ts'])).toEqual([]);
    expect(await probe.ids('CodeFile')).not.toContain('demo:src/jobs/sync.ts');
  });

  test('a capped map keeps how many files were worth mapping, never fewer than it holds', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap({ candidates: 10_290 }));
    expect((await store.codegraph.codeMapMeta('demo'))?.candidates).toBe(10_290);
    expect((await store.codegraph.codeMap('demo'))?.candidates).toBe(10_290);
    await store.codegraph.replaceCodeMap('demo', codeMap({ candidates: 2 }));
    expect((await store.codegraph.codeMapMeta('demo'))?.candidates).toBe(6);
    await store.codegraph.replaceCodeMap('demo', codeMap());
    expect((await store.codegraph.codeMapMeta('demo'))?.candidates).toBeNull();
  });

  test('a map keeps how many imports it could not follow to a file, so answers can say the import graph is incomplete', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap({ unresolved: 42 }));
    expect((await store.codegraph.codeMapMeta('demo'))?.unresolved).toBe(42);
    await store.codegraph.replaceCodeMap('demo', codeMap({ unresolved: 0 }));
    expect((await store.codegraph.codeMapMeta('demo'))?.unresolved).toBe(0);
    await store.codegraph.replaceCodeMap('demo', codeMap());
    expect((await store.codegraph.codeMapMeta('demo'))?.unresolved).toBeNull();
  });

  test('editedPaths: the files the project\'s sessions edited, most recently edited first; reads and other projects left out', async () => {
    const a = session('s-a', [edit('src/db.ts', '2026-10-01T10:03:00Z'), { name: 'Read', ts: '2026-10-01T10:00:00Z', filePath: `${HOST}/src/cli.ts` }]);
    const b = session('s-b', [edit('src/api.ts', '2026-10-02T10:03:00Z'), edit('src/db.ts', '2026-09-01T10:03:00Z')]);
    for (const s of [a, b]) {
      await store.graph.upsertSession(demo, s, []);
      await store.codegraph.recordSessionFiles(s.sessionId, sessionFiles(s, HOST));
    }
    expect(await store.codegraph.editedPaths('demo', 10)).toEqual(['src/api.ts', 'src/db.ts']);
    expect(await store.codegraph.editedPaths('demo', 1)).toEqual(['src/api.ts']);
    expect(await store.codegraph.editedPaths('other', 10)).toEqual([]);
  });

  test('a new map replaces the old one: removed files, symbols and edges are gone', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    const next = codeMap({
      files: [file('src/api.ts'), file('src/db.ts'), file('src/main.ts')],
      symbols: [{ id: 'src/db.ts#Db', path: 'src/db.ts', name: 'Db', kind: 'class', exported: true, lines: '1-22' }],
      imports: [{ from: 'src/main.ts', to: 'src/api.ts', names: ['route'], spec: './api.ts' }],
      tests: [],
      churn: {},
      fingerprint: 'head:def',
    });
    expect(await store.codegraph.replaceCodeMap('demo', next)).toEqual({ files: 3, symbols: 1, imports: 1, tests: 0 });
    const m = (await store.codegraph.codeMap('demo'))!;
    expect(m.files.map((f) => f.path)).toEqual(['src/api.ts', 'src/db.ts', 'src/main.ts']);
    expect(m.symbols).toEqual(next.symbols);
    expect(m.imports).toEqual(next.imports);
    expect(await store.codegraph.moduleContext('demo', 'src/cli.ts')).toBeNull();
    expect((await store.codegraph.moduleContext('demo', 'src/db.ts'))!.file.churn).toBeNull();
    expect(await probe.count('Symbol')).toBe(1);
  });

  test('files that left the map are removed on replace, unless a scan, a fact or a session still refers to them', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    // cli.ts was scanned (with a fact); api.test.ts was edited by a session; db.test.ts is only in the map.
    await store.facts.saveFileFacts('demo', { path: 'src/cli.ts', hash: 'sha1-cli', summary: 'the cli' }, [
      { kind: 'convention', statement: 'flags are kebab-case', path: 'src/cli.ts', lines: '1', confidence: 0.9, why: 'w', embedding: vec(2) },
    ], 'ollama:gemma4');
    const s = session('s-touch', [edit('test/api.test.ts', '2026-10-01T10:01:00Z')]);
    await store.graph.upsertSession(demo, s, []);
    await store.codegraph.recordSessionFiles('s-touch', sessionFiles(s, HOST));
    await store.codegraph.replaceCodeMap('demo', codeMap({ files: [file('src/api.ts'), file('src/db.ts'), file('src/main.ts')], symbols: [], imports: [], tests: [] }));
    const ids = await probe.ids('CodeFile');
    expect(ids).not.toContain('demo:test/db.test.ts');
    expect(ids).toContain('demo:src/cli.ts');
    expect(ids.filter((id) => id.startsWith('demo:src/'))).toEqual(expect.arrayContaining(['demo:src/api.ts', 'demo:src/db.ts', 'demo:src/main.ts']));
    expect((await store.codegraph.codeMap('demo'))!.files.map((f) => f.path)).toEqual(['src/api.ts', 'src/db.ts', 'src/main.ts']);
    // What still refers to the files that left is intact.
    expect(await store.facts.fileHashes('demo')).toEqual(new Map([['src/cli.ts', 'sha1-cli']]));
    expect((await store.facts.listFacts({ projectKey: 'demo', path: 'src/cli.ts' })).map((f) => f.statement)).toEqual(['flags are kebab-case']);
    expect((await store.codegraph.sessionFiles('s-touch')).map((f) => [f.path, f.edited])).toEqual([['test/api.test.ts', true]]);
    // Another project's files are never touched.
    await store.codegraph.replaceCodeMap('other', codeMap({ files: [file('src/x.ts')], symbols: [], imports: [], tests: [] }));
    await store.codegraph.replaceCodeMap('demo', codeMap({ files: [file('src/api.ts')], symbols: [], imports: [], tests: [] }));
    expect(await probe.ids('CodeFile')).toContain('other:src/x.ts');
    expect(await probe.ids('CodeFile')).not.toContain('demo:src/main.ts');
  });

  test('a replace that fails part way leaves the previous map as it was', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    const bad = codeMap({
      files: [file('src/only.ts')],
      symbols: [{ id: 'src/only.ts#x', path: 'src/only.ts', name: 'x', kind: { not: 'a primitive' } as never, exported: true, lines: '1-1' }],
      fingerprint: 'head:bad',
    });
    await expect(store.codegraph.replaceCodeMap('demo', bad)).rejects.toThrow();
    // Postgres writes a map in one transaction; Neo4j in slices (its transaction memory is bounded), clearing the
    // fingerprint first. Either way a failed write is never taken for a current map: a null one is reparsed whole.
    const meta = (await store.codegraph.codeMapMeta('demo'))!;
    expect(meta.fingerprint).not.toBe('head:bad');
    if (meta.fingerprint !== null) {
      const m = (await store.codegraph.codeMap('demo'))!;
      expect(m.fingerprint).toBe('head:abc');
      expect(m.files).toHaveLength(6);
      expect(m.symbols).toHaveLength(3);
    }
  });

  test('purgeOrphanCodeFiles deletes files out of every map that are gone from the repo with nothing about them, and nothing else', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    const scanned = (path: string, facts: { statement: string }[] = []) =>
      store.facts.saveFileFacts('demo', { path, hash: `sha1-${path}`, summary: 's' }, facts.map((f) => ({ kind: 'convention' as const, statement: f.statement, path, lines: '1', confidence: 0.9, why: 'w', embedding: vec(2) })), 'ollama:gemma4');
    await scanned('docs/gone.md');
    await scanned('docs/cited.md', [{ statement: 'docs are terse' }]);
    await scanned('docs/kept.md');
    await store.facts.markFilesRemoved('demo', ['docs/gone.md', 'docs/cited.md']);
    expect(await store.codegraph.purgeOrphanCodeFiles(100)).toBe(1);
    const ids = await probe.ids('CodeFile');
    expect(ids).not.toContain('demo:docs/gone.md');
    // A closed fact still cites it; a scanned file still in the repo is the scan's memory of its hash; map files stay.
    expect(ids).toEqual(expect.arrayContaining(['demo:docs/cited.md', 'demo:docs/kept.md', 'demo:src/db.ts']));
    expect(await store.facts.fileHashes('demo')).toEqual(new Map([['docs/kept.md', 'sha1-docs/kept.md']]));
    expect(await store.codegraph.purgeOrphanCodeFiles(100)).toBe(0);
  });

  test('purgeOrphanCodeFiles also deletes files never mapped nor scanned that nothing refers to any more (a session touched them once)', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    const s = session('s-once', [edit('lib/once.ts', '2026-10-01T10:01:00Z'), edit('lib/still.ts', '2026-10-01T10:02:00Z')]);
    await store.graph.upsertSession(demo, s, []);
    await store.codegraph.recordSessionFiles('s-once', sessionFiles(s, HOST));
    // The session is read again and now touched only one of them: the other is referred to by nothing.
    const again = session('s-once', [edit('lib/still.ts', '2026-10-01T10:02:00Z')]);
    await store.codegraph.recordSessionFiles('s-once', sessionFiles(again, HOST));
    await store.facts.saveFileFacts('demo', { path: 'docs/kept.md', hash: 'sha1-kept', summary: 's' }, [], 'ollama:gemma4');
    await store.codegraph.purgeOrphanCodeFiles(100);
    const ids = await probe.ids('CodeFile');
    expect(ids).not.toContain('demo:lib/once.ts');
    // A scanned file is the scan's memory of its hash; map files stay; what the session still touches is intact.
    expect(ids).toEqual(expect.arrayContaining(['demo:docs/kept.md', 'demo:src/db.ts']));
    expect((await store.codegraph.sessionFiles('s-once')).map((f) => f.path)).toEqual(['lib/still.ts']);
    expect(await store.codegraph.purgeOrphanCodeFiles(100)).toBe(0);
  });

  test('deselected maps expire after grace, reselection cancels expiry, and unreferenced scanned rows go too', async () => {
    await store.selection.setTracked(['demo']);
    await store.codegraph.replaceCodeMap('demo', codeMap());
    await store.facts.saveFileFacts('demo', { path: 'docs/scan-only.md', hash: 'scanned', summary: 's' }, [], 'model');
    await store.facts.saveFileFacts('demo', { path: 'docs/cited.md', hash: 'cited', summary: 's' }, [
      { kind: 'convention', statement: 'Keep cited evidence.', path: 'docs/cited.md', lines: '1', confidence: 0.9, why: 'w', embedding: vec(2) },
    ], 'model');
    const work = session('retained-work', [edit('src/db.ts', '2026-10-01T10:01:00Z')]);
    await store.graph.upsertSession(demo, work, []);
    await store.codegraph.recordSessionFiles(work.sessionId, sessionFiles(work, HOST));
    const first = await store.selection.setTracked([]);
    const after = (hours: number) => new Date(Date.parse(first.selection.updatedAt!) + hours * 60 * 60_000);
    await store.codegraph.purgeOrphanCodeFiles(100, after(23));
    expect(await store.codegraph.codeMapMeta('demo')).not.toBeNull();
    expect(await probe.ids('CodeFile')).toContain('demo:docs/scan-only.md');

    await store.selection.setTracked(['demo']);
    await store.codegraph.purgeOrphanCodeFiles(100, after(48));
    expect(await store.codegraph.codeMapMeta('demo')).not.toBeNull();
    expect(await probe.ids('CodeFile')).toContain('demo:docs/scan-only.md');

    await store.selection.setTracked([]);
    await store.codegraph.purgeOrphanCodeFiles(100, after(49));
    expect(await store.codegraph.codeMapMeta('demo')).toBeNull();
    expect(await probe.ids('CodeFile')).not.toContain('demo:docs/scan-only.md');
    expect(await probe.ids('CodeFile')).not.toContain('demo:src/api.ts');
    expect(await probe.ids('CodeFile')).toContain('demo:docs/cited.md');
    expect((await store.codegraph.sessionFiles(work.sessionId)).map(f => f.path)).toEqual(['src/db.ts']);
    expect(await store.facts.listFacts({ projectKey: 'demo' })).toHaveLength(1);
  });

  test('large orphan maps are drained in bounded batches and partial cleanup is rebuilt after reselection', async () => {
    const files = Array.from({ length: 300 }, (_, i) => file(`src/file${i}.ts`));
    await store.selection.setTracked(['demo']);
    await store.codegraph.replaceCodeMap('demo', codeMap({ files, imports: [], tests: [], churn: {},
      symbols: files.map(f => ({ id: `${f.path}#f`, path: f.path, name: 'f', kind: 'function', exported: true, lines: '1' })) }));
    const removed = await store.selection.setTracked([]);
    const future = new Date(Date.parse(removed.selection.updatedAt!) + 48 * 60 * 60_000);
    expect(await store.codegraph.purgeOrphanCodeFiles(7, future)).toBeLessThanOrEqual(7);
    expect(await store.codegraph.codeMapMeta('demo')).not.toBeNull();
    expect((await store.codegraph.codeMapRebuildsRequested()).map(x => x.projectKey)).toContain('demo');
    const remaining = (await probe.ids('CodeFile')).length;
    expect(remaining).toBeGreaterThanOrEqual(293);
    await store.selection.setTracked(['demo']);
    await store.codegraph.purgeOrphanCodeFiles(5000, future);
    expect((await probe.ids('CodeFile')).length).toBe(remaining);
    await store.selection.setTracked([]);
    for (let n = 0; n < 6; n++) await store.codegraph.purgeOrphanCodeFiles(5000, future);
    expect(await store.codegraph.codeMapMeta('demo')).toBeNull();
    expect(await probe.ids('CodeFile')).toEqual([]);
  });

  test('a rebuild asked for stays requested until the map is built again; a project with no map cannot be asked', async () => {
    expect(await store.codegraph.requestCodeMapRebuild('demo')).toBe(false);
    await store.codegraph.replaceCodeMap('demo', codeMap());
    expect(await store.codegraph.codeMapRebuildsRequested()).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    expect(await store.codegraph.requestCodeMapRebuild('demo')).toBe(true);
    expect(await store.codegraph.codeMapRebuildsRequested()).toEqual([{ projectKey: 'demo', requestedAt: expect.any(String) }]);
    await new Promise((r) => setTimeout(r, 5));
    await store.codegraph.replaceCodeMap('demo', codeMap());
    expect(await store.codegraph.codeMapRebuildsRequested()).toEqual([]);
  });

  test('a rebuild where a few files changed reads back exactly like a fresh write of the new map', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    const next = codeMap({
      files: [...codeMap().files.filter((f) => f.path !== 'src/cli.ts'), file('src/new.ts')],
      symbols: [
        ...codeMap().symbols.filter((x) => x.path !== 'src/api.ts'),
        { id: 'src/api.ts#route', path: 'src/api.ts', name: 'route', kind: 'function', exported: true, lines: '1-6' },
        { id: 'src/new.ts#n', path: 'src/new.ts', name: 'n', kind: 'function', exported: false, lines: '1-1' },
      ],
      imports: [
        ...codeMap().imports.filter((i) => i.from !== 'src/cli.ts' && i.to !== 'pkg:pg'),
        { from: 'src/db.ts', to: 'pkg:postgres', names: ['sql'], spec: 'postgres' },
        { from: 'src/new.ts', to: 'src/db.ts', names: ['Db', 'x'], spec: './db.ts' },
      ],
      fingerprint: 'head:def',
    });
    await store.codegraph.replaceCodeMap('demo', next);
    const incremental = (await store.codegraph.codeMap('demo'))!;
    await store.codegraph.replaceCodeMap('fresh', next);
    const fresh = (await store.codegraph.codeMap('fresh'))!;
    const sort = <T extends { from: string; to: string }>(xs: T[]) => xs.toSorted((a, b) => `${a.from} ${a.to}`.localeCompare(`${b.from} ${b.to}`));
    expect(incremental.files).toEqual(fresh.files);
    expect(incremental.symbols).toEqual(fresh.symbols);
    expect(sort(incremental.imports)).toEqual(sort(fresh.imports));
    expect(incremental.stats).toEqual({ files: 6, symbols: 4, imports: 6, tests: 3 });
    expect((await store.codegraph.moduleContext('demo', 'src/db.ts'))!.imports.map((i) => i.to)).toEqual(['pkg:postgres']);
  });

  test('symbol names, import names and specifiers are redacted before they are stored', async () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
    await store.codegraph.replaceCodeMap('demo', codeMap({
      symbols: [{ id: `src/db.ts#${key}`, path: 'src/db.ts', name: key, kind: 'const', exported: false, lines: '1-1' }],
      imports: [{ from: 'src/db.ts', to: 'pkg:x', names: [key], spec: key }],
    }));
    const json = JSON.stringify([await store.codegraph.codeMap('demo'), await probe.rows('Symbol')]);
    expect(json).not.toContain(key);
    expect(json).toContain('[REDACTED]');
  });

  test('moduleContext gives a file\'s symbols, importers, imports, tests, churn and facts', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    await store.facts.saveFileFacts('demo', { path: 'src/db.ts', hash: 'sha1', summary: 'the pool' }, [
      { kind: 'gotcha', statement: 'always release the client', path: 'src/db.ts', lines: '5-9', confidence: 0.9, why: 'leaks', embedding: vec(2) },
    ], 'ollama:gemma4');
    const c = (await store.codegraph.moduleContext('demo', 'src/db.ts'))!;
    expect(c.file).toEqual({ ...file('src/db.ts'), churn: { commits: 7, lastTs: '2026-10-20T10:00:00.000Z' } });
    expect(c.symbols.map((s) => s.name)).toEqual(['Db', 'Db.query']);
    expect(c.importers).toEqual(['src/api.ts', 'src/cli.ts', 'test/db.test.ts']);
    expect(c.imports).toEqual([{ to: 'pkg:pg', names: ['Pool'] }]);
    expect(c.tests).toEqual(['test/api.test.ts', 'test/db.test.ts']);
    // Facts are about the same file node the map wrote: one node, not two.
    expect(c.facts.map((f) => f.statement)).toEqual(['always release the client']);
    expect((await probe.ids('CodeFile')).filter((id) => id === 'demo:src/db.ts')).toHaveLength(1);
    expect(c.misses).toEqual([]);
    expect(c.lessons).toEqual([]);
    expect(await store.codegraph.moduleContext('demo', 'src/nope.ts')).toBeNull();
  });

  test('moduleContext lists the tests that reach a file through several imports, the same ones impact does', async () => {
    // test/e2e.test.ts -> src/main.ts -> src/api.ts -> src/db.ts: three hops, so no TESTS edge points at db.ts.
    const base = codeMap();
    await store.codegraph.replaceCodeMap('demo', codeMap({
      files: [...base.files, file('test/e2e.test.ts', true)],
      imports: [...base.imports, { from: 'test/e2e.test.ts', to: 'src/main.ts', names: ['main'], spec: '../src/main.ts' }],
      tests: [...base.tests, { test: 'test/e2e.test.ts', target: 'src/main.ts' }, { test: 'test/e2e.test.ts', target: 'src/api.ts' }],
    }));
    const c = (await store.codegraph.moduleContext('demo', 'src/db.ts'))!;
    expect(c.tests).toEqual(['test/api.test.ts', 'test/db.test.ts', 'test/e2e.test.ts']);
    expect(c.tests).toEqual((await store.codegraph.impact('demo', ['src/db.ts'], MODULE_TESTS_DEPTH)).tests);
    // A file nothing imports has only its direct tests.
    expect((await store.codegraph.moduleContext('demo', 'src/main.ts'))!.tests).toEqual(['test/e2e.test.ts']);
  });

  test('a mapped file is not a scanned one: the scanner\'s file hashes are untouched by the map', async () => {
    await store.facts.saveFileFacts('demo', { path: 'src/db.ts', hash: 'sha1-db', summary: '' }, [], 'p');
    await store.codegraph.replaceCodeMap('demo', codeMap());
    expect(await store.facts.fileHashes('demo')).toEqual(new Map([['src/db.ts', 'sha1-db']]));
    await store.codegraph.replaceCodeMap('demo', codeMap({ files: [file('src/api.ts')], symbols: [], imports: [], tests: [] }));
    expect(await store.facts.fileHashes('demo')).toEqual(new Map([['src/db.ts', 'sha1-db']]));
    expect((await store.facts.listFacts({ projectKey: 'demo' }))).toEqual([]);
  });

  test('sessions record the repo files they read and edited; recording again replaces them', async () => {
    const s = session('s1', [{ name: 'Read', ts: '2026-10-01T10:00:00Z', filePath: `${HOST}/src/api.ts` }, edit('src/db.ts', '2026-10-01T10:03:00Z')]);
    await store.graph.upsertSession(demo, s, []);
    await store.codegraph.recordSessionFiles('s1', sessionFiles(s, HOST));
    expect(await store.codegraph.sessionFiles('s1')).toEqual([
      { path: 'src/api.ts', read: true, edited: false, firstEditAt: null, lastEditAt: null },
      { path: 'src/db.ts', read: false, edited: true, firstEditAt: '2026-10-01T10:03:00.000Z', lastEditAt: '2026-10-01T10:03:00.000Z' },
    ]);
    await store.codegraph.recordSessionFiles('s1', [{ path: 'src/db.ts', read: true, edited: true, firstEditAt: '2026-10-01T10:03:00.000Z', lastEditAt: '2026-10-01T10:05:00.000Z' }]);
    expect((await store.codegraph.sessionFiles('s1')).map((f) => [f.path, f.read, f.lastEditAt])).toEqual([['src/db.ts', true, '2026-10-01T10:05:00.000Z']]);
    await store.codegraph.recordSessionFiles('no-such-session', [{ path: 'a.ts', read: true, edited: false, firstEditAt: null, lastEditAt: null }]);
    expect(await store.codegraph.sessionFiles('no-such-session')).toEqual([]);
    // Touching a file does not make it a scanned file either.
    expect(await store.facts.fileHashes('demo')).toEqual(new Map());
  });

  test('a miss is linked to the files its session edited, and knows where the fix landed', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    const fid = await miss('s1', [edit('src/api.ts', '2026-10-01T10:00:30Z'), edit('src/db.ts', '2026-10-01T10:00:40Z'), edit('src/db.ts', '2026-10-01T10:03:00Z')]);
    const db = (await store.codegraph.moduleContext('demo', 'src/db.ts'))!;
    expect(db.misses).toEqual([{
      missId: `miss:${fid}`, missed: 'missed in s1', cause: 'context_available_ignored', causeExplanation: 'it was in CLAUDE.md',
      feedbackId: fid, feedbackText: 'turn 1', sessionId: 's1', ts: '2026-10-01T10:02:00Z', paths: ['src/db.ts'], fixedHere: true, lessonId: `lesson:${fid}`,
    }]);
    expect((await store.codegraph.moduleContext('demo', 'src/api.ts'))!.misses).toEqual([expect.objectContaining({ paths: ['src/api.ts'], fixedHere: false })]);
    // Read-only files are not linked.
    expect((await store.codegraph.moduleContext('demo', 'src/main.ts'))!.misses).toEqual([]);
  });

  test('a process miss (branches, pushes, pull requests) is tied to none of the files its session edited', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    await miss('s1', [edit('src/api.ts', '2026-10-01T10:00:30Z'), edit('src/db.ts', '2026-10-01T10:00:40Z')], 'pushed before review', { subject: 'process' });
    expect((await store.codegraph.moduleContext('demo', 'src/db.ts'))!.misses).toEqual([]);
    expect((await store.codegraph.impact('demo', ['src/api.ts'], 3)).misses).toEqual([]);
    expect((await store.codegraph.hotspots('demo', 100)).find((x) => x.path === 'src/api.ts')).toMatchObject({ misses: 0 });
  });

  test('an old miss marked a process miss afterwards (setMissSubject) leaves the files it was on', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    const fid = await miss('s1', [edit('src/db.ts', '2026-10-01T10:00:40Z')], 'pushed before review');
    expect((await store.codegraph.moduleContext('demo', 'src/db.ts'))!.misses).toHaveLength(1);
    expect(await store.knowledge.setMissSubject(`miss:${fid}`, 'process')).toBe(true);
    expect((await store.codegraph.moduleContext('demo', 'src/db.ts'))!.misses).toEqual([]);
    // Once: it has a subject now.
    expect(await store.knowledge.setMissSubject(`miss:${fid}`, 'process')).toBe(false);
    // Undone (a changed rule no longer calls it a process miss): on the file again, read from its session.
    expect(await store.knowledge.setMissSubject(`miss:${fid}`, null)).toBe(true);
    expect((await store.codegraph.moduleContext('demo', 'src/db.ts'))!.misses).toHaveLength(1);
    expect(await store.knowledge.setMissSubject(`miss:${fid}`, null)).toBe(false);
  });

  test('approved lessons reach a file through its misses or through their paths; proposed ones do not', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    const fid = await miss('s1', [edit('src/db.ts', '2026-10-01T10:03:00Z')]);
    expect((await store.codegraph.moduleContext('demo', 'src/db.ts'))!.lessons).toEqual([]);
    await store.knowledge.updateLesson(`lesson:${fid}`, { status: 'approved' }, {});
    await store.knowledge.upsertLesson({ id: 'mem:sql', projectKey: 'demo', title: 'SQL', rule: 'r', appliesWhen: 'a', scope: 'project', paths: ['src/*.ts'], status: 'approved', source: 'memory', embedding: vec(3) });
    await store.knowledge.upsertLesson({ id: 'mem:global', projectKey: null, title: 'G', rule: 'r', appliesWhen: 'a', scope: 'global', paths: ['**/db.ts'], status: 'approved', source: 'memory', embedding: vec(3) });
    await store.knowledge.upsertLesson({ id: 'mem:docs', projectKey: 'demo', title: 'D', rule: 'r', appliesWhen: 'a', scope: 'project', paths: ['docs/**'], status: 'approved', source: 'memory', embedding: vec(3) });
    await store.knowledge.upsertLesson({ id: 'mem:prop', projectKey: 'demo', title: 'P', rule: 'r', appliesWhen: 'a', scope: 'project', paths: ['src/db.ts'], status: 'proposed', source: 'memory', embedding: vec(3) });
    await store.knowledge.upsertLesson({ id: 'mem:else', projectKey: 'other', title: 'E', rule: 'r', appliesWhen: 'a', scope: 'project', paths: ['src/db.ts'], status: 'approved', source: 'memory', embedding: vec(3) });
    expect((await store.codegraph.moduleContext('demo', 'src/db.ts'))!.lessons.map((l) => l.id)).toEqual([`lesson:${fid}`, 'mem:global', 'mem:sql']);
    expect(await store.codegraph.lessonsForPaths('demo', ['src/db.ts', 'README.md'])).toEqual([
      { lesson: expect.objectContaining({ id: `lesson:${fid}` }), paths: ['src/db.ts'] },
      { lesson: expect.objectContaining({ id: 'mem:global' }), paths: ['src/db.ts'] },
      { lesson: expect.objectContaining({ id: 'mem:sql' }), paths: ['src/db.ts'] },
    ]);
    expect(await store.codegraph.lessonsForPaths('demo', [])).toEqual([]);
  });

  test('impact lists dependents by depth, the tests to run, and the misses and lessons on what it touches', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    await miss('s1', [edit('src/main.ts', '2026-10-01T10:03:00Z')]);
    const one = await store.codegraph.impact('demo', ['src/db.ts', 'src/gone.ts'], 1);
    expect(one.paths).toEqual(['src/db.ts']);
    expect(one.dependents).toEqual([{ path: 'src/api.ts', depth: 1 }, { path: 'src/cli.ts', depth: 1 }, { path: 'test/db.test.ts', depth: 1 }]);
    expect(one.tests).toEqual(['test/api.test.ts', 'test/db.test.ts']);
    expect(one.misses).toEqual([]);
    const two = await store.codegraph.impact('demo', ['src/db.ts'], 2);
    expect(two.dependents.filter((d) => d.depth === 2)).toEqual([{ path: 'src/main.ts', depth: 2 }, { path: 'test/api.test.ts', depth: 2 }]);
    expect(two.misses.map((m) => [m.sessionId, m.paths])).toEqual([['s1', ['src/main.ts']]]);
    expect((await store.codegraph.impact('demo', [], 3))).toEqual({ paths: [], dependents: [], tests: [], misses: [], lessons: [] });
  });

  test('hotspots combine churn, misses and dependents, and return the parts', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    await miss('s1', [edit('src/api.ts', '2026-10-01T10:03:00Z')]);
    await miss('s2', [edit('src/api.ts', '2026-10-01T10:03:00Z'), edit('src/main.ts', '2026-10-01T10:03:00Z')]);
    await miss('s3', [edit('src/cli.ts', '2026-10-01T10:03:00Z')], 'rejected one', { reject: true });
    const top = await store.codegraph.hotspots('demo', 3);
    expect(top).toEqual([
      { path: 'src/api.ts', churn: 1, misses: 2, dependents: 2, score: 10.58 },
      { path: 'src/main.ts', churn: 0, misses: 1, dependents: 0, score: 4 },
      { path: 'src/db.ts', churn: 7, misses: 0, dependents: 3, score: 5 },
    ].sort((a, b) => b.score - a.score));
    expect((await store.codegraph.hotspots('demo', 100)).find((x) => x.path === 'src/cli.ts')).toEqual({ path: 'src/cli.ts', churn: 0, misses: 0, dependents: 0, score: 0 });
    expect(await store.codegraph.hotspots('other', 10)).toEqual([]);
  });

  test('hotspots leave test files out unless asked to include them', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap({ churn: { 'test/db.test.ts': { commits: 31, lastTs: '2026-10-20T10:00:00.000Z' } } }));
    expect((await store.codegraph.hotspots('demo', 100)).map((h) => h.path)).toEqual(['src/db.ts', 'src/api.ts', 'src/cli.ts', 'src/main.ts']);
    expect(await store.codegraph.hotspots('demo', 2, { includeTests: true })).toEqual([
      { path: 'test/db.test.ts', churn: 31, misses: 0, dependents: 0, score: 5 },
      { path: 'src/db.ts', churn: 0, misses: 0, dependents: 3, score: 2 },
    ]);
    // The export carries every file's numbers, tests included.
    expect((await store.portability.exportData({ projectKey: 'demo' })).codeFiles.find((f) => f.path === 'test/db.test.ts')?.score).toBe(5);
  });

  test('mapGraph: the top files by score, their hottest neighbours, the edges among them, and their misses and lessons', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    const fid = await miss('s1', [edit('src/api.ts', '2026-10-01T10:03:00Z')]);
    await miss('s2', [edit('src/api.ts', '2026-10-01T10:03:00Z'), edit('src/main.ts', '2026-10-01T10:03:00Z')]);
    await store.knowledge.updateLesson(`lesson:${fid}`, { status: 'approved' }, {});
    await store.knowledge.upsertLesson({ id: 'mem:db', projectKey: 'demo', title: 'DB', rule: 'r', appliesWhen: 'a', scope: 'project', paths: ['src/db.ts'], status: 'approved', source: 'memory', embedding: vec(3) });

    const g = await store.codegraph.mapGraph('demo', { limit: 2 });
    // Top: api (misses) and db (churn, dependents). Neighbours by edge: main, cli and both tests; the two hottest stay.
    expect(g.files.map((f) => [f.path, f.top])).toEqual([['src/api.ts', true], ['src/db.ts', true], ['src/main.ts', false], ['src/cli.ts', false]]);
    expect(g.files[0]).toEqual({ path: 'src/api.ts', churn: 1, misses: 2, dependents: 2, score: 10.58, lang: 'typescript', loc: 10, isTest: false, top: true });
    expect(g.imports).toEqual([
      { from: 'src/api.ts', to: 'src/db.ts' }, { from: 'src/cli.ts', to: 'src/db.ts' }, { from: 'src/main.ts', to: 'src/api.ts' },
    ]);
    expect(g.tests).toEqual([]);
    expect(g.misses.map((m) => [m.sessionId, m.paths])).toEqual([['s1', ['src/api.ts']], ['s2', ['src/api.ts', 'src/main.ts']]]);
    expect(g.lessons).toEqual([
      { id: `lesson:${fid}`, title: 'lesson for missed in s1', paths: ['src/api.ts'] },
      { id: 'mem:db', title: 'DB', paths: ['src/db.ts'] },
    ]);
    expect(g.cap).toEqual({ limit: 2, eligible: 4, neighbors: 2, neighborsFound: 4 });

    const all = await store.codegraph.mapGraph('demo', { limit: 50, includeTests: true });
    expect(all.files.map((f) => f.path).sort()).toEqual(['src/api.ts', 'src/cli.ts', 'src/db.ts', 'src/main.ts', 'test/api.test.ts', 'test/db.test.ts']);
    expect(all.files.every((f) => f.top)).toBe(true);
    expect(all.tests).toEqual([
      { test: 'test/api.test.ts', target: 'src/api.ts' }, { test: 'test/api.test.ts', target: 'src/db.ts' }, { test: 'test/db.test.ts', target: 'src/db.ts' },
    ]);
    expect(all.imports).toHaveLength(5); // pkg:pg is not a file
    expect(all.cap).toEqual({ limit: 50, eligible: 6, neighbors: 0, neighborsFound: 0 });
    expect(await store.codegraph.mapGraph('other', { limit: 10 })).toEqual({
      files: [], imports: [], tests: [], misses: [], lessons: [], cap: { limit: 10, eligible: 0, neighbors: 0, neighborsFound: 0 },
    });
  });

  test('export carries file paths and hotspot numbers only; deleting the project removes the map and session files', async () => {
    await store.codegraph.replaceCodeMap('demo', codeMap());
    await store.codegraph.replaceCodeMap('other', codeMap({ fingerprint: null }));
    await miss('s1', [edit('src/api.ts', '2026-10-01T10:03:00Z')]);
    const x = await store.portability.exportData({ projectKey: 'demo' });
    expect(x.codeFiles).toHaveLength(6);
    expect(x.codeFiles.find((f) => f.path === 'src/api.ts')).toEqual({
      projectKey: 'demo', path: 'src/api.ts', lang: 'typescript', loc: 10, isTest: false, churn: 1, misses: 1, dependents: 2, score: 6.58,
    });
    const json = JSON.stringify(x);
    for (const hidden of ['Db.query', 'sha-src/api.ts', './api.ts', 'pkg:pg']) expect(json).not.toContain(hidden);
    expect((await store.portability.exportData()).codeFiles.map((f) => f.projectKey)).toContain('other');

    await store.portability.deleteProject('demo');
    expect(await probe.filedUnder('demo')).toEqual([]);
    expect(await store.codegraph.codeMap('demo')).toBeNull();
    expect(await store.codegraph.sessionFiles('s1')).toEqual([]);
    expect((await store.codegraph.codeMap('other'))!.files).toHaveLength(6);
  });
});
