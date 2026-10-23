import { randomUUID } from 'node:crypto';
import type { Config } from '../config.ts';
import { EMPTY_SELECTION, initialSelection, projectScope, type ProjectScope, type ProjectSelection } from '../scope.ts';
import type { ActivityStore, SelectionStore } from '../store.ts';
import type { ActivityInput } from '../types.ts';
import type { GraphRepo } from './repo.ts';

/** One top-level folder under a root, as the worker last saw it. Counts come from file heads, not whole transcripts. */
export type FolderCandidate = {
  key: string;
  /** Host path (what you see on your machine), or the container path when HOST_PROJECT_ROOTS is unset. */
  path: string;
  /** False: sessions ran in this folder but it is gone. */
  exists: boolean;
  git: boolean;
  remote: string | null;
  claudeSessions: number;
  codexSessions: number;
  /** Newest session file change in this folder, ISO. */
  lastActivity: string | null;
  /**
   * The existing project this folder is another clone of (same remote), when it is not a project itself: it follows
   * that project from before its first session is read. Unset in snapshots from older workers.
   */
  cloneOf?: string | null;
};

export type CandidateSnapshot = {
  builtAt: string;
  /** The configured roots, as host paths. */
  roots: string[];
  candidates: FolderCandidate[];
  /** Sessions whose cwd is outside every root: add a root to make them selectable. */
  outsideRoots: { claudeSessions: number; codexSessions: number };
  /** Whether the Codex sessions folder was there to read. */
  codexSessionsFound: boolean;
};

/** The id of the single selection record and of the single candidate-list record. */
export const SELECTION_ID = 'selection';
const ID = SELECTION_ID;

/**
 * The activity a first start logs once, when it stores the initial selection. `existing`: projects already stored.
 * `fromIngest`: INGEST_PROJECTS was set (otherwise a non-empty seed came from the projects you invested in).
 */
export function selectionSeededActivity(seed: Pick<ProjectSelection, 'tracked' | 'initialized'>, existing: number, fromIngest = seed.initialized): ActivityInput {
  const seededFrom = fromIngest ? 'INGEST_PROJECTS' : seed.tracked.length ? 'existing data' : 'nothing';
  const projects = (k: number) => `${k} project${k === 1 ? '' : 's'}`;
  return {
    kind: 'projects_selected',
    actor: 'deterministic',
    projectKey: null,
    subject: seed.tracked.length
      ? `reading ${projects(seed.tracked.length)}: ${seed.tracked.join(', ')}`
      : 'no projects are selected yet: no sessions are read until you choose folders in Settings',
    why: seededFrom === 'INGEST_PROJECTS'
      ? 'first start with a project selection: taken from INGEST_PROJECTS; change it in Settings from now on'
      : seededFrom === 'existing data'
        ? `first start with a project selection after an upgrade; INGEST_PROJECTS was empty, so the projects that hold your approved lessons, confirmed feedback, docs or scans were selected and agents keep getting their lessons (${projects(existing)} in the graph). Review it in Settings`
        : existing
          ? `first start with a project selection; INGEST_PROJECTS was empty and the tool no longer reads every project it finds (${projects(existing)} already in the graph keep their data)`
          : 'new install: the tool reads only the folders you choose',
    details: { tracked: seed.tracked, seededFrom, projectsInGraph: existing },
  };
}

/**
 * Alias folder key -> project key: the aliases recorded on projects, plus the folders the worker's last snapshot
 * found to be clones of an existing project (not recorded yet, because none of their sessions was read). Recorded
 * aliases win.
 */
export function withClones(recorded: Map<string, string>, snap: CandidateSnapshot | null): Map<string, string> {
  const out = new Map(recorded);
  for (const c of snap?.candidates ?? []) {
    if (c.cloneOf && c.cloneOf !== c.key && !out.has(c.key)) out.set(c.key, c.cloneOf);
  }
  return out;
}

/** The owner's project selection and the worker's candidate list, each a single node. */
export class SelectionRepo implements SelectionStore {
  readonly g: GraphRepo;
  constructor(g: GraphRepo) {
    this.g = g;
  }

  async get(): Promise<ProjectSelection | null> {
    const [r] = await this.g.run('MATCH (s:ProjectSelection {id: $id}) RETURN s', { id: ID });
    return r ? toSelection(r.get('s').properties) : null;
  }

  /** The stored selection, or the empty one (nothing tracked) when none was stored yet. */
  async current(): Promise<ProjectSelection> {
    return (await this.get()) ?? EMPTY_SELECTION;
  }

  /**
   * First start: store the initial selection (INGEST_PROJECTS, or nothing) and log it. Safe to call from both
   * services at once: only the call that created the node logs.
   */
  async ensure(env: Pick<Config, 'ingestProjects' | 'excludeProjects'>, activity?: Pick<ActivityStore, 'record'>): Promise<{ selection: ProjectSelection; seeded: boolean }> {
    const stored = await this.get();
    if (stored) return { selection: stored, seeded: false };
    const seed = initialSelection(env, env.ingestProjects.length ? [] : await this.investedKeys());
    const token = randomUUID();
    const [r] = await this.g.run(
      `MERGE (s:ProjectSelection {id: $id})
         ON CREATE SET s.tracked = $tracked, s.initialized = $initialized, s.updatedAt = $now, s.createdBy = $token
       RETURN s, s.createdBy = $token AS created`,
      { id: ID, tracked: seed.tracked, initialized: seed.initialized, now: new Date().toISOString(), token },
    );
    const selection = toSelection(r.get('s').properties);
    const seeded = r.get('created') === true;
    if (seeded && activity) {
      const [c] = await this.g.run('MATCH (p:Project) RETURN count(p) AS n');
      const existing = Number(c?.get('n') ?? 0);
      await activity.record(selectionSeededActivity(seed, existing, env.ingestProjects.length > 0));
    }
    return { selection, seeded };
  }

  /**
   * Project keys you invested in, for the first selection after an upgrade from a version that read every project:
   * approved lessons (a global one counts for the project it came from), confirmed feedback, docs and scans.
   */
  async investedKeys(): Promise<string[]> {
    const rows = await this.g.run(
      `CALL {
         MATCH (l:Lesson {status: 'approved'}) RETURN coalesce(l.projectKey, l.originProjectKey) AS key
         UNION MATCH (f:Feedback) WHERE f.status <> 'rejected' RETURN f.projectKey AS key
         UNION MATCH (d:Doc) RETURN d.projectKey AS key
         UNION MATCH (j:ScanJob) RETURN j.projectKey AS key
       }
       WITH key WHERE key IS NOT NULL
       RETURN DISTINCT key ORDER BY key`,
    );
    return rows.map((r) => r.get('key') as string);
  }

  /** Replace the tracked folders. Returns the previous list so the caller can log what changed. */
  async setTracked(tracked: string[]): Promise<{ before: string[]; selection: ProjectSelection }> {
    const next = [...new Set(tracked)].sort();
    const [r] = await this.g.run(
      `MERGE (s:ProjectSelection {id: $id})
       WITH s, coalesce(s.tracked, []) AS before
       SET s.tracked = $tracked, s.initialized = true, s.updatedAt = $now
       RETURN s, before`,
      { id: ID, tracked: next, now: new Date().toISOString() },
    );
    return { before: (r.get('before') as string[]) ?? [], selection: toSelection(r.get('s').properties) };
  }

  /** Alias folder key → the project key it is a clone of (recorded, or found by the worker: withClones). */
  async aliases(): Promise<Map<string, string>> {
    const rows = await this.g.run('MATCH (p:Project) WHERE size(coalesce(p.aliases, [])) > 0 UNWIND p.aliases AS a RETURN a, p.key AS key ORDER BY key');
    const out = new Map<string, string>();
    for (const r of rows) if (!out.has(r.get('a'))) out.set(r.get('a'), r.get('key'));
    return withClones(out, await this.candidates());
  }

  /** A write to one IngestLock node, held until fn settles: another section's write waits for the commit. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const session = this.g.driver.session();
    const tx = session.beginTransaction();
    try {
      await tx.run('MERGE (l:IngestLock {id: $id}) SET l.heldAt = $now', { id: ID, now: new Date().toISOString() });
      let out: T;
      try {
        out = await fn();
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      }
      await tx.commit();
      return out;
    } finally {
      await session.close();
    }
  }

  async forgetReads(folderKeys: string[]): Promise<void> {
    if (!folderKeys.length) return;
    // A counter node of its own (not the lock's, so this can run inside an exclusive section): its write lock orders
    // concurrent callers.
    await this.g.run(
      `MERGE (c:ReadResetSeq {id: $id})
       SET c.seq = coalesce(c.seq, 0) + 1
       CREATE (:ReadReset {seq: c.seq, keys: $keys, at: $now})`,
      { id: ID, keys: [...new Set(folderKeys)], now: new Date().toISOString() },
    );
  }

  async forgottenReads(after: number): Promise<{ seq: number; keys: string[] }> {
    const rows = await this.g.run('MATCH (r:ReadReset) RETURN r.seq AS seq, r.keys AS keys ORDER BY seq');
    const max = rows.reduce((m, r) => Math.max(m, Number(r.get('seq'))), 0);
    const from = max < after ? 0 : after;
    const keys = new Set<string>();
    for (const r of rows) if (Number(r.get('seq')) > from) for (const k of r.get('keys') as string[]) keys.add(k);
    return { seq: max, keys: [...keys] };
  }

  async scope(env: Pick<Config, 'excludeProjects'>): Promise<ProjectScope> {
    const [selection, aliases] = await Promise.all([this.current(), this.aliases()]);
    return projectScope(selection, env, aliases);
  }

  async saveCandidates(s: CandidateSnapshot): Promise<void> {
    await this.g.run('MERGE (c:ProjectCandidates {id: $id}) SET c.json = $json, c.builtAt = $builtAt', { id: ID, json: JSON.stringify(s), builtAt: s.builtAt });
  }

  async candidates(): Promise<CandidateSnapshot | null> {
    const [r] = await this.g.run('MATCH (c:ProjectCandidates {id: $id}) RETURN c.json AS json', { id: ID });
    if (!r) return null;
    try {
      return JSON.parse(r.get('json')) as CandidateSnapshot;
    } catch {
      return null;
    }
  }

  /** Project keys that hold anything: sessions, lessons, facts, docs, feedback, scans. The activity log does not count. */
  async keysWithData(): Promise<string[]> {
    const rows = await this.g.run(
      `CALL {
         MATCH (p:Project) RETURN p.key AS key
         UNION MATCH (l:Lesson) WHERE l.projectKey IS NOT NULL RETURN l.projectKey AS key
         UNION MATCH (d:Doc) RETURN d.projectKey AS key
         UNION MATCH (f:Feedback) RETURN f.projectKey AS key
         UNION MATCH (j:ScanJob) RETURN j.projectKey AS key
         UNION MATCH (c:CodeFile) RETURN c.projectKey AS key
       }
       WITH key WHERE key IS NOT NULL
       RETURN DISTINCT key ORDER BY key`,
    );
    return rows.map((r) => r.get('key') as string);
  }
}

/** A stored selection, tracked keys sorted. */
export function toSelection(p: { tracked?: unknown; initialized?: unknown; updatedAt?: unknown }): ProjectSelection {
  return { tracked: ((p.tracked as string[]) ?? []).slice().sort(), initialized: p.initialized === true, updatedAt: (p.updatedAt as string) ?? null };
}
