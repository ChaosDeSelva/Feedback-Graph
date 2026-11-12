import type { DocsStore } from '@fb/core';

/** Of `ids` (Linear ticket ids), the project's: ones it holds or its PRs name, or from a team whose tickets it holds. */
export async function projectLinkedTickets(docs: Pick<DocsStore, 'projectTickets' | 'listDocs'>, projectKey: string, ids: string[]): Promise<string[]> {
  const held = new Set(await docs.projectTickets({ projectKey, ids }));
  const teams = new Set((await docs.listDocs(projectKey)).filter((x) => x.source === 'linear').map((x) => x.ref.replace(/^linear:/, '').split('-')[0]));
  return ids.filter((id) => held.has(id) || teams.has(id.split('-')[0]));
}
