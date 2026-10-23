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

/** A plain warning when nothing is being read, for /api/status and the worker log. */
export function selectionNote(sel: Pick<ProjectSelection, 'tracked'>): string | null {
  return sel.tracked.length ? null : 'No projects are selected yet, so no sessions are being read. Choose the folders to include in Settings.';
}
