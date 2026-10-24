/**
 * The storage seam. Everything the api and the worker read or write goes through these interfaces, so one set of
 * callers runs on either backend: Neo4j (the default local store, ./graph/*) or Postgres with pgvector
 * (@fb/store-postgres, for the hosted team product). The contract suites (*.int.test.ts, run per backend by
 * TEST_STORES) are what "behaves the same" means.
 *
 * Rules every backend follows:
 * - Redact before storing, exactly where the Neo4j classes do (redactDeep / redactSecrets from ../redact.ts),
 *   including activity subjects, whys and details.
 * - Ids are the Neo4j ids (`lesson:<feedbackId>`, `doc:<project>:<source>:<ref>`, `act:<uuid>`, ...), so data and
 *   links move between backends unchanged.
 * - Times the tool generates are ISO strings from Date.toISOString(); times that came from outside (turn and commit
 *   timestamps) are returned exactly as they were stored.
 * - Vectors of a different length than the query are skipped by searches, never an error.
 */
import type { Config } from './config.ts';
import type { ActivityInput, Activity, ActivityKind, Candidate, Classification, Commit, FactKind, LessonStatus, Lesson, ParsedSession, PostMortem, PostMortemInput, Project, ProjectSummary, ScanJob, ScanStatus, WorkerStatus } from './types.ts';
import type { ProjectScope, ProjectSelection } from './scope.ts';
import type { CandidateDetail, CandidateFilter, ClassifiableTurn, StatsRow } from './graph/repo.ts';
import type { LessonDetail, LessonHit, LessonInput, LessonPatch, RelatedMiss } from './graph/knowledge.ts';
import type { EmbeddedFact, FactHit, StoredFact } from './graph/facts.ts';
import type { DocHit, DocInput, DocSummary } from './graph/docs.ts';
import type { EvidenceGraph, PatternReport } from './graph/insights.ts';
import type { ExportBundle } from './graph/portability.ts';
import type { CandidateSnapshot } from './graph/selection.ts';
import type { CodeMapMeta, CodeMapStats, CodeMapWrite, Hotspot, HotspotOpts, Impact, MapGraph, ModuleContext, SessionFile, StoredCodeMap } from './codegraph.ts';
import type { HumanTurn, SessionDetail, SessionListItem, SessionState } from './types.ts';
import type { SessionCursor, SummaryWork, SummaryWorkQuery, SummaryWrite } from './sessions.ts';

export type StoreKind = 'neo4j' | 'postgres';
export const STORE_KINDS: readonly StoreKind[] = ['neo4j', 'postgres'];

/** Sessions, turns, the inbox of flagged candidates, your decisions, projects and their aliases, the worker heartbeat. */
export interface GraphStore {
  upsertSession(project: Project, s: ParsedSession, commits: Commit[]): Promise<void>;
  /** dryRun: only say which project the folder follows; no alias is recorded. */
  canonicalProject(folder: Project, o?: { dryRun?: boolean }): Promise<{ project: Project; aliasedNow: boolean }>;
  projectByAlias(key: string): Promise<Project | null>;
  projectsMissingRemote(): Promise<Project[]>;
  setProjectRemote(key: string, remote: string): Promise<void>;
  unclassifiedTurns(limit: number, projectKeys?: string[], excludeKeys?: string[]): Promise<ClassifiableTurn[]>;
  recordClassifyFailure(turnUuid: string): Promise<void>;
  /** Unlabelled turns skipped for good after MAX_CLASSIFY_ATTEMPTS failed classifications. */
  givenUpTurns(): Promise<number>;
  /** Give those turns their attempts back so the classifier tries them again; returns how many. */
  requeueGivenUpTurns(): Promise<number>;
  /**
   * With makeCandidate, the turn becomes an Inbox item, unless an agent already reported the same miss (dedupe.ts):
   * a pending report then moves onto this turn, keeping its report; a decided one only records the detector as a source.
   * Returns the id of the Inbox item the turn is filed under (the turn's own id, or the merged report's), null without
   * makeCandidate.
   */
  saveClassification(turnUuid: string, c: Classification, makeCandidate: boolean): Promise<string | null>;
  listCandidates(f?: CandidateFilter): Promise<Candidate[]>;
  candidateDetail(id: string): Promise<CandidateDetail | null>;
  decide(id: string, status: 'confirmed' | 'rejected', note: string | null): Promise<void>;
  /** keepUnsummarized: only turns a session summary already covers lose their text (summaries stay either way). */
  pruneTurnText(before: Date, limit?: number, o?: { keepUnsummarized?: boolean }): Promise<number>;
  heartbeat(s: WorkerStatus): Promise<void>;
  workerStatus(): Promise<WorkerStatus | null>;
  stats(): Promise<StatsRow[]>;
}

/** Post-mortems (feedback, miss, cause, lesson, context items, fix commits), lessons and their search. */
export interface KnowledgeStore {
  feedbackNeedingPostmortem(limit: number, now?: Date): Promise<PostMortemInput[]>;
  recordPostmortemFailure(feedbackId: string, error: string, now?: Date): Promise<{ attempts: number; retryAt: string | null }>;
  retryPostmortem(feedbackId: string): Promise<boolean>;
  savePostmortem(feedbackId: string, raw: PostMortem, embeddings: { miss: number[]; lesson: number[] }): Promise<void>;
  listLessons(f: { status?: LessonStatus; projectKey?: string; limit?: number }): Promise<Lesson[]>;
  lessonDetail(id: string): Promise<LessonDetail | null>;
  updateLesson(id: string, patch: LessonPatch, o: { reembed?: number[] }): Promise<{ unscoped: boolean }>;
  searchLessons(q: { embedding: number[]; projectKey: string | null; k: number; status?: LessonStatus }): Promise<LessonHit[]>;
  relatedMisses(q: { embedding: number[]; projectKey: string | null; k: number }): Promise<RelatedMiss[]>;
  /**
   * An agent's report_feedback. Returns the Inbox item's id: a new `manual:<uuid>`, or the id of the detector's item
   * for the same miss that it was merged into (REPORT_MERGE_MINUTES, dedupe.ts). The detector merges the other way in
   * GraphStore.saveClassification.
   */
  createManualFeedback(input: { project: Project; cwd: string; text: string; whatWasDone: string; sessionId?: string | null }): Promise<string>;
  recordPreDoneCheck(c: { projectKey: string; task: string; checkedLessonIds: string[]; gapLessonIds: string[] }): Promise<void>;
  upsertLesson(input: LessonInput): Promise<void>;
}

/** Code facts from scans, the files they are about, scan jobs, and the per-project summary. */
export interface FactsStore {
  fileHashes(projectKey: string): Promise<Map<string, string>>;
  saveFileFacts(projectKey: string, rawFile: { path: string; hash: string; summary: string }, rawFacts: EmbeddedFact[], source: string, scanJobId?: string | null): Promise<void>;
  markFilesRemoved(projectKey: string, paths: string[]): Promise<void>;
  /** All or nothing: a failure part way leaves the old facts current and the old hashes in place. */
  replaceProjectFacts(projectKey: string, rawFacts: EmbeddedFact[], source: string, files: { path: string; hash: string }[], scanJobId?: string | null): Promise<void>;
  currentSources(projectKey: string): Promise<string[]>;
  listFacts(q: { projectKey: string; kind?: FactKind; path?: string; limit?: number }): Promise<StoredFact[]>;
  searchFacts(q: { embedding: number[]; projectKey: string; k: number }): Promise<FactHit[]>;
  requestScan(project: Project, provider: string | null): Promise<ScanJob>;
  scanJob(id: string): Promise<ScanJob | null>;
  /** The oldest queued job that is due (its retryAt, if any, has passed). */
  nextScanJob(now?: Date): Promise<ScanJob | null>;
  /**
   * A run that did not finish. `counted` (a real failure): one more attempt, queued again after scanRetryAt, or
   * failed for good after MAX_SCAN_ATTEMPTS. Not counted (the model could not be asked): queued again after
   * SCAN_UNAVAILABLE_WAIT_MS, attempts unchanged. Returns the job's attempts and when it runs next (null: failed).
   */
  recordScanFailure(id: string, error: string, o: { counted: boolean }, now?: Date): Promise<{ attempts: number; retryAt: string | null }>;
  updateScanJob(id: string, patch: Partial<Pick<ScanJob, 'filesScanned' | 'factsAdded' | 'error'>> & { status?: ScanStatus }): Promise<void>;
  requeueStaleScans(): Promise<void>;
  listProjects(): Promise<ProjectSummary[]>;
}

/** Documents that are not code (uploads, PR discussions, tickets) as embedded chunks, and integration sync cursors. */
export interface DocsStore {
  upsertDoc(input: DocInput, raw: { text: string; embedding: number[] }[]): Promise<string>;
  listDocs(projectKey: string): Promise<DocSummary[]>;
  deleteDoc(id: string): Promise<boolean>;
  searchDocs(q: { embedding: number[]; projectKey: string; k: number }): Promise<DocHit[]>;
  getCursor(key: string): Promise<string | null>;
  setCursor(key: string, value: string): Promise<void>;
}

/** The provenance log: append-only, newest first. */
export interface ActivityStore {
  record(a: ActivityInput): Promise<void>;
  list(q: { projectKey?: string; kind?: ActivityKind; target?: string; limit?: number }): Promise<Activity[]>;
}

/** Read-only views: one project's evidence graph, and patterns across misses. */
export interface InsightsStore {
  projectGraph(projectKey: string, limit?: number): Promise<EvidenceGraph>;
  patterns(q: { projectKey?: string; threshold?: number }): Promise<PatternReport>;
}

/** Export of derived knowledge, and deleting a project with everything learned from it. */
export interface PortabilityStore {
  exportData(o?: { projectKey?: string; approvedOnly?: boolean }): Promise<ExportBundle>;
  /** Returns how many records were deleted (backends count differently; callers only show it). */
  deleteProject(key: string): Promise<number>;
}

/** Which embedding model the stored vectors came from, and re-embedding everything with another. */
export interface EmbeddingsStore {
  stored(): Promise<string | null>;
  check(model: string): Promise<{ ok: boolean; stored: string }>;
  reembed(model: string, embed: (texts: string[]) => Promise<number[][]>, progress?: (label: string, done: number) => void): Promise<number>;
}

/** The owner's project selection and the worker's list of candidate folders. */
export interface SelectionStore {
  get(): Promise<ProjectSelection | null>;
  current(): Promise<ProjectSelection>;
  ensure(env: Pick<Config, 'ingestProjects' | 'excludeProjects'>, activity?: Pick<ActivityStore, 'record'>): Promise<{ selection: ProjectSelection; seeded: boolean }>;
  setTracked(tracked: string[]): Promise<{ before: string[]; selection: ProjectSelection }>;
  aliases(): Promise<Map<string, string>>;
  scope(env: Pick<Config, 'excludeProjects'>): Promise<ProjectScope>;
  saveCandidates(s: CandidateSnapshot): Promise<void>;
  candidates(): Promise<CandidateSnapshot | null>;
  keysWithData(): Promise<string[]>;
  /**
   * Run fn while no other exclusive section runs, in any process: the worker's writes of one transcript, and the
   * deletion of a project's data, so a cycle that is part way never writes a deleted project back.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Ask the worker to forget which transcripts and memory files of these folders it read (their data was deleted). */
  forgetReads(folderKeys: string[]): Promise<void>;
  /** Folders to forget since cursor `after`, and the new cursor. A cursor ahead of the store starts over. */
  forgottenReads(after: number): Promise<{ seq: number; keys: string[] }>;
}

/**
 * The code knowledge graph of each project (files, symbols, IMPORTS / DEFINES / TESTS edges, churn), the files each
 * session read and edited, and the views that link code to misses. A miss is linked to the files its session edited
 * (fixedHere: edited after the feedback); file nodes are the ones facts are ABOUT. Paths are repo-relative.
 */
export interface CodeGraphStore {
  /** Replace the project's map in one transaction: files gone from it lose their map data, edges are rebuilt. */
  replaceCodeMap(projectKey: string, map: CodeMapWrite): Promise<CodeMapStats>;
  /** The stored map in the parser's shape (for an incremental build), or null before the first build. */
  codeMap(projectKey: string): Promise<StoredCodeMap | null>;
  /** When the map was built, from what (fingerprint), and its size; null before the first build. Cheap. */
  codeMapMeta(projectKey: string): Promise<CodeMapMeta | null>;
  /** Replace the files a session touched (paths already repo-relative, see sessionFiles()). Unknown session: no-op. */
  recordSessionFiles(sessionId: string, files: SessionFile[]): Promise<void>;
  sessionFiles(sessionId: string): Promise<SessionFile[]>;
  /** A mapped file with its symbols, importers, imports, tests, facts, misses and approved lessons; null if not mapped. */
  moduleContext(projectKey: string, path: string): Promise<ModuleContext | null>;
  /** What changing these files touches: dependents up to `depth`, tests to run, misses and lessons on them. */
  impact(projectKey: string, paths: string[], depth: number): Promise<Impact>;
  /** Mapped files by score (misses, churn, dependents), highest first, ties by path. Test files only with includeTests. */
  hotspots(projectKey: string, limit: number, opts?: HotspotOpts): Promise<Hotspot[]>;
  /** The map as a graph: the top files by score, their neighbours, the edges among them, and their misses and lessons. */
  mapGraph(projectKey: string, opts: HotspotOpts & { limit: number }): Promise<MapGraph>;
  /** Approved lessons (global ones included) whose paths cover one of these files or whose miss edited one. */
  lessonsForPaths(projectKey: string, paths: string[]): Promise<{ lesson: Lesson; paths: string[] }[]>;
}

/**
 * Running summaries of sessions (see sessions.ts): the summary, the cursor of the last turn it covers, its update
 * history, and whether the session is active or idle. Manual sessions (agent reports) are never listed or summarized.
 * Summaries are redacted before they are stored and are never part of an export or a sync.
 */
export interface SessionsStore {
  /** Newest activity first. projectKeys: only these (an empty list finds nothing); summarizedOnly: with a summary. */
  list(q: { projectKeys: string[]; state?: SessionState; limit: number; after?: SessionCursor | null; summarizedOnly?: boolean }): Promise<{ sessions: SessionListItem[]; next: SessionCursor | null }>;
  detail(id: string): Promise<SessionDetail | null>;
  /** Sessions the summarize stage has something to do for, newest activity first (see SummaryWorkQuery). */
  work(q: SummaryWorkQuery): Promise<SummaryWork[]>;
  /** The session's turns with index > afterIndex, in order, at most limit. */
  turns(sessionId: string, afterIndex: number, limit: number): Promise<HumanTurn[]>;
  /** Store one update (redacted) and append it to the history. False when the session moved on meanwhile (not applied). */
  save(sessionId: string, w: SummaryWrite): Promise<boolean>;
  /** A failed update: the summary and cursor stay, and the session waits (summaryRetryAt) before it is tried again. */
  recordFailure(sessionId: string, error: string, now?: Date): Promise<{ attempts: number; retryAt: string }>;
  setState(sessionId: string, state: SessionState): Promise<void>;
  /** The next update rebuilds the summary from the first turn. The current one is served until then. False: no such session. */
  requestRebuild(sessionId: string): Promise<boolean>;
}

/** One backend, opened: every repository over one connection, plus the lifecycle the services need. */
export interface Store {
  readonly kind: StoreKind;
  readonly graph: GraphStore;
  readonly knowledge: KnowledgeStore;
  readonly facts: FactsStore;
  readonly docs: DocsStore;
  readonly activity: ActivityStore;
  readonly insights: InsightsStore;
  readonly portability: PortabilityStore;
  readonly embeddings: EmbeddingsStore;
  readonly selection: SelectionStore;
  readonly codegraph: CodeGraphStore;
  readonly sessions: SessionsStore;
  /** Create or upgrade the schema (Neo4j constraints and indexes; Postgres migrations). Safe from two services at once. */
  ensureSchema(): Promise<void>;
  /** Whether the database answers. Never throws. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
