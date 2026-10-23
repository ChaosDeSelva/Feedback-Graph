import type { SelectionStore } from '@fb/core';
import type { FileState } from './state.ts';

const CURSOR = 'forgotten-reads';

export type ForgetDeps = {
  selection: Pick<SelectionStore, 'forgottenReads'>;
  state: FileState;
  /** Whose a read mark is, for marks kept before folder keys were recorded with them. */
  legacyKeys: (path: string, kind: 'transcript' | 'memory') => string[] | null;
};

/**
 * Folders whose data was deleted (Settings cleanup, project delete) since the last call: forget which of their
 * transcripts and memory files were read, so selecting them again reads their history again. Returns marks dropped.
 */
export async function forgetDeleted(d: ForgetDeps): Promise<number> {
  const after = Number(d.state.getSetting(CURSOR) ?? 0) || 0;
  const r = await d.selection.forgottenReads(after);
  const dropped = r.keys.length ? d.state.forget(r.keys, d.legacyKeys) : 0;
  if (r.seq !== after) d.state.setSetting(CURSOR, String(r.seq));
  return dropped;
}
