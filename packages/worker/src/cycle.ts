import { feedbackSkipRule, hostRepoPath, isSelfReview, modelTimeoutReason, providerUnavailableReason, redactSecrets, sessionFiles, type ActivityStore, type ProjectScope, type Classification, type CodeGraphStore, type GraphStore, type HumanTurn, type ParsedSession, type SessionSource, type ToolCall } from '@fb/core';
import { gitEvidence } from './detect/instruction.ts';
import { prefilterPushback } from './detect/prefilter.ts';
import { codexSessionParser } from './ingest/codex.ts';
import { conversationFingerprint } from './ingest/fingerprint.ts';
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
  /** callsAfter: what the agent did after a message (the evidence an instruction about git was broken). */
  repo: Pick<GraphStore, 'upsertSession' | 'unclassifiedTurns' | 'saveClassification' | 'recordClassifyFailure'> & Partial<Pick<GraphStore, 'callsAfter'>>;
  roots: Root[];
  commits: typeof commitsInWindow;
  classify(turn: HumanTurn): Promise<Classification | null>;
  classifyBatch: number;
  /** True while a scan is using a model: a classify timeout then means a queue behind it, not this turn's fault. */
  modelBusy?: () => boolean;
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
  /** How many turns the graph holds for a session, null when it has none (SessionsStore.detail): see codexCopyOf. */
  storedTurns?: (sessionId: string) => Promise<number | null>;
  /** A folder's canonical git remote (projectRemote). Without it and `projects`, projects are folders only. */
  remote?: (repoPath: string) => Promise<string | null>;
  projects?: Pick<GraphStore, 'canonicalProject' | 'projectsMissingFolder' | 'fillProjectFolder'>;
  /** The selected folders (container paths): records made by scans, code maps or uploads get their path from here. */
  folders?: () => Promise<{ key: string; repoPath: string }[]>;
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
/** A comments_skipped entry keeps this many skipped comments as samples (clipped), and this many as targets. */
const MAX_SKIP_SAMPLES = 5;
const SKIP_SAMPLE_CHARS = 200;
const MAX_SKIP_TARGETS = 50;

const INSTRUCTION: Classification = {
  label: 'neutral',
  confidence: 1,
  summary: 'an instruction about git, not a correction: nothing it forbids was done before it or after it',
  signals: ['instruction'],
};

/**
 * Projects recorded before remotes were (or whose folder had none then), and records a scan, a code map or an upload
 * made with no folder at all, get their path and remote in place from the selected folder: nothing is re-ingested.
 * Cloud sync and link detection read the remote from these records.
 */
async function backfillRemotes(deps: CycleDeps, log: (msg: string, extra?: object) => void) {
  if (!deps.remote || !deps.projects) return;
  try {
    const missing = await deps.projects.projectsMissingFolder();
    if (!missing.length) return;
    const folders = new Map((deps.folders ? await deps.folders() : []).map((f) => [f.key, f.repoPath]));
    for (const p of missing) {
      const repoPath = p.repoPath || folders.get(p.key);
      if (!repoPath) continue;
      const remote = p.remote ?? (await deps.remote(repoPath));
      if (repoPath !== p.repoPath || (remote && remote !== p.remote)) await deps.projects.fillProjectFolder(p.key, { repoPath, remote });
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

/**
 * The Claude Code session this Codex session is a copy of, or null: Codex's own. Judged once, the first time it is read,
 * and kept: a live session read at its first turn is too short to fingerprint, so it is Codex's own, and stays so when
 * it grows to open like a Claude Code conversation (the same prompts given to both agents). Judging on every read
 * dropped such a session once it matched, frozen at the turns already stored. A session with no verdict yet that the
 * graph already holds was read as Codex's own under that rule: it stays so, and is logged as resumed.
 */
async function codexCopyOf(s: ParsedSession, fingerprint: string | null, projectKey: string, deps: CycleDeps): Promise<string | null> {
  const verdict = deps.state.codexVerdict(s.sessionId);
  if (verdict !== undefined) return verdict;
  const original = fingerprint ? deps.state.conversation(fingerprint) : null;
  const stored = original && deps.storedTurns ? await deps.storedTurns(s.sessionId) : null;
  if (original && stored === null) {
    deps.state.judgeCodexSession(s.sessionId, original);
    return original;
  }
  deps.state.judgeCodexSession(s.sessionId, null);
  if (original && stored !== null) {
    await deps.activity?.record({
      kind: 'session_resumed',
      actor: 'deterministic',
      projectKey,
      subject: `Codex session ${s.sessionId} is read again: ${stored} of its ${s.turns.length} turns were stored`,
      why: 'an older rule dropped a Codex session as a copy of a Claude Code conversation once its opening matched one, though it had already been read as Codex\'s own; it stopped at the turns stored then',
      details: { sessionId: s.sessionId, storedTurns: stored, turns: s.turns.length, matched: original },
      targets: [s.sessionId],
    });
  }
  return null;
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
          // Codex can import Claude Code conversations; Claude Code files are listed first, so the original is known.
          const fingerprint = conversationFingerprint(s);
          if (fingerprint && source === 'claude') deps.state.rememberConversation(fingerprint, s.sessionId);
          keys.add(folder.key);
          // Out of scope: skipped, and remembered as such so selecting it later reads this file again. Before the copy
          // verdict, so a project not selected is neither judged nor named in Activity.
          if (scope && !scope.folder(folder.key)) {
            skipped.add(folder.key);
            continue;
          }
          const original = source === 'codex' ? await codexCopyOf(s, fingerprint, folder.key, deps) : null;
          if (original) {
            log('codex session skipped: a copy of a Claude Code conversation', { session: s.sessionId, original });
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
  // Comments the skip rules kept from the model this cycle, per project: one activity entry each (comments_skipped).
  const skippedBy = new Map<string, { turn: string; rule: string; text: string }[]>();
  for (const turn of await deps.repo.unclassifiedTurns(deps.classifyBatch * 20, deps.onlyProjects, deps.excludeProjects)) {
    let c: Classification | null = NEUTRAL;
    const pre = prefilterPushback(turn.text);
    // A bot, the PR author's reply, a status note or a bare review trigger: never feedback, so never sent (feedbackRules.ts).
    const skip = turn.external ? feedbackSkipRule(turn.text, turn.external) : null;
    if (skip) {
      c = { label: 'neutral', confidence: 1, summary: `skipped before the model: ${skip.description}`, signals: [`skip:${skip.name}`] };
      skippedBy.set(turn.projectKey, [...(skippedBy.get(turn.projectKey) ?? []), { turn: turn.uuid, rule: skip.name, text: turn.text }]);
    }
    // A review or issue comment is feedback on finished work by nature, and reviewers word it politely: always ask the model.
    else if (pre.hit || turn.external) {
      // An instruction about git ("don't push a PR yet") is not pushback until the agent does what it forbids.
      const git = turn.external ? null : await gitEvidence(turn, deps.repo.callsAfter?.bind(deps.repo), now());
      if (git === 'wait') continue;
      if (git === 'instruction') c = INSTRUCTION;
      else {
        if (unavailable || modelCalls >= deps.classifyBatch || failuresInRow >= MAX_CONSECUTIVE_FAILURES) continue;
        modelCalls++;
        try {
          c = await deps.classify(git ? { ...turn, followingToolCalls: git } : turn);
        } catch (err) {
          // The model could not be asked (down, missing, not signed in): not the turn's fault, so nothing is charged.
          unavailable = providerUnavailableReason(err);
          const timeout = unavailable ? null : modelTimeoutReason(err);
          if (timeout && deps.modelBusy?.()) unavailable = `the model is busy with a scan: ${timeout}`;
          if (unavailable) {
            log('classifier unavailable, pausing until next cycle', { reason: unavailable });
            continue;
          }
          // Anything else (a call that timed out, an answer it could not use) is this turn's failure: charged below,
          // and the batch goes on, so a turn the model can never finish is skipped after its attempts.
          log('classification failed', { turn: turn.uuid, error: redactSecrets(String(err)).slice(0, 800) });
          c = null;
        }
        failuresInRow = c ? 0 : failuresInRow + 1;
      }
    }
    if (!c) {
      // Counted per turn, so a message the model can never label stops being retried (see unclassifiedTurns).
      await deps.repo.recordClassifyFailure(turn.uuid);
      if (failuresInRow === MAX_CONSECUTIVE_FAILURES) log('classifier failing, pausing until next cycle', { turn: turn.uuid });
      continue;
    }
    // An agent reviewing its own PR under the author's account: kept, but labelled so the Inbox does not read it as a reviewer's pushback.
    if (turn.external && !skip && isSelfReview(turn.external) && !c.signals.includes('self-review')) c = { ...c, signals: [...c.signals, 'self-review'] };
    const isCandidate = CANDIDATE_LABELS.has(c.label);
    // The Inbox item the turn is filed under: its own id, or an agent report's it was merged into (dedupe.ts).
    const itemId = await deps.repo.saveClassification(turn.uuid, c, isCandidate);
    turnsClassified++;
    if (isCandidate) {
      candidates++;
      await deps.activity?.record({
        kind: 'candidate_flagged',
        ...(turn.run ? { run: turn.run } : {}),
        ...(turn.sandbox ? { sandbox: true } : {}),
        actor: deps.classifierId ?? 'classifier',
        projectKey: turn.projectKey,
        subject: `flagged as ${c.label}: "${turn.text.slice(0, 80)}${turn.text.length > 80 ? '…' : ''}"`,
        why: c.summary,
        details: { label: c.label, confidence: c.confidence, signals: c.signals, sessionId: turn.sessionId, turnUuid: turn.uuid, prefilter: pre.signals.join(' | ') },
        targets: [itemId ?? turn.uuid],
      });
    }
  }

  for (const [projectKey, skipped] of skippedBy) {
    const rules: Record<string, number> = {};
    for (const s of skipped) rules[s.rule] = (rules[s.rule] ?? 0) + 1;
    await deps.activity?.record({
      kind: 'comments_skipped', actor: 'skip-rules', projectKey,
      subject: `${skipped.length} comment${skipped.length === 1 ? '' : 's'} skipped before the classifier`,
      why: Object.entries(rules).map(([r, n]) => `${r}: ${n}`).join(', '),
      // A few of them to look at (the rest are in targets), clipped: enough to tell whether a rule skips real feedback.
      details: { rules, samples: skipped.slice(0, MAX_SKIP_SAMPLES).map((s) => ({ rule: s.rule, turn: s.turn, text: s.text.slice(0, SKIP_SAMPLE_CHARS) })) },
      targets: skipped.slice(0, MAX_SKIP_TARGETS).map((s) => s.turn),
    });
  }

  return unavailable ? { filesIngested, turnsClassified, candidates, classifierUnavailable: unavailable } : { filesIngested, turnsClassified, candidates };
}
