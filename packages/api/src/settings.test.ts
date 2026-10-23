import type { ActivityInput, CandidateSnapshot, ProjectSelection } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo, type SettingsDeps } from './app.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as ApiRepo;

const snapshot: CandidateSnapshot = {
  builtAt: '2026-10-23T00:00:00Z',
  roots: ['/Users/me/Vibe'],
  candidates: [
    { key: 'demo-shop', path: '/Users/me/Vibe/demo-shop', exists: true, git: true, remote: 'github.com/me/shop', claudeSessions: 3, codexSessions: 2, lastActivity: '2026-10-22T00:00:00Z' },
    { key: 'demo-shop-2', path: '/Users/me/Vibe/demo-shop-2', exists: true, git: true, remote: 'github.com/me/shop', claudeSessions: 1, codexSessions: 0, lastActivity: '2026-10-21T00:00:00Z' },
    { key: 'client', path: '/Users/me/Vibe/client', exists: true, git: false, remote: null, claudeSessions: 4, codexSessions: 0, lastActivity: null },
    { key: 'gone', path: '/Users/me/Vibe/gone', exists: false, git: false, remote: null, claudeSessions: 1, codexSessions: 0, lastActivity: '2026-01-01T00:00:00Z' },
  ],
  outsideRoots: { claudeSessions: 5, codexSessions: 1 },
  codexSessionsFound: true,
};

function setup(o: { selection?: ProjectSelection; snapshot?: CandidateSnapshot | null; dataKeys?: string[]; aliases?: [string, string][] } = {}) {
  let sel: ProjectSelection = o.selection ?? { tracked: ['demo-shop'], initialized: true, updatedAt: '2026-10-23T00:00:00Z' };
  const log: ActivityInput[] = [];
  const deleted: string[] = [];
  /** What ran inside SelectionStore.exclusive, in order. */
  const locked: string[] = [];
  let inSection = false;
  const forgotten: string[][] = [];
  const settings: SettingsDeps = {
    selection: {
      current: async () => sel,
      setTracked: async (tracked) => {
        const before = sel.tracked;
        sel = { tracked: [...new Set(tracked)].sort(), initialized: true, updatedAt: 'now' };
        return { before, selection: sel };
      },
      candidates: async () => (o.snapshot === undefined ? snapshot : o.snapshot),
      aliases: async () => new Map(o.aliases ?? [['demo-shop-2', 'demo-shop']]),
      keysWithData: async () => o.dataKeys ?? ['demo-shop', 'old-one', 'client'],
      exclusive: async (fn) => {
        inSection = true;
        locked.push('enter');
        try {
          return await fn();
        } finally {
          inSection = false;
          locked.push('leave');
        }
      },
      forgetReads: async (keys) => { forgotten.push([...keys].sort()); },
    },
    folders: async () => [{ key: 'brand-new', path: '/Users/me/Vibe/brand-new' }, { key: 'demo-shop', path: '/Users/me/Vibe/demo-shop' }],
    excluded: ['client'],
    roots: ['/Users/me/Vibe'],
  };
  const app = createApp(repo, {
    settings,
    activity: { record: async (a) => { log.push(a); }, list: async () => [] },
    portability: { exportData: async () => { throw new Error('unused'); }, deleteProject: async (k) => { deleted.push(k); locked.push(inSection ? `delete ${k}` : `delete ${k} OUTSIDE`); return 10; } },
    system: { version: '0.3.0', ping: async () => true, worker: async () => null, selection: async () => sel },
  });
  return { app, log, deleted, locked, forgotten, sel: () => sel };
}

const ui = { origin: 'http://localhost', 'content-type': 'application/json' };
const put = (body: unknown, headers: Record<string, string> = ui) => ({ method: 'PUT', headers, body: JSON.stringify(body) });

test('GET lists every candidate folder with its sessions, selection, exclusion, alias and data', async () => {
  const { app } = setup();
  const res = await app.request('/api/settings/projects');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ initialized: true, tracked: ['demo-shop'], roots: ['/Users/me/Vibe'], outsideRoots: { claudeSessions: 5, codexSessions: 1 }, builtAt: '2026-10-23T00:00:00Z', codexSessionsFound: true });
  const byKey = Object.fromEntries(body.candidates.map((c: { key: string }) => [c.key, c]));
  expect(Object.keys(byKey)).toEqual(['brand-new', 'client', 'demo-shop', 'demo-shop-2', 'gone', 'old-one']);
  expect(byKey['demo-shop']).toEqual({
    key: 'demo-shop', path: '/Users/me/Vibe/demo-shop', exists: true, git: true, remote: 'github.com/me/shop', claudeSessions: 3, codexSessions: 2,
    lastActivity: '2026-10-22T00:00:00Z', tracked: true, excluded: false, aliasOf: null, hasData: true, inScope: true,
  });
  expect(byKey['demo-shop-2']).toMatchObject({ aliasOf: 'demo-shop', tracked: true, inScope: true, hasData: false });
  expect(byKey.client).toMatchObject({ excluded: true, tracked: false, inScope: false, hasData: true });
  expect(byKey.gone).toMatchObject({ exists: false, claudeSessions: 1 });
  // A folder made since the worker's last pass, and a project known only from its data.
  expect(byKey['brand-new']).toMatchObject({ exists: true, claudeSessions: 0, codexSessions: 0, tracked: false });
  expect(byKey['old-one']).toMatchObject({ exists: false, hasData: true, path: '' });
});

test('before the worker has built the list, the folders on disk are still offered', async () => {
  const { app } = setup({ snapshot: null });
  const body = await (await app.request('/api/settings/projects')).json();
  expect(body.builtAt).toBeNull();
  expect(body.candidates.map((c: { key: string }) => c.key)).toEqual(['brand-new', 'client', 'demo-shop', 'old-one']);
  expect(body.outsideRoots).toEqual({ claudeSessions: 0, codexSessions: 0 });
});

test('PUT is yours alone: from the UI, as JSON', async () => {
  const { app } = setup();
  expect((await app.request('/api/settings/projects', put({ tracked: ['demo-shop'] }, { 'content-type': 'application/json' }))).status).toBe(403);
  expect((await app.request('/api/settings/projects', put({ tracked: ['demo-shop'] }, { origin: 'http://evil.example', 'content-type': 'application/json' }))).status).toBe(403);
  expect((await app.request('/api/settings/projects', { method: 'PUT', headers: { origin: 'http://localhost' }, body: '{}' })).status).toBe(415);
});

test('PUT saves the selection, logs who changed what and why, and returns the new list', async () => {
  const { app, log, sel } = setup();
  const res = await app.request('/api/settings/projects', put({ tracked: ['brand-new', 'demo-shop', 'gone'] }));
  expect(res.status).toBe(200);
  expect(sel().tracked).toEqual(['brand-new', 'demo-shop', 'gone']);
  const body = await res.json();
  expect(body.tracked).toEqual(['brand-new', 'demo-shop', 'gone']);
  expect(log).toEqual([expect.objectContaining({
    kind: 'projects_selected', actor: 'you', projectKey: null,
    details: { added: ['brand-new', 'gone'], removed: [], tracked: ['brand-new', 'demo-shop', 'gone'] },
  })]);
  expect(log[0].why).toMatch(/next cycle/);
});

test('PUT refuses unknown folders, excluded folders and clones of excluded projects, and changes nothing', async () => {
  const { app, sel, log } = setup({ aliases: [['demo-shop-2', 'demo-shop'], ['client-2', 'client']], snapshot: { ...snapshot, candidates: [...snapshot.candidates, { ...snapshot.candidates[2], key: 'client-2', path: '/Users/me/Vibe/client-2' }] } });
  for (const [tracked, msg] of [
    [['nope'], /not a folder under your project roots: nope/],
    [['client'], /EXCLUDE_PROJECTS: client/],
    [['client-2'], /client-2 is another clone of client, which EXCLUDE_PROJECTS excludes/],
    [['../etc'], /not a folder/],
  ] as const) {
    const res = await app.request('/api/settings/projects', put({ tracked }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(msg);
  }
  expect((await app.request('/api/settings/projects', put({ tracked: 'demo-shop' }))).status).toBe(400);
  expect((await app.request('/api/settings/projects', put({ tracked: [], extra: 1 }))).status).toBe(400);
  expect(sel().tracked).toEqual(['demo-shop']);
  expect(log).toEqual([]);
});

test('ticking a clone selects the project it follows', async () => {
  const { app, sel, log } = setup({ selection: { tracked: [], initialized: true, updatedAt: null } });
  const res = await app.request('/api/settings/projects', put({ tracked: ['demo-shop-2'] }));
  expect(res.status).toBe(200);
  expect(sel().tracked).toEqual(['demo-shop']);
  expect(log[0].details).toMatchObject({ added: ['demo-shop'], tracked: ['demo-shop'] });
});

test('a saved key that became a clone or was excluded since never makes Settings unsaveable: it is dropped, the rest saved', async () => {
  // demo-shop-2 was ticked before the worker found it to be a clone; client was ticked before EXCLUDE_PROJECTS named it.
  const { app, sel, log } = setup({ selection: { tracked: ['client', 'demo-shop-2'], initialized: true, updatedAt: null } });
  const before = await (await app.request('/api/settings/projects')).json();
  expect(before.tracked).toEqual(['client', 'demo-shop-2']);
  // The UI sends back what it was given, plus what you ticked.
  const res = await app.request('/api/settings/projects', put({ tracked: [...before.tracked, 'brand-new'] }));
  expect(res.status).toBe(200);
  expect(sel().tracked).toEqual(['brand-new']);
  expect(log[0].details).toMatchObject({ added: ['brand-new'], removed: ['client', 'demo-shop-2'], dropped: ['client', 'demo-shop-2'] });
  expect(log[0].why).toMatch(/demo-shop-2 is another clone of demo-shop/);
});

test('unselecting everything is allowed: nothing is read, and the data stays', async () => {
  const { app, sel, deleted } = setup();
  expect((await app.request('/api/settings/projects', put({ tracked: [] }))).status).toBe(200);
  expect(sel()).toMatchObject({ tracked: [], initialized: true });
  expect(deleted).toEqual([]);
});

test('cleanup needs you, from the UI, typing the confirm phrase', async () => {
  const { app, deleted } = setup();
  const post = (body: unknown, headers: Record<string, string> = ui) => app.request('/api/settings/cleanup', { method: 'POST', headers, body: JSON.stringify(body) });
  expect((await post({ confirm: 'remove-unselected' }, { 'content-type': 'application/json' })).status).toBe(403);
  expect((await post({ confirm: 'yes' })).status).toBe(400);
  expect((await post({})).status).toBe(400);
  expect(deleted).toEqual([]);
});

test('cleanup removes the data of every project that is not selected, and only those', async () => {
  const { app, deleted, log } = setup();
  const res = await app.request('/api/settings/cleanup', { method: 'POST', headers: ui, body: JSON.stringify({ confirm: 'remove-unselected' }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ removed: ['client', 'old-one'], nodesRemoved: 20 });
  expect(deleted).toEqual(['client', 'old-one']);
  expect(log).toEqual([expect.objectContaining({ kind: 'projects_cleaned', actor: 'you', projectKey: null, details: { projects: ['client', 'old-one'], nodesRemoved: 20 } })]);
});

test('cleanup keeps data filed under a clone of a selected project, and deletes a clone of an unselected one', async () => {
  const { app, deleted } = setup({ dataKeys: ['demo-shop', 'demo-shop-2', 'old-one', 'old-one-2'], aliases: [['demo-shop-2', 'demo-shop'], ['old-one-2', 'old-one']] });
  const res = await app.request('/api/settings/cleanup', { method: 'POST', headers: ui, body: JSON.stringify({ confirm: 'remove-unselected' }) });
  expect((await res.json()).removed).toEqual(['old-one', 'old-one-2']);
  expect(deleted).toEqual(['old-one', 'old-one-2']);
});

test('cleanup deletes inside the exclusive section, and has the worker forget it read those folders and their clones', async () => {
  const { app, locked, forgotten } = setup({ dataKeys: ['demo-shop', 'old-one'], aliases: [['demo-shop-2', 'demo-shop'], ['old-one-2', 'old-one']] });
  await app.request('/api/settings/cleanup', { method: 'POST', headers: ui, body: JSON.stringify({ confirm: 'remove-unselected' }) });
  expect(locked).toEqual(['enter', 'delete old-one', 'leave']);
  expect(forgotten).toEqual([['old-one', 'old-one-2']]);
});

test('deleting a project runs inside the exclusive section; an unselected one is read in full if selected again', async () => {
  const { app, locked, forgotten } = setup({ aliases: [['old-one-2', 'old-one']] });
  const del = (key: string) => app.request(`/api/projects/${key}`, { method: 'DELETE', headers: ui, body: JSON.stringify({ confirm: key }) });
  expect((await del('old-one')).status).toBe(200);
  expect(locked).toEqual(['enter', 'delete old-one', 'leave']);
  expect(forgotten).toEqual([['old-one', 'old-one-2']]);
  // Still selected: its history stays deleted, and only new sessions are read.
  expect((await del('demo-shop')).status).toBe(200);
  expect(forgotten).toHaveLength(1);
});

test('cleanup is refused while no selection was ever made, so it cannot wipe everything by accident', async () => {
  const { app, deleted } = setup({ selection: { tracked: [], initialized: false, updatedAt: null } });
  const res = await app.request('/api/settings/cleanup', { method: 'POST', headers: ui, body: JSON.stringify({ confirm: 'remove-unselected' }) });
  expect(res.status).toBe(409);
  expect(deleted).toEqual([]);
});

test('status says how many projects are selected, and says plainly when none are', async () => {
  const some = setup();
  const s1 = await (await some.app.request('/api/status')).json();
  expect(s1.selection).toEqual({ initialized: true, tracked: 1, note: null });
  const none = setup({ selection: { tracked: [], initialized: false, updatedAt: null } });
  const s2 = await (await none.app.request('/api/status')).json();
  expect(s2.selection).toMatchObject({ initialized: false, tracked: 0, note: expect.stringMatching(/no projects are selected/i) });
});
