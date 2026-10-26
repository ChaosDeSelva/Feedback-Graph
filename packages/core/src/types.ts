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
  /**
   * Set only while classifying an instruction about git, never stored: the agent's git actions after this turn, the
   * evidence that what it forbade happened.
   */
  followingToolCalls?: ToolCall[];
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
  /**
   * The PR's description or the issue's (markdown; redacted and clipped at sync): the requirements as written.
   * Untrusted text by a person. Unset on comments synced before it was kept; '' or null when there is none.
   */
  description?: string | null;
  /** Linear only: the ticket's workflow state, priority, labels and assignee when it was synced. */
  ticket?: TicketMeta | null;
  /** Who wrote it (feedbackRules.authorKindOf): a person, a bot, or an AI agent. Unset on comments synced before. */
  authorKind?: AuthorKind;
  /** The author kind comes from the GitHub login (a bot or agent listed by login), not from text the author typed. */
  authorVerified?: boolean;
  /** GitHub: the PR's author, so a reply of theirs is told from a reviewer's comment. */
  threadAuthor?: string | null;
  /** GitHub: a reply in a review comment thread (not the comment that opened it). */
  isReply?: boolean;
  /** GitHub: for a reply, who wrote the comment it answers (the thread's first comment); null when not fetched. */
  repliesTo?: string | null;
  /** GitHub: the verdict of the review the comment belongs to. */
  reviewState?: ReviewVerdict | null;
  /**
   * GitHub, a review's summary: the inline comment (its item uuid) it repeats, when its content is the same as its
   * inline comments (feedbackRules.foldsIntoInline). One item, not two: the summary is skipped (review-folded).
   */
  foldedInto?: string | null;
  /**
   * GitHub: the repo-relative files the pull request changed (capped), what a session must have edited to be matched to
   * the PR by its files (worker postmortem/work.ts). Unset on comments synced before they were kept, and on Linear.
   */
  prFiles?: string[] | null;
};

export type AuthorKind = 'human' | 'bot' | 'agent';
export type ReviewVerdict = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';

export type TicketMeta = { state: string | null; priority: string | null; labels: string[]; assignee: string | null };

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
  /**
   * The instruction files (CLAUDE.md, AGENTS.md, memory notes) the transcript shows the agent had, as the transcript
   * names them: Claude Code attachments and the contents it puts in context, Codex's AGENTS.md instructions. Evidence
   * of what was loaded, on top of what each agent loads by default. Unset: not recorded (read before ingest v5).
   */
  instructionFiles?: string[];
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
   * Who made the last decision: 'you' (the UI) or 'operator:<name>' (an agent holding FG_OPERATOR_TOKEN). Null while
   * pending, or decided before this was recorded.
   */
  decidedBy?: string | null;
  /**
   * Who flagged it: the detector (from the transcript), an agent's report_feedback call, or both when the two were the
   * same miss and were merged into this one item (see dedupe.ts). Always set by the stores.
   */
  origins?: CandidateOrigin[];
  /** What the agent reported through report_feedback, when it did; kept when merged with the detector's turn. */
  agentReport?: AgentReport | null;
  /** The run it was reported in (RunTag), and whether that run was a sandbox; absent when none. */
  run?: string;
  sandbox?: true;
};

export type CandidateOrigin = 'detector' | 'agent';
/** A pending Inbox item from GitHub or Linear, as the skip rules see it (GraphStore.pendingExternalItems). */
export type PendingExternalItem = { id: string; turnUuid: string; projectKey: string; text: string; external: ExternalRef };
/** A pending Inbox item the detector flagged in a session (not a synced comment, not an agent's report), with the agent's calls before it. */
export type PendingSessionItem = { id: string; turnUuid: string; projectKey: string; text: string; precedingToolCalls: ToolCall[] };
export type AgentReport = { text: string; whatWasDone: string; reportedAt: string; sessionId: string | null };

// ── Milestone 2: post-mortems and lessons ──────────────────────────────

export const CAUSES = [
  'context_missing',
  'context_available_ignored',
  'code_not_read',
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

/** What a context item says when the model gave no usable reason. */
export const NO_CONTEXT_WHY = 'the model gave no reason';
/**
 * A context item's "why", or NO_CONTEXT_WHY when the model left it empty or filled it with a field name or a bare value
 * (`wasAvailable`, `true`, `null`): small models echo the item's keys, and the UI printed the literal word as the reason.
 */
export function contextWhy(why: string | null | undefined): string {
  const w = (why ?? '').trim();
  return !w || /^(true|false|null|undefined|none|n\/a)$/i.test(w) || /^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(w) || /^(why|kind|ref|excerpt)$/i.test(w) ? NO_CONTEXT_WHY : w;
}

export type PostMortem = {
  taskTitle: string;
  missed: string;
  cause: Cause;
  causeExplanation: string;
  outcome: Outcome;
  lesson: { title: string; rule: string; appliesWhen: string; scope: LessonScope; paths: string[] };
  contextItems: ContextItem[];
  /** What the lesson check found (stored on the lesson as `checks`); unset: not checked. */
  lessonChecks?: LessonCheck[];
  /**
   * Set when the model's lesson was no lesson even after its retry (the rule field held a scope word or a label, and the
   * title was not a rule either): why. The miss is saved; the lesson is not (savePostmortem writes no lesson).
   */
  lessonDropped?: string;
  /**
   * 'process': the miss is about how the work was handled (branches, pushes, pull requests), not the code, so it is
   * tied to no file the session edited. Unset: about the code.
   */
  subject?: 'process';
  /**
   * Facts about the code the post-mortem noticed beside its lesson (how the code is, not what to do). Proposals only:
   * they are logged with the post-mortem for the owner and never stored as facts or served to agents.
   */
  facts?: ProposedFact[];
  /**
   * Set when the post-mortem's own miss says there was none ("the agent did not miss any defects"): the lesson it wrote
   * is invented, so it is saved rejected, never proposed (worker postmortem/step.ts). The text that said so.
   */
  noMiss?: string;
};

export type ProposedFact = { path: string; statement: string };

/**
 * What the lesson check (worker postmortem/lessonCheck.ts) found on a proposed lesson, shown to the owner before they
 * decide. A check narrows only what is clearly wrong (a path that is not a repository path, a universal rule from one
 * nit) and flags the rest; it never approves or rejects.
 */
export const LESSON_CHECKS = [
  'non-repo-path',
  'bad-path',
  'needs-path',
  'universal-from-nit',
  'meta-lesson',
  'platitude',
  'broken-rule',
  'looks-like-a-fact',
  'not-pushback',
  'wrong-session',
  'self-review',
  'path-missing',
  'duplicate-of',
  'contradicts-evidence',
  'unlinked-ticket',
  'generic',
  'bundled',
  'ambiguous-path',
  'no-miss',
  'filler-applies-when',
  // An approved lesson the redaction rules read a credential in (redact.ts redactStoredLesson): its text is the owner's.
  'may-hold-secret',
] as const;
export type LessonCheckName = (typeof LESSON_CHECKS)[number];
/** `of`: for duplicate-of, the lesson this one repeats. */
export type LessonCheck = { name: LessonCheckName; why: string; of?: string };

/**
 * The version of the lesson checks, stored with them (Lesson.checksVersion). Raise it when a check changes: at start the
 * worker re-checks every proposed or approved lesson checked with an older version, and logs what changed.
 * 1: the checks before the version was stored. 2: path-missing, duplicate-of, the data checks on stored lessons, and
 * the item-20 fixes (APPROVED is not a nit, clause-start imperatives, platitudes in the title). 3: contradicts-evidence,
 * a miss blaming an instruction file the agent "did not load" when the session had it, and unlinked-ticket, a
 * post-mortem that cited Linear tickets of another project (the hunt searched the whole workspace). 4: generic (a rule
 * naming nothing concrete, only process verbs), bundled (two unrelated instructions in one rule), and paths normalized:
 * a proposed lesson's bare file names resolve to their one repository match, and instruction files, PR refs, bare
 * identifiers, missing files and globs matching nothing are dropped (bad-path says which); an approved lesson's paths
 * are only flagged. 5: broken-rule judged on the rule as it is now (one the owner fixed is no longer flagged),
 * looks-like-a-fact knows more imperative verbs ("Cap ...", "Refresh ...", "Coalesce ..."), wrong-session is no longer read
 * from the words of a post-mortem that had no session or one matched by branch or files, and filler-applies-when (an
 * appliesWhen of just "task" or "project", flagged only).
 */
export const LESSON_CHECKS_VERSION = 5;

/**
 * Where a lesson's feedback came from: a GitHub or Linear comment, pushback in an agent session, an imported memory
 * file, or written by hand. Set by the stores.
 */
export const LESSON_FROM = ['github', 'linear', 'session', 'memory', 'manual', 'demo'] as const;
export type LessonFrom = (typeof LESSON_FROM)[number];

export type LessonStatus = 'proposed' | 'approved' | 'rejected' | 'superseded';
export type LessonSource = 'postmortem' | 'memory' | 'manual' | 'demo';

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
  /**
   * Who made its last decision (approved, rejected, back to proposed): 'you' (the UI), or `operator:<name>` for an
   * agent holding FG_OPERATOR_TOKEN. Null for lessons decided before this was recorded, or never decided.
   */
  decidedBy?: string | null;
  /**
   * What the lesson check found when the lesson was proposed (or re-checked), for the owner deciding on it. Null: never
   * checked (proposed before the checks were stored; the worker re-checks those once). [] : checked, nothing found.
   */
  checks?: LessonCheck[] | null;
  /** LESSON_CHECKS_VERSION its checks were made with; null: before the version was stored (or never checked). */
  checksVersion?: number | null;
  /** Where its feedback came from (LESSON_FROM). Set by the stores. */
  from?: LessonFrom;
  /** Why its last decision was made, when that says more than the status ("converted to a fact"). Null: none given. */
  decisionNote?: string | null;
  /** The run its feedback was reported in (RunTag), copied by the post-mortem; absent when none. */
  run?: string;
  /** From a sandbox run: served only to that run's agents. Absent unless true. */
  sandbox?: true;
  /**
   * The lesson as the post-mortem wrote it, kept the first time the owner (or an operator) changed its words, paths or
   * scope while it was proposed. Null or absent: never edited while proposed (approved as written, if approved).
   */
  proposedAs?: LessonDraft | null;
};

/** What the lesson writer controls: the parts the owner edits before approving. */
export type LessonDraft = Pick<Lesson, 'title' | 'rule' | 'appliesWhen' | 'scope' | 'paths'>;

/**
 * How the owner decided a lesson the post-mortem wrote: approved as written, approved after editing it, or rejected.
 * The few-shot examples of the post-mortem prompt and the lesson quality numbers are made of these.
 */
export type LessonOutcome = 'as_written' | 'edited' | 'rejected';

/** Of the post-mortem lessons decided in the last `days` days: how many of each outcome (decided is their sum). */
/** byOperator: of `decided`, those an agent with the operator token made (counted as the owner's, said apart). */
export type LessonQuality = { days: number; asWritten: number; edited: number; rejected: number; decided: number; byOperator: number };
/**
 * GET /api/lessons/quality: LessonQuality over the last 30 and 90 days, in all (the shown projects, or ?project=) and by
 * project (where each lesson was learned). capped: more decisions than were counted (the oldest were left out).
 */
export type LessonQualityReport = { windows: LessonQuality[]; projects: Record<string, LessonQuality[]>; capped?: true };

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
  work?: {
    sessionId: string; source: SessionSource; cwd: string; turns: HumanTurn[];
    /** How it was matched: it ran on the PR's branch, or it edited files the PR changed. Unset: not said. */
    matchedBy?: 'branch' | 'files';
  } | null;
  feedback: HumanTurn;
  /** All human turns in the session, in order (the flagged one included). */
  turns: HumanTurn[];
  note: string | null;
  /**
   * Who confirmed it, and so wrote `note`: 'you' (the UI) or 'operator:<name>'. Anything but 'you' (null: not recorded)
   * puts the note in the prompt as untrusted text, never as the developer's.
   */
  noteBy?: string | null;
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

/**
 * `why`: the extractor's reason a coding agent needs this fact. `relevance` (0..1): how often an agent doing everyday
 * coding in the project needs it (setup of an external tool is low); null or absent: not scored yet.
 */
export type CodeFact = {
  kind: FactKind; statement: string; path: string; lines: string | null; confidence: number; why: string; relevance?: number | null;
  /** Where it came from (unset on facts saved before this was recorded: see factOrigin). */
  origin?: FactOrigin;
  /** How well its citation was checked when it was saved (unset on older facts: unknown). */
  evidence?: FactEvidence;
  /**
   * The citation rule that last checked it (the worker's FACT_CHECK_VERSION); unset or null: none recorded, so it is
   * checked again (FactsStore.factsToRecheck).
   */
  checkVersion?: string | null;
};

/**
 * model: a model read the code. manifest: read from package.json, go.mod, a Makefile... without a model. document: from
 * an upload. you: the owner (or an agent with the operator token) wrote it, e.g. a lesson converted to a fact; no scan
 * closes or replaces it.
 */
export const FACT_ORIGINS = ['model', 'manifest', 'document', 'you'] as const;
export type FactOrigin = (typeof FACT_ORIGINS)[number];
/**
 * line: the cited lines exist and hold what the statement names. file: the file exists, the lines were missing, wrong
 * or past its end (and were dropped). none: project-wide, nothing to check.
 */
export const FACT_EVIDENCE = ['line', 'file', 'none'] as const;
export type FactEvidence = (typeof FACT_EVIDENCE)[number];

/**
 * Who set a fact's relevance: the extractor or the background scorer ('model'), you ('you'), or an agent holding
 * FG_OPERATOR_TOKEN ('operator:<name>'). Only 'model' is ever overwritten by a model.
 */
export type RelevanceBy = 'model' | 'you' | `operator${string}`;

/** Relevance used for ranking when a fact has none yet. */
export const UNSCORED_RELEVANCE = 0.5;

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
  /** An agentic scan's shards (packages or services, one agent run each): null for a per-file scan or before the end. */
  shards?: ScanShards | null;
  /**
   * When it last gave up its slot after a shard so another project's scan could run (FactsStore.requeueScanJob): it
   * waits in the queue from then, not from requestedAt. Null: it never has.
   */
  servedAt?: string | null;
};

/**
 * A queued or running scan in the order the queue serves it (FactsStore.scanQueue). waitingSince is what the order
 * goes by: the oldest of when it was requested (or last gave up its slot) and when an agent first asked for one of the
 * project's files that is not read yet (requestFilesScan).
 */
export type ScanQueueEntry = ScanJob & { waitingSince: string };

/**
 * How many shards an agentic scan had, how many it rescanned (the others had not changed) and how many of those failed.
 * done: while it runs, the shards it has got through so far (skipped ones included); unset once it is finished.
 * unreached: the directories or files the agents said they did not read (at most 200; absent: none, or not asked).
 * processed, failedKeys: while it runs or waits between shards, the keys of the shards it has got through (skipped and
 * failed ones included) and of those that failed, so a scan that gave up its slot goes on from there. Unset once finished.
 */
export type ScanShards = { total: number; rescanned: number; failed: number; done?: number; unreached?: string[]; processed?: string[]; failedKeys?: string[] };

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
  /** The current facts split by where they came from (factOrigin): the model's are the ones to headline. */
  factsByOrigin?: Record<FactOrigin, number>;
  lastScan: ScanJob | null;
  /** You pinned it: it comes first in every project list (UI order only). */
  pinned: boolean;
  /** Confirmed links to other shown projects. Counted by the API from the links store; absent when it has none. */
  links?: number;
  /**
   * Scanned files an older scanner read (FactsStore.olderScannerFiles): the next scan you start reads them again.
   * Counted by the API; absent when there are none.
   */
  olderScanner?: number;
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
  'facts_scored',
  'fact_relevance_set',
  'project_pinned',
  'links_suggested',
  'link_decided',
  'doc_read',
  'comments_skipped',
  'lessons_checked',
  'lesson_to_fact',
  'misses_reclassified',
  'items_reopened',
  'session_resumed',
  'secrets_redacted',
  'run_cleaned',
  'demo_seeded',
  'demo_removed',
  'sessions_rematched',
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
  /** The run the request was labelled with (x-fg-run, see RunTag); unset: no run. */
  run?: string | null;
  /** The run was a sandbox one. */
  sandbox?: boolean;
};
/**
 * detailsOmitted: a list asked for small rows (maxDetailBytes) and these details were bigger, so `details` is `{}`;
 * the entry on its own (ActivityStore.get, GET /api/activity/:id) has them. `run` and `sandbox` are there only when set.
 */
export type Activity = Required<Omit<ActivityInput, 'run' | 'sandbox'>> & Pick<ActivityInput, 'run' | 'sandbox'> & { id: string; ts: string; detailsOmitted?: boolean };

// ── Runs ───────────────────────────────────────────────────────────────

/** A run id as a tester labels its requests (x-fg-run): 1 to 64 letters, digits, dots, dashes or underscores. */
export const RUN_ID = /^[\w.-]{1,64}$/;

/**
 * The run a request was labelled with: what it writes records the run id, so `fg cleanup --run <id>` can remove exactly
 * that. sandbox: what it writes is never served to agents of other runs (nor exported or synced to the cloud).
 */
export type RunTag = { id: string; sandbox: boolean };

/**
 * A run's write to a record it does not own (the owner's, or another run's): refused, so a tester never replaces,
 * decides on or adopts the owner's records (and `fg cleanup --run` never removes them). The API answers 409.
 */
export class NotTheRunsError extends Error {
  constructor(what: string, run: string) {
    super(`${what} is not run ${run}'s: a labelled run changes only what it wrote (a sandbox run makes its own copy; drop x-fg-run, or open the run from the owner's browser, to change the owner's)`);
    this.name = 'NotTheRunsError';
  }
}

/**
 * Who opened a run (RunsStore.claim), from its first labelled write: the operator token (FG_OPERATOR_TOKEN), the owner's
 * API token (API_TOKEN as the Bearer, no Origin), the browser (it sent Origin), or an agent with neither token (/mcp or
 * the API with no API_TOKEN configured). Writes under the run by anyone else are refused, and the operator token may
 * clean up only a run it opened.
 */
export const RUN_PRINCIPALS = ['operator', 'owner_token', 'browser', 'agent'] as const;
export type RunPrincipal = (typeof RUN_PRINCIPALS)[number];
/**
 * A run's owner as stored. firstSeen: ISO time of its first labelled write. actor: for an operator-token run, the
 * operator's name as Activity records it (`operator:<name>`, or `operator` with none); null for the other principals,
 * and for an operator run opened before names were recorded (any operator name may use that one).
 */
export type RunOwner = { run: string; principal: RunPrincipal; actor: string | null; firstSeen: string };

/** What a run's id is stored on (RunsStore.items). feedback: an agent's report, with its post-mortem's miss and lesson. */
export const RUN_ITEM_KINDS = ['feedback', 'lesson', 'miss', 'predone_check', 'fact', 'doc', 'link', 'chat'] as const;
export type RunItemKind = (typeof RUN_ITEM_KINDS)[number];
/**
 * One record a run wrote. `group`: the report a lesson or miss came from (its feedback id); null for the rest.
 * merged: a report the detector then found in a real session, so it is that session's Inbox item now (never removed).
 */
export type RunItem = { kind: RunItemKind; id: string; projectKey: string | null; sandbox: boolean; group: string | null; merged: boolean };

/**
 * One turn of a session as the detector saw it (SessionsStore.turnEvidence), without its words. label null: not
 * classified (the opening turn, one still waiting, or one given up on after classifyAttempts). signals: the
 * classifier's, plus the rules applied (`skip:<rule>`, `manual`). candidateId: the Inbox item it filed, if any.
 */
export type TurnEvidence = {
  uuid: string; index: number; ts: string; label: TurnLabel | null; confidence: number | null; summary: string | null;
  signals: string[]; classifyAttempts: number; candidateId: string | null;
};

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
  /** How each job's model last fared (classify, postmortem, scan, summary, docs, chat); missing until it is first asked. */
  health?: Partial<Record<ModelJob, ProviderHealth>>;
  /** Jobs turned off on purpose (SUMMARY_LLM=off), so a missing model is not reported as broken. */
  off?: ModelJob[];
  /** What the worker is doing right now; absent from workers older than 0.4.5. */
  stage?: WorkerStage | null;
  /** Work waiting, as last counted by the worker. */
  backlog?: WorkerBacklog | null;
};

/**
 * The step of the worker's loop running now. `waiting`: between cycles, nothing to do. done/total count the step's items
 * where it has them (null where not: ingest reads only changed files, so it counts reads without a total); `current` is
 * the item in hand (a transcript's file name, a turn id, a project key, a feedback id).
 */
export const WORKER_STAGES = ['sync', 'ingest', 'classify', 'postmortem', 'scan', 'docs', 'waiting'] as const;
export type WorkerStageName = (typeof WORKER_STAGES)[number];
export type WorkerStage = { name: WorkerStageName; startedAt: string; done: number | null; total: number | null; current: string | null };
/**
 * Turns waiting for the classifier (the first `classifyBatch * 20` of them are fetched: `capped` means at least).
 * oldestAt: the oldest fetched turn's time (newest are fetched first, so when capped the oldest waits longer still).
 */
export type WorkerBacklog = { classify: number; classifyCapped: boolean; at: string; oldestAt?: string | null };

/**
 * How a provider last fared: `reason` says why it could not be asked, null while it answers. `since`: when it was first
 * found unavailable in this run of failures (unset while it answers).
 */
export type ProviderHealth = { provider: string; ok: boolean; reason: string | null; at: string; since?: string };

export const MODEL_JOBS = ['classify', 'postmortem', 'scan', 'summary', 'docs', 'chat'] as const;
export type ModelJob = (typeof MODEL_JOBS)[number];
/** A job's model as /api/status reports it: ok until it was last found unavailable (or, for an Ollama model, while
 * Ollama does not answer), with the reason. */
export type ModelHealth = {
  provider: string | null;
  ok: boolean;
  reason: string | null;
  off?: true;
  /** While unavailable: since when (the first failure in a row), and when that was last seen. */
  since?: string;
  checkedAt?: string;
};

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
  /** The model that judges check_before_done (provider:model, e.g. ollama:gemma4); null when unknown or none. */
  judge?: string | null;
  /**
   * How many project folders are selected for reading, and how many project roots are mounted (unset from older APIs);
   * `note` says plainly when nothing can be read. Null when unknown.
   */
  selection: { initialized: boolean; tracked: number; roots?: number; note: string | null } | null;
  /** Feedback Graph Cloud sync: null when off. The token is always shown as [REDACTED]. */
  cloud?: {
    host: string;
    token: '[REDACTED]';
    intervalMinutes: number | null;
    /** The last Sync now this api ran (Settings or fg cloud sync-now); null: none since it started. */
    lastManual?: { at: string; ok: boolean; error: string | null; sent: Record<string, number>; unchanged: number; failed: number } | null;
    /** A Sync now in progress: projects done of total, the one being sent, and since when. */
    syncing?: { done: number; total: number; current: string | null; startedAt: string } | null;
  } | null;
  /** Each job's model from the worker's heartbeat; null when the worker has not reported. */
  models?: Record<ModelJob, ModelHealth> | null;
  /** Turns the classifier gave up on (they can be re-queued); null when unknown. */
  givenUpTurns?: number | null;
  /** Ollama, which every embedding (search, get_task_context, check_before_done) needs: null when not checked. */
  ollama?: OllamaHealth | null;
  /** GitHub, Linear, Claude, Codex, Ollama and cloud sync; null when unknown (an older api leaves it out). */
  connections?: Record<ConnectionName, Connection> | null;
  /** The worker's current step and since when; null when the worker is offline or has not said. */
  stage?: { name: WorkerStageName; startedAt: string; current: string | null } | null;
  /** That step's items done of total (total null when it has none); null when the step does not count items. */
  progress?: { done: number; total: number | null } | null;
};

/**
 * GET /api/pipeline: where everything stands, for the first-run panel. Each count is null when this server cannot tell
 * (an older worker, or a store without that count).
 */
export type PipelineStatus = {
  stage: NonNullable<SystemStatus['stage']> | null;
  progress: NonNullable<SystemStatus['progress']> | null;
  /** Sessions read so far, in the shown projects. */
  sessions: number | null;
  /** Turns waiting for the classifier; `capped`: at least that many. */
  classify: { backlog: number; capped: boolean } | null;
  inbox: { pending: number; confirmed: number } | null;
  postmortems: { queued: number } | null;
  /**
   * global: how many of them have no project of their own (they serve every project). quality: LessonQualityReport's
   * windows, when the store can tell. Older APIs leave both out.
   */
  lessons: { proposed: number; approved: number; global?: number; quality?: LessonQuality[] } | null;
  /**
   * olderScanner: files an older scanner read, in all and by project (only those with some), which the next scan you
   * start reads again; absent when there are none or the store cannot count them.
   */
  scans: { done: number; queued: number; running: number; failed: number; never: number; olderScanner?: { files: number; projects: Record<string, number> } } | null;
  /** Back-pressure: each queue's waiting work and what runs now. Older APIs leave it out. */
  queues?: WorkQueues;
};

/** One piece of work running now: what (a project, a feedback or turn id), since when; a scan's shards got through so far. */
export type QueueRun = { what: string; since: string; shards?: { done: number; total: number } | null };
/**
 * A queue: how many wait (capped: at least that many), since when the oldest has waited (null: none waits, or it is
 * not known), and what runs now.
 */
export type WorkQueue = { waiting: number; capped?: boolean; oldestAt: string | null; running: QueueRun[] };
/** A scan queued or running: since when it has waited (or, running, run), and its shards got through of all. */
export type ScanQueueItem = { project: string; status: 'queued' | 'running'; since: string; shards: { done: number; total: number } | null };
/** The queues of /api/pipeline; each null when this server cannot read it. Scans count the shown projects only. */
export type WorkQueues = {
  scans: (WorkQueue & { projects: ScanQueueItem[] }) | null;
  classify: WorkQueue | null;
  postmortems: WorkQueue | null;
  chats: WorkQueue | null;
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
