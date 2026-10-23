import { hostRepoPath, providerUnavailableReason, sessionFiles, type ActivityStore, type ProjectScope, type Classification, type CodeGraphStore, type GraphStore, type HumanTurn, type ParsedSession, type SessionSource } from '@fb/core';
import { prefilterPushback } from './detect/prefilter.ts';
import { codexSessionParser } from './ingest/codex.ts';
import type { commitsInWindow } from './ingest/git.ts';
import { parseTranscript } from './ingest/parseTranscript.ts';
import { projectFromCwd, type Project, type Root } from '@fb/core';
import type { FileState } from './state.ts';

/** `source` unset: a Claude Code transcript. */
export type FileInfo = { path: string; size: number; mtimeMs: number; source?: SessionSource };

/** A file this big that keeps changing (a long Codex session can pass 800 MB) is re-read at most this often. */
const LARGE_FILE_BYTES = 32 * 1024 * 1024;
const LARGE_FILE_MIN_INTERVAL_MS = 10 * 60_000;

export type CycleDeps = {
  listFiles(): Promise<FileInfo[]>;
  readFile(path: string): Promise<string>;
  /** Codex rollouts are streamed, never read whole. */
  readLines?(path: string): AsyncIterable<string>;
  /**
   * The folder key a file's head says it belongs to (a Codex rollout that changed cwd: every folder it was in): null
   * when there is nothing in it to ingest (outside every root, an agent-only session), undefined when unknown (the
   * file is parsed to find out).
   */
  folderOf?(path: string): string | string[] | null | undefined;
  state: FileState;
  repo: Pick<GraphStore, 'upsertSession' | 'unclassifiedTurns' | 'saveClassification' | 'recordClassifyFailure'>;
  roots: Root[];
  commits: typeof commitsInWindow;
  classify(turn: HumanTurn): Promise<Classification | null>;
  classifyBatch: number;
  log?: (msg: string, extra?: object) => void;
  /** ProjectScope.folder: when set, only sessions in folders that pass are read and ingested. */
  includeProject?: (key: string) => boolean;
  /**
   * The scope as stored right now, read inside the exclusive section before a transcript is written: the selection
   * can change (and a cleanup run) while a long cycle is part way. Unset: includeProject and onlyProjects.
   */
  scopeNow?: () => Promise<Pick<ProjectScope, 'folder' | 'projects'>>;
  /** SelectionStore.exclusive: a transcript's writes never interleave with a project's deletion. */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** ProjectScope.projects: only turns of these projects are classified; an empty list classifies none. */
  onlyProjects?: string[];
  /** EXCLUDE_PROJECTS: turns already in the graph from these projects are not classified either. */
  excludeProjects?: string[];
  /** Provider id of `classify`, for the provenance log. */
  classifierId?: string;
  activity?: Pick<ActivityStore, 'record'>;
  /** A folder's canonical git remote (projectRemote). Without it and `projects`, projects are folders only. */
  remote?: (repoPath: string) => Promise<string | null>;
  projects?: Pick<GraphStore, 'canonicalProject' | 'projectsMissingRemote' | 'setProjectRemote'>;
  /** Where the repo files each session read and edited are recorded (links misses to code). */
  codegraph?: Pick<CodeGraphStore, 'recordSessionFiles'>;
  now?: () => number;
  largeFileBytes?: number;
  largeFileMinIntervalMs?: number;
};

/** `classifierUnavailable`: why the model could not be asked this cycle (no turn was charged for it). */
export type CycleResult = { filesIngested: number; turnsClassified: number; candidates: number; classifierUnavailable?: string };

const CANDIDATE_LABELS = new Set(['pushback', 'correction']);
const NEUTRAL: Classification = { label: 'neutral', confidence: 0, summary: '', signals: [] };
/** Failures in a row before the cycle stops calling the model: a hung or broken model would otherwise cost batch × timeout. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Projects recorded before remotes were (or whose folder had none then) get one in place: nothing is re-ingested. */
async function backfillRemotes(deps: CycleDeps, log: (msg: string, extra?: object) => void) {
  if (!deps.remote || !deps.projects) return;
  try {
    for (const p of await deps.projects.projectsMissingRemote()) {
      const remote = await deps.remote(p.repoPath);
      if (remote) await deps.projects.setProjectRemote(p.key, remote);
    }
  } catch (err) {
    log('remote backfill failed', { error: String(err) });
  }
}

type Scope = Pick<ProjectScope, 'folder' | 'projects'>;

/**
 * The project a session in this folder is recorded under: the folder itself, or the project it is a clone of. A
 * clone follows its project: when that project is out of scope the session is skipped (`skipped`: that project's
 * key) and no alias is recorded, so the folder is not tied to a project nobody selected.
 */
async function projectFor(folder: Project, deps: CycleDeps, scope: Scope | null): Promise<{ project: Project } | { skipped: string }> {
  if (!deps.remote || !deps.projects) return { project: folder };
  const remote = await deps.remote(folder.repoPath);
  const would = await deps.projects.canonicalProject({ ...folder, remote }, { dryRun: true });
  if (would.project.key !== folder.key && scope && !scope.folder(would.project.key)) return { skipped: would.project.key };
  const { project, aliasedNow } = await deps.projects.canonicalProject({ ...folder, remote });
  if (project.key === folder.key) return { project: { ...folder, remote } };
  if (scope && !scope.folder(project.key)) return { skipped: project.key };
  if (aliasedNow) {
    await deps.activity?.record({
      kind: 'project_aliased',
      actor: 'deterministic',
      projectKey: project.key,
      subject: `"${folder.key}" is another clone of ${project.key}: its sessions are recorded under ${project.key}`,
      why: `both folders have the git remote ${remote}`,
      details: { folder: folder.key, remote },
    });
  }
  return { project };
}

/** The files a session touched, relative to its folder on the host. Best effort: a failure here never stops ingest. */
async function recordTouchedFiles(s: ParsedSession, deps: CycleDeps, log: (msg: string, extra?: object) => void) {
  const root = deps.codegraph && hostRepoPath(s.cwd, deps.roots);
  if (!root) return;
  try {
    await deps.codegraph!.recordSessionFiles(s.sessionId, sessionFiles(s, root));
  } catch (err) {
    log('session files not recorded', { session: s.sessionId, error: String(err) });
  }
}

async function readSessions(path: string, source: SessionSource, deps: CycleDeps): Promise<ParsedSession[]> {
  if (source === 'claude') return parseTranscript(await deps.readFile(path), path);
  if (!deps.readLines) throw new Error('no line reader for Codex sessions');
  const p = codexSessionParser(path);
  for await (const line of deps.readLines(path)) p.push(line);
  return p.finish();
}

export async function runCycle(deps: CycleDeps): Promise<CycleResult> {
  const log = deps.log ?? (() => {});
  let filesIngested = 0;
  await backfillRemotes(deps, log);

  const now = deps.now ?? Date.now;
  const include = deps.includeProject;
  const exclusive = deps.exclusive ?? (<T>(fn: () => Promise<T>) => fn());
  for (const file of await deps.listFiles()) {
    // Not selected: not read and not marked, so selecting the folder later reads it in full.
    const head = deps.folderOf?.(file.path);
    if (head === null) continue;
    const folderKeys = head === undefined ? undefined : typeof head === 'string' ? [head] : head;
    if (folderKeys && include && !folderKeys.some(include)) continue;
    const st = deps.state.ingestState(file.path, file.size, file.mtimeMs);
    // Read before with part of it out of scope, and that part is selected now: read it again.
    const rescoped = !!include && st.skipped.some(include);
    if (!st.changed && !rescoped) continue;
    if (st.changed && !rescoped && file.size > (deps.largeFileBytes ?? LARGE_FILE_BYTES) && st.readAt !== null && now() - st.readAt < (deps.largeFileMinIntervalMs ?? LARGE_FILE_MIN_INTERVAL_MS)) continue;
    const source: SessionSource = file.source ?? 'claude';
    let sessions: ParsedSession[];
    try {
      sessions = (await readSessions(file.path, source, deps)).map((s) => ({ ...s, source }));
    } catch (err) {
      // Unreadable or unparseable: retried when the file changes, not every 30 seconds forever.
      deps.state.markIngested(file.path, file.size, file.mtimeMs, now());
      log('ingest failed', { file: file.path, error: String(err) });
      continue;
    }
    try {
      const ingested = await exclusive(async () => {
        const scope: Scope | null = deps.scopeNow ? await deps.scopeNow() : include ? { folder: include, projects: deps.onlyProjects ?? [] } : null;
        const keys = new Set<string>();
        const skipped = new Set<string>();
        let wrote = false;
        for (const s of sessions) {
          const folder = projectFromCwd(s.cwd, deps.roots);
          if (!folder || !s.turns.length) continue;
          keys.add(folder.key);
          // Out of scope: skipped, and remembered as such so selecting it later reads this file again.
          if (scope && !scope.folder(folder.key)) {
            skipped.add(folder.key);
            continue;
          }
          const target = await projectFor(folder, deps, scope);
          if ('skipped' in target) {
            keys.add(target.skipped);
            skipped.add(target.skipped);
            continue;
          }
          keys.add(target.project.key);
          const commits = await deps.commits(folder.repoPath, s.startedAt, s.endedAt);
          await deps.repo.upsertSession(target.project, s, commits);
          wrote = true;
          await recordTouchedFiles(s, deps, log);
        }
        deps.state.markIngested(file.path, file.size, file.mtimeMs, now(), { keys: [...keys], skipped: [...skipped] });
        return wrote;
      });
      if (ingested) filesIngested++;
    } catch (err) {
      // A graph error is not the file's fault: leave it unmarked so the next cycle tries again.
      log('ingest failed', { file: file.path, error: String(err) });
    }
  }

  let turnsClassified = 0;
  let candidates = 0;
  // Prefilter misses are labelled neutral without a model call, so only model calls count against the batch.
  let modelCalls = 0;
  let failuresInRow = 0;
  let unavailable: string | null = null;
  for (const turn of await deps.repo.unclassifiedTurns(deps.classifyBatch * 20, deps.onlyProjects, deps.excludeProjects)) {
    let c: Classification | null = NEUTRAL;
    const pre = prefilterPushback(turn.text);
    if (pre.hit) {
      if (unavailable || modelCalls >= deps.classifyBatch || failuresInRow >= MAX_CONSECUTIVE_FAILURES) continue;
      modelCalls++;
      try {
        c = await deps.classify(turn);
      } catch (err) {
        // The model could not be asked (down, missing, not signed in): not the turn's fault, so nothing is charged.
        unavailable = providerUnavailableReason(err);
        if (!unavailable) throw err;
        log('classifier unavailable, pausing until next cycle', { reason: unavailable });
        continue;
      }
      failuresInRow = c ? 0 : failuresInRow + 1;
    }
    if (!c) {
      // Counted per turn, so a message the model can never label stops being retried (see unclassifiedTurns).
      await deps.repo.recordClassifyFailure(turn.uuid);
      if (failuresInRow === MAX_CONSECUTIVE_FAILURES) log('classifier failing, pausing until next cycle', { turn: turn.uuid });
      continue;
    }
    const isCandidate = CANDIDATE_LABELS.has(c.label);
    // The Inbox item the turn is filed under: its own id, or an agent report's it was merged into (dedupe.ts).
    const itemId = await deps.repo.saveClassification(turn.uuid, c, isCandidate);
    turnsClassified++;
    if (isCandidate) {
      candidates++;
      await deps.activity?.record({
        kind: 'candidate_flagged',
        actor: deps.classifierId ?? 'classifier',
        projectKey: turn.projectKey,
        subject: `flagged as ${c.label}: "${turn.text.slice(0, 80)}${turn.text.length > 80 ? '…' : ''}"`,
        why: c.summary,
        details: { label: c.label, confidence: c.confidence, signals: c.signals, sessionId: turn.sessionId, turnUuid: turn.uuid, prefilter: pre.signals.join(' | ') },
        targets: [itemId ?? turn.uuid],
      });
    }
  }

  return unavailable ? { filesIngested, turnsClassified, candidates, classifierUnavailable: unavailable } : { filesIngested, turnsClassified, candidates };
}
