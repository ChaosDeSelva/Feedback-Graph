import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphStore, Root, SelectionStore, Store } from '@fb/core';
import { describeStores, type StoreProbe } from '@fb/core/testing';
import { beforeAll, expect, test } from 'vitest';
import { runCycle, type CycleDeps } from './cycle.ts';
import { codexSessionFiles } from './ingest/codex.ts';
import { readLines } from './ingest/lines.ts';
import { buildCandidates } from './projects/candidates.ts';
import { forgetDeleted } from './forget.ts';
import { FileState } from './state.ts';

function world() {
  const base = mkdtempSync(join(tmpdir(), 'fb-sel-int-'));
  const vibe = join(base, 'vibe');
  mkdirSync(join(vibe, 'demo-shop'), { recursive: true });
  mkdirSync(join(vibe, 'other'), { recursive: true });
  const codex = join(base, 'codex', '2026', '10', '01');
  mkdirSync(codex, { recursive: true });
  const fixture = readFileSync(join(import.meta.dirname, '../../../fixtures/codex/normal.jsonl'), 'utf8');
  writeFileSync(join(codex, 'rollout-demo.jsonl'), fixture.replaceAll('/work/', `${vibe}/`));
  writeFileSync(join(codex, 'rollout-other.jsonl'), fixture.replaceAll('/work/demo-shop', `${vibe}/other`).replaceAll('codex-normal-0001', 'codex-other-0001'));
  const roots: Root[] = [{ host: vibe, container: vibe }];
  return { roots, codexDir: join(base, 'codex') };
}

describeStores('worker project selection', (h) => {
  let store: Store;
  let repo: GraphStore;
  let selection: SelectionStore;
  let probe: StoreProbe;
  beforeAll(() => {
    store = h.store;
    repo = h.store.graph;
    selection = h.store.selection;
    probe = h.probe;
  });

  /**
   * One worker pass, wired as main.ts wires it. `remote`: every folder's remote (null: none). `duringRead`: runs once
   * while the first file is being read, before anything of it is written (what the owner does mid-cycle).
   */
  async function cycle(w: ReturnType<typeof world>, state: FileState, o: { remote?: string; duringRead?: () => Promise<void> } = {}) {
    const remote = async () => o.remote ?? null;
    const files = (await codexSessionFiles(w.codexDir)).map((f) => ({ ...f, source: 'codex' as const }));
    const { folderOf, ...snapshot } = await buildCandidates({
      roots: w.roots, files, state, codexSessionsFound: true, remote,
      cloneOf: async (f) => (await repo.canonicalProject({ key: f.key, name: f.key, repoPath: f.repoPath, remote: f.remote }, { dryRun: true })).project.key,
    });
    await selection.saveCandidates(snapshot);
    const scope = await selection.scope({ excludeProjects: [] });
    let during = o.duringRead;
    const deps: CycleDeps = {
      listFiles: async () => files,
      readFile: async () => { throw new Error('Codex files are streamed'); },
      readLines: async function* (p) {
        for await (const l of readLines(p)) {
          yield l;
          const d = during;
          during = undefined;
          await d?.();
        }
      },
      scopeNow: () => selection.scope({ excludeProjects: [] }),
      exclusive: (fn) => selection.exclusive(fn),
      remote: o.remote ? remote : undefined,
      projects: o.remote ? repo : undefined,
      folderOf: (p) => folderOf.get(p),
      state,
      repo,
      roots: w.roots,
      commits: async () => [],
      classify: async () => ({ label: 'pushback', confidence: 0.9, summary: 'wants it on the server', signals: ['No,'] }),
      classifyBatch: 50,
      includeProject: scope.folder,
      onlyProjects: scope.projects,
      activity: store.activity,
    };
    return runCycle(deps);
  }

  test('Codex sessions of the selected folder reach the inbox as Codex; others are not read until selected', async () => {
    const w = world();
    const state = new FileState(':memory:');
    await selection.ensure({ ingestProjects: ['demo-shop'], excludeProjects: [] });

    const r = await cycle(w, state);
    expect(r.filesIngested).toBe(1);
    const inbox = await repo.listCandidates({ status: 'pending' });
    expect(inbox.length).toBeGreaterThan(0);
    expect(inbox.every((c) => c.source === 'codex' && c.projectKey === 'demo-shop')).toBe(true);
    expect(await probe.ids('Project')).toEqual(['demo-shop']);

    const snap = await selection.candidates();
    expect(snap?.candidates.map((c) => [c.key, c.codexSessions])).toEqual([['demo-shop', 1], ['other', 1]]);

    // Selecting a folder later reads its sessions on the next cycle, though its file was seen before.
    await selection.setTracked(['demo-shop', 'other']);
    expect((await cycle(w, state)).filesIngested).toBe(1);
    expect((await repo.listCandidates()).some((c) => c.projectKey === 'other')).toBe(true);

    // Unselecting stops reading, and keeps the data.
    await selection.setTracked(['demo-shop']);
    expect((await cycle(w, state)).filesIngested).toBe(0);
    expect((await repo.listCandidates()).some((c) => c.projectKey === 'other')).toBe(true);
  });

  test('with nothing selected the worker reads nothing, but still lists the candidates', async () => {
    const w = world();
    await selection.ensure({ ingestProjects: [], excludeProjects: [] });
    const r = await cycle(w, new FileState(':memory:'));
    expect(r).toEqual({ filesIngested: 0, turnsClassified: 0, candidates: 0 });
    expect(await probe.count('Session')).toBe(0);
    expect((await selection.candidates())?.candidates.map((c) => c.key)).toEqual(['demo-shop', 'other']);
  });

  test('a project cleaned up and selected again has its whole history read again', async () => {
    const w = world();
    const state = new FileState(':memory:');
    await selection.ensure({ ingestProjects: ['demo-shop'], excludeProjects: [] });
    expect((await cycle(w, state)).filesIngested).toBe(1);

    // What POST /api/settings/cleanup does after you unselect it.
    await selection.setTracked([]);
    await selection.exclusive(async () => {
      await store.portability.deleteProject('demo-shop');
      await selection.forgetReads(['demo-shop']);
    });
    expect(await probe.ids('Project')).toEqual([]);
    await forgetDeleted({ selection, state, legacyKeys: () => null });

    await selection.setTracked(['demo-shop']);
    expect((await cycle(w, state)).filesIngested).toBe(1);
    expect(await probe.ids('Project')).toEqual(['demo-shop']);
  });

  test('a cleanup during a cycle is not undone by the transcript that cycle was reading', async () => {
    const w = world();
    const state = new FileState(':memory:');
    await selection.ensure({ ingestProjects: ['demo-shop'], excludeProjects: [] });
    const r = await cycle(w, state, {
      // The owner unselects demo-shop and cleans it up while its transcript is being read.
      duringRead: async () => {
        await selection.setTracked([]);
        await selection.exclusive(() => store.portability.deleteProject('demo-shop'));
      },
    });
    expect(r.filesIngested).toBe(0);
    expect(await probe.ids('Project')).toEqual([]);
    expect(await probe.count('Session')).toBe(0);

    // Its file was skipped as out of scope, so selecting it again reads it.
    await selection.setTracked(['demo-shop']);
    expect((await cycle(w, state)).filesIngested).toBe(1);
  });

  test('a ticked clone of an unselected project follows it: nothing read or aliased until that project is selected', async () => {
    const w = world();
    const state = new FileState(':memory:');
    for (const k of ['demo-shop', 'other']) mkdirSync(join(w.roots[0].container, k, '.git'));
    const remote = 'github.com/o/shop';
    await selection.ensure({ ingestProjects: ['demo-shop'], excludeProjects: [] });
    expect((await cycle(w, state, { remote })).filesIngested).toBe(1);

    // demo-shop keeps its data but is unselected; other, a second clone of it, is ticked.
    await selection.setTracked(['other']);
    expect((await cycle(w, state, { remote })).filesIngested).toBe(0);
    expect(await selection.aliases()).toEqual(new Map([['other', 'demo-shop']]));
    expect(await repo.projectByAlias('other')).toBeNull();
    expect(await probe.ids('Project')).toEqual(['demo-shop']);
    expect((await repo.listCandidates()).every((c) => c.sessionId !== 'codex-other-0001')).toBe(true);

    await selection.setTracked(['demo-shop']);
    expect((await cycle(w, state, { remote })).filesIngested).toBe(1);
    expect(await repo.projectByAlias('other')).toMatchObject({ key: 'demo-shop' });
    expect(await probe.ids('Project')).toEqual(['demo-shop']);
  });
});
