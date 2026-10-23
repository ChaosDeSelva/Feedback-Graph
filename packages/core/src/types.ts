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
};

/** Which agent's transcript a session came from. Sessions stored before Codex support are Claude Code's. */
export type SessionSource = 'claude' | 'codex';

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
};

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
  /** The agent the flagged session ran in. */
  source: SessionSource;
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
  projectKey: string | null;
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
  source?: SessionSource;
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
  /** How each job's model last fared (classify, postmortem, scan); missing until it is first asked. */
  health?: Partial<Record<ModelJob, ProviderHealth>>;
};

/** How a provider last fared: `reason` says why it could not be asked, null while it answers. */
export type ProviderHealth = { provider: string; ok: boolean; reason: string | null; at: string };

export const MODEL_JOBS = ['classify', 'postmortem', 'scan'] as const;
export type ModelJob = (typeof MODEL_JOBS)[number];
/** A job's model as /api/status reports it: ok until it was last found unavailable (or, for an Ollama model, while
 * Ollama does not answer), with the reason. */
export type ModelHealth = { provider: string | null; ok: boolean; reason: string | null };

/** Whether Ollama answers at `url` with the models it is asked for; `reason` says why not. */
export type OllamaHealth = { url: string; ok: boolean; reason: string | null };

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
  /** How many project folders are selected for reading; `note` says plainly when none are. Null when unknown. */
  selection: { initialized: boolean; tracked: number; note: string | null } | null;
  /** Feedback Graph Cloud sync: null when off. The token is always shown as [REDACTED]. */
  cloud?: { host: string; token: '[REDACTED]'; intervalMinutes: number | null } | null;
  /** Each job's model from the worker's heartbeat; null when the worker has not reported. */
  models?: Record<ModelJob, ModelHealth> | null;
  /** Turns the classifier gave up on (they can be re-queued); null when unknown. */
  givenUpTurns?: number | null;
  /** Ollama, which every embedding (search, get_task_context, check_before_done) needs: null when not checked. */
  ollama?: OllamaHealth | null;
};
