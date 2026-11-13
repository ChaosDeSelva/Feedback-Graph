import type { IntakeFormat } from './intake/parse.ts';
import type { CloudSyncStatus } from './cloud.ts';
export type ToolCall = { name: string; ts: string; filePath?: string; command?: string };

export type HumanTurn = {
  run?: string;
  sandbox?: true;
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

/**
 * The task a PR's or issue's comments criticize: the thread itself (`PR owner/repo#12: <title>`, `ENG-42: <title>`), never
 * the model's name for whatever work session it was matched to, which one session matched to many PRs gives them all.
 */
export const threadTaskTitle = (ext: Pick<ExternalRef, 'source' | 'thread' | 'title'>): string =>
  `${ext.source === 'github' ? 'PR ' : ''}${ext.thread}: ${ext.title}`.slice(0, 200);

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
  /** Current source pull request state; closed means it was closed without merging. */
  threadState?: 'open' | 'closed' | 'merged';
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
  /** triggers: what in a later change shows the lesson applies, validated against this miss (lessonTriggers.ts). */
  lesson: { title: string; rule: string; appliesWhen: string; scope: LessonScope; paths: string[]; triggers?: LessonTriggers | null };
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
  'source-pr-unmerged',
  'path-missing',
  'duplicate-of',
  'contradicts-evidence',
  'unlinked-ticket',
  'generic',
  'bundled',
  'ambiguous-path',
  'no-miss',
  'filler-applies-when',
  // An appliesWhen that names only the one instance the miss was about ("this feature", one variable): flagged, with a
  // broader one suggested by the worker (suggestion), never applied for the owner.
  'instance-applies-when',
  // An appliesWhen copied from an example the post-mortem was shown (another lesson's) that this miss is not about.
  'example-applies-when',
  // The post-mortem's miss is not about the flagged turn (it described the agent's reply beside it) even after a retry:
  // the owner reads the turn before deciding.
  'off-turn',
  // An approved lesson the redaction rules read a credential in (redact.ts redactStoredLesson): its text is the owner's.
  'may-hold-secret',
  // A lesson that tells agents to fetch a URL or run a command that downloads, installs, deletes or evaluates: what an
  // injected comment asks for. The learning loop never targets it, and never writes such text into a lesson.
  'risky-command',
  // A trigger that is a glob for a kind of file anywhere (**/*.sql), kept because the rule says it of every such file:
  // it reaches every such change, so the owner looks at it.
  'broad-trigger',
  // An approved lesson whose paths, trigger paths or named symbols changed or vanished in the code map since: it may
  // be about code that is no longer there. Flagged only: the owner decides (the worker never revokes it).
  'code-changed',
] as const;
export type LessonCheckName = (typeof LESSON_CHECKS)[number];
/**
 * `of`: for duplicate-of, the lesson this one repeats. `suggestion`: for instance-applies-when, a broader "applies when"
 * the worker proposed; the owner may take it, nothing applies it.
 */
export type LessonCheck = { name: LessonCheckName; why: string; of?: string; suggestion?: string };

/**
 * What in a later change shows a lesson applies, beside its embedding: `paths`, repo-relative globs a named or changed
 * file matches; `patterns`, regular expressions (case-insensitive) an added diff line or the task's words match;
 * `symbols`, exact code names (a function, an env var, a flag, a key) an added line or the task names as a whole token.
 * Derived by the post-mortem (or the worker's backfill) and kept only when they match the miss's own files or text
 * (lessonTriggers.ts validateTriggers); the owner edits them like the rest of the lesson.
 */
export type LessonTriggers = { paths: string[]; patterns: string[]; symbols: string[] };

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
 * appliesWhen of just "task" or "project", flagged only). 7: instance-applies-when (an appliesWhen that names only this
 * feature or one variable), with a broader one suggested by the worker. 8: risky-command (a lesson telling agents to fetch
 * a URL or download, install, delete or evaluate something). 9: instance-applies-when no longer flags the one name the
 * rule names (`formatAmount must return two decimals`, "Always pass an idempotency key to chargeCard"; "changing" it),
 * and example-applies-when (an appliesWhen copied from an example the post-mortem was shown, none of whose words the
 * miss shares). 10: risky-command reads through lookalike, zero-width, %-escaped and defanged text, and knows package
 * runners (npx, dlx, uvx), flags before an install's package, split rm flags, a bare domain to fetch and run, inline
 * code (python -c, node -e, powershell -enc), commands spelled letter by letter, and telling agents to expose secrets
 * (keys, .env, the environment, tokens) to the PR, a chat, a log or a URL; and it re-checks lessons checked at 9 by
 * the narrower example- and instance-applies-when rules above, which came after 9 was stamped. 11: looks-like-a-fact
 * needs a declarative statement and no imperative in any sentence ("Retries are capped at 3. Don't raise the cap." is a
 * rule; typographic apostrophes read as typed ones). 12: broad-trigger and code-changed (raised by the trigger derivation
 * and the code map's re-check) and off-turn (raised by the post-mortem) are kept by the re-check, which runs once more.
 */
export const LESSON_CHECKS_VERSION = 12;

/**
 * Where a lesson's feedback came from: a GitHub or Linear comment, pushback in an agent session, a miss an agent reported
 * (report_feedback), an imported memory file, or written by hand. Set by the stores.
 */
export const LESSON_FROM = ['github', 'linear', 'session', 'agent', 'memory', 'manual', 'demo'] as const;
export type LessonFrom = (typeof LESSON_FROM)[number];

export type LessonStatus = 'proposed' | 'approved' | 'rejected' | 'revoked' | 'superseded';
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
  /**
   * What in a later change shows it applies (LessonTriggers). Null or absent: never derived (the worker backfills it);
   * empty lists: derived, and nothing in the miss's files or text was specific enough.
   */
  triggers?: LessonTriggers | null;
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
  /**
   * The learning loop's serving weight (rank_weight, SERVING_WEIGHT_MIN..MAX): it reorders, and so moves across the cut,
   * only lessons already tied to the task; it never admits one. Absent: 1, as written by no decision.
   */
  servingWeight?: number;
  /** The lesson the learning loop split this one off (reword_lesson on a bundled rule); absent for every other lesson. */
  splitFrom?: string;
};

/** What the lesson writer controls: the parts the owner edits before approving. */
export type LessonDraft = Pick<Lesson, 'title' | 'rule' | 'appliesWhen' | 'scope' | 'paths'>;

/**
 * How the owner decided a lesson the post-mortem wrote: approved as written, approved after editing it, or rejected.
 * The few-shot examples of the post-mortem prompt and the lesson quality numbers are made of these.
 */
export type LessonOutcome = 'as_written' | 'edited' | 'rejected';

/** Of the post-mortem lessons decided in the last `days` days: how many of each outcome (decided is their sum). */
/** decided: the owner's own decisions. byOperator: those an agent with the operator token made, counted apart, not in `decided`. */
export type LessonQuality = { days: number; asWritten: number; edited: number; rejected: number; decided: number; byOperator: number };
/**
 * GET /api/lessons/quality: LessonQuality over the last 30 and 90 days, in all (the shown projects, or ?project=) and by
 * project (where each lesson was learned). capped: more decisions than were counted (the oldest were left out).
 */
export type LessonQualityReport = { windows: LessonQuality[]; projects: Record<string, LessonQuality[]>; capped?: true };

/** Everything the post-mortem needs about one confirmed piece of feedback. */
export type PostMortemInput = {
  run?: string;
  sandbox?: true;
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

/** What code scans and documents yield, and all a cloud before the claim kinds accepts (CLAIM_FACT_KINDS_FEATURE). */
export const CODE_FACT_KINDS = [
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
export type CodeFactKind = (typeof CODE_FACT_KINDS)[number];

/** What people decided, planned or committed to (0.9.0: an accepted claim of that type, origin 'claim'). */
export const CLAIM_FACT_KINDS = ['decision', 'plan', 'commitment'] as const;

export const FACT_KINDS = [...CODE_FACT_KINDS, ...CLAIM_FACT_KINDS] as const;
export type FactKind = (typeof FACT_KINDS)[number];

const CODE_KIND_SET: ReadonlySet<string> = new Set(CODE_FACT_KINDS);

/** The code kind nearest a kind: itself when it is one, `architecture` for the claim kinds; null for anything else. */
export function codeFactKind(kind: string): CodeFactKind | null {
  if (CODE_KIND_SET.has(kind)) return kind as CodeFactKind;
  return (CLAIM_FACT_KINDS as readonly string[]).includes(kind) ? 'architecture' : null;
}

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
 * an upload. you: the owner (or an agent with the operator token) wrote it, e.g. a lesson converted to a fact. loop: the
 * learning loop recorded it (record_fact: a lesson that states how the code is, or what you said more than once). claim:
 * the owner accepted a claim drawn from what someone said (knowledge intake). No scan closes or replaces a fact of
 * yours, the loop's or a claim's (FACT_ORIGINS_KEPT).
 */
export const FACT_ORIGINS = ['model', 'manifest', 'document', 'you', 'loop', 'claim'] as const;
export type FactOrigin = (typeof FACT_ORIGINS)[number];
/** The origins of facts filed under their project, not read from code: a scan never closes, replaces or re-checks them. */
export const FACT_ORIGINS_KEPT = ['you', 'loop', 'claim'] as const satisfies readonly FactOrigin[];
export type OwnFactOrigin = (typeof FACT_ORIGINS_KEPT)[number];
/**
 * line: the cited lines exist and hold what the statement names. file: the file exists, the lines were missing, wrong
 * or past its end (and were dropped). none: project-wide, nothing to check.
 */
export const FACT_EVIDENCE = ['line', 'file', 'none'] as const;
export type FactEvidence = (typeof FACT_EVIDENCE)[number];

/**
 * Who set a fact's relevance: the extractor or the background scorer ('model'), you ('you'), an agent holding
 * FG_OPERATOR_TOKEN ('operator:<name>'), or the learning loop ('loop:<policy version>', a fact it recorded). Only 'model'
 * is ever overwritten by a model.
 */
export type RelevanceBy = 'model' | 'you' | `operator${string}` | `loop:${string}`;

/** Relevance used for ranking when a fact has none yet. */
export const UNSCORED_RELEVANCE = 0.5;

/**
 * A project's own similarity floors, set by an applied tune_threshold decision (within TUNE_MARGIN of the defaults,
 * SIMILARITY_FLOOR and FACT_RANK_FLOOR); null: the default.
 */
export type ProjectThresholds = { similarityFloor: number | null; factRankFloor: number | null };

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
  /**
   * When its model first failed the readiness probe in this wait (scan/runner.ts parkScanProvider); null once the
   * model answers. A job parked longer than SCAN_PARK_LIMIT_MS is failed with the reason.
   */
  parkedAt?: string | null;
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
  /** Lessons learned for this project (projectKey), every status, sandbox runs' left out. */
  lessons: number;
  /** `lessons` by status: they add up to it. */
  lessonsByStatus?: Partial<Record<LessonStatus, number>>;
  /** Global lessons (no project), counted apart: the Lessons page lists them under every project. */
  globalLessons?: number;
  facts: number;
  /** The current facts split by where they came from (factOrigin): the model's are the ones to headline. */
  factsByOrigin?: Record<FactOrigin, number>;
  lastScan: ScanJob | null;
  /** You pinned it: it comes first in every project list (UI order only). */
  pinned: boolean;
  /** Confirmed links to other shown projects. Counted by the API from the links store; absent when it has none. */
  links?: number;
  /**
   * Scanned files an older scanner read (FactsStore.olderScannerFiles `older`), and apart those no scanner version was
   * recorded for (`never`): the next scan you start reads them again. Counted by the API; each absent when none.
   */
  olderScanner?: number;
  neverScanned?: number;
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
  // The learning loop (0.8.0): a decision recorded, applied, rolled back or annotated, and its settings and pause.
  'decision_made',
  'decision_applied',
  'decision_rolled_back',
  'decision_noted',
  'loop_settings_changed',
  'loop_paused',
  // Knowledge intake (0.9.0): a source added or read, a claim or question decided, a conflict found or resolved, a
  // person renamed, merged or forgotten.
  'source_added',
  'source_read',
  'claim_decided',
  'question_changed',
  'conflict_found',
  'conflict_resolved',
  'person_changed',
  // Settings' Cloud sync card changed what is synced (claim facts, who said them).
  'cloud_settings_changed',
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

// ── Learning loop ──────────────────────────────────────────────────────

/**
 * What the learning loop can decide (docs: the 0.8.0 loop design). Housekeeping (merge, link, rank, retire) applies on
 * its own; changes to what agents are told apply on their own only once the owner's verdicts earned it; the rest waits.
 */
export const DECISION_TYPES = [
  'link_misses',
  'merge_duplicates',
  'rank_weight',
  'retire_lesson',
  'reject_lesson',
  'approve_lesson',
  'reword_lesson',
  'narrow_scope',
  'record_fact',
  'triage_inbox',
  'tune_threshold',
  // Knowledge intake's housekeeping and proposals (0.9.1): claims joined and linked, accepted (tier A, never an opinion
  // or an agent's), a conflict's resolution suggested, a question assigned or closed. Settling a conflict stays the owner's.
  'merge_claims',
  'link_claims',
  'accept_claim',
  'propose_resolution',
  'assign_question',
  'close_question',
  // A lesson's paths and trigger paths moved to the name git renamed the file to (0.9.1): housekeeping.
  'update_paths',
  // The owner settling a conflict (0.9.0 §6): never the loop's (author owner), recorded so it rolls back like any other.
  'resolve_conflict',
  // The owner removing a source with everything drawn from it: its accepted claims rejected, their facts closed.
  'remove_source',
] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];
/** The types only the owner makes (author owner): the loop never proposes, schedules, calibrates or configures them. */
export const OWNER_DECISION_TYPES = ['resolve_conflict', 'remove_source'] as const satisfies readonly DecisionType[];
export type LoopDecisionType = Exclude<DecisionType, (typeof OWNER_DECISION_TYPES)[number]>;
/** The learning loop's own types: what LOOP_TYPES, its settings, its engine and its metrics cover. */
export const LOOP_DECISION_TYPES = DECISION_TYPES.filter((t): t is LoopDecisionType => !(OWNER_DECISION_TYPES as readonly string[]).includes(t));
/** owner: a change the owner made through a decision (resolve_conflict), never calibrated or counted as the loop's. */
export const DECISION_AUTHORS = ['loop', 'owner'] as const;
export type DecisionAuthor = (typeof DECISION_AUTHORS)[number];

/**
 * observed: recorded only (observe mode). proposed: waits for the owner. applying: its target write is under way (a
 * start-up pass settles one a crash left so). applied, rejected, rolled_back. overridden: the owner changed its target
 * since. expired: no longer worth deciding.
 */
export const DECISION_STATUSES = ['observed', 'proposed', 'applying', 'applied', 'rejected', 'rolled_back', 'overridden', 'expired'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];
/** H: housekeeping, applies on its own. A: agent-facing, applies on its own once earned. P: always a proposal. */
export const DECISION_TIERS = ['H', 'A', 'P'] as const;
export type DecisionTier = (typeof DECISION_TIERS)[number];
export const DECISION_MODES = ['observe', 'propose', 'auto'] as const;
export type DecisionMode = (typeof DECISION_MODES)[number];
export const DECISION_TARGET_KINDS = ['lesson', 'fact', 'miss', 'candidate', 'project', 'claim', 'conflict', 'question'] as const;
export type DecisionTargetKind = (typeof DECISION_TARGET_KINDS)[number];
/**
 * primary: the record decided on. keeper / merged: a merge's survivor and the duplicate, or a conflict's winner and
 * loser. created: what the decision made.
 */
export const DECISION_TARGET_ROLES = ['primary', 'keeper', 'merged', 'created'] as const;
export type DecisionTargetRole = (typeof DECISION_TARGET_ROLES)[number];
export type DecisionTarget = { kind: DecisionTargetKind; id: string; role: DecisionTargetRole };

/**
 * A target's state before or after a decision: its fields as stored (redacted), and the fingerprint of the canonical
 * ones (lessonFingerprint, factFingerprint) that a domain write compares (`expect`) to refuse a target changed since.
 */
export type TargetSnapshot = { kind: DecisionTargetKind; id: string; fields: Record<string, unknown>; fingerprint: string };

/** What a decision rests on, by pointer: an Activity entry, a miss, a lesson, a lesson check... with its weight. */
export const EVIDENCE_KINDS = ['activity', 'miss', 'lesson', 'fact', 'candidate', 'check', 'session', 'claim', 'conflict', 'question'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type EvidenceRef = { kind: EvidenceKind; id: string; role: string; weight: number; observedAt: string };

/** p: the calibrated chance the owner keeps it; lower: the bound the auto-apply rule reads; n: owner labels; band: 0-4. */
export type DecisionConfidence = { p: number; lower: number; n: number; band: number };
/** cascade: the later decisions rolled back with it, newest first. */
export type DecisionRollback = { at: string; by: string; reason: DecisionNoteReason | null; note: string | null; cascade: string[] };

/** What DecisionsStore.propose stores; the store adds the id (decisionId), createdAt and the status history. */
export type DecisionInput = {
  type: DecisionType;
  projectKey: string | null;
  targets: DecisionTarget[];
  before: TargetSnapshot[];
  after: TargetSnapshot[];
  evidence: EvidenceRef[];
  features: Record<string, number>;
  score: number;
  confidence: DecisionConfidence;
  tier: DecisionTier;
  mode: DecisionMode;
  rationale: string;
  /** The model's provider spec, or 'deterministic'; null: none recorded. */
  model: string | null;
  policyVersion: number;
  /** How it starts: observed (observe mode) or proposed. */
  status: 'observed' | 'proposed';
  /** Earlier loop decisions whose `after` this one's `before` is: rolled back first when this one is. */
  dependsOn?: string[];
  /** Who made it (default loop): an owner's decision is never calibrated, budgeted or counted as a loop proposal. */
  author?: DecisionAuthor;
};

export type Decision = Omit<DecisionInput, 'status' | 'dependsOn'> & {
  /** `dec:<sha256>` of the type, targets, evidence and policy version (decisionId): proposing it again finds it. */
  id: string;
  status: DecisionStatus;
  dependsOn: string[];
  createdAt: string;
  appliedAt: string | null;
  /** The last status change made by someone (approve, reject, roll back...), and who: `loop:<v>`, you, `operator:<name>`. */
  decidedAt: string | null;
  decidedBy: string | null;
  supersededBy: string | null;
  rollback: DecisionRollback | null;
  /** The owner kept an applied decision ("Keep"). */
  ratifiedAt: string | null;
  ratifiedBy: string | null;
  /** Until then a cloud export sends its target as it was before (the loop's change is not shared yet). */
  syncHoldUntil: string | null;
};

export const DECISION_NOTE_REASONS = ['wrong_evidence', 'too_broad', 'wording', 'not_now', 'other'] as const;
export type DecisionNoteReason = (typeof DECISION_NOTE_REASONS)[number];
/**
 * Two records the owner said are not the same (a merge rolled back, or marked distinct): a, b in id order. by: who;
 * reason: why, in words; decisionId: the merge rolled back, if one was.
 */
export type DistinctPair = { a: string; b: string; by: string; at: string; reason: string; decisionId: string | null };
/** A pair as stored: its two ids in order, so either way round is one record. */
export const distinctKey = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);
export type DecisionNote = {
  id: string; decisionId: string; ts: string; by: string; text: string;
  verdict: 'agree' | 'disagree' | null; reason: DecisionNoteReason | null;
};

/** The outcome counts the loop folds from Activity per lesson (LessonSignals). */
export const LESSON_SIGNAL_COUNTS = [
  'served', 'sessionsServed', 'addressed', 'notAddressed', 'notApplicable', 'cannotTell', 'gapsFixed', 'repeatServed',
  'repeatUnserved', 'ownerPushbackAfter', 'agentNotApplicable', 'agentWrong', 'ownerEdits', 'ownerRejects',
] as const;
export type LessonSignalCount = (typeof LESSON_SIGNAL_COUNTS)[number];
export type LessonSignals = { lessonId: string; counts: Record<LessonSignalCount, number>; lastServed: string | null; lastOwnerTouch: string | null; updatedAt: string };

/** One confidence band of a decision type under one policy version: a Beta(alpha, beta) posterior of "the owner kept it". */
export type CalibrationBucket = { type: DecisionType; band: number; policyVersion: number; alpha: number; beta: number; n: number; updatedAt: string };

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
    super(`${what} is not run ${run}'s: a labelled run changes only what it wrote (use records created in this run, or make the change from the owner's browser)`);
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
/** The first agent seen (GraphStore.agentSeen): the client's name from MCP initialize, and when it first called a tool. */
export type AgentSeen = { client: string; at: string };

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
  /** How each job's model last fared (classify, postmortem, scan, summary, docs, chat, intake); missing until it is first asked. */
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

export const MODEL_JOBS = ['classify', 'postmortem', 'scan', 'summary', 'docs', 'chat', 'intake'] as const;
export type ModelJob = (typeof MODEL_JOBS)[number];
/** A job's model as /api/status reports it: ok until it was last found unavailable (or, for an Ollama model, while
 * Ollama does not answer), with the reason. */
export type ModelHealth = {
  provider: string | null;
  ok: boolean;
  reason: string | null;
  off?: true;
  /** Unavailable on purpose, not a failure: its Codex runner is turned off on this machine by its safety flag. */
  disabled?: true;
  /** While unavailable: since when (the first failure in a row), and when that was last seen. */
  since?: string;
  checkedAt?: string;
};

/** How a scan failed for being parked too long begins its error (worker scan/runner.ts); /api/status and doctor list these. */
export const SCAN_PARK_GAVE_UP = 'gave up after more than 24 hours parked on ';

/** What to do about a Codex runner its safety flag turned off. */
export const RUNNER_OFF_FIX = 'Its safety flag turned it off on this machine. Choose another scan model (SCAN_LLM, e.g. a local ollama: model) in .env, or fix the isolation failure and re-enable the runner: ./scripts/doctor.sh says how.';
/** "Codex runner off: scans paused", naming the jobs that wait for it. */
export function runnerOffLine(jobs: readonly string[]): string {
  const named: Record<string, string> = { scan: 'scans', postmortem: 'post-mortems', docs: 'document reading', chat: 'Ask with Codex', classify: 'classifying', summary: 'summaries', intake: 'intake reading' } satisfies Record<ModelJob, string>;
  return `Codex runner off: ${jobs.map((j) => named[j] ?? j).join(', ')} paused`;
}

/** The jobs whose model is codex-cli, which the Codex runner runs. */
export function codexJobs(providers: Partial<Record<string, string | null>>): ModelJob[] {
  return MODEL_JOBS.filter((j) => /^codex-cli(:|$)/.test(providers[j] ?? ''));
}
/** The Codex runner while no job uses it: neutral, whatever its state, since nothing waits for it. */
export function runnerNotUsedLine(scanModel: string | null): string {
  return `Codex runner: not used (scans use ${scanModel ?? 'no model'})`;
}

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
export type Connection = {
  state: ConnectionState; source: 'env' | 'app' | null; detail: string; href: string;
  /** Nothing uses it (the Codex runner while no job is set to codex-cli): shown neutrally and left out of the counts. */
  unused?: true;
};

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
  /** API auth is on but the separate browser-owner credential is missing. */
  ownerSetupRequired?: boolean;
  /** Stale or failed code maps that need attention; omitted when code maps are unavailable. */
  /** Maps needing attention: a failed or interrupted rebuild, or (rebuilding) a rebuild running now, which is not a failure. */
  /** builtAt, ageDays and checkedAt are null for a map whose first build never finished. */
  codeMaps?: { projectKey: string; builtAt: string | null; ageDays: number | null; /** When the worker last found the map current (the repo unchanged since the build); builtAt when later. */ checkedAt: string | null; interrupted?: boolean; rebuilding?: boolean; lastFailureAt?: string | null; lastFailure?: string | null }[];
  /**
   * Selected projects whose last scan waits on a model that fails its readiness probe (parked, with since when), or
   * was failed after more than a day of that (gaveUp, with the reason). Omitted when no facts store is wired.
   */
  scans?: { parked: { projectKey: string; provider: string; since: string | null; error: string }[]; gaveUp: { projectKey: string; at: string | null; error: string }[] };
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
  /** Knowledge intake (INTAKE_ENABLED): whether its routes and the Intake page are on. Unset from older APIs: off. */
  intake?: { enabled: boolean };
  /** The worker's current step and since when; null when the worker is offline or has not said. */
  stage?: { name: WorkerStageName; startedAt: string; current: string | null } | null;
  /** That step's items done of total (total null when it has none); null when the step does not count items. */
  progress?: { done: number; total: number | null } | null;
  /** The first agent that called an MCP tool (GraphStore.agentSeen); null: none yet, or the store cannot tell. */
  agent?: AgentSeen | null;
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
   * windows, when the store can tell. demo: how many of them fg demo seed wrote (source 'demo'). Older APIs leave these out.
   */
  lessons: { proposed: number; approved: number; global?: number; demo?: { proposed: number; approved: number }; quality?: LessonQuality[] } | null;
  /**
   * olderScanner: files an older scanner read, in all and by project (only those with some), which the next scan you
   * start reads again; neverScanned: the same for files no scanner version was recorded for. Each absent when there
   * are none or the store cannot count them.
   */
  scans: { done: number; queued: number; running: number; failed: number; never: number; olderScanner?: { files: number; projects: Record<string, number> }; neverScanned?: { files: number; projects: Record<string, number> } } | null;
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
  run?: string;
  sandbox?: true;
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

// ── Knowledge intake (0.9.0) ───────────────────────────────────────────
// IntakeFormat and INTAKE_FORMATS live with the parsers (intake/parse.ts).

/**
 * A source: what people said, stored as a Doc with source 'intake' plus this record (IntakeStore.upsertMeta).
 * transcript: a call or meeting. notes: someone's notes. doc: any other text.
 */
export const INTAKE_KINDS = ['transcript', 'notes', 'doc'] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

/**
 * A source's details. occurredAt: when it was said (the meeting date, as given). origin: free text ("Zoom weekly
 * sync") or a URL. private: never synced, even with SYNC_CLAIMS. participants: the Person ids who attended.
 * windowsDone: how many extraction windows of the current upload are saved (IntakeStore.saveWindow); windowsTotal:
 * how many there are, once known.
 */
export type IntakeMeta = {
  docId: string; kind: IntakeKind; format: IntakeFormat; occurredAt: string | null; origin: string | null; private: boolean;
  participants: string[]; windowsDone: number; windowsTotal: number | null;
};
export type IntakeMetaInput = Pick<IntakeMeta, 'docId' | 'kind' | 'format' | 'occurredAt' | 'origin' | 'private' | 'participants'>;

/** What a claim says: a fact, a decision, an opinion, a plan or a commitment. Only an opinion is never served to agents. */
export const CLAIM_TYPES = ['fact', 'decision', 'opinion', 'plan', 'commitment'] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];
/** proposed: waits for review. accepted: the owner's (a non-opinion becomes a Fact). superseded: lost a conflict. */
export const CLAIM_STATUSES = ['proposed', 'accepted', 'rejected', 'superseded'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
/** quote-fuzzy: the quote matched the source only approximately. statement-adds: the statement names what the quote does not. */
export const CLAIM_FLAGS = ['quote-fuzzy', 'statement-adds'] as const;
export type ClaimFlag = (typeof CLAIM_FLAGS)[number];
/** area: a part of the product or code ("billing"); files: repo-relative paths that resolved against the code map. */
export type ClaimScope = { area: string | null; files: string[] };
/** Where a quote is in its source: the utterance and the character range inside the source text. */
export type ClaimSpan = { utt: number; start: number; end: number };

/**
 * One statement drawn from a source. docId: its source, or `answer:<questionId>` for the owner's answer to a question.
 * window: the extraction window it came from (null for an answer). speakerId: the Person who said it. assertedAt:
 * when it was said. factId: the Fact accepting it created. run, sandbox: the run its source was added in.
 */
export type Claim = {
  id: string; projectKey: string | null; docId: string; window: number | null; span: ClaimSpan | null;
  type: ClaimType; statement: string; quote: string; speakerId: string | null; assertedAt: string | null;
  confidence: number; scope: ClaimScope; about: string; due: string | null; flags: ClaimFlag[];
  status: ClaimStatus; decidedBy: string | null; decidedAt: string | null; factId: string | null; createdAt: string;
  run: string | null; sandbox: boolean;
};
/** A claim as extraction makes it (IntakeStore.saveWindow): always proposed. */
export type ClaimDraft = Pick<Claim, 'type' | 'statement' | 'quote' | 'speakerId' | 'span' | 'assertedAt' | 'confidence' | 'scope' | 'about' | 'due' | 'flags'> & {
  embedding: number[] | null;
};

/** unanswered: asked and not answered. contradictory: the source contradicts itself. needs_owner: a plan or commitment with no owner. */
export const QUESTION_KINDS = ['unanswered', 'contradictory', 'needs_owner'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export const QUESTION_STATUSES = ['open', 'assigned', 'answered', 'dismissed'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
/** askedBy, assignee: Person ids. answerClaimId: the claim answering it (IntakeStore.answerQuestion). */
export type Question = {
  id: string; projectKey: string | null; docId: string; window: number | null; text: string; kind: QuestionKind;
  quote: string | null; askedBy: string | null; assignee: string | null; status: QuestionStatus; answerClaimId: string | null;
  decidedBy: string | null; decidedAt: string | null; createdAt: string; run: string | null; sandbox: boolean;
};
export type QuestionDraft = Pick<Question, 'text' | 'kind' | 'quote' | 'askedBy'>;

/** proposed: made from a speaker label nobody has confirmed. forgotten: its name and aliases are gone (forgetPerson). */
export const PERSON_STATUSES = ['proposed', 'confirmed', 'forgotten'] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];
/** aliases: the normalised names that resolve to it (aliasNorm). claims: how many claims it said. */
export type Person = {
  id: string; displayName: string; isOwner: boolean; status: PersonStatus; aliases: string[]; claims: number; createdAt: string;
};

/** supersession: the newer side probably replaces the older (same speaker, later decision); disagreement: anything else. */
export const CONFLICT_KINDS = ['disagreement', 'supersession'] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];
/** dismissed: "not a conflict"; the pair stays suppressed until either side changes (its fingerprint). */
export const CONFLICT_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];
export const CONFLICT_SIDE_KINDS = ['claim', 'fact', 'lesson'] as const;
export type ConflictSideKind = (typeof CONFLICT_SIDE_KINDS)[number];
/** a / b: that side is true. both: both partly, with a note. none: not a conflict (with a reason). */
export const CONFLICT_CHOICES = ['a', 'b', 'both', 'none'] as const;
export type ConflictChoice = (typeof CONFLICT_CHOICES)[number];
export const CONFLICT_DISMISS_REASONS = ['scope', 'refines', 'handled'] as const;
export type ConflictDismissReason = (typeof CONFLICT_DISMISS_REASONS)[number];

/** A record a conflict, supersession or claim link names. */
export type IntakeRef = { kind: ConflictSideKind; id: string };
/**
 * One side as it was when the conflict was found: its fingerprint (claimFingerprint, factFingerprint or
 * lessonFingerprint) decides whether a dismissed pair has changed since, and assertedAt when it was said or recorded.
 */
export type ConflictSide = IntakeRef & { fingerprint: string; assertedAt: string | null };
/** A deterministic pre-filter's finding ("numbers differ: 30 s vs 60 s"), kept as the pre-filter made it. */
/** One pre-filter finding that made a pair worth judging (conflicts/prefilter.ts). */
export type ConflictSignal = import('./conflicts/prefilter.ts').PrefilterSignal;
/** The judge's answer: aQuote and bQuote are cited from each side's stored text. */
export type ConflictJudge = {
  relation: 'contradicts' | 'refines' | 'same' | 'unrelated'; aQuote: string; bQuote: string; explanation: string; confidence: number; model: string | null;
};
/** How the owner settled it. createdFactId: the reconciled statement's owner fact (both partly). */
export type ConflictResolution = { choice: ConflictChoice; note: string | null; reason: ConflictDismissReason | null; createdFactId: string | null };
/** decisionId: the resolve_conflict decision that settled it. */
export type Conflict = {
  id: string; kind: ConflictKind; status: ConflictStatus; projectKey: string | null; a: ConflictSide; b: ConflictSide;
  signals: ConflictSignal[]; judge: ConflictJudge | null; resolution: ConflictResolution | null; decisionId: string | null;
  createdAt: string; resolvedAt: string | null; resolvedBy: string | null; run: string | null; sandbox: boolean;
};
export type ConflictInput = Pick<Conflict, 'kind' | 'projectKey' | 'a' | 'b' | 'signals' | 'judge'> & { run?: RunTag | null };

/** `from` lost conflict `conflictId` to `to`: (from)-[:SUPERSEDED_BY {conflictId}]->(to). */
export type Supersession = { from: IntakeRef; to: IntakeRef; conflictId: string };
export const CLAIM_LINK_RELS = ['refines', 'corroborates'] as const;
export type ClaimLinkRel = (typeof CLAIM_LINK_RELS)[number];
/** (claim)-[:REFINES|CORROBORATES]->(to). */
export type ClaimLink = { from: string; to: IntakeRef; rel: ClaimLinkRel };
