import type { Activity, ActivityKind, Connection, ConnectionName, ExternalRef, FeedbackSource, CloudSyncResult, SyncCounts, SyncTrigger, Candidate, CodeMapMeta, Hotspot, MapGraph, ModuleContext, FolderCandidate, OutsideFolder, DocSummary, CandidateDetail, CandidateStatus, EvidenceGraph, FactHit, FactKind, Lesson, LessonDetail, LessonStatus, PatternReport, ProjectSummary, ScanJob, SessionDetail, SessionListItem, SessionState, StatsRow, StoredFact, SystemStatus } from '@fb/core';

export type { Connection, ConnectionName, ExternalRef, FeedbackSource, CloudSyncResult, SyncCounts, Activity, Candidate, CodeMapMeta, Hotspot, MapGraph, ModuleContext, DocSummary, CandidateDetail, CandidateStatus, EvidenceGraph, Lesson, LessonDetail, LessonStatus, PatternReport, ProjectSummary, ScanJob, SessionDetail, SessionListItem, SessionState, StatsRow, StoredFact, SystemStatus };

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
  /** Sessions outside every root, and the folders they ran in that could be added as roots. `folders`: unset from older APIs. */
  outsideRoots: { claudeSessions: number; codexSessions: number; folders?: OutsideFolder[] };
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
export type CodeMapReport = { meta: CodeMapMeta | null; hotspots: Hotspot[] };
/** GET /api/codemap/hotspots: hotspots across the selected projects. */
export type ProjectHotspot = Hotspot & { projectKey: string };

/** GET /api/cloud: the Cloud sync card on Settings. */
export type CloudInfo = {
  enabled: boolean;
  host: string | null;
  intervalMinutes: number | null;
  /** SYNC_SUGGESTIONS: lessons you have not approved are sent too (proposed ones as suggestions). Older APIs leave it out. */
  suggestions?: boolean;
  projects: string[];
  preview: { total: SyncCounts; projects: { key: string; counts: SyncCounts | null }[] } | null;
  previewError: string | null;
  last: { at: string; ok: boolean; trigger: SyncTrigger; error: string | null; sent: SyncCounts | null; projects: string[]; failed: string[] } | null;
  nextAt: string | null;
  neverSent: string;
};

/** POST /api/import: what an export bundle brought in. */
export type ImportResult = {
  lessons: { added: number; approved: number; proposed: number; existing: number; excluded: number; skipped: number };
  facts: { added: number; projects: string[]; skippedProjects: string[] };
  notImported: { misses: number; docs: number; codeFiles: number };
};

/** The phrase POST /api/settings/cleanup wants before it deletes anything. */
export const CLEANUP_CONFIRM = 'remove-unselected';

export type LessonEdit = Partial<Pick<Lesson, 'title' | 'rule' | 'appliesWhen' | 'scope'>> & { status?: 'approved' | 'rejected' | 'proposed' };

/** Fired when the API wants a sign-in (a token is configured and the session is missing or expired). */
export const SIGN_IN_EVENT = 'fg:sign-in';

/** The server's own explanation ("cannot narrow…", validation errors) instead of a bare status code. */
async function errorText(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const e = body?.error;
  if (typeof e === 'string') return e;
  if (e?.fieldErrors) return Object.entries(e.fieldErrors as Record<string, string[]>).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') || res.statusText;
  return `${res.status} ${res.statusText}`;
}

async function request<T = void>(path: string, o: { method?: string; body?: unknown } = {}): Promise<T> {
  const write = o.method && o.method !== 'GET';
  const res = await fetch(path, {
    method: o.method ?? 'GET',
    // Writes are always JSON: the API refuses other content types to block form-based cross-site posts.
    headers: write ? { 'content-type': 'application/json' } : undefined,
    body: write && o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  if (res.status === 401) window.dispatchEvent(new Event(SIGN_IN_EVENT));
  if (!res.ok) throw new Error(await errorText(res));
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const enc = encodeURIComponent;
const qs = (o: Record<string, string | undefined>) => {
  const q = new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => !!e[1]));
  return q.size ? `?${q}` : '';
};

export const api = {
  session: () => request<{ authRequired: boolean; authenticated: boolean }>('/api/session'),
  signIn: (token: string) => request('/api/session', { method: 'POST', body: { token } }),
  signOut: () => request('/api/session', { method: 'DELETE', body: {} }),
  status: () => request<SystemStatus>('/api/status'),

  candidates: (status: CandidateStatus, project?: string) => request<Candidate[]>(`/api/candidates${qs({ status, limit: '500', project })}`),
  candidate: (id: string) => request<CandidateDetail>(`/api/candidates/${enc(id)}`),
  decide: (id: string, status: 'confirmed' | 'rejected', note?: string) =>
    request(`/api/candidates/${enc(id)}/decision`, { method: 'POST', body: note ? { status, note } : { status } }),
  stats: () => request<StatsRow[]>('/api/stats'),

  lessons: (status: LessonStatus, project?: string) => request<Lesson[]>(`/api/lessons${qs({ status, project })}`),
  lesson: (id: string) => request<LessonDetail>(`/api/lessons/${enc(id)}`),
  updateLesson: (id: string, patch: LessonEdit) => request(`/api/lessons/${enc(id)}`, { method: 'PATCH', body: patch }),
  retryPostmortem: (feedbackId: string) => request(`/api/feedback/${enc(feedbackId)}/retry`, { method: 'POST', body: {} }),
  /** Give the turns the classifier gave up on another go (owner-only). */
  requeueTurns: () => request<{ requeued: number }>('/api/turns/requeue', { method: 'POST', body: {} }),

  projects: () => request<ProjectSummary[]>('/api/projects'),
  /** Search returns scored hits, listing returns facts; both come back as plain facts. */
  facts: async (key: string, o: { q?: string; kind?: FactKind }) => {
    const rows = await request<(StoredFact | FactHit)[]>(`/api/projects/${enc(key)}/facts${qs(o.q ? { q: o.q } : { kind: o.kind })}`);
    return rows.map((r) => ('fact' in r ? r.fact : r));
  },
  scan: (key: string, provider?: string) => request<ScanJob>(`/api/projects/${enc(key)}/scan`, { method: 'POST', body: provider ? { provider } : {} }),
  deleteProject: (key: string) => request(`/api/projects/${enc(key)}`, { method: 'DELETE', body: { confirm: key } }),
  exportUrl: (key?: string) => `/api/export${qs({ project: key })}`,
  importBundle: (bundle: unknown, keepApproved: boolean) => request<ImportResult>(`/api/import${qs({ keepApproved: keepApproved ? '1' : undefined })}`, { method: 'POST', body: bundle }),

  graph: (key: string) => request<EvidenceGraph>(`/api/graph${qs({ project: key })}`),
  patterns: (key?: string) => request<PatternReport>(`/api/patterns${qs({ project: key })}`),
  activity: (o: { project?: string; kind?: ActivityKind; target?: string; limit?: number }) =>
    request<Activity[]>(`/api/activity${qs({ target: o.target, project: o.project, kind: o.kind, limit: String(o.limit ?? 100) })}`),

  codeMap: (key: string, limit = 200, includeTests = false) =>
    request<CodeMapReport>(`/api/projects/${enc(key)}/codemap/hotspots${qs({ limit: String(limit), tests: includeTests ? '1' : undefined })}`),
  codeGraph: (key: string, includeTests = false) => request<MapGraph>(`/api/projects/${enc(key)}/codemap/graph${qs({ tests: includeTests ? '1' : undefined })}`),
  codeModule: (key: string, path: string) => request<ModuleContext>(`/api/projects/${enc(key)}/codemap/module${qs({ path })}`),
  topHotspots: (project?: string, limit = 10, includeTests = false) =>
    request<ProjectHotspot[]>(`/api/codemap/hotspots${qs({ project, limit: String(limit), tests: includeTests ? '1' : undefined })}`),

  docs: (key: string) => request<DocSummary[]>(`/api/projects/${enc(key)}/docs`),
  uploadDoc: (key: string, doc: { title: string; name: string; text: string }) =>
    request<{ id: string; chunks: number }>(`/api/projects/${enc(key)}/docs`, { method: 'POST', body: doc }),
  projectSettings: () => request<ProjectSettings>('/api/settings/projects'),
  saveProjectSelection: (tracked: string[]) => request<ProjectSettings>('/api/settings/projects', { method: 'PUT', body: { tracked } }),
  saveProjectRoots: (roots: string[]) => request<ProjectSettings>('/api/settings/roots', { method: 'PUT', body: { roots } }),
  cleanupUnselected: () => request<{ removed: string[]; nodesRemoved: number }>('/api/settings/cleanup', { method: 'POST', body: { confirm: CLEANUP_CONFIRM } }),

  cloud: () => request<CloudInfo>('/api/cloud'),
  syncCloud: () => request<CloudSyncResult>('/api/cloud/sync', { method: 'POST', body: {} }),

  deleteDoc: (id: string) => request(`/api/docs/${enc(id)}`, { method: 'DELETE', body: {} }),

  sessions: (o: { project?: string; state?: SessionState; cursor?: string }) =>
    request<SessionPage>(`/api/sessions${qs({ project: o.project, state: o.state, cursor: o.cursor })}`),
  sessionDetail: (id: string) => request<SessionDetail>(`/api/sessions/${enc(id)}`),
  /** Rebuild a session's summary from its first turn (owner-only). */
  resummarize: (id: string) => request<{ queued: boolean }>(`/api/sessions/${enc(id)}/resummarize`, { method: 'POST', body: {} }),
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
  github: { repo: string | null; from: 'remote' | 'GITHUB_REPOS' | null; enabled: boolean; lastSyncAt: string | null; items: number; error: string | null };
  linear: { teamId: string | null; teamName: string | null; lastSyncAt: string | null; items: number; error: string | null };
};

export type IntegrationsView = { canSave: boolean; syncMinutes: number; github: ServiceView; linear: ServiceView; projects: ProjectIntegrations[] };
export type IntegrationKind = 'github' | 'linear';
export type LinearTeam = { id: string; key: string; name: string };

export const integrationsApi = {
  get: () => request<IntegrationsView>('/api/settings/integrations'),
  connect: (kind: IntegrationKind, token: string) => request<IntegrationsView>(`/api/settings/integrations/${kind}`, { method: 'PUT', body: { token } }),
  test: (kind: IntegrationKind) => request<{ ok: boolean; account: string | null; error: string | null; view: IntegrationsView }>(`/api/settings/integrations/${kind}/test`, { method: 'POST', body: {} }),
  disconnect: (kind: IntegrationKind) => request<IntegrationsView>(`/api/settings/integrations/${kind}`, { method: 'DELETE', body: {} }),
  linearTeams: () => request<LinearTeam[]>('/api/settings/integrations/linear/teams'),
  setProject: (key: string, patch: { github?: boolean; linearTeamId?: string | null; linearTeamName?: string | null }) =>
    request<IntegrationsView>(`/api/settings/integrations/projects/${enc(key)}`, { method: 'PUT', body: patch }),
};

/** GET /api/sessions: one page, newest first; `next` asks for the following one. */
export type SessionPage = { sessions: SessionListItem[]; next: string | null };
