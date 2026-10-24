import type { CloudSyncStatus } from './cloud.ts';
export type ToolCall = { name: string; ts: string; filePath?: string; command?: string };

export type HumanTurn = {
  uuid: string;
  sessionId: string;
  ts: string;
  index: number;
  text: string;
  /** Last assistant text before this turn, trimmed to 2,000 chars. */
  precedingAssistantText: string;
  /** Tool calls since the previous human turn. */
  precedingToolCalls: ToolCall[];
  /** Set on a comment synced from GitHub or Linear (its stand-in thread holds one turn per comment). */
  external?: ExternalRef;
};

/** Where a piece of feedback came from outside the agent's transcript. */
export type ExternalSource = 'github' | 'linear';
export const EXTERNAL_SOURCES: readonly ExternalSource[] = ['github', 'linear'];

/**
 * A comment from a pull request (GitHub) or an issue (Linear), stored on its turn. `thread` is the PR or issue
 * (owner/repo#12, ENG-42); `branch` the PR's head branch or the issue's suggested branch, used to find the agent
 * session that did the work; `linkedSessionIds` those sessions, newest first (empty: none found).
 */
export type ExternalRef = {
  source: ExternalSource;
  kind: 'review_comment' | 'review' | 'issue_comment' | 'linear_comment';
  author: string;
  url: string;
  thread: string;
  title: string;
  threadUrl: string;
  path: string | null;
  line: number | null;
  /** The diff lines a review comment is attached to (GitHub's diff_hunk), clipped. */
  diffHunk: string | null;
  branch: string | null;
  createdAt: string;
  linkedSessionIds: string[];
};

/** Which agent's transcript a session came from. Sessions stored before Codex support are Claude Code's. */
export type SessionSource = 'claude' | 'codex';
/** Where an Inbox item came from: an agent's transcript, or a comment synced from GitHub or Linear. */
export type FeedbackSource = SessionSource | ExternalSource;
export const FEEDBACK_SOURCES: readonly FeedbackSource[] = ['claude', 'codex', 'github', 'linear'];

export type ParsedSession = {
  sessionId: string;
  /** Unset means 'claude'. */
  source?: SessionSource;
  sourceFile: string;
  cwd: string;
  gitBranch: string | null;
  startedAt: string;
  endedAt: string;
  turns: HumanTurn[];
  toolCalls: ToolCall[];
  /**
   * The agent's last text after the last human turn (redacted, the last 2,000 chars), with its time; null when the
   * session ends on a human turn. Not a turn: it is never classified, so it never becomes an Inbox item. Summaries
   * take it in with the delta that reaches the last turn.
   */
  finalReply?: FinalReply | null;
};

export type FinalReply = { text: string; ts: string };

/**
 * key = top-level dir name under a project root: the local handle. remote = normalizeRemote(origin), the same for
 * every clone, so two folders (or two developers) holding one repo can be recognised as one project.
 */
export type Project = { key: string; name: string; repoPath: string; remote?: string | null };

export type Commit = { sha: string; ts: string; subject: string };

export type TurnLabel = 'pushback' | 'correction' | 'approval' | 'neutral';
export const TURN_LABELS: readonly TurnLabel[] = ['pushback', 'correction', 'approval', 'neutral'];

export type Classification = { label: TurnLabel; confidence: number; summary: string; signals: string[] };

export type CandidateStatus = 'pending' | 'confirmed' | 'rejected';

export type Candidate = {
  id: string;
  turnUuid: string;
  sessionId: string;
  projectKey: string;
  /** The agent the flagged session ran in, or github / linear for a synced comment. */
  source: FeedbackSource;
  /** The comment's details, when source is github or linear. */
  external?: ExternalRef | null;
  classification: Classification;
  status: CandidateStatus;
  createdAt: string;
  decidedAt: string | null;
  note: string | null;
  /**
   * Who flagged it: the detector (from the transcript), an agent's report_feedback call, or both when the two were the
   * same miss and were merged into this one item (see dedupe.ts). Always set by the stores.
   */
  origins?: CandidateOrigin[];
  /** What the agent reported through report_feedback, when it did; kept when merged with the detector's turn. */
  agentReport?: AgentReport | null;
};

export type CandidateOrigin = 'detector' | 'agent';
export type AgentReport = { text: string; whatWasDone: string; reportedAt: string; sessionId: string | null };

// ── Milestone 2: post-mortems and lessons ──────────────────────────────

export const CAUSES = [
  'context_missing',
  'context_available_ignored',
  'requirement_unstated',
  'verification_gap',
  'implementation_error',
] as const;
export type Cause = (typeof CAUSES)[number];

export type LessonScope = 'task' | 'project' | 'global';
export type Outcome = 'approved' | 'addressed' | 'unresolved' | 'unknown';
export type FeedbackStatus = 'open' | 'addressed' | 'verified' | 'approved' | 'rejected' | 'reopened' | 'superseded' | 'unknown';

export type ContextKind = 'code' | 'doc' | 'claude_md' | 'agents_md' | 'memory' | 'session' | 'pr' | 'ticket' | 'upload';
export type ContextItem = { kind: ContextKind; ref: string; excerpt: string; why: string; wasAvailable: boolean };

export type PostMortem = {
  taskTitle: string;
  missed: string;
  cause: Cause;
  causeExplanation: string;
  outcome: Outcome;
  lesson: { title: string; rule: string; appliesWhen: string; scope: LessonScope; paths: string[] };
  contextItems: ContextItem[];
};

export type LessonStatus = 'proposed' | 'approved' | 'rejected' | 'superseded';
export type LessonSource = 'postmortem' | 'memory' | 'manual';

export type Lesson = {
  id: string;
  /** Who it is served to: its project, or null for a global lesson. */
  projectKey: string | null;
  /** The project it was learned in (a global lesson keeps it here); null when it has none. Set by the stores. */
  origin?: string | null;
  title: string;
  rule: string;
  appliesWhen: string;
  scope: LessonScope;
  paths: string[];
  status: LessonStatus;
  source: LessonSource;
  cause: Cause | null;
  missId: string | null;
  createdAt: string;
  decidedAt: string | null;
};

/** Everything the post-mortem needs about one confirmed piece of feedback. */
export type PostMortemInput = {
  feedbackId: string;
  projectKey: string;
  repoPath: string;
  cwd: string;
  sessionId: string;
  /** The agent the session ran in; it decides which instruction files (CLAUDE.md or AGENTS.md) the agent had loaded. Unset: 'claude'. */
  source?: FeedbackSource;
  /**
   * For a comment from GitHub or Linear (feedback.external is set): the agent session that most likely did the work,
   * filled in by the worker. Absent: no session was found, and the post-mortem works from the comment alone.
   */
  work?: { sessionId: string; source: SessionSource; cwd: string; turns: HumanTurn[] } | null;
  feedback: HumanTurn;
  /** All human turns in the session, in order (the flagged one included). */
  turns: HumanTurn[];
  note: string | null;
};

// ── Code scanning ──────────────────────────────────────────────────────

export const FACT_KINDS = [
  'architecture',
  'convention',
  'api',
  'invariant',
  'gotcha',
  'config',
  'dependency',
  'command',
  'data_model',
  'security',
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** `why`: the extractor's reason a coding agent needs this fact. */
export type CodeFact = { kind: FactKind; statement: string; path: string; lines: string | null; confidence: number; why: string };

export type ScanStatus = 'queued' | 'running' | 'done' | 'failed';
export type ScanJob = {
  id: string;
  projectKey: string;
  repoPath: string;
  provider: string | null;
  status: ScanStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  filesScanned: number;
  factsAdded: number;
  error: string | null;
  /** Failed runs so far (a model that could not be asked never counts); MAX_SCAN_ATTEMPTS of them and it is failed. */
  attempts: number;
  /** Queued but not to run before this (ISO): backing off after a failure or an unreachable model. */
  retryAt: string | null;
};

export type ProjectSummary = {
  key: string;
  repoPath: string;
  remote: string | null;
  /** Other folders holding a clone of the same remote, whose sessions are recorded under this project. */
  aliases: string[];
  sessions: number;
  feedback: number;
  lessons: number;
  facts: number;
  lastScan: ScanJob | null;
};

// ── Provenance ─────────────────────────────────────────────────────────

/** Everything the system creates or decides leaves one of these: who/what did it, from what, and why. */
export const ACTIVITY_KINDS = [
  'scan_started',
  'facts_extracted',
  'scan_finished',
  'memory_imported',
  'candidate_flagged',
  'feedback_decided',
  'postmortem_done',
  'postmortem_failed',
  'lesson_decided',
  'context_served',
  'predone_check',
  'doc_added',
  'doc_removed',
  'project_deleted',
  'project_aliased',
  'projects_selected',
  'projects_cleaned',
  'code_mapped',
  'cloud_synced',
  'turns_requeued',
  'bundle_imported',
  'session_summarized',
  'roots_saved',
  'integration_changed',
  'feedback_synced',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type ActivityInput = {
  kind: ActivityKind;
  /** A provider id (`ollama:gemma4`, `claude-cli`), `you`, `memory-file`, `deterministic`, or an MCP client. */
  actor: string;
  projectKey: string | null;
  /** What happened, one line. */
  subject: string;
  /** Why it happened: the trigger or the model's stated reason. */
  why: string;
  details?: Record<string, unknown>;
  /** Ids of graph nodes this activity created or touched (lesson ids, `project:path` code files, feedback ids). */
  targets?: string[];
};
export type Activity = Required<ActivityInput> & { id: string; ts: string };

/** What the worker reports about itself each heartbeat; shown in the UI header and at /api/status. */
export type WorkerStatus = {
  version: string;
  startedAt: string;
  lastBeat: string;
  lastCycleAt: string | null;
  lastCycle: Record<string, number | boolean> | null;
  lastError: string | null;
  providers: Record<string, string | null>;
  /** Feedback Graph Cloud sync; absent or null when CLOUD_URL is not set. */
  cloudSync?: CloudSyncStatus | null;
  /** How each job's model last fared (classify, postmortem, scan, summary); missing until it is first asked. */
  health?: Partial<Record<ModelJob, ProviderHealth>>;
  /** Jobs turned off on purpose (SUMMARY_LLM=off), so a missing model is not reported as broken. */
  off?: ModelJob[];
};

/** How a provider last fared: `reason` says why it could not be asked, null while it answers. */
export type ProviderHealth = { provider: string; ok: boolean; reason: string | null; at: string };

export const MODEL_JOBS = ['classify', 'postmortem', 'scan', 'summary'] as const;
export type ModelJob = (typeof MODEL_JOBS)[number];
/** A job's model as /api/status reports it: ok until it was last found unavailable (or, for an Ollama model, while
 * Ollama does not answer), with the reason. */
export type ModelHealth = { provider: string | null; ok: boolean; reason: string | null; off?: true };

/** Whether Ollama answers at `url` with the models it is asked for; `reason` says why not. */
export type OllamaHealth = { url: string; ok: boolean; reason: string | null };

/** Everything Feedback Graph talks to outside the machine or beside it, as the app shell's connections list shows it. */
export const CONNECTION_NAMES = ['github', 'linear', 'claude', 'codex', 'ollama', 'cloud'] as const;
export type ConnectionName = (typeof CONNECTION_NAMES)[number];
export type ConnectionState = 'connected' | 'not_connected' | 'error';
/**
 * One connection: its state, where its credential comes from (.env or saved in the app; null when none or not
 * applicable), one plain sentence (the account, the last sync, or what is wrong and how to fix it) and the Settings
 * link that manages it. Never a token.
 */
export type Connection = { state: ConnectionState; source: 'env' | 'app' | null; detail: string; href: string };

export type SystemStatus = {
  version: string;
  /** The backend everything is stored in (STORE); null when unknown. */
  store: 'neo4j' | 'postgres' | null;
  /** Whether that store answers (named for the original, graph-only backend). */
  graph: boolean;
  worker: WorkerStatus | null;
  /** The worker beat within the last few minutes. */
  workerHealthy: boolean;
  authRequired: boolean;
  /**
   * How many project folders are selected for reading, and how many project roots are mounted (unset from older APIs);
   * `note` says plainly when nothing can be read. Null when unknown.
   */
  selection: { initialized: boolean; tracked: number; roots?: number; note: string | null } | null;
  /** Feedback Graph Cloud sync: null when off. The token is always shown as [REDACTED]. */
  cloud?: { host: string; token: '[REDACTED]'; intervalMinutes: number | null } | null;
  /** Each job's model from the worker's heartbeat; null when the worker has not reported. */
  models?: Record<ModelJob, ModelHealth> | null;
  /** Turns the classifier gave up on (they can be re-queued); null when unknown. */
  givenUpTurns?: number | null;
  /** Ollama, which every embedding (search, get_task_context, check_before_done) needs: null when not checked. */
  ollama?: OllamaHealth | null;
  /** GitHub, Linear, Claude, Codex, Ollama and cloud sync; null when unknown (an older api leaves it out). */
  connections?: Record<ConnectionName, Connection> | null;
};

// ── Session summaries ──────────────────────────────────────────────────

/**
 * active: turns are still coming in (or came in within SESSION_IDLE_MINUTES); idle: quiet for that long and summarized
 * to its last turn ("complete for now"). A new turn makes an idle session active again.
 */
export const SESSION_STATES = ['active', 'idle'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** A model's running summary of one session, merged as new turns arrive. `markdown` is rendered from the rest. */
export type SessionSummary = {
  goal: string;
  done: string[];
  decisions: string[];
  openThreads: string[];
  /** Repo-relative where known. */
  filesTouched: string[];
  /** What the developer pushed back on, in a few words each. */
  pushback: string[];
  outcome: string;
  markdown: string;
};

/** How far a summary reaches: the last turn it covers, by index in its session and by that turn's time (as stored). */
export type SummaryCursor = { index: number; ts: string };

/** One change to a session's summary: which turns it took in (after `from`, up to `to`), with what, when. */
export type SummaryUpdate = {
  version: number;
  /** Null: built from the session's first turn (a first summary, or a rebuild). */
  from: SummaryCursor | null;
  to: SummaryCursor;
  deltaTurns: number;
  model: string;
  at: string;
  /** The owner asked for it to be rebuilt from scratch. */
  rebuild: boolean;
};

/** A session in the Sessions list. */
export type SessionListItem = {
  id: string;
  projectKey: string;
  source: SessionSource;
  cwd: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  /** The newest of its last event and its last turn (ISO); null when neither could be read. */
  lastActivityAt: string | null;
  turnCount: number;
  state: SessionState;
  /** The summary's goal, for the list; null before the first summary. */
  snippet: string | null;
  summarizedThrough: SummaryCursor | null;
  summaryUpdatedAt: string | null;
  /** How many updates built the current summary. */
  summaryVersion: number;
  /** Turns after the cursor, not summarized yet. */
  pendingTurns: number;
};

/** An Inbox item flagged in a session, with the lesson its post-mortem proposed, if any. */
export type SessionInboxItem = { id: string; status: CandidateStatus; label: string | null; summary: string | null; lessonId: string | null; lessonStatus: LessonStatus | null };

export type SessionDetail = SessionListItem & {
  summary: SessionSummary | null;
  summaryModel: string | null;
  /** Oldest first. */
  history: SummaryUpdate[];
  /** The owner asked for a rebuild that has not run yet. */
  rebuildRequested: boolean;
  /** Turns whose text TURN_RETENTION_DAYS removed: a rebuild could not see them. */
  prunedTurns: number;
  /** Why the last attempt failed, and when the next is due (null while it is not backing off). */
  summaryError: string | null;
  summaryRetryAt: string | null;
  inbox: SessionInboxItem[];
};
