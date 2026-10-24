import type { Hono } from 'hono';
import { z } from 'zod';
import { projectScope, type ActivityStore, type FolderCandidate, type OutsideFolder, type PortabilityStore, type ProjectScope, type SelectionStore } from '@fb/core';
import { MAX_ROOTS, normalizeRoots, type RootsStore } from './roots.ts';

export type SettingsDeps = {
  selection: Pick<SelectionStore, 'current' | 'setTracked' | 'candidates' | 'aliases' | 'keysWithData' | 'exclusive' | 'forgetReads'>;
  /** Top-level folders under the roots right now, as host paths: the worker's list can be a cycle old. */
  folders(): Promise<{ key: string; path: string }[]>;
  /** EXCLUDE_PROJECTS: shown, never selectable. */
  excluded: string[];
  /** The mounted roots as host paths (HOST_PROJECT_ROOTS), for when the worker has not built its list yet. */
  roots: string[];
  /** Where Settings saves the roots for scripts/setup.sh to mount (ROOTS_FILE). Unset: roots are not editable here. */
  savedRoots?: RootsStore;
  /** The host's home folder (HOST_HOME), for `~` in a typed root. */
  hostHome?: string | null;
};

/** The command that mounts saved roots and restarts the containers. */
export const APPLY_ROOTS = './scripts/setup.sh';

/** One row of GET /api/settings/projects. */
export type ProjectCandidate = FolderCandidate & {
  /** In the tracked list. For an alias folder: whether the project it is a clone of is tracked (it follows that). */
  tracked: boolean;
  excluded: boolean;
  /** The project this folder is another clone of; its sessions are recorded under that project. */
  aliasOf: string | null;
  /** The graph holds data under this key (sessions, lessons, facts, docs). */
  hasData: boolean;
  /** Sessions here are read: tracked (or its project is) and nothing involved is excluded. */
  inScope: boolean;
};

export type ProjectSettings = {
  initialized: boolean;
  tracked: string[];
  candidates: ProjectCandidate[];
  /** Sessions outside every root, and the folders they ran in that could be added as roots (none already chosen). */
  outsideRoots: { claudeSessions: number; codexSessions: number; folders: OutsideFolder[] };
  roots: string[];
  /** Roots saved in Settings that differ from the mounted ones: they take effect once ./scripts/setup.sh is run. */
  pendingRoots: string[] | null;
  /** Roots can be saved from Settings (ROOTS_FILE is set). */
  rootsEditable: boolean;
  /** When the worker last counted sessions; null before its first pass. */
  builtAt: string | null;
  codexSessionsFound: boolean | null;
};

export const CLEANUP_CONFIRM = 'remove-unselected';

const Selection = z.object({ tracked: z.array(z.string().min(1).max(200)).max(2000) }).strict();
const Cleanup = z.object({ confirm: z.string() }).strict();
const Roots = z.object({ roots: z.array(z.string().max(2048)).max(MAX_ROOTS * 5) }).strict();

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
/** The folder is this root or inside it. */
const within = (path: string, root: string) => path === root || path.startsWith(`${root.replace(/\/+$/, '')}/`);

async function settingsBody(d: SettingsDeps): Promise<ProjectSettings> {
  const [sel, snap, aliases, dataKeys, folders, saved] = await Promise.all([
    d.selection.current(), d.selection.candidates(), d.selection.aliases(), d.selection.keysWithData(), d.folders(),
    d.savedRoots?.read() ?? null,
  ]);
  const scope = projectScope(sel, { excludeProjects: d.excluded }, aliases);
  const excluded = new Set(d.excluded);
  const data = new Set(dataKeys);
  const rows = new Map<string, FolderCandidate>();
  for (const c of snap?.candidates ?? []) rows.set(c.key, c);
  for (const f of folders) {
    const known = rows.get(f.key);
    if (known) known.exists = true;
    else rows.set(f.key, { key: f.key, path: f.path, exists: true, git: false, remote: null, claudeSessions: 0, codexSessions: 0, lastActivity: null });
  }
  for (const key of data) {
    if (!rows.has(key)) rows.set(key, { key, path: '', exists: false, git: false, remote: null, claudeSessions: 0, codexSessions: 0, lastActivity: null });
  }
  const candidates = [...rows.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((c): ProjectCandidate => {
      const aliasOf = aliases.get(c.key) ?? null;
      return {
        ...c,
        tracked: sel.tracked.includes(aliasOf ?? c.key),
        excluded: excluded.has(c.key),
        aliasOf: aliasOf === c.key ? null : aliasOf,
        hasData: data.has(c.key),
        inScope: scope.folder(c.key),
      };
    });
  const chosen = [...d.roots, ...(saved?.roots ?? [])];
  const out = snap?.outsideRoots;
  return {
    initialized: sel.initialized,
    tracked: sel.tracked,
    candidates,
    outsideRoots: {
      claudeSessions: out?.claudeSessions ?? 0,
      codexSessions: out?.codexSessions ?? 0,
      folders: (out?.folders ?? []).filter((f) => !chosen.some((r) => within(f.path, r))),
    },
    roots: snap?.roots ?? d.roots,
    pendingRoots: saved && !sameSet(saved.roots, d.roots) ? saved.roots : null,
    rootsEditable: !!d.savedRoots,
    builtAt: snap?.builtAt ?? null,
    codexSessionsFound: snap?.codexSessionsFound ?? null,
  };
}

const list = (keys: string[]) => keys.join(', ');

/**
 * Delete these projects' data inside the store's exclusive section, so a worker cycle part way cannot write them
 * back. `forget`: which of them the worker should forget it read (with their clone folders), so selecting them again
 * reads their history again. Returns nodes (rows) removed.
 */
export async function deleteProjects(
  d: Pick<SettingsDeps, 'selection' | 'excluded'>,
  portability: Pick<PortabilityStore, 'deleteProject'>,
  keys: string[],
  forget: (scope: ProjectScope) => (key: string) => boolean,
): Promise<number> {
  return d.selection.exclusive(async () => {
    const [sel, aliases] = await Promise.all([d.selection.current(), d.selection.aliases()]);
    const scope = projectScope(sel, { excludeProjects: d.excluded }, aliases);
    const forgetting = new Set(keys.filter(forget(scope)));
    let removed = 0;
    for (const k of keys) removed += await portability.deleteProject(k);
    const folders = new Set(forgetting);
    for (const [alias, project] of aliases) if (forgetting.has(project)) folders.add(alias);
    if (folders.size) await d.selection.forgetReads([...folders]);
    return removed;
  });
}

/** Routes behind the Settings page. Writes are owner-only (guarded in createApp). */
export function settingsRoutes(
  app: Hono,
  d: SettingsDeps,
  o: { activity?: Pick<ActivityStore, 'record'>; portability?: Pick<PortabilityStore, 'deleteProject'> },
) {
  app.get('/api/settings/projects', async (c) => c.json(await settingsBody(d)));

  app.put('/api/settings/projects', async (c) => {
    const body = Selection.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'send { "tracked": ["folder", ...] }' }, 400);
    const current = await settingsBody(d);
    const byKey = new Map(current.candidates.map((x) => [x.key, x]));
    const saved = new Set(current.tracked);
    // A clone follows its project: ticking one selects that project. A key that was saved before it became a clone
    // or was excluded (server-side changes the UI sends back unchanged) is dropped, never a reason to refuse the save.
    const unknown: string[] = [];
    const excluded: string[] = [];
    const problems: string[] = [];
    const dropped: { key: string; why: string }[] = [];
    const tracked = new Set<string>();
    for (const k of [...new Set(body.data.tracked)].sort()) {
      const aliasOf = byKey.get(k)?.aliasOf ?? null;
      let why: string | null = null;
      if (!byKey.has(k) && !saved.has(k)) unknown.push(k); // a key already tracked may stay even if its folder is gone
      else if (d.excluded.includes(k)) why = `excluded by EXCLUDE_PROJECTS: ${k}`;
      else if (aliasOf && d.excluded.includes(aliasOf)) why = `${k} is another clone of ${aliasOf}, which EXCLUDE_PROJECTS excludes`;
      else if (aliasOf && saved.has(k)) {
        dropped.push({ key: k, why: `${k} is another clone of ${aliasOf}: it is read when ${aliasOf} is selected` });
        continue;
      }
      if (why && saved.has(k)) dropped.push({ key: k, why });
      else if (why && why.startsWith('excluded by')) excluded.push(k);
      else if (why) problems.push(why);
      else if (!unknown.includes(k)) tracked.add(aliasOf ?? k);
    }
    const errors = [
      ...(unknown.length ? [`not a folder under your project roots: ${list(unknown)}`] : []),
      ...(excluded.length ? [`excluded by EXCLUDE_PROJECTS: ${list(excluded)}`] : []),
      ...problems,
    ];
    if (errors.length) return c.json({ error: errors.join('; ') }, 400);

    const next = [...tracked].sort();
    const { before } = await d.selection.setTracked(next);
    const added = next.filter((k) => !before.includes(k));
    const removed = before.filter((k) => !next.includes(k));
    await o.activity?.record({
      kind: 'projects_selected',
      actor: 'you',
      projectKey: null,
      subject: next.length
        ? `reading ${next.length} project${next.length === 1 ? '' : 's'}${added.length ? `; added ${list(added)}` : ''}${removed.length ? `; stopped ${list(removed)}` : ''}`
        : 'no projects selected: no sessions are read',
      why: `you chose them in Settings. Added folders are read from the next cycle; stopped ones are no longer read and keep their data.${dropped.length ? ` Not kept in the list: ${dropped.map((x) => x.why).join('; ')}.` : ''}`,
      details: { added, removed, tracked: next, ...(dropped.length ? { dropped: dropped.map((x) => x.key) } : {}) },
    });
    return c.json(await settingsBody(d));
  });

  app.put('/api/settings/roots', async (c) => {
    if (!d.savedRoots) return c.json({ error: `project roots cannot be saved here (ROOTS_FILE is not set): set PROJECTS_DIRS in .env and run ${APPLY_ROOTS}` }, 501);
    const body = Roots.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'send { "roots": ["/absolute/host/path", ...] }' }, 400);
    const norm = normalizeRoots(body.data.roots, d.hostHome ?? null);
    if ('error' in norm) return c.json({ error: norm.error }, 400);
    const before = (await d.savedRoots.read())?.roots ?? d.roots;
    const { roots } = await d.savedRoots.write(norm.roots);
    const added = roots.filter((r) => !before.includes(r));
    const removed = before.filter((r) => !roots.includes(r));
    const mounted = sameSet(roots, d.roots);
    await o.activity?.record({
      kind: 'roots_saved',
      actor: 'you',
      projectKey: null,
      subject: roots.length
        ? `project roots saved: ${list(roots)}${added.length ? `; added ${list(added)}` : ''}${removed.length ? `; removed ${list(removed)}` : ''}`
        : 'project roots saved: none (no project folder is mounted)',
      why: mounted
        ? 'you saved them in Settings; they are the folders already mounted, so nothing needs to restart'
        : `you saved them in Settings. They are mounted when you run ${APPLY_ROOTS} on the host (it restarts the containers); until then the old roots stay in use`,
      details: { roots, added, removed },
    });
    return c.json(await settingsBody(d));
  });

  app.post('/api/settings/cleanup', async (c) => {
    const body = Cleanup.safeParse(await c.req.json().catch(() => null));
    if (!body.success || body.data.confirm !== CLEANUP_CONFIRM) {
      return c.json({ error: `type ${CLEANUP_CONFIRM} to confirm: this deletes everything learned from projects you have not selected` }, 400);
    }
    if (!o.portability) return c.json({ error: 'deleting data is not available' }, 501);
    const sel = await d.selection.current();
    if (!sel.initialized) return c.json({ error: 'choose your projects first: with nothing chosen yet this would delete everything' }, 409);
    const aliases = await d.selection.aliases();
    // Data filed under a clone's folder key belongs to the project the clone follows.
    const keys = (await d.selection.keysWithData()).filter((k) => !sel.tracked.includes(k) && !sel.tracked.includes(aliases.get(k) ?? k)).sort();
    const nodesRemoved = keys.length ? await deleteProjects(d, o.portability, keys, () => () => true) : 0;
    await o.activity?.record({
      kind: 'projects_cleaned',
      actor: 'you',
      projectKey: null,
      subject: keys.length ? `deleted everything learned from ${keys.length} unselected project${keys.length === 1 ? '' : 's'}: ${list(keys)}` : 'nothing to delete: every project with data is selected',
      why: 'you asked Settings to remove the data of projects you have not selected',
      details: { projects: keys, nodesRemoved },
    });
    return c.json({ removed: keys, nodesRemoved });
  });
}
