import { selectionNote, type ProjectScope, type SelectionStore } from '@fb/core';
import type { FileInfo } from './cycle.ts';
import { forgetDeleted } from './forget.ts';
import { memoryProjectKey } from './memory/memory.ts';
import type { CandidateBuild } from './projects/candidates.ts';
import type { FileState } from './state.ts';

type Log = (msg: string, extra?: object) => void;

export type WorkspaceDeps = {
  selection: Pick<SelectionStore, 'saveCandidates' | 'forgottenReads'>;
  /** The selection as stored now (SelectionStore.scope with the configured exclusions). */
  scopeNow: () => Promise<ProjectScope>;
  excludeProjects: string[];
  state: FileState;
  transcriptsDir: string;
  codexSessionsDir: string;
  isDirectory: (path: string) => Promise<boolean>;
  listFiles: () => Promise<FileInfo[]>;
  /** projects/candidates.ts buildCandidates over these files. */
  candidates: (files: (FileInfo & { source: NonNullable<FileInfo['source']> })[], codexSessionsFound: boolean) => Promise<CandidateBuild>;
  /** The project folders under each root, by host path (memory import's keys). */
  memoryRoots: () => Promise<{ host: string; keys: string[] }[]>;
  /** core refreshLayout over the roots; folders keepWhole says are kept as one project. */
  refreshLayout: (keepWhole: (key: string) => boolean) => Promise<void>;
  log: Log;
};

/**
 * What the worker reads, refreshed each wake: the selection (it changes from Settings at any time, including during a
 * long backfill), the project layout, the candidate list for Settings with each transcript's folder (the ingest
 * prefilter), and the reads of folders whose data was deleted. A failing layout or candidate list is logged and the
 * last one kept.
 */
export class Workspace {
  scope: ProjectScope;
  /** Each transcript's folder (null: none), from the last candidate list. */
  folderOf = new Map<string, string | string[] | null>();
  private d: WorkspaceDeps;
  private lastNote: string | null = null;
  private codexMissingLogged = false;

  constructor(d: WorkspaceDeps, scope: ProjectScope) {
    this.d = d;
    this.scope = scope;
  }

  /** Re-read the selection; logs when what is read changes to or from nothing. */
  async refreshScope(): Promise<void> {
    this.scope = await this.d.scopeNow();
    const note = selectionNote({ tracked: this.scope.projects });
    if (note === this.lastNote) return;
    if (note) this.d.log('nothing to read', { note });
    else this.d.log('reading projects', { projects: this.scope.projects });
    this.lastNote = note;
  }

  /**
   * Which folders are projects: top-level folders, and the git repos nested in a folder that is not one. A top-level
   * folder already selected or excluded as a whole stays one project.
   */
  async refreshLayout(): Promise<void> {
    const whole = new Set([...this.scope.projects, ...this.d.excludeProjects]);
    try {
      await this.d.refreshLayout((k) => whole.has(k));
    } catch (err) {
      this.d.log('project layout failed', { error: String(err) });
    }
  }

  /** The candidate list for Settings, from file heads (cached), and each file's folder. A missing Codex folder is logged once. */
  async refreshCandidates(): Promise<void> {
    const codexFound = await this.d.isDirectory(this.d.codexSessionsDir);
    if (!codexFound && !this.codexMissingLogged) this.d.log('no Codex sessions folder; carrying on without Codex sessions', { dir: this.d.codexSessionsDir });
    this.codexMissingLogged = !codexFound;
    try {
      const built = await this.d.candidates((await this.d.listFiles()).map((f) => ({ ...f, source: f.source ?? 'claude' })), codexFound);
      this.folderOf = built.folderOf;
      const { folderOf: _, ...snapshot } = built;
      await this.d.selection.saveCandidates(snapshot);
    } catch (err) {
      this.d.log('candidate list failed', { error: String(err) });
    }
  }

  /** Forget the reads of folders whose data was deleted, so selecting them again reads their history again. */
  async forgetDeletedReads(): Promise<void> {
    const memRoots = await this.d.memoryRoots();
    const dropped = await forgetDeleted({
      selection: this.d.selection,
      state: this.d.state,
      // Marks kept before folder keys were recorded with them: a memory file by its path, a transcript by its folder.
      legacyKeys: (path, kind) => {
        if (kind === 'memory') {
          const k = memoryProjectKey(path, this.d.transcriptsDir, memRoots);
          return k ? [k] : null;
        }
        const f = this.folderOf.get(path);
        return f == null ? null : typeof f === 'string' ? [f] : f;
      },
    });
    if (dropped) this.d.log('forgot reads of deleted projects, read again when selected', { files: dropped });
  }
}
