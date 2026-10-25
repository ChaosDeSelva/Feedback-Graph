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
import type { EmbeddedFact, FactHit, RelevanceUpdate, StoredFact, UnscoredFact } from './graph/facts.ts';
import type { DocHit, DocInput, DocSummary, DocToRead, UpsertDocOpts } from './graph/docs.ts';
import type { TaskImage } from './llm/providers.ts';
import type { DetectedLink, LinkPatch, ProjectLink } from './graph/links.ts';
import type { EvidenceGraph, PatternReport } from './graph/insights.ts';
import type { ExportBundle } from './graph/portability.ts';
import type { CandidateSnapshot } from './graph/selection.ts';
import type { CodeMapMeta, CodeMapStats, CodeMapWrite, Hotspot, HotspotOpts, Impact, MapGraph, ModuleContext, SessionFile, StoredCodeMap } from './codegraph.ts';
import type { ExternalRef, ExternalSource, SessionSource, HumanTurn, SessionDetail, SessionListItem, SessionState } from './types.ts';
import type { SessionCursor, SummaryWork, SummaryWorkQuery, SummaryWrite } from './sessions.ts';

/**
 * A pull request's or Linear issue's comments as one stand-in session (`id`, e.g. `github:acme/shop#12`): never
 * listed or summarized, one turn per comment (index from 1, oldest first). The classifier labels the turns like any
 * other; pushback and corrections become Inbox items with the thread's source. `context` is what the comment answers
 * (title, file and diff lines), shown where an agent's last message would be.
 */
export type ExternalThread = {
  id: string;
  source: ExternalSource;
  items: { uuid: string; ts: string; index: number; text: string; context: string; external: ExternalRef }[];
};

/**
 * An agent session that did work a comment may be about (GraphStore.workSessions): `edits` file edits and `commits`
 * git commits over the whole session (sessionWork()).
 */
export type WorkSession = {
  id: string;
  source: SessionSource;
  gitBranch: string | null;
  cwd: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  edits: number;
  commits: number;
};

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
  /**
   * Store (or update) a synced PR or issue thread under a project (redacted here too). A comment already stored keeps
   * its classification. Returns how many of its comments were new.
   */
  upsertExternalThread(project: Project, t: ExternalThread): Promise<number>;
  /**
   * Agent sessions of a project (stand-in sessions never) that did the work: a session counts only when it edited files
   * or ran a git commit (sessionWork(), recorded by upsertSession), so a review or a Q&A session never does. Those on
   * `branch` whose first work was before `before`; with no branch, those whose work overlaps `after`..`before`. Most
   * edits first, then the most recent work.
   */
  workSessions(q: { projectKey: string; branch: string | null; before: string; after?: string | null; limit: number }): Promise<WorkSession[]>;
  heartbeat(s: WorkerStatus): Promise<void>;
  workerStatus(): Promise<WorkerStatus | null>;
  stats(): Promise<StatsRow[]>;
}

/** Post-mortems (feedback, miss, cause, lesson, context items, fix commits), lessons and their search. */
export interface KnowledgeStore {
  feedbackNeedingPostmortem(limit: number, now?: Date): Promise<PostMortemInput[]>;
  /** How many still wait for a post-mortem: not rejected, none yet, not given up (those backing off count). */
  postmortemBacklog?(): Promise<number>;
  recordPostmortemFailure(feedbackId: string, error: string, now?: Date): Promise<{ attempts: number; retryAt: string | null }>;
  retryPostmortem(feedbackId: string): Promise<boolean>;
  savePostmortem(feedbackId: string, raw: PostMortem, embeddings: { miss: number[]; lesson: number[] }): Promise<void>;
  /**
   * projectKeys (here and in searchLessons): only lessons learned in these projects (a global lesson by its origin);
   * lessons with no project at all stay. An empty list leaves only those.
   */
  listLessons(f: { status?: LessonStatus; projectKey?: string; projectKeys?: string[]; limit?: number }): Promise<Lesson[]>;
  lessonDetail(id: string): Promise<LessonDetail | null>;
  /** `by`: who decides, when the patch sets a status ('you' when unset; `operator:<name>` for the operator token). */
  updateLesson(id: string, patch: LessonPatch, o: { reembed?: number[]; by?: string }): Promise<{ unscoped: boolean }>;
  searchLessons(q: { embedding: number[]; projectKey: string | null; k: number; status?: LessonStatus; projectKeys?: string[] }): Promise<LessonHit[]>;
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
  /** Current facts of these projects that have no relevance yet, oldest path first. */
  unscoredFacts(q: { projectKeys: string[]; limit: number }): Promise<UnscoredFact[]>;
  /** Set relevance (clamped to 0..1). A 'model' update skips facts you scored. Returns how many facts changed. */
  setFactRelevance(updates: RelevanceUpdate[]): Promise<number>;
  requestScan(project: Project, provider: string | null): Promise<ScanJob>;
  scanJob(id: string): Promise<ScanJob | null>;
  /** The oldest queued job that is due (its retryAt, if any, has passed), other than the `exclude` ids. */
  nextScanJob(now?: Date, exclude?: string[]): Promise<ScanJob | null>;
  /**
   * A run that did not finish. `counted` (a real failure): one more attempt, queued again after scanRetryAt, or
   * failed for good after MAX_SCAN_ATTEMPTS. Not counted (the model could not be asked): queued again after
   * SCAN_UNAVAILABLE_WAIT_MS, attempts unchanged. Returns the job's attempts and when it runs next (null: failed).
   */
  recordScanFailure(id: string, error: string, o: { counted: boolean }, now?: Date): Promise<{ attempts: number; retryAt: string | null }>;
  updateScanJob(id: string, patch: Partial<Pick<ScanJob, 'filesScanned' | 'factsAdded' | 'error'>> & { status?: ScanStatus }): Promise<void>;
  requeueStaleScans(): Promise<void>;
  listProjects(): Promise<ProjectSummary[]>;
  /** Pin or unpin. A folder with no data yet is recorded as a project (its name and path kept if it had them). */
  setPinned(project: Project, pinned: boolean): Promise<void>;
}

/** Documents that are not code (uploads, PR discussions, tickets) as embedded chunks, and integration sync cursors. */
export interface DocsStore {
  /** Insert or replace; a replaced document loses what was read from it (its facts, its image) and is read again if `read`. */
  upsertDoc(input: DocInput, raw: { text: string; embedding: number[] }[], o?: UpsertDocOpts): Promise<string>;
  /** The oldest upload waiting to be read whose retryAt (if any) has passed. */
  nextDocToRead(now?: Date): Promise<DocToRead | null>;
  /** version: only if it is still that upload. False when it was replaced (or is gone). */
  markDocReading(id: string, version?: string): Promise<boolean>;
  /**
   * What the reader made of it: its facts (filed under the project, path = the document's name, never closed by a code
   * scan) replace earlier ones, and `chunks`, when given (an image's description), replace its excerpts. Redacted here.
   */
  saveDocReading(id: string, r: { version?: string; chunks?: { text: string; embedding: number[] }[]; facts: EmbeddedFact[]; source: string }): Promise<boolean>;
  /**
   * Like recordScanFailure: counted failures back off and give up after MAX_SCAN_ATTEMPTS; uncounted ones just wait.
   * final: give up now (retrying cannot help, e.g. an image for a model with no vision). version: only if it is still
   * that upload; null when it was replaced, so a failure of the old version never marks the new one.
   */
  recordDocFailure(id: string, error: string, o: { counted: boolean; final?: boolean; version?: string }, now?: Date): Promise<{ attempts: number; retryAt: string | null } | null>;
  /** Readings left running by a worker that died go back to pending (on startup). */
  requeueStaleDocs(): Promise<void>;
  docImage(id: string): Promise<TaskImage | null>;
  listDocs(projectKey: string): Promise<DocSummary[]>;
  deleteDoc(id: string): Promise<boolean>;
  searchDocs(q: { embedding: number[]; projectKey: string; k: number }): Promise<DocHit[]>;
  getCursor(key: string): Promise<string | null>;
  setCursor(key: string, value: string): Promise<void>;
}

/** Links between projects: suggested by the worker's evidence, confirmed or dismissed by you, made by hand. */
export interface LinksStore {
  /** projectKey: links with it at either end. projectKeys: links with both ends in it (an empty list finds none). */
  listLinks(q: { projectKey?: string; projectKeys?: string[] }): Promise<ProjectLink[]>;
  /**
   * One detection round over the `scanned` projects. New pairs become suggestions; a suggestion gets the new relation,
   * score and evidence; a link you decided keeps its status, relation and note and only gets fresh evidence. A
   * suggestion between scanned projects that this round did not find again is dropped. Returns how many are new.
   */
  replaceDetected(scanned: string[], found: DetectedLink[]): Promise<number>;
  /** Your decision or edit; creates the link (confirmed, by you) when there is none. Throws for a project and itself. */
  setLink(x: string, y: string, patch: LinkPatch): Promise<ProjectLink>;
  deleteLink(id: string): Promise<boolean>;
}

/** The provenance log: append-only, newest first. */
export interface ActivityStore {
  record(a: ActivityInput): Promise<void>;
  /** projectKeys: entries of other projects are left out; entries with no project stay. */
  list(q: { projectKey?: string; projectKeys?: string[]; kind?: ActivityKind; target?: string; limit?: number }): Promise<Activity[]>;
}

/** Read-only views: one project's evidence graph, and patterns across misses. */
export interface InsightsStore {
  projectGraph(projectKey: string, limit?: number): Promise<EvidenceGraph>;
  /** projectKeys: only these projects (an empty list: an empty report). */
  patterns(q: { projectKey?: string; projectKeys?: string[]; threshold?: number }): Promise<PatternReport>;
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
  /** Paths the project's sessions edited, most recently edited first (then path), at most `limit`. */
  editedPaths(projectKey: string, limit: number): Promise<string[]>;
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
  readonly links: LinksStore;
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
