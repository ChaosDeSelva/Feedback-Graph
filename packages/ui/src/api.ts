import type { Activity, ActivityKind, Connection, ConnectionName, ExternalRef, FeedbackSource, CloudSyncResult, SyncCounts, SyncTrigger, Candidate, CodeMapMeta as StoredCodeMapMeta, Hotspot, MapGraph, ModuleContext, FolderCandidate, OutsideFolder, PipelineStatus, DocSummary, CandidateDetail, CandidateStatus, EvidenceGraph, FactHit, FactKind, Lesson as StoredLesson, LessonCheckName, LessonDetail as StoredLessonDetail, LessonFrom, LessonQuality, LessonQualityReport, LessonStatus, LessonTriggers, PatternReport, ProjectSummary, ProjectLink, LinkRelation, LinkStatus, ScanJob, SessionDetail, SessionListItem, SessionState, StatsRow, StoredFact, SystemStatus } from '@fb/core';
import type { ChatConversation, ChatProvider, ChatThread } from '@fb/core/chat';
import type { Utterance } from '@fb/core';
import type { Claim, ClaimScope, ClaimSpan, ClaimStatus, ClaimType, Conflict, ConflictChoice, ConflictDismissReason, ConflictStatus, IntakeKind, IntakeMeta, IntakeRef, Person, PersonStatus, Question, QuestionStatus } from '@fb/core/types';

export type { Connection, ConnectionName, ExternalRef, FeedbackSource, CloudSyncResult, SyncCounts, Activity, Candidate, Hotspot, MapGraph, ModuleContext, DocSummary, CandidateDetail, CandidateStatus, EvidenceGraph, LessonQuality, LessonQualityReport, LessonStatus, PatternReport, ProjectSummary, ProjectLink, LinkRelation, LinkStatus, ScanJob, PipelineStatus, SessionDetail, SessionListItem, SessionState, StatsRow, StoredFact, SystemStatus };
/** A lesson as the API serves it: changedByLoop when a learning-loop decision still applied changed it. */
export type Lesson = StoredLesson & { changedByLoop?: true };
export type LessonDetail = Omit<StoredLessonDetail, 'lesson'> & { lesson: Lesson };

/** One folder on the Settings page (GET /api/settings/projects). */
export type ProjectCandidate = FolderCandidate & {
  /** In the tracked list. For an alias folder: whether the project it is a clone of is tracked. */
  tracked: boolean;
  /** EXCLUDE_PROJECTS: shown, never selectable. */
  excluded: boolean;
  /** The project this folder is another clone of; not selectable on its own. */
  aliasOf: string | null;
  /** The graph holds data under this key. */
  hasData: boolean;
  /** Its sessions are read now. */
  inScope: boolean;
};

export type ProjectSettings = {
  initialized: boolean;
  tracked: string[];
  candidates: ProjectCandidate[];
  /** Sessions outside every root, and the folders they ran in that could be added as roots. */
  outsideRoots: { claudeSessions: number; codexSessions: number; folders: OutsideFolder[] };
  /** Sessions that only ran in a root itself or a folder above one (none of their turns is read); unset from older APIs. */
  atRoots?: OutsideFolder[];
  /** The mounted roots, as host paths. */
  roots: string[];
  /** Roots saved here that are not mounted yet (./scripts/setup.sh mounts them); null when nothing is waiting. */
  pendingRoots?: string[] | null;
  /** Roots can be saved from Settings. Unset from older APIs (then they cannot). */
  rootsEditable?: boolean;
  /** When the worker last counted sessions; null before its first pass. */
  builtAt: string | null;
  /** false: no Codex sessions folder is mounted; null: the worker has not reported. */
  codexSessionsFound: boolean | null;
};

/** GET /api/projects/:key/codemap/hotspots: the map's stats (null before its first build) and its hotspots. */
/**
 * Whether the map is capped (the API's mapCapped): `of` the files worth mapping, or null for a map built before they
 * were counted that holds as many files as the cap allows.
 */
export type MapCapped = { files: number; of: number | null } | null;
/**
 * A code map's meta as the API sends it: builtAt and checkedAt are null for a map whose first build never finished (a
 * 0.7.5 Neo4j record of the failure), which the store's type does not say.
 */
export type CodeMapMeta = Omit<StoredCodeMapMeta, 'builtAt' | 'checkedAt'> & { builtAt: string | null; checkedAt?: string | null };
export type CodeMapReport = { meta: CodeMapMeta | null; hotspots: Hotspot[]; capped?: MapCapped };
/** GET /api/codemap/hotspots: hotspots across the selected projects. */
export type ProjectHotspot = Hotspot & { projectKey: string };

/** GET /api/cloud: the Cloud sync card on Settings. */
export type CloudInfo = {
  enabled: boolean;
  host: string | null;
  intervalMinutes: number | null;
  /** SYNC_SUGGESTIONS: lessons you have not approved are sent too (proposed ones as suggestions). */
  suggestions: boolean;
  /** Projects never sent: the saved list and CLOUD_LOCAL_ONLY_PROJECTS together. */
  localOnlyProjects: string[];
  /** The saved list can be changed here (the API has somewhere to keep it). */
  localOnlyEditable: boolean;
  savedLocalOnlyProjects: string[];
  shareDemoProjects: string[];
  projects: string[];
  preview: { total: SyncCounts; projects: { key: string; counts: SyncCounts | null; reason?: string }[] } | null;
  previewError: string | null;
  last: { at: string; ok: boolean; trigger: SyncTrigger; error: string | null; sent: SyncCounts | null; projects: string[]; failed: string[]; teamLessons?: { message: string }[] } | null;
  nextAt: string | null;
  neverSent: string;
};

/** POST /api/import: what an export bundle brought in. */
export type ImportResult = {
  lessons: { added: number; approved: number; proposed: number; revoked?: number; existing: number; excluded: number; skipped: number };
  facts: { added: number; projects: string[]; skippedProjects: string[] };
  notImported: { misses: number; docs: number; codeFiles: number };
};

/** The phrase POST /api/settings/cleanup wants before it deletes anything. */
export const CLEANUP_CONFIRM = 'remove-unselected';

/** projectKey: with scope project or task, the project a global lesson is narrowed to (PATCH /api/lessons/:id). */
export type LessonEdit = Partial<Pick<Lesson, 'title' | 'rule' | 'appliesWhen' | 'scope'>> & { triggers?: LessonTriggers; status?: 'approved' | 'rejected' | 'revoked' | 'proposed'; projectKey?: string };

/** Fired when the API wants a sign-in (a token is configured and the session is missing or expired). */
export const SIGN_IN_EVENT = 'fg:sign-in';

/** What to show for a failure: an Error's message, or the thrown value itself. */
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** An error the API answered with; anything else thrown by a request is the API not answering at all. */
export class ApiError extends Error {
  readonly status: number;
  /** The refusal's JSON body, or null: some carry more than the message (a rollback's 409 names what blocks it). */
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown = null) { super(message); this.status = status; this.body = body; }
}
/** The API is down or restarting (no answer, or a 5xx), as opposed to answering a request it refuses. */
export const isOutage = (e: unknown) => !(e instanceof ApiError) || e.status >= 500;

/** The server's own explanation ("cannot narrow…", validation errors) instead of a bare status code. */
async function apiError(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => null);
  const e = body?.error;
  const text = typeof e === 'string' ? e
    : e?.fieldErrors ? Object.entries(e.fieldErrors as Record<string, string[]>).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') || res.statusText
    : `${res.status} ${res.statusText}`;
  return new ApiError(res.status, text, body);
}

/**
 * A write that could not reach the API at all (it is restarting, or the network dropped) is tried again after each of
 * these waits; one the server answered, even with an error, never is. Writes that must not happen twice (uploads,
 * imports, deletes, cleanup, a cloud sync) pass retry: false: the first try may have reached the server. The app shell shows NETWORK_EVENT as a banner.
 */
export const WRITE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
export const NETWORK_EVENT = 'fg:network';
/** retrying: attempt `attempt` of `of` failed, trying again; ok: it got through after retrying; failed: gave up. */
export type NetworkState = { state: 'retrying'; attempt: number; of: number } | { state: 'ok' } | { state: 'failed' };
const announce = (detail: NetworkState) => window.dispatchEvent(new CustomEvent<NetworkState>(NETWORK_EVENT, { detail }));
const UNREACHABLE = 'Could not reach the Feedback Graph API (it may be restarting)';

async function send(path: string, init: RequestInit, o: { write: boolean; retry: boolean }): Promise<Response> {
  const retry = o.write && o.retry;
  const delays = retry ? WRITE_RETRY_DELAYS_MS : [];
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(path, init);
      if (attempt > 0) announce({ state: 'ok' });
      return res;
    } catch (err) {
      // fetch rejects only when no answer came back (a TypeError); anything else is a bug worth seeing as it is.
      if (!(err instanceof TypeError)) throw err;
      if (attempt >= delays.length) {
        if (retry) announce({ state: 'failed' });
        throw new Error(o.write ? `${UNREACHABLE}; this change was not saved. Try again in a moment.` : `${UNREACHABLE}.`, { cause: err });
      }
      announce({ state: 'retrying', attempt: attempt + 1, of: delays.length });
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

async function request<T = void>(path: string, o: { method?: string; body?: unknown; retry?: boolean } = {}): Promise<T> {
  const write = !!o.method && o.method !== 'GET';
  const res = await send(path, {
    method: o.method ?? 'GET',
    // Writes are always JSON: the API refuses other content types to block form-based cross-site posts.
    headers: write ? { 'content-type': 'application/json' } : undefined,
    body: write && o.body !== undefined ? JSON.stringify(o.body) : undefined,
  }, { write, retry: o.retry !== false });
  if (res.status === 401) window.dispatchEvent(new Event(SIGN_IN_EVENT));
  if (!res.ok) throw await apiError(res);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** A GET of one page of a list: the rows, and where the next page starts (the x-next-offset header), or null. */
async function requestPage<T>(path: string): Promise<{ items: T[]; next: number | null }> {
  const res = await send(path, { method: 'GET' }, { write: false, retry: true });
  if (res.status === 401) window.dispatchEvent(new Event(SIGN_IN_EVENT));
  if (!res.ok) throw await apiError(res);
  const next = res.headers.get('x-next-offset');
  return { items: (await res.json()) as T[], next: next === null ? null : Number(next) };
}

/** A GET of one page of a list paged by cursor: the rows, and the cursor of the next page (`header`), or null. */
async function requestCursorPage<T>(path: string, header = 'x-next-cursor'): Promise<{ items: T[]; next: string | null }> {
  const res = await send(path, { method: 'GET' }, { write: false, retry: true });
  if (res.status === 401) window.dispatchEvent(new Event(SIGN_IN_EVENT));
  if (!res.ok) throw await apiError(res);
  return { items: (await res.json()) as T[], next: res.headers.get(header) };
}

const enc = encodeURIComponent;
const qs = (o: Record<string, string | undefined>) => {
  const q = new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => !!e[1]));
  return q.size ? `?${q}` : '';
};

/** The query parameter that asks GET /api/activity for labelled runs' entries as well as the owner's. */
export const ACTIVITY_WITH_RUNS = 'runs';

/** Inbox items per page. */
export const CANDIDATE_PAGE = 200;

export const api = {
  session: () => request<{ authRequired: boolean; authenticated: boolean; ownerSession: boolean; ownerSetupRequired?: boolean; ownerWrites?: boolean }>('/api/session'),
  signIn: (token: string) => request('/api/session', { method: 'POST', body: { token } }),
  signOut: () => request('/api/session', { method: 'DELETE', body: {} }),
  status: () => request<SystemStatus>('/api/status'),
  pipeline: (project?: string) => request<PipelineStatus>(`/api/pipeline${qs({ project })}`),

  /** One page of the Inbox (CANDIDATE_PAGE items from `offset`), and where the next starts. */
  candidates: (status: CandidateStatus, project?: string, offset = 0, filters: { pr?: string; author?: string } = {}) =>
    requestPage<Candidate>(`/api/candidates${qs({ status, ...filters, limit: String(CANDIDATE_PAGE), project, offset: offset ? String(offset) : undefined })}`),
  candidate: (id: string) => request<CandidateDetail>(`/api/candidates/${enc(id)}`),
  undoDecision: (id: string, decidedAt: string) => request<void>(`/api/candidates/${encodeURIComponent(id)}/undo`, { method: 'POST', body: { decidedAt } }),
  decide: (id: string, status: 'confirmed' | 'rejected', note?: string) =>
    request(`/api/candidates/${enc(id)}/decision`, { method: 'POST', body: note ? { status, note } : { status } }),
  stats: () => request<StatsRow[]>('/api/stats'),

  lessons: (status: LessonStatus, o: { project?: string; flag?: LessonCheckName; source?: LessonFrom; pr?: string; author?: string } = {}) =>
    request<Lesson[]>(`/api/lessons${qs({ status, project: o.project, flag: o.flag, source: o.source, pr: o.pr, author: o.author })}`),
  /** Many decisions in one call (owner-only); each lesson is recorded as decided on its own. */
  decideLessons: (items: { id: string; status: 'approved' | 'rejected'; note?: string }[]) =>
    request<{ results: { id: string; ok: boolean; status?: string; error?: string }[] }>('/api/lessons/decisions', { method: 'POST', body: { items } }),
  lesson: (id: string) => request<LessonDetail>(`/api/lessons/${enc(id)}`),
  /** Of the post-mortem's lessons decided in the last 30 and 90 days: approved as written, after an edit, rejected. */
  lessonQuality: (project?: string) => request<LessonQualityReport>(`/api/lessons/quality${qs({ project })}`),
  updateLesson: (id: string, patch: LessonEdit) => request(`/api/lessons/${enc(id)}`, { method: 'PATCH', body: patch }),
  /** File the lesson's rule as a project fact you wrote (no scan replaces it); the lesson is rejected, noted "converted to a fact". */
  lessonToFact: (id: string, body: { kind: FactKind; relevance: number }) => request<StoredFact>(`/api/lessons/${enc(id)}/to-fact`, { method: 'POST', body }),
  retryPostmortem: (feedbackId: string) => request(`/api/feedback/${enc(feedbackId)}/retry`, { method: 'POST', body: {} }),
  /** Give the turns the classifier gave up on another go (owner-only). */
  requeueTurns: () => request<{ requeued: number }>('/api/turns/requeue', { method: 'POST', body: {} }),

  projects: () => request<ProjectSummary[]>('/api/projects'),
  /** Search returns scored hits, listing returns facts; both come back as plain facts. */
  facts: async (key: string, o: { q?: string; kind?: FactKind }) => {
    const rows = await request<(StoredFact | FactHit)[]>(`/api/projects/${enc(key)}/facts${qs(o.q ? { q: o.q } : { kind: o.kind })}`);
    return rows.map((r) => ('fact' in r ? r.fact : r));
  },
  links: (key: string) => request<ProjectLink[]>(`/api/projects/${enc(key)}/links`),
  setLink: (body: { a: string; b: string; status?: LinkStatus; relation?: LinkRelation; note?: string }) => request<ProjectLink>('/api/links', { method: 'PUT', body }),
  deleteLink: (id: string) => request(`/api/links/${enc(id)}`, { method: 'DELETE', body: {}, retry: false }),
  pinProject: (key: string, pinned: boolean) => request(`/api/projects/${enc(key)}/pin`, { method: 'PUT', body: { pinned } }),
  setFactRelevance: (key: string, id: string, relevance: number) =>
    request(`/api/projects/${enc(key)}/facts/${enc(id)}/relevance`, { method: 'PATCH', body: { relevance } }),
  scan: (key: string, provider?: string) => request<ScanJob & { blocked?: boolean; warning?: string }>(`/api/projects/${enc(key)}/scan`, { method: 'POST', body: provider ? { provider } : {} }),
  cancelScan: (key: string, id: string) => request(`/api/projects/${enc(key)}/scan/${enc(id)}/cancel`, { method: 'POST', body: {}, retry: false }),
  deleteProject: (key: string) => request(`/api/projects/${enc(key)}`, { method: 'DELETE', body: { confirm: key }, retry: false }),
  exportUrl: (key?: string) => `/api/export${qs({ project: key })}`,
  importBundle: (bundle: unknown, keepApproved: boolean) => request<ImportResult>(`/api/import${qs({ keepApproved: keepApproved ? '1' : undefined })}`, { method: 'POST', body: bundle, retry: false }),

  graph: (key: string) => request<EvidenceGraph>(`/api/graph${qs({ project: key })}`),
  patterns: (key?: string) => request<PatternReport>(`/api/patterns${qs({ project: key })}`),
  /**
   * run: one labelled run's entries. withRuns: ask for labelled runs' entries too (ACTIVITY_WITH_RUNS), for an API
   * whose default feed leaves them out; the Activity page also hides them itself unless asked.
   */
  activity: (o: { project?: string; kind?: ActivityKind | LoopActivityKind; target?: string; run?: string; limit?: number; withRuns?: boolean }) =>
    request<Activity[]>(`/api/activity${qs({ target: o.target, project: o.project, kind: o.kind, run: o.run, limit: String(o.limit ?? 100), [ACTIVITY_WITH_RUNS]: o.withRuns ? '1' : undefined })}`),
  /** One activity entry with all its details (a list row with detailsOmitted has none). */
  activityEntry: (id: string) => request<Activity>(`/api/activity/${enc(id)}`),

  codeMap: (key: string, limit = 200, includeTests = false) =>
    request<CodeMapReport>(`/api/projects/${enc(key)}/codemap/hotspots${qs({ limit: String(limit), tests: includeTests ? '1' : undefined })}`),
  rebuildCodeMap: (key: string) => request<{ queued: boolean }>(`/api/projects/${enc(key)}/codemap/rebuild`, { method: 'POST', body: {}, retry: false }),
  codeGraph: (key: string, includeTests = false) => request<MapGraph & { meta?: CodeMapMeta | null; capped?: MapCapped }>(`/api/projects/${enc(key)}/codemap/graph${qs({ tests: includeTests ? '1' : undefined })}`),
  codeModule: (key: string, path: string) => request<ModuleContext>(`/api/projects/${enc(key)}/codemap/module${qs({ path })}`),
  /** missesOnly: only the files a confirmed miss touched ("where agents struggle"). */
  topHotspots: (project?: string, limit = 10, includeTests = false, missesOnly = false) =>
    request<ProjectHotspot[]>(`/api/codemap/hotspots${qs({ project, limit: String(limit), tests: includeTests ? '1' : undefined, misses: missesOnly ? '1' : undefined })}`),

  /** A page of a project's documents, newest first (the API's default size, or `limit`), and where the next starts. */
  docs: (key: string, o: { cursor?: string; limit?: number } = {}) =>
    requestCursorPage<DocSummary>(`/api/projects/${enc(key)}/docs${qs({ cursor: o.cursor, limit: o.limit ? String(o.limit) : undefined })}`),
  // Uploads and imports are not retried: a lost answer can mean it was stored, and a retry would store it twice.
  uploadDoc: (key: string, doc: { title: string; name: string } & ({ text: string } | { image: { mediaType: string; data: string } })) =>
    request<{ id: string; chunks: number; pending?: true }>(`/api/projects/${enc(key)}/docs`, { method: 'POST', body: doc, retry: false }),
  projectSettings: () => request<ProjectSettings>('/api/settings/projects'),
  saveProjectSelection: (tracked: string[]) => request<ProjectSettings>('/api/settings/projects', { method: 'PUT', body: { tracked } }),
  saveProjectRoots: (roots: string[]) => request<ProjectSettings>('/api/settings/roots', { method: 'PUT', body: { roots } }),
  cleanupUnselected: () => request<{ removed: string[]; nodesRemoved: number }>('/api/settings/cleanup', { method: 'POST', body: { confirm: CLEANUP_CONFIRM }, retry: false }),

  cloud: () => request<CloudInfo>('/api/cloud'),
  cloudLocalOnly: (projects: string[]) => request<{ projects: string[] }>('/api/cloud/local-only', { method: 'PUT', body: { projects } }),
  syncCloud: () => request<CloudSyncResult>('/api/cloud/sync', { method: 'POST', body: {}, retry: false }),

  /** A failed reading, queued again (no re-upload): after DOCS_LLM changed to a model with vision, say. */
  /** One document by id, with its embed status (DocSummary.embed); null when there is none (any more). */
  doc: async (id: string): Promise<DocSummary | null> => {
    const res = await send(`/api/docs/${enc(id)}`, { method: 'GET' }, { write: false, retry: true });
    if (res.status === 401) window.dispatchEvent(new Event(SIGN_IN_EVENT));
    if (res.status === 404) return null;
    if (!res.ok) throw await apiError(res);
    return (await res.json()) as DocSummary;
  },
  rereadDoc: (id: string) => request(`/api/docs/${enc(id)}/reread`, { method: 'POST', body: {} }),
  deleteDoc: (id: string) => request(`/api/docs/${enc(id)}`, { method: 'DELETE', body: {}, retry: false }),

  sessions: (o: { project?: string; state?: SessionState; cursor?: string }) =>
    request<SessionPage>(`/api/sessions${qs({ project: o.project, state: o.state, cursor: o.cursor })}`),
  sessionDetail: (id: string) => request<SessionDetail>(`/api/sessions/${enc(id)}`),
  /** Rebuild a session's summary from its first turn (owner-only). */
  resummarize: (id: string) => request<{ queued: boolean }>(`/api/sessions/${enc(id)}/resummarize`, { method: 'POST', body: {} }),

  // Ask: conversations about one project. Writes spend the owner's model subscription, so a send or retry is never
  // repeated on its own: a lost answer may mean the question was queued.
  chats: (project?: string) => request<ChatConversation[]>(`/api/chats${qs({ project })}`),
  chat: (id: string) => request<ChatThread>(`/api/chats/${enc(id)}`),
  createChat: (body: { project: string; provider?: ChatProvider | null; title?: string }) =>
    request<ChatConversation>('/api/chats', { method: 'POST', body, retry: false }),
  sendChat: (id: string, text: string) => request<ChatThread>(`/api/chats/${enc(id)}/messages`, { method: 'POST', body: { text }, retry: false }),
  retryChatTurn: (id: string, turnId: string) => request<ChatThread>(`/api/chats/${enc(id)}/turns/${enc(turnId)}/retry`, { method: 'POST', body: {}, retry: false }),
  updateChat: (id: string, patch: { provider?: ChatProvider | null; title?: string }) => request<ChatConversation>(`/api/chats/${enc(id)}`, { method: 'PATCH', body: patch }),
  deleteChat: (id: string) => request(`/api/chats/${enc(id)}`, { method: 'DELETE', body: {}, retry: false }),
};

/** One service on Settings > Integrations (GET /api/settings/integrations). Never carries a token. */
export type ServiceView = {
  connection: Connection;
  envSet: boolean;
  envVar: string;
  savedInApp: boolean;
  account: string | null;
  checkedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  errorKind: 'auth' | 'rate_limit' | 'not_found' | 'network' | 'other' | null;
  rateLimitedUntil: string | null;
};

export type ProjectIntegrations = {
  key: string;
  github: {
    author?: string | null; repo: string | null; from: 'remote' | 'GITHUB_REPOS' | null; enabled: boolean; lastSyncAt: string | null; items: number; error: string | null;
    /** PRs a sync stopped by its cap has not read yet (updated after `since`, before `until`): read on the next syncs. */
    backlog: { since: string; until: string } | null;
  };
  linear: { teamId: string | null; teamName: string | null; lastSyncAt: string | null; items: number; error: string | null };
};

/** A skip rule with how many comments it kept from the classifier (null: not counted). */
export type SkipRuleView = { name: string; description: string; skipped: number | null; fromInbox: number | null };
export type IntegrationsView = {
  canSave: boolean; syncMinutes: number; github: ServiceView; linear: ServiceView; projects: ProjectIntegrations[];
  rules: SkipRuleView[];
  /** The oldest skip counted; null when nothing has been skipped. */
  skippedSince: string | null;
};
export type IntegrationKind = 'github' | 'linear';
export type LinearTeam = { id: string; key: string; name: string };

export const integrationsApi = {
  get: () => request<IntegrationsView>('/api/settings/integrations'),
  connect: (kind: IntegrationKind, token: string) => request<IntegrationsView>(`/api/settings/integrations/${kind}`, { method: 'PUT', body: { token } }),
  test: (kind: IntegrationKind) => request<{ ok: boolean; account: string | null; error: string | null; view: IntegrationsView }>(`/api/settings/integrations/${kind}/test`, { method: 'POST', body: {} }),
  disconnect: (kind: IntegrationKind) => request<IntegrationsView>(`/api/settings/integrations/${kind}`, { method: 'DELETE', body: {} }),
  linearTeams: () => request<LinearTeam[]>('/api/settings/integrations/linear/teams'),
  setProject: (key: string, patch: { githubAuthor?: string | null; github?: boolean; linearTeamId?: string | null; linearTeamName?: string | null }) =>
    request<IntegrationsView>(`/api/settings/integrations/projects/${enc(key)}`, { method: 'PUT', body: patch }),
};

/** GET /api/sessions: one page, newest first; `next` asks for the following one. */
export type SessionPage = { sessions: SessionListItem[]; next: string | null };

// ── Learning loop (0.8.0): the Decision record and the loop's state. Mirrors core's Decision types (core types.ts);
// docs/learning-loop-api.md is the contract the API implements. Lookups keyed by these enums fall back at runtime
// (loop.ts), because a newer server may send a value this build does not know.

export const DECISION_TYPES = ['link_misses', 'merge_duplicates', 'rank_weight', 'retire_lesson', 'reject_lesson', 'approve_lesson', 'reword_lesson', 'narrow_scope', 'record_fact', 'triage_inbox', 'tune_threshold', 'resolve_conflict', 'remove_source'] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];
export const DECISION_STATUSES = ['observed', 'proposed', 'applying', 'applied', 'rejected', 'rolled_back', 'overridden', 'expired'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];
export type DecisionTier = 'H' | 'A' | 'P';
/** A decision's own mode: recorded only, waiting for you, or applied by the loop. */
export type DecisionMode = 'observe' | 'propose' | 'auto';
export const LOOP_MODES = ['off', 'observe', 'propose', 'auto'] as const;
export type LoopMode = (typeof LOOP_MODES)[number];
export type DecisionTargetKind = 'lesson' | 'fact' | 'miss' | 'candidate' | 'project' | 'claim' | 'conflict';
export type DecisionTarget = { kind: DecisionTargetKind; id: string; role: 'primary' | 'keeper' | 'merged' | 'created' };
/** A target's redacted fields at one moment, and the sha256 of its canonical fields. */
export type TargetSnapshot = { kind: DecisionTargetKind; id: string; fields: Record<string, unknown>; fingerprint: string };
export type EvidenceKind = 'activity' | 'miss' | 'lesson' | 'fact' | 'check' | 'session' | 'candidate' | 'claim' | 'conflict';
export type EvidenceRef = { kind: EvidenceKind; id: string; role: string; weight: number; observedAt: string };
export type DecisionConfidence = { p: number; lower: number; n: number; band: number };
export type DecisionRollback = { at: string; by: string; reason: RollbackReason | null; note: string | null; cascade: string[] };
export type Decision = {
  id: string;
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
  /** A provider spec, or 'deterministic'. */
  model: string | null;
  policyVersion: number;
  status: DecisionStatus;
  dependsOn: string[];
  supersededBy?: string;
  createdAt: string;
  appliedAt?: string;
  decidedAt?: string;
  /** `loop:<v>`, `you` or `operator:<name>`. */
  decidedBy?: string;
  rollback?: DecisionRollback;
  ratifiedAt?: string;
  ratifiedBy?: string;
  syncHoldUntil?: string;
  /** loop, or owner: a change you made through a decision (a conflict resolved). Absent on older answers: the loop's. */
  author?: 'loop' | 'owner';
};
export const NOTE_REASONS = ['wrong_evidence', 'too_broad', 'wording', 'not_now', 'other'] as const;
export type RollbackReason = (typeof NOTE_REASONS)[number];
export type DecisionNote = { id: string; decisionId: string; ts: string; by: string; text: string; verdict?: 'agree' | 'disagree' | null; reason?: RollbackReason };

/** An evidence pointer resolved to something to show and link: `missing` when it no longer exists. */
export type ResolvedEvidence = EvidenceRef & { label: string; projectKey?: string | null; path?: string | null; activity?: Activity | null; missing?: boolean };
/** Another decision, as a line in "depends on / depended on by" and in a rollback cascade. */
export type DecisionSummary = Pick<Decision, 'id' | 'type' | 'status' | 'createdAt' | 'projectKey'> & { label: string };
/** GET /api/decisions/:id. `current`: the targets now (empty for a target that is gone). */
export type DecisionDetail = { decision: Decision; current: TargetSnapshot[]; evidence: ResolvedEvidence[]; dependsOn: DecisionSummary[]; dependents: DecisionSummary[]; notes: DecisionNote[] };
export type DecisionFilter = {
  status?: DecisionStatus; type?: DecisionType; project?: string; mode?: DecisionMode; band?: number; target?: string;
  since?: string; until?: string; q?: string; limit?: number; offset?: number;
  /** x-next-after of the page before: the next page by keyset, as fast however deep (instead of offset). */
  after?: string;
};
/** POST …/rollback with cascade 'preview': what else would be undone, and what blocks it. */
export type RollbackPreview = { cascade: DecisionSummary[]; blocked: { id: string; reason: string }[] };
export type DecisionAction = 'approve' | 'reject' | 'keep' | 'rollback';
export type DecisionActionBody = { expect: DecisionStatus; note?: string; reason?: RollbackReason; cascade?: 'preview' | 'apply'; restoreAnyway?: boolean };

export type CalibrationBand = { band: number; alpha: number; beta: number; n: number; p: number; lower: number };
export type LoopTypeState = {
  type: DecisionType;
  tier: DecisionTier;
  /** The per-type override; null follows the global mode. */
  mode: LoopMode | null;
  effectiveMode: LoopMode;
  tau: number;
  tauDefault: number;
  calibration: { p: number; lower: number; n: number };
  bands: CalibrationBand[];
  rollbackRate: { rolledBack: number; of: number };
  breaker: { tripped: boolean; at: string | null; reason: string | null };
};
export const ROUND_PHASES = ['reading', 'scoring', 'writing', 'done', 'aborted'] as const;
export type RoundPhase = (typeof ROUND_PHASES)[number];
export type LoopRound = {
  id: string; startedAt: string; finishedAt: string | null; phase: RoundPhase;
  signalsIngested: number; targetsScored: number; targetsTotal: number | null;
  decisions: { observed: number; proposed: number; applied: number; skipped: number };
  skipped: { reason: string; count: number }[];
  llmCalls: number; error: string | null;
};
export type HoldoutArm = { lessons: number; repeatRate: number; helpfulRate: number; ciLow: number; ciHigh: number };
export type HoldoutReport = { share: number; treated: HoldoutArm; control: HoldoutArm };
/** GET /api/loop. */
export type LoopState = {
  mode: LoopMode;
  /** What runs after LOOP_DISABLED, a pause and the tokenless cap. */
  effectiveMode: LoopMode;
  disabled: boolean;
  paused: { at: string; by: string } | null;
  /** Why the mode is capped below `mode`, if it is. */
  capped: 'tokenless' | 'disabled' | 'paused' | null;
  policyVersion: number;
  types: LoopTypeState[];
  budget: { llmCallsToday: number; llmCallsPerDay: number; autoToday: number; autoPerDay: number; autoPerProject: number };
  counts: { proposed: number; week: { observed: number; proposed: number; applied: number; rolledBack: number } };
  rollbackRate: { rolledBack: number; of: number };
  round: LoopRound | null;
  holdout: HoldoutReport | null;
};
/** k of n, with the 95% Wilson interval: rate 0 and [0, 1] when n is 0. */
export type Rate = { k: number; n: number; rate: number; ciLow: number; ciHigh: number };
/** GET /api/loop/metrics: the learning loop's value over the last `weeks` ISO weeks from `since`. */
export type LoopMetrics = {
  since: string; weeks: number;
  repeatRate: Rate & { weekly: { week: string; feedback: number; repeats: number }[] };
  checksCaughtGap: Rate;
  gapsFixedPerServed: Rate;
  notApplicableShare: Rate;
  proposalsPerWeek: { week: string; proposals: number }[];
  rollbackRate: { type: DecisionType; rolledBack: number; of: number; rate: Rate }[];
};
export const LOOP_EVENT_KINDS = ['decision_made', 'decision_applied', 'decision_rolled_back', 'decision_noted', 'loop_settings_changed', 'loop_paused', 'loop_round'] as const;
export type LoopEventKind = (typeof LOOP_EVENT_KINDS)[number];
/** The Activity kinds the loop writes (every event kind but the round record). */
export type LoopActivityKind = Exclude<LoopEventKind, 'loop_round'>;
export const LOOP_ACTIVITY_KINDS = LOOP_EVENT_KINDS.filter((k): k is LoopActivityKind => k !== 'loop_round');
export type LoopEvent = {
  seq: string; ts: string; kind: LoopEventKind; actor: string; subject: string;
  decisionId: string | null; decisionType: DecisionType | null; status: DecisionStatus | null; projectKey: string | null;
};
/** GET /api/loop/events. `gap`: events after `after` were dropped (it fell behind retention); reload the state. */
export type LoopEventPage = { events: LoopEvent[]; next: string; gap: boolean };
export type LoopSettingsPatch = { mode?: LoopMode; types?: Partial<Record<DecisionType, { mode?: LoopMode | null; tau?: number | null }>> };
export type LessonSignals = {
  served: number; lastServed: string | null; sessions: number;
  addressed: number; notAddressed: number; notApplicable: number; cannotTell: number;
  gapsFixed: number; repeatServed: number; repeatUnserved: number; ownerPushbackAfter: number;
  ownerEdits: number; ownerRejects: number; holdout: boolean;
};
export const TRACK_KINDS = ['served', 'judged', 'gap_fixed', 'repeat', 'owner', 'decision'] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];
export type TrackEntry = { ts: string; kind: TrackKind; label: string; sessionId: string | null; decisionId: string | null };
/** GET /api/loop/lessons/:id/track: why the loop believes what it believes about one lesson. */
export type TrackRecord = { lessonId: string; title: string; projectKey: string | null; signals: LessonSignals; timeline: TrackEntry[] };

/** Fired after a decision changes here, so the sidebar's proposals badge counts again. */
export const LOOP_CHANGED_EVENT = 'fg:loop-changed';

/** Rows per page of GET /api/decisions. */
export const DECISION_PAGE = 100;

const filterQuery = (f: DecisionFilter) => qs({
  status: f.status, type: f.type, project: f.project, mode: f.mode, band: f.band === undefined ? undefined : String(f.band), target: f.target,
  since: f.since, until: f.until, q: f.q, limit: String(f.limit ?? DECISION_PAGE), offset: f.offset ? String(f.offset) : undefined, after: f.after,
});

/**
 * One call of `f` at a time: a call made while one runs waits for it and then runs once for every caller that came
 * meanwhile, so a slow answer never has several more stacked behind it (the Learning loop page reloads its state on a
 * timer and on every event, the Dashboard card and the menu badge on theirs), and no caller gets an answer older than
 * its call.
 */
export function coalesced<T>(f: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  let next: Promise<T> | null = null;
  const call = (): Promise<T> => {
    // finally clears it before its callers see the answer: whoever calls then starts the next one.
    if (!running) return (running = f().finally(() => { running = null; }));
    next ??= running.catch(() => undefined).then(() => { next = null; return call(); });
    return next;
  };
  return call;
}

export const loopApi = {
  decisions: (f: DecisionFilter = {}) => requestPage<Decision>(`/api/decisions${filterQuery(f)}`),
  /** Like decisions, paged by keyset: next is the `after` of the next page (x-next-after), or null. */
  decisionsAfter: (f: Omit<DecisionFilter, 'offset'> = {}) => requestCursorPage<Decision>(`/api/decisions${filterQuery(f)}`, 'x-next-after'),
  decision: (id: string) => request<DecisionDetail>(`/api/decisions/${enc(id)}`),
  /**
   * Approve, reject, keep or roll back; `expect` makes a repeat answer 409, so these are retried like other decisions,
   * except an applied rollback (it may undo a cascade). A rollback preview answers RollbackPreview, the rest the decision.
   */
  act: (id: string, action: DecisionAction, body: DecisionActionBody) =>
    request<RollbackPreview | Decision>(`/api/decisions/${enc(id)}/${action}`, { method: 'POST', body, retry: action !== 'rollback' || body.cascade === 'preview' }),
  addNote: (id: string, note: { text: string; verdict?: 'agree' | 'disagree' | null; reason?: RollbackReason }) =>
    request<DecisionNote>(`/api/decisions/${enc(id)}/notes`, { method: 'POST', body: note, retry: false }),
  state: coalesced(() => request<LoopState>('/api/loop')),
  saveSettings: (patch: LoopSettingsPatch) => request<LoopState>('/api/loop/settings', { method: 'PUT', body: patch }),
  pause: () => request<LoopState>('/api/loop/pause', { method: 'POST', body: {} }),
  resume: () => request<LoopState>('/api/loop/resume', { method: 'POST', body: {} }),
  events: (after?: string) => request<LoopEventPage>(`/api/loop/events${qs({ after })}`),
  track: (lessonId: string) => request<TrackRecord>(`/api/loop/lessons/${enc(lessonId)}/track`),
  metrics: () => request<LoopMetrics>('/api/loop/metrics'),
};

// ── Knowledge intake (0.9.0; the Intake page) ───────────────────────────
// Sources are step 4's routes (/api/intake/sources); claims, questions and people are intakeReview.ts's.

/** One source as GET /api/intake/sources lists it: the Doc, its intake details (null while it is being stored), and a
 * background embedding's state while there is one. */
export type IntakeSource = DocSummary & { intake: IntakeMeta | null };
/** GET /api/intake/sources/:id: the source, its text (null until stored), utterances, and where each claim drawn from it is. */
export type IntakeSourceDetail = IntakeSource & {
  text: string | null; utterances: Utterance[]; claims: { id: string; type: ClaimType; status: ClaimStatus; span: ClaimSpan | null }[];
};
/** A claim as listed: the open conflicts naming it, and the other side of each. */
export type ListedClaim = Claim & { conflicts: { id: string; with: IntakeRef }[] };
export type ClaimDetail = { claim: ListedClaim; fingerprint: string; speaker: Person | null; source: IntakeMeta | null };
/** PATCH /api/claims/:id: only the keys given change. asFact false keeps it as an opinion; kind, relevance and projectKey say how its fact is filed. */
export type ClaimEdit = {
  status?: 'proposed' | 'accepted' | 'rejected'; statement?: string; type?: ClaimType; scope?: ClaimScope; about?: string; asFact?: boolean;
  kind?: FactKind; relevance?: number; projectKey?: string; expect?: string;
};
export type QuestionDetail = { question: Question; askedBy: Person | null; assignee: Person | null; answer: Claim | null; source: IntakeMeta | null };
export type BulkResults = { results: { id: string; ok: boolean; status?: string; factId?: string | null; error?: string }[] };

/** One side of a conflict as GET /api/conflicts shows it: what it says, the quote, who said it and when, and whether agents see it now. */
export type ConflictSideView = IntakeRef & {
  fingerprint: string; assertedAt: string | null; text: string; quote: string | null; type: string | null; status: string | null;
  speaker: { id: string; displayName: string; isOwner: boolean } | null; origin: string | null; path: string | null; docId: string | null;
  source: { docId: string; kind: IntakeMeta['kind']; occurredAt: string | null; origin: string | null } | null; agentsSee: boolean; gone: boolean;
};
export type ConflictView = Conflict & { fingerprint: string; sides: { a: ConflictSideView; b: ConflictSideView } };
/** POST /api/conflicts/:id/resolve. */
export type ConflictResolveBody = {
  choice: ConflictChoice; note?: string; reason?: ConflictDismissReason; statement?: string; projectKey?: string; factKind?: FactKind; expect?: string;
};

/** Claims, questions and people per page. */
export const INTAKE_PAGE = 100;

/** What POST /api/intake takes. name: the file it came from (sending it again replaces it); private: never synced. */
export type IntakeUpload = {
  projectKey: string; kind: IntakeKind; title: string; text: string; name?: string; occurredAt?: string | null;
  participants?: string[]; origin?: string | null; private?: boolean;
};

export const intakeApi = {
  sources: (project?: string) => request<IntakeSource[]>(`/api/intake/sources${qs({ project })}`),
  source: (id: string) => request<IntakeSourceDetail>(`/api/intake/sources/${enc(id)}`),
  rereadSource: (id: string) => request(`/api/intake/sources/${enc(id)}/reread`, { method: 'POST', body: {}, retry: false }),
  /** POST /api/intake: a pasted or uploaded transcript, notes or doc, read into claims in the background. 202: still being stored. */
  addSource: (b: IntakeUpload) => request<{ id: string; chunks: number; pending?: true }>('/api/intake', { method: 'POST', body: b, retry: false }),
  /** keep facts: the text, chunks, unaccepted claims and questions go; none: its facts are closed too. */
  deleteSource: (id: string, keep: 'facts' | 'none') => request(`/api/intake/sources/${enc(id)}${qs({ keep })}`, { method: 'DELETE', body: {}, retry: false }),

  claims: (f: { status: ClaimStatus; type?: ClaimType; project?: string; person?: string; source?: string; offset?: number }) =>
    requestPage<ListedClaim>(`/api/claims${qs({ status: f.status, type: f.type, project: f.project, person: f.person, source: f.source, limit: String(INTAKE_PAGE), offset: f.offset ? String(f.offset) : undefined })}`),
  claim: (id: string) => request<ClaimDetail>(`/api/claims/${enc(id)}`),
  editClaim: (id: string, edit: ClaimEdit) => request<{ claim: Claim; fact: StoredFact | null }>(`/api/claims/${enc(id)}`, { method: 'PATCH', body: edit }),
  /** Many claims, or every proposed claim of one source; each is decided on its own. */
  decideClaims: (body: { items: { id: string; status: 'accepted' | 'rejected' }[] } | { source: string; status: 'accepted' | 'rejected' }) =>
    request<BulkResults>('/api/claims/decisions', { method: 'POST', body }),

  questions: (f: { status: QuestionStatus; project?: string; source?: string; offset?: number }) =>
    requestPage<Question>(`/api/questions${qs({ status: f.status, project: f.project, source: f.source, limit: String(INTAKE_PAGE), offset: f.offset ? String(f.offset) : undefined })}`),
  question: (id: string) => request<QuestionDetail>(`/api/questions/${enc(id)}`),
  updateQuestion: (id: string, patch: { assignee?: string | null; status?: 'open' | 'dismissed' }) => request<Question>(`/api/questions/${enc(id)}`, { method: 'PATCH', body: patch }),
  answerQuestion: (id: string, body: { text: string; type: ClaimType; projectKey?: string }) =>
    request<{ question: Question; claim: Claim; fact: StoredFact | null }>(`/api/questions/${enc(id)}/answer`, { method: 'POST', body, retry: false }),

  conflicts: (f: { status: ConflictStatus; project?: string; offset?: number }) =>
    requestPage<ConflictView>(`/api/conflicts${qs({ status: f.status, project: f.project, limit: String(INTAKE_PAGE), offset: f.offset ? String(f.offset) : undefined })}`),
  conflict: (id: string) => request<ConflictView & { decision: Decision | null }>(`/api/conflicts/${enc(id)}`),
  /** Not retried: a second resolve after a lost answer would answer 409 for the first one's change. */
  resolveConflict: (id: string, body: ConflictResolveBody) => request<{ conflict: ConflictView; decision: Decision }>(`/api/conflicts/${enc(id)}/resolve`, { method: 'POST', body, retry: false }),
  people: (status?: PersonStatus) => request<Person[]>(`/api/people${qs({ status })}`),
  updatePerson: (id: string, patch: { displayName?: string; status?: 'proposed' | 'confirmed'; addAliases?: string[]; removeAliases?: string[] }) =>
    request<Person>(`/api/people/${enc(id)}`, { method: 'PATCH', body: patch }),
  mergePeople: (keepId: string, mergedId: string) => request<Person>('/api/people/merge', { method: 'POST', body: { keepId, mergedId }, retry: false }),
  forgetPerson: (id: string) => request<{ person: Person; claimsRemoved: number }>(`/api/people/${enc(id)}/forget`, { method: 'POST', body: { confirm: id }, retry: false }),
};
