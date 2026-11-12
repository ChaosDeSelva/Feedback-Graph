import type { DocsStore } from '../store.ts';

/**
 * The renames git saw in a project's churn window (worker codegraph/churn.ts, -M), kept after each code map build: each
 * old path to the name its file has now. The learning loop's update_paths reads them to propose a lesson's new paths.
 */
export const renamesCursor = (projectKey: string) => `code-renames:${projectKey}`;

export const writeRenames = (docs: Pick<DocsStore, 'setCursor'>, projectKey: string, renames: Record<string, string>) =>
  docs.setCursor(renamesCursor(projectKey), JSON.stringify(renames));

/** The project's renames as last kept; {} when none (or none readable). */
export async function readRenames(docs: Pick<DocsStore, 'getCursor'>, projectKey: string): Promise<Record<string, string>> {
  try {
    const o = JSON.parse((await docs.getCursor(renamesCursor(projectKey))) ?? '{}') as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
  } catch {
    return {};
  }
}
