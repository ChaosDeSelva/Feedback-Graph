/**
 * What both stores' RunsStore share: turning the records a run wrote into RunItems, and deciding which of them a
 * cleanup removes. The stores only find the rows and delete the ids this hands back.
 */
import { NotTheRunsError, RUN_ITEM_KINDS, type RunItem, type RunItemKind, type RunTag } from './types.ts';

/** A record a store found with the run's id. merged: on a report, RunItem.merged; ignored on the others. */
export type RunRow = { kind: RunItemKind; id: string; projectKey: string | null; sandbox: boolean; merged: boolean };

/** A lesson's or miss's report (its feedback id): the id without its prefix. Null for the other kinds. */
const groupOf = (kind: RunItemKind, id: string): string | null =>
  kind === 'lesson' ? id.replace(/^lesson:/, '') : kind === 'miss' ? id.replace(/^miss:/, '') : null;

/** The rows as RunItems, by kind (RUN_ITEM_KINDS order) then id; a lesson or miss is merged when its report is. */
export function runItems(rows: RunRow[]): RunItem[] {
  const merged = new Set(rows.filter((r) => r.kind === 'feedback' && r.merged).map((r) => r.id));
  const order = (k: RunItemKind) => RUN_ITEM_KINDS.indexOf(k);
  return rows
    .map((r) => {
      const group = groupOf(r.kind, r.id);
      return { kind: r.kind, id: r.id, projectKey: r.projectKey ?? null, sandbox: !!r.sandbox, group, merged: r.kind === 'feedback' ? !!r.merged : !!group && merged.has(group) };
    })
    .sort((a, b) => order(a.kind) - order(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The ids RunsStore.remove deletes, per kind: everything but `keep` and merged reports. A report is one unit with its
 * lesson and miss: keeping any of the three keeps all three.
 */
export function runRemoval(items: RunItem[], keep: string[]): Record<RunItemKind, string[]> {
  const kept = new Set(keep);
  const keptReports = new Set(items.filter((i) => (i.kind === 'feedback' || i.group) && (kept.has(i.id) || i.merged)).map((i) => i.group ?? i.id));
  const out = Object.fromEntries(RUN_ITEM_KINDS.map((k) => [k, [] as string[]])) as Record<RunItemKind, string[]>;
  for (const i of items) {
    const report = i.kind === 'feedback' ? i.id : i.group;
    if (report ? keptReports.has(report) : kept.has(i.id)) continue;
    out[i.kind].push(i.id);
  }
  return out;
}

/** Per kind, how many of `ids` a delete reported gone. */
export const removedCounts = (counts: Partial<Record<RunItemKind, number>>): Record<RunItemKind, number> =>
  Object.fromEntries(RUN_ITEM_KINDS.map((k) => [k, counts[k] ?? 0])) as Record<RunItemKind, number>;

/**
 * Who a document (or link) written by `run` ends up owned by, given who owns it now (`current`: its run, null for the
 * owner's; undefined: there is none yet). Throws NotTheRunsError for a run's write over a record it does not own.
 */
export function runWriteOwner(what: string, current: string | null | undefined, run: RunTag | null | undefined, byOwner?: boolean): RunTag | null {
  if (!run) return null;
  if (current === undefined || current === run.id) return run;
  if (byOwner && !run.sandbox) return null;
  throw new NotTheRunsError(what, run.id);
}
