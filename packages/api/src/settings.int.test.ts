import type { ParsedSession, Store } from '@fb/core';
import { describeStores, type StoreProbe } from '@fb/core/testing';
import { beforeAll, expect, test } from 'vitest';
import { createApp } from './app.ts';

const session = (id: string): ParsedSession => ({
  sessionId: id, sourceFile: 'f', cwd: '/x', gitBranch: null, startedAt: '2026-10-01T10:00:00Z', endedAt: '2026-10-01T10:00:00Z',
  turns: [{ uuid: `${id}-t0`, sessionId: id, ts: '2026-10-01T10:00:00Z', index: 0, text: 'hi', precedingAssistantText: '', precedingToolCalls: [] }],
  toolCalls: [],
});

describeStores('settings api', (h) => {
  let store: Store;
  let probe: StoreProbe;
  beforeAll(() => {
    store = h.store;
    probe = h.probe;
  });

  function app() {
    const { selection, activity } = store;
    return {
      selection,
      activity,
      app: createApp(store.graph, {
        settings: { selection, folders: async () => [{ key: 'keep', path: '/Users/me/Vibe/keep' }], excluded: [], roots: ['/Users/me/Vibe'] },
        activity,
        portability: store.portability,
      }),
    };
  }

  const ui = { origin: 'http://localhost', 'content-type': 'application/json' };

  test('selection round-trips through the graph, and cleanup deletes only unselected projects', async () => {
    const { app: a, selection, activity } = app();
    for (const k of ['keep', 'drop-a', 'drop-b']) await store.graph.upsertSession({ key: k, name: k, repoPath: `/vibe/${k}` }, session(`s-${k}`), []);
    // Seeded before the approved lesson below: an upgrade would preselect a project holding one (SelectionStore.ensure).
    await selection.ensure({ ingestProjects: [], excludeProjects: [] });
    await probe.seedOrphan({ kind: 'Lesson', id: 'l-drop', projectKey: 'drop-c' });

    // Nothing chosen yet: cleanup would delete everything, so it is refused.
    expect((await a.request('/api/settings/cleanup', { method: 'POST', headers: ui, body: JSON.stringify({ confirm: 'remove-unselected' }) })).status).toBe(409);

    const put = await a.request('/api/settings/projects', { method: 'PUT', headers: ui, body: JSON.stringify({ tracked: ['keep'] }) });
    expect(put.status).toBe(200);
    expect((await selection.current()).tracked).toEqual(['keep']);
    const body = await (await a.request('/api/settings/projects')).json();
    expect(body.candidates.filter((c: { hasData: boolean }) => c.hasData).map((c: { key: string }) => c.key)).toEqual(['drop-a', 'drop-b', 'drop-c', 'keep']);

    const res = await a.request('/api/settings/cleanup', { method: 'POST', headers: ui, body: JSON.stringify({ confirm: 'remove-unselected' }) });
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toEqual(['drop-a', 'drop-b', 'drop-c']);
    expect(await selection.keysWithData()).toEqual(['keep']);
    expect(await probe.count('Session')).toBe(1);
    expect((await activity.list({ kind: 'projects_cleaned' }))[0].details).toMatchObject({ projects: ['drop-a', 'drop-b', 'drop-c'] });
    expect((await activity.list({ kind: 'projects_selected' }))[0]).toMatchObject({ actor: 'you', details: { added: ['keep'], removed: [] } });
    // The worker is told to forget it read the deleted folders, so selecting one again reads its history again.
    expect((await selection.forgottenReads(0)).keys.sort()).toEqual(['drop-a', 'drop-b', 'drop-c']);
  });

  test('a clone saved in the selection never blocks a save, and cleanup keeps data filed under a selected project\'s clone', async () => {
    const { app: a, selection } = app();
    await store.graph.upsertSession({ key: 'keep', name: 'keep', repoPath: '/vibe/keep', remote: 'github.com/o/keep' }, session('s-keep'), []);
    // Both clones were ticked; the worker made keep-2 an alias of keep when it read it. A memory lesson of keep-2 is filed under its folder.
    await store.graph.canonicalProject({ key: 'keep-2', name: 'keep-2', repoPath: '/vibe/keep-2', remote: 'github.com/o/keep' });
    await probe.seedOrphan({ kind: 'Lesson', id: 'l-keep-2', projectKey: 'keep-2' });
    await selection.setTracked(['keep', 'keep-2']);

    const before = await (await a.request('/api/settings/projects')).json();
    const put = await a.request('/api/settings/projects', { method: 'PUT', headers: ui, body: JSON.stringify({ tracked: before.tracked }) });
    expect(put.status).toBe(200);
    expect((await selection.current()).tracked).toEqual(['keep']);

    const res = await a.request('/api/settings/cleanup', { method: 'POST', headers: ui, body: JSON.stringify({ confirm: 'remove-unselected' }) });
    expect((await res.json()).removed).toEqual([]);
    expect(await selection.keysWithData()).toEqual(['keep', 'keep-2']);
  });
});
