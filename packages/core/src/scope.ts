import type { Config } from './config.ts';

/**
 * Which project folders the owner chose to have read. Folder keys are the unit: the top-level folder under a root
 * (projectFromCwd). Stored once in the graph; nothing is read until a project is tracked.
 */
export type ProjectSelection = { tracked: string[]; initialized: boolean; updatedAt: string | null };

/** The one answer to "is this project in scope", for ingest, memory import, scans, GitHub sync and MCP context. */
export type ProjectScope = {
  /** A graph project key (canonical): selected and not excluded. */
  project(key: string): boolean;
  /** A folder key: an alias folder follows its project, and neither may be excluded. */
  folder(key: string): boolean;
  /** Selected project keys that are not excluded. Empty means nothing is in scope. */
  projects: string[];
};

export const EMPTY_SELECTION: ProjectSelection = { tracked: [], initialized: false, updatedAt: null };

/**
 * Selection x EXCLUDE_PROJECTS x aliases. INGEST_PROJECTS plays no part here: it only seeds the first selection
 * (initialSelection), so a project you tick in Settings is never silently ignored. EXCLUDE_PROJECTS is a hard deny.
 * `aliases` maps an alias folder key to the project key it is a clone of.
 */
export function projectScope(
  sel: Pick<ProjectSelection, 'tracked'>,
  env: Pick<Config, 'excludeProjects'>,
  aliases: ReadonlyMap<string, string> = new Map(),
): ProjectScope {
  const never = new Set(env.excludeProjects);
  const tracked = new Set(sel.tracked);
  const project = (key: string) => tracked.has(key) && !never.has(key);
  return {
    project,
    folder: (key) => {
      const canonical = aliases.get(key);
      return canonical !== undefined && canonical !== key ? !never.has(key) && project(canonical) : project(key);
    },
    projects: [...tracked].filter((k) => !never.has(k)).sort(),
  };
}

/**
 * What a first start with no stored selection begins with: INGEST_PROJECTS when set. Otherwise, on an upgrade, the
 * projects you invested in (`invested`: approved lessons, confirmed feedback, docs, scans), so agents keep getting
 * what you approved; on a new install, nothing.
 */
export function initialSelection(env: Pick<Config, 'ingestProjects' | 'excludeProjects'>, invested: string[] = []): Pick<ProjectSelection, 'tracked' | 'initialized'> {
  const never = new Set(env.excludeProjects);
  const from = env.ingestProjects.length ? env.ingestProjects : invested;
  const tracked = [...new Set(from)].filter((k) => !never.has(k)).sort();
  return { tracked, initialized: env.ingestProjects.length > 0 || tracked.length > 0 };
}

/**
 * A stored selection that was never made (a start with nothing chosen: empty, not initialized) still takes
 * INGEST_PROJECTS set since (setup.sh --select), once: a first run without the UI is not stuck. A selection made in
 * Settings, even as nothing at all, is initialized and never seeded again.
 */
export function ingestSeedsStored(stored: Pick<ProjectSelection, 'tracked' | 'initialized'>, env: Pick<Config, 'ingestProjects'>): boolean {
  return !stored.initialized && stored.tracked.length === 0 && env.ingestProjects.length > 0;
}

/** A plain warning when nothing is being read, for /api/status and the worker log. */
export const NO_ROOTS_NOTE = 'No project folders yet: add a project folder in Settings first.';

/** `roots`: how many project roots are mounted, when known. With none, nothing can be read whatever is selected. */
export function selectionNote(sel: Pick<ProjectSelection, 'tracked'>, roots?: number): string | null {
  if (roots === 0) return NO_ROOTS_NOTE;
  return sel.tracked.length ? null : 'No projects are selected yet, so no sessions are being read. Choose the folders to include in Settings.';
}

/**
 * What the app shows outside Settings: the selected projects (not excluded) and the clone folders that follow them,
 * whose old data may still be filed under their own key. Before a selection is saved nothing is shown (opt-in).
 */
export type ShownProjects = {
  initialized: boolean;
  /** Sorted. Empty: nothing is shown. */
  keys: string[];
  has(key: string): boolean;
};

export function shownProjects(
  sel: Pick<ProjectSelection, 'tracked' | 'initialized'>,
  env: Pick<Config, 'excludeProjects'>,
  aliases: ReadonlyMap<string, string> = new Map(),
): ShownProjects {
  const scope = projectScope(sel.initialized ? sel : { tracked: [] }, env, aliases);
  const keys = new Set(scope.projects);
  for (const alias of aliases.keys()) if (scope.folder(alias)) keys.add(alias);
  const sorted = [...keys].sort();
  return { initialized: sel.initialized, keys: sorted, has: (key) => keys.has(key) };
}
