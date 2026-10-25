import { Hono, type Context, type Next } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { ACTIVITY_KINDS, EVERYDAY_FROM, chunkText, mapCapped, MAX_AUTO_MAP_FILES, MODEL_JOBS, cleanLessonPath, cmp, FACT_KINDS, redactSecrets, relevanceBand, selectionNote, type ActivityStore, type CodeGraphStore, type DocsStore, type FactsStore, type GraphStore, type InsightsStore, type ModelHealth, type ModelJob, type OllamaHealth, type PipelineStatus, type ProviderHealth, type KnowledgeStore, type Lesson, type LinksStore, IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, LINK_RELATIONS, LINK_STATUSES, linkPair, type PortabilityStore, type Project, type ProjectSelection, type RelevanceBy, type ProjectSummary, type ShownProjects, type StoreKind, type SystemStatus, type WorkerStatus } from '@fb/core';
import { chatRoutes, type ChatRouteDeps } from './chat.ts';
import { trackedProject, type ContextDeps } from './context.ts';
import { authenticated, needsAuth, SECURITY_HEADERS, sessionCookie, tokenMatches, type AuthOpts } from './auth.ts';
import { cloudRoutes, cloudStatus, type CloudDeps, type CloudState } from './cloud.ts';
import { createEventHub, type FgEvent } from './events.ts';
import { handleMcp } from './mcp.ts';
import { handleAdminMcp } from './adminMcp.ts';
import { openApiDocument } from './openapi.ts';
import { actingAsOperator, asActor, currentActor, hasOperatorToken, operatorName, OWNER_ROUTES, refusedVerb, runAs } from './operator.ts';
import { deleteProjects, settingsRoutes, type SettingsDeps } from './settings.ts';
import { importRoutes, type ImportDeps } from './import.ts';
import { sessionRoutes, type SessionsDeps } from './sessions.ts';
import { connectionsStatus, integrationRoutes, type IntegrationsDeps } from './integrations.ts';

export type { SettingsDeps } from './settings.ts';

export type ApiRepo = Pick<GraphStore, 'listCandidates' | 'candidateDetail' | 'decide' | 'stats'>;

const ListQuery = z.object({
  status: z.enum(['pending', 'confirmed', 'rejected']).optional(),
  project: z.string().min(1).optional(),
  source: z.enum(['claude', 'codex', 'github', 'linear']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const Decision = z.object({
  status: z.enum(['confirmed', 'rejected']),
  note: z.string().max(4000).optional(),
});

const Decisions = z.object({
  items: z.array(z.object({ id: z.string().min(1).max(500), decision: z.enum(['confirm', 'reject']), reason: z.string().max(4000).optional() }).strict()).min(1).max(500),
}).strict();

/** The admin MCP endpoint (owner decisions, operator token only); /mcp stays read-and-report only. */
const ADMIN_MCP = '/mcp/admin';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostname(hostHeader: string | undefined): string {
  return (hostHeader ?? '').replace(/:\d+$/, '').toLowerCase();
}

const DEV_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',');

/** Same host+port as the request itself (http, or https behind a TLS proxy), or an explicitly allowed dev origin. */
function originAllowed(origin: string, hostHeader: string): boolean {
  return origin === `http://${hostHeader}` || origin === `https://${hostHeader}` || DEV_ORIGINS.includes(origin);
}

export type AppOpts = {
  staticDir?: string;
  context?: ContextDeps;
  knowledge?: Pick<KnowledgeStore, 'listLessons' | 'lessonDetail' | 'updateLesson'> & Partial<Pick<KnowledgeStore, 'retryPostmortem' | 'postmortemBacklog'>>;
  embed?: (texts: string[]) => Promise<number[][]>;
  facts?: Pick<FactsStore, 'listProjects' | 'requestScan' | 'listFacts' | 'searchFacts'> & Partial<Pick<FactsStore, 'setFactRelevance' | 'setPinned' | 'scanJob' | 'addOwnerFact'>>;
  /** Folders under the configured roots that can be scanned. */
  projectDirs?: () => Promise<Project[]>;
  insights?: Pick<InsightsStore, 'projectGraph' | 'patterns'>;
  activity?: Pick<ActivityStore, 'record' | 'list'>;
  docs?: Pick<DocsStore, 'upsertDoc' | 'listDocs' | 'deleteDoc'> & Partial<Pick<DocsStore, 'docImage' | 'requeueDocRead'>>;
  links?: Pick<LinksStore, 'listLinks' | 'setLink' | 'deleteLink'>;
  auth?: AuthOpts;
  /** JSON access log: method, path, status, ms. Query strings are left out (they can carry search text). */
  log?: (msg: string, extra?: object) => void;
  portability?: Pick<PortabilityStore, 'exportData' | 'deleteProject'>;
  system?: {
    version: string;
    /** The backend in use (STORE). */ store?: StoreKind;
    ping(): Promise<boolean>;
    worker(): Promise<WorkerStatus | null>;
    selection?(): Promise<ProjectSelection>;
    /** How many project roots are mounted: with none, the status note points to Settings to add one. */ roots?: number;
    /** Turns the classifier gave up on. */ givenUpTurns?(): Promise<number>;
    /** Whether Ollama answers (embeddings always need it; so do ollama:<model> jobs). */ ollama?(): Promise<OllamaHealth>;
  };
  /** Turns the classifier gave up on, and re-queueing them (owner-only). */
  classifyQueue?: Pick<GraphStore, 'givenUpTurns' | 'requeueGivenUpTurns'>;
  /** The Settings page: which project folders are read. */
  settings?: SettingsDeps;
  /** The code map, for the Projects page (stats, hotspots, a file's module panel) and the Patterns page. */
  codegraph?: Pick<CodeGraphStore, 'hotspots' | 'moduleContext' | 'impact' | 'codeMapMeta'> & Partial<Pick<CodeGraphStore, 'mapGraph' | 'requestCodeMapRebuild'>>;
  /** SCAN_MAX_FILES (null: the cap scales with the repo): how many hotspots one page may list, and whether a map is capped. */
  mapMaxFiles?: number | null;
  /** Feedback Graph Cloud sync: the Settings card and Sync now. */
  cloud?: CloudDeps;
  /** ProjectScope.project (the Settings selection and EXCLUDE_PROJECTS): the code map routes answer only inside it. */
  inScope?: (key: string) => boolean | Promise<boolean>;
  /** Import of an export bundle (POST /api/import). */
  importer?: ImportDeps;
  /** Session summaries: the Sessions page. */
  sessions?: SessionsDeps;
  /**
   * What every page but Settings shows: the selected projects and their clone folders (shownProjects). Lists ask the
   * store for these keys only, and an item of any other project is not found. Unset: everything is shown.
   */
  shown?: () => Promise<ShownProjects> | ShownProjects;
  /** Settings > Integrations (GitHub, Linear) and the connections in /api/status. */
  integrations?: IntegrationsDeps;
  /** Ask: conversations answered by the worker from a context pack built here (chat.ts). */
  chat?: ChatRouteDeps;
};

/** The store's projectKeys for a list: every shown key, or for ?project= that one if it is shown (else none). */
function keysFor(v: ShownProjects | null, project?: string): string[] | undefined {
  if (!v) return undefined;
  return project ? (v.has(project) ? [project] : []) : v.keys;
}

/** A lesson belongs to the project it serves, else the one it was learned in; one with neither is shown everywhere. */
function showsLesson(v: ShownProjects | null, l: Pick<Lesson, 'projectKey' | 'origin'>): boolean {
  const key = l.projectKey ?? l.origin ?? null;
  return !v || key === null || v.has(key);
}

const NOT_SHOWN = { error: 'not found: this project is not selected (choose it in Settings to see it)' };

const MAX_DEPTH = 5;
/** A repo-relative path as the map holds it: no absolute paths, no `..`. */
const RepoPath = z.string().min(1).max(1000).refine((p) => cleanLessonPath(p) === p, 'a repo-relative path');
/** tests=1: rank test files too (hotspots leave them out by default). */
const IncludeTests = z.enum(['0', '1', 'true', 'false']).optional().transform((v) => v === '1' || v === 'true');
/** Hotspots of one project: up to a whole map (the cap: SCAN_MAX_FILES, or 4000 when it scales with the repo). */
const hotspotQuery = (maxFiles: number | null) =>
  z.object({ limit: z.coerce.number().int().min(1).max(Math.max(MAX_AUTO_MAP_FILES, maxFiles ?? 0)).default(50), tests: IncludeTests });
const TopHotspotQuery = z.object({ project: z.string().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(10), tests: IncludeTests });
/** The Graph page's Code mode: up to `limit` top files and as many neighbours, so at most twice that many nodes. */
const MapGraphQuery = z.object({ limit: z.coerce.number().int().min(1).max(300).default(60), tests: IncludeTests });
const ImpactQuery = z.object({ path: z.array(RepoPath).min(1).max(50), depth: z.coerce.number().int().min(1).max(MAX_DEPTH).default(3) });

/** The worker beats every 30s; three minutes of silence means it is down or wedged. */
const WORKER_STALE_MS = 3 * 60_000;
/** /api/pipeline counts Inbox items and lessons up to this many each (the panel only needs to know there are some). */
const PIPELINE_LIMIT = 1000;
/** /api/events: at most this many open streams; a heartbeat comment this often; the reconnect delay it suggests. */
const MAX_EVENT_STREAMS = 20;
const EVENT_HEARTBEAT_MS = 15_000;
const EVENT_RETRY_MS = 5000;
/** How many of the latest Activity entries each poll reads for new ones. */
const EVENT_ACTIVITY_WINDOW = 100;

const DocUpload = z
  .object({
    title: z.string().min(1).max(300),
    name: z.string().min(1).max(200).regex(/^[\w][\w .()-]*$/, 'a plain file name'),
    text: z.string().min(1).max(2_000_000).optional(),
    // No SVG: it is a page that can run script, not an image a model reads.
    image: z.object({ mediaType: z.enum(IMAGE_MEDIA_TYPES), data: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'base64') }).strict().optional(),
  })
  .strict()
  .refine((d) => (d.text === undefined) !== (d.image === undefined), 'send either text or an image');
/** Base64 of MAX_IMAGE_BYTES. */
const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

const ActivityQuery = z.object({
  project: z.string().min(1).max(200).optional(),
  kind: z.enum(ACTIVITY_KINDS).optional(),
  target: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const ScanProvider = z.string().regex(/^[a-z][a-z-]*(:[\w./:-]+)?$/);
const ScanRequest = z.object({ provider: ScanProvider.optional() }).strict();
const BatchScanRequest = z
  .object({ keys: z.array(z.string().min(1).max(200)).min(1).max(2000).optional(), all: z.literal(true).optional(), provider: ScanProvider.optional() })
  .strict()
  .refine((b) => (b.keys === undefined) !== (b.all === undefined), 'send either keys or all: true');
const LinkRequest = z.object({
  a: z.string().min(1).max(200),
  b: z.string().min(1).max(200),
  status: z.enum(LINK_STATUSES).optional(),
  relation: z.enum(LINK_RELATIONS).optional(),
  note: z.string().max(500).optional(),
}).strict();
const PinRequest = z.object({ pinned: z.boolean() }).strict();
const RelevanceRequest = z.object({ relevance: z.number().min(0).max(1) });

/** Converting a lesson to a fact: the kind you chose (default convention) and how often everyday coding needs it. */
const LessonToFact = z.object({ kind: z.enum(FACT_KINDS).default('convention'), relevance: z.number().min(0).max(1).default(EVERYDAY_FROM) }).strict();

/** Where a fact from a lesson is filed: the lesson's first path (a glob cut back to its folder), else the project ('.'). */
export function lessonFactPath(paths: string[]): string {
  const first = paths.length ? cleanLessonPath(paths[0]) : null;
  if (!first) return '.';
  const segments = first.split('/');
  const glob = segments.findIndex((s) => /[*?[\]{}]/.test(s));
  return (glob < 0 ? segments : segments.slice(0, glob)).join('/').replace(/\/+$/, '') || '.';
}
const FactsQuery = z.object({ q: z.string().min(1).max(500).optional(), kind: z.enum(FACT_KINDS).optional() });

const ProjectParam = z.object({ project: z.string().min(1).max(200) });

const LessonQuery = z.object({
  status: z.enum(['proposed', 'approved', 'rejected', 'superseded']).optional(),
  project: z.string().min(1).optional(),
});

const LessonPatch = z
  .object({
    status: z.enum(['approved', 'rejected', 'proposed']).optional(),
    title: z.string().min(1).max(300).optional(),
    rule: z.string().min(1).max(4000).optional(),
    appliesWhen: z.string().max(1000).optional(),
    scope: z.enum(['task', 'project', 'global']).optional(),
    paths: z.array(z.string().max(300)).max(50).optional(),
    supersedes: z.string().optional(),
  })
  .strict();

const ExportQuery = z.object({ project: z.string().min(1).max(200).optional(), approved: z.enum(['1', 'true']).optional() });

/** For the OpenAPI document (openapi.ts). */
export const appSchemas = {
  ListQuery, Decision, Decisions, RepoPath, hotspotQuery, TopHotspotQuery, MapGraphQuery, ImpactQuery, DocUpload, ActivityQuery, ScanRequest,
  BatchScanRequest, LinkRequest, PinRequest, RelevanceRequest, FactsQuery, ProjectParam, LessonQuery, LessonPatch, LessonToFact, ExportQuery,
};

/** The Bearer token a request carries, trimmed; null when there is none (or it is empty). */
const bearerOf = (c: Context): string | null => {
  const h = c.req.header('authorization');
  return h?.startsWith('Bearer ') && h.slice(7).trim() ? h.slice(7).trim() : null;
};

/** Could not reach the server at all, as opposed to a server that answered with a refusal. */
const UNREACHABLE = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|fetch failed|not reachable|socket hang up/i;

/**
 * A job's last failure that is no longer true: the same provider has answered since (for another job), or it was an
 * Ollama model that could not reach Ollama and Ollama answers now (checked on this read). Without this a job that has
 * not run again (summaries wait for an idle session) would report a long-fixed outage.
 */
function stale(job: ModelJob, h: ProviderHealth, w: WorkerStatus, ollama: OllamaHealth | null): boolean {
  const answeredSince = MODEL_JOBS.some((j) => {
    const o = w.health?.[j];
    return j !== job && !!o?.ok && o.provider === h.provider && o.at > h.at;
  });
  return answeredSince || (h.provider.startsWith('ollama:') && !!ollama?.ok && UNREACHABLE.test(h.reason ?? ''));
}

/** Each job's model as the worker last reported it. A job with no model (it could not be built) is unavailable, and
 * so is an Ollama model while Ollama does not answer, whether or not a job has asked it yet. */
function modelHealth(w: WorkerStatus, ollama: OllamaHealth | null): Record<ModelJob, ModelHealth> {
  const out = {} as Record<ModelJob, ModelHealth>;
  for (const job of MODEL_JOBS) {
    const provider = w.providers[job] ?? null;
    const reported = w.health?.[job];
    const h = reported && !reported.ok && stale(job, reported, w, ollama) ? { ...reported, ok: true, reason: null } : reported;
    const current = h?.provider ?? provider;
    // A worker older than the summary report leaves the key out: unknown, not broken.
    const unbuilt = !provider && (job === 'classify' || (job === 'summary' && job in w.providers));
    out[job] = w.off?.includes(job)
      ? { provider: null, ok: true, reason: null, off: true }
      : unbuilt
      ? { provider: null, ok: false, reason: job === 'classify' ? 'no classifier is configured (see the worker log)' : 'no summary model could be built (SUMMARY_LLM; see the worker log): summaries are paused' }
      : ollama && !ollama.ok && current?.startsWith('ollama:')
        ? { provider: current, ok: false, reason: ollama.reason }
        : h && !h.ok
          ? { provider: current, ok: false, reason: h.reason, since: h.since ?? h.at, checkedAt: h.at }
          : { provider: current, ok: true, reason: null };
  }
  return out;
}

/** /api/status stage and progress from a live worker's heartbeat (both null when it is offline or does not say). */
function stageOf(w: WorkerStatus | null): Pick<PipelineStatus, 'stage' | 'progress'> {
  const st = w?.stage;
  if (!st) return { stage: null, progress: null };
  return { stage: { name: st.name, startedAt: st.startedAt, current: st.current }, progress: st.done === null ? null : { done: st.done, total: st.total } };
}

export function createApp(repo: ApiRepo, opts: AppOpts = {}) {
  const { staticDir, context, knowledge, embed, facts, projectDirs, insights, docs, links, auth = {}, system, portability, settings, log, codegraph, classifyQueue, inScope, sessions, shown } = opts;
  // Writes made with the operator token are logged as the agent that made them, wherever the route lives.
  const activity = asActor(opts.activity);
  const cloud = opts.cloud && { ...opts.cloud, activity: asActor(opts.cloud.activity) };
  const importer = opts.importer && { ...opts.importer, activity: asActor(opts.importer.activity) };
  const integrations = opts.integrations && { ...opts.integrations, activity: asActor(opts.integrations.activity) };
  /** null: no selection to apply (everything is shown). */
  const view = async (): Promise<ShownProjects | null> => (shown ? await shown() : null);
  const shows = async (key: string) => {
    const v = await view();
    return !v || v.has(key);
  };
  const app = new Hono();
  /** Sync now's progress and last run, once its routes are registered below. */
  let cloudState: CloudState | null = null;
  // Other host names are only safe once a token stands between them and the API.
  const hosts = new Set([...LOCAL_HOSTS, ...(auth.token ? (auth.publicHosts ?? []).map((h) => h.toLowerCase()) : [])]);

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
    const logged = c.req.path === '/mcp' || c.req.path === ADMIN_MCP || (c.req.path.startsWith('/api/') && c.req.path !== '/api/health');
    if (log && logged) {
      log('request', { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
    }
  });

  /**
   * A Bearer was sent and matches no configured token: 401, and a log line naming the route and the agent (never the
   * token), so a stale token is plain to the agent and repeated guesses show in the log.
   */
  const unrecognised = (c: Context) => {
    log?.('auth refused', { method: c.req.method, path: c.req.path, reason: 'bearer token not recognised', operator: operatorName(c.req.header('x-fg-operator')) });
    return c.json({ error: 'token not recognised: check FG_OPERATOR_TOKEN (or API_TOKEN) against the .env this Feedback Graph runs with' }, 401);
  };

  // Refuse DNS-rebinding hosts and cross-site writes; with a token configured, require it.
  app.use('*', async (c, next) => {
    const host = hostname(c.req.header('host') ?? new URL(c.req.url).host);
    if (!hosts.has(host)) return c.json({ error: 'forbidden host' }, 403);
    // The admin MCP endpoint answers only the operator token: without it, it does not exist (no token sent, or
    // FG_OPERATOR_TOKEN unset); a bearer that is not the operator token (the API token included) is refused.
    if (c.req.path === ADMIN_MCP && !hasOperatorToken(c, auth.operator)) {
      if (!auth.operator?.token || !bearerOf(c)) return c.notFound();
      log?.('auth refused', { method: c.req.method, path: c.req.path, reason: 'not the operator token', operator: operatorName(c.req.header('x-fg-operator')) });
      return c.json({ error: 'the admin MCP endpoint takes FG_OPERATOR_TOKEN as the Bearer: check it against the .env this Feedback Graph runs with' }, 401);
    }
    if (needsAuth(c.req.path) && !authenticated(c, auth.token) && !hasOperatorToken(c, auth.operator)) {
      return bearerOf(c) ? unrecognised(c) : c.json({ error: 'sign in required' }, 401);
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const site = c.req.header('sec-fetch-site');
      if (site === 'cross-site' || site === 'same-site') return c.json({ error: 'cross-site write' }, 403);
      // Browsers always send Origin on cross-origin writes; MCP/CLI clients send none.
      const origin = c.req.header('origin');
      if (origin !== undefined && !originAllowed(origin, c.req.header('host') ?? new URL(c.req.url).host)) {
        return c.json({ error: 'cross-origin write' }, 403);
      }
      // A Streamable HTTP client ending its MCP session sends DELETE with no body; handleMcp answers it.
      const mcpEnd = c.req.method === 'DELETE' && (c.req.path === '/mcp' || c.req.path === ADMIN_MCP);
      if (!mcpEnd && !c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'json required' }, 415);
    }
    await next();
  });

  // Decisions that teach agents are yours: they must come from the UI (browsers always send Origin on writes).
  // A local agent with curl sends none. This stops accidental self-approval; it cannot stop a process that
  // deliberately forges headers (that process could read .env and the database anyway).
  // The exception you opt into: FG_OPERATOR_TOKEN as the Bearer, for the verbs OPERATOR_ALLOW names. Its writes are
  // logged as operator:<name> (X-FG-Operator), never as you.
  const allowed = new Set(auth.operator?.allow ?? []);
  const ownerOnly = (verb: (typeof OWNER_ROUTES)[number][2]) => async (c: Context, next: Next) => {
    if (hasOperatorToken(c, auth.operator)) {
      if (!allowed.has(verb)) return c.json(refusedVerb(verb), 403);
      return runAs(operatorName(c.req.header('x-fg-operator')), next);
    }
    // A token was offered for this decision and it is neither token (with the operator token configured): say so. The
    // API token is recognised, it just cannot decide: that stays the 403 below.
    const offered = bearerOf(c);
    if (auth.operator?.token && offered && !(auth.token && tokenMatches(offered, auth.token))) return unrecognised(c);
    if (c.req.header('origin') === undefined) {
      return c.json({ error: 'only you can make this decision, from the Feedback Graph UI, or with FG_OPERATOR_TOKEN as a Bearer for the verbs OPERATOR_ALLOW names' }, 403);
    }
    await next();
  };
  for (const [method, path, verb] of OWNER_ROUTES) app.on(method, path, ownerOnly(verb));

  app.get('/api/health', (c) => c.json({ ok: true }));
  // Readiness, unlike health, needs the store: a load balancer should not route here while the database is down.
  app.get('/api/ready', async (c) => {
    const ok = (await system?.ping().catch(() => false)) ?? true;
    const body = system?.store ? { ok, store: system.store } : { ok };
    return ok ? c.json(body) : c.json(body, 503);
  });
  app.get('/api/status', async (c) => {
    const graph = (await system?.ping().catch(() => false)) ?? false;
    const worker = graph ? ((await system?.worker().catch(() => null)) ?? null) : null;
    const sel = graph && system?.selection ? await system.selection().catch(() => null) : null;
    const givenUpTurns = graph && system?.givenUpTurns ? await system.givenUpTurns().catch(() => null) : null;
    const ollama = system?.ollama ? await system.ollama().catch(() => null) : null;
    const workerHealthy = !!worker && Date.now() - Date.parse(worker.lastBeat) < WORKER_STALE_MS;
    const s: SystemStatus = {
      version: system?.version ?? 'dev',
      store: system?.store ?? null,
      graph,
      worker,
      workerHealthy,
      ...stageOf(workerHealthy ? worker : null),
      authRequired: !!auth.token,
      selection: sel && { initialized: sel.initialized, tracked: sel.tracked.length, ...(system?.roots === undefined ? {} : { roots: system.roots }), note: selectionNote(sel, system?.roots) },
      cloud: cloudStatus(cloud?.cloud ?? null, cloudState),
      models: worker ? modelHealth(worker, ollama) : null,
      givenUpTurns,
      ollama,
      connections: await connectionsStatus({ integrations: graph ? (integrations?.integrations ?? null) : null, deps: integrations, worker, ollama, cloud: cloud?.cloud ?? null, manualSync: cloudState?.lastManual() ?? null }).catch(() => null),
    };
    return c.json(s);
  });

  // The first-run panel: every stage's count in one call. Each count fails on its own (null), never the whole answer.
  // ?project=: one project's counts (an empty state filtered to it); the classify backlog and the stage stay worker-wide.
  const pipelineStatus = async (project?: string): Promise<PipelineStatus> => {
    const v = await view();
    const keys = project ? (keysFor(v, project) ?? [project]) : keysFor(v);
    const graph = (await system?.ping().catch(() => false)) ?? false;
    const worker = graph ? ((await system?.worker().catch(() => null)) ?? null) : null;
    const live = !!worker && Date.now() - Date.parse(worker.lastBeat) < WORKER_STALE_MS;
    const count = async <T>(fn: () => Promise<T>): Promise<T | null> => fn().catch(() => null);
    const pending = (status: 'pending' | 'confirmed') => repo.listCandidates({ status, limit: PIPELINE_LIMIT, ...(keys && { projectKeys: keys }) }).then((r) => r.length);
    const lessons = (status: 'proposed' | 'approved') =>
      knowledge!.listLessons({ status, limit: PIPELINE_LIMIT, ...(keys && { projectKeys: keys }) }).then((r) => r.filter((l) => showsLesson(v, l)).length);
    const projects = facts ? await count(async () => (await facts.listProjects()).filter((p) => (!v || v.has(p.key)) && (!project || p.key === project))) : null;
    const scans = projects && { done: 0, queued: 0, running: 0, failed: 0, never: 0 };
    for (const p of projects ?? []) scans![p.lastScan?.status ?? 'never']++;
    const [inboxPending, inboxConfirmed, proposed, approved, queued] = await Promise.all([
      count(() => pending('pending')),
      count(() => pending('confirmed')),
      knowledge ? count(() => lessons('proposed')) : null,
      knowledge ? count(() => lessons('approved')) : null,
      knowledge?.postmortemBacklog ? count(() => knowledge.postmortemBacklog!()) : null,
    ]);
    return {
      ...stageOf(live ? worker : null),
      sessions: projects ? projects.reduce((n, p) => n + p.sessions, 0) : null,
      classify: worker?.backlog ? { backlog: worker.backlog.classify, capped: worker.backlog.classifyCapped } : null,
      inbox: inboxPending === null || inboxConfirmed === null ? null : { pending: inboxPending, confirmed: inboxConfirmed },
      postmortems: queued === null ? null : { queued },
      lessons: proposed === null || approved === null ? null : { proposed, approved },
      scans,
    };
  };
  app.get('/api/pipeline', async (c) => c.json(await pipelineStatus(c.req.query('project')?.slice(0, 200) || undefined)));

  // This API as an OpenAPI 3.1 document (openapi.ts); signed in like every other read.
  app.get('/api/openapi.json', (c) => c.json(openApiDocument(system?.version ?? 'dev')));

  // What changes, as server-sent events (events.ts): one poller for every stream, narrowed to the shown projects.
  const hub = createEventHub({
    ...(system && {
      stage: async () => {
        const w = await system.worker();
        const workerHealthy = !!w && Date.now() - Date.parse(w.lastBeat) < WORKER_STALE_MS;
        return { ...stageOf(workerHealthy ? w : null), workerHealthy };
      },
    }),
    pipeline: () => pipelineStatus(),
    ...(facts && {
      scans: async () => {
        const v = await view();
        return (await facts.listProjects()).filter((p) => p.lastScan && (!v || v.has(p.key))).map((p) => p.lastScan!);
      },
    }),
    ...(opts.chat && {
      chats: {
        list: async () => opts.chat!.store.listConversations({ projectKeys: keysFor(await view()) }),
        thread: async (id: string) => {
          const t = await opts.chat!.store.conversation(id);
          return t && (await shows(t.projectKey)) ? t : null;
        },
      },
    }),
    ...(activity && {
      activity: async () => {
        const v = await view();
        const entries = await activity.list({ limit: EVENT_ACTIVITY_WINDOW, ...(v && { projectKeys: v.keys }) });
        return entries.filter((a) => !v || a.projectKey === null || v.has(a.projectKey));
      },
    }),
  });
  let streams = 0;
  app.get('/api/events', (c) => {
    if (streams >= MAX_EVENT_STREAMS) return c.json({ error: `too many event streams are open (${MAX_EVENT_STREAMS}): close one, or poll /api/status` }, 503);
    streams++;
    return streamSSE(c, async (stream) => {
      let close = () => {};
      const closed = new Promise<void>((resolve) => { close = resolve; });
      stream.onAbort(() => close());
      const send = (e: FgEvent) => void stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) }).catch(() => close());
      let off = () => {};
      const beat = setInterval(() => void stream.write(': ping\n\n').catch(() => close()), EVENT_HEARTBEAT_MS);
      try {
        await stream.write(`retry: ${EVENT_RETRY_MS}\n\n`);
        for (const e of hub.current()) send(e);
        off = hub.subscribe(send);
        await closed;
      } finally {
        clearInterval(beat);
        off();
        streams--;
      }
    });
  });

  const secure = (c: Context) => c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';
  app.get('/api/session', (c) => c.json({ authRequired: !!auth.token, authenticated: authenticated(c, auth.token) }));
  app.post('/api/session', async (c) => {
    if (!auth.token) return c.body(null, 204);
    const body = await c.req.json().catch(() => null);
    if (!tokenMatches(body?.token, auth.token)) return c.json({ error: 'wrong token' }, 401);
    c.header('set-cookie', sessionCookie(auth.token, secure(c)));
    return c.body(null, 204);
  });
  app.delete('/api/session', (c) => {
    if (auth.token) c.header('set-cookie', sessionCookie(auth.token, secure(c), true));
    return c.body(null, 204);
  });

  app.get('/api/candidates', async (c) => {
    const q = ListQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: q.error.flatten() }, 400);
    const projectKeys = keysFor(await view(), q.data.project);
    return c.json(await repo.listCandidates({ status: q.data.status, projectKey: q.data.project, source: q.data.source, limit: q.data.limit, ...(projectKeys && { projectKeys }) }));
  });

  /** An Inbox item, if it belongs to a shown project. */
  const shownCandidate = async (id: string) => {
    const d = await repo.candidateDetail(id);
    return d && (await shows(d.candidate.projectKey)) ? d : null;
  };

  app.get('/api/candidates/:id', async (c) => {
    const d = await shownCandidate(c.req.param('id'));
    return d ? c.json(d) : c.json({ error: 'not found' }, 404);
  });

  /** Confirm or reject an Inbox item of a shown project, and log it. False: no such item (or not shown). */
  const decideCandidate = async (id: string, status: 'confirmed' | 'rejected', note: string | null): Promise<boolean> => {
    const detail = await shownCandidate(id);
    if (!detail) return false;
    await repo.decide(id, status, note, currentActor());
    const text = detail.turn.text ?? '';
    const who = actingAsOperator() ? `an agent (${currentActor()})` : 'you';
    await activity?.record({
      kind: 'feedback_decided',
      actor: 'you',
      projectKey: detail.candidate.projectKey,
      subject: `${status}: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`,
      why: note || (status === 'confirmed' ? `${who} confirmed this was real pushback` : `${who} rejected it as not pushback`),
      details: { status, classifier: { label: detail.candidate.classification.label, confidence: detail.candidate.classification.confidence } },
      targets: [id],
    });
    return true;
  };

  app.post('/api/candidates/:id/decision', async (c) => {
    const body = Decision.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    if (!(await decideCandidate(c.req.param('id'), body.data.status, body.data.note ?? null))) return c.json({ error: 'not found' }, 404);
    return c.body(null, 204);
  });

  // Many Inbox decisions in one call (the `fg` CLI, an agent with the operator token). Each item is decided like the
  // single route above; one that is not found does not stop the rest.
  app.post('/api/candidates/decisions', async (c) => {
    const body = Decisions.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const results = [];
    for (const item of body.data.items) {
      const status = item.decision === 'confirm' ? 'confirmed' : 'rejected';
      results.push((await decideCandidate(item.id, status, item.reason ?? null)) ? { id: item.id, ok: true, status } : { id: item.id, ok: false, error: 'not found' });
    }
    return c.json({ results });
  });

  app.get('/api/stats', async (c) => {
    const v = await view();
    return c.json((await repo.stats()).filter((r) => !v || v.has(r.projectKey)));
  });

  if (context) app.all('/mcp', (c) => handleMcp(c.req.raw, context));
  // Owner decisions for an agent holding the operator token (adminMcp.ts): each tool calls the REST route in-process,
  // so the OPERATOR_ALLOW gate, validation and Activity are the route's own. Not mounted without FG_OPERATOR_TOKEN.
  if (auth.operator?.token) app.all(ADMIN_MCP, (c) => handleAdminMcp(c.req.raw, { request: (path, init) => app.request(path, init) }));
  // Read-only, for the Claude Code plugin's hooks: is this folder a selected project?
  if (context) app.get('/api/agent/project', async (c) => c.json(await trackedProject({ cwd: c.req.query('cwd') ?? undefined }, context)));

  if (facts && projectDirs) {
    // Every page's project list. Settings lists every folder (GET /api/settings/projects); this lists the shown ones.
    app.get('/api/projects', async (c) => {
      const v = await view();
      const dirs = await projectDirs();
      const folder = new Map(dirs.map((d) => [d.key, d]));
      // Records a scan, a code map or an upload made carry no path or remote: the selected folder fills what is missing.
      const known = (await facts.listProjects())
        .filter((p) => !v || v.has(p.key))
        .map((p) => {
          const d = folder.get(p.key);
          return d ? { ...p, repoPath: p.repoPath || d.repoPath, remote: p.remote ?? d.remote ?? null } : p;
        });
      // An alias folder is a second clone: its sessions are its project's, so it is not listed as one of its own.
      const keys = new Set(known.flatMap((p) => [p.key, ...p.aliases]));
      const fresh: ProjectSummary[] = dirs
        .filter((d) => !keys.has(d.key) && (!v || v.has(d.key)))
        .map((d) => ({ key: d.key, repoPath: d.repoPath, remote: d.remote ?? null, aliases: [], sessions: 0, feedback: 0, lessons: 0, facts: 0, lastScan: null, pinned: false }));
      // Confirmed links whose other end is shown, so a hidden project never counts (one query for every project).
      const linkCount = new Map<string, number>();
      if (links) {
        for (const l of await links.listLinks({})) {
          if (l.status !== 'confirmed' || (v && !(v.has(l.a) && v.has(l.b)))) continue;
          for (const k of [l.a, l.b]) linkCount.set(k, (linkCount.get(k) ?? 0) + 1);
        }
      }
      const all = links ? [...known, ...fresh].map((p) => ({ ...p, links: linkCount.get(p.key) ?? 0 })) : [...known, ...fresh];
      // Pinned first: every page lists projects in this order.
      return c.json(all.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.key.localeCompare(b.key)));
    });

    app.post('/api/projects/:key/scan', async (c) => {
      const body = ScanRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!body.success) return c.json({ error: body.error.flatten() }, 400);
      const project = (await projectDirs()).find((p) => p.key === c.req.param('key'));
      if (!project) return c.json({ error: 'no such folder under the configured roots' }, 404);
      return c.json(await facts.requestScan(project, body.data.provider ?? null), 202);
    });

    // Scan many folders in one call: `all` (every selected folder) or `keys`. Each is queued like the route above;
    // a folder that is not selected is skipped, and the answer says per key what happened.
    app.post('/api/projects/scan', async (c) => {
      const body = BatchScanRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: body.error.flatten() }, 400);
      const folders = await projectDirs();
      const v = await view();
      const keys = body.data.all ? folders.map((p) => p.key).filter((k) => !v || v.has(k)) : [...new Set(body.data.keys)];
      const results = [];
      for (const key of keys) {
        const project = folders.find((p) => p.key === key);
        if (!project) results.push({ key, queued: false, error: 'no such folder under the configured roots' });
        else if (v && !v.has(key)) results.push({ key, queued: false, error: 'not selected: choose it in Settings first' });
        else results.push({ key, queued: true, job: await facts.requestScan(project, body.data.provider ?? null) });
      }
      return c.json({ results }, 202);
    });

    const scanJob = facts.scanJob?.bind(facts);
    if (scanJob) {
      // One scan job, for `fg scan --wait`: its status, and while it waits its place in the queue (1: next). Jobs are
      // one open per project, so the projects' last scans are the queue.
      app.get('/api/scans/:id', async (c) => {
        const job = await scanJob(c.req.param('id'));
        if (!job || !(await shows(job.projectKey))) return c.json({ error: 'not found' }, 404);
        let queuePosition: number | null = null;
        if (job.status === 'queued') {
          const ahead = (await facts.listProjects()).filter((p) => p.lastScan?.status === 'queued' && p.lastScan.id !== job.id && p.lastScan.requestedAt < job.requestedAt).length;
          queuePosition = ahead + 1;
        }
        return c.json({ ...job, queuePosition });
      });
    }

    app.get('/api/projects/:key/facts', async (c) => {
      const q = FactsQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: q.error.flatten() }, 400);
      const projectKey = c.req.param('key');
      if (!(await shows(projectKey))) return c.json(NOT_SHOWN, 404);
      if (q.data.q && embed) {
        const [embedding] = await embed([q.data.q]);
        return c.json(await facts.searchFacts({ embedding, projectKey, k: 30 }));
      }
      return c.json(await facts.listFacts({ projectKey, kind: q.data.kind, limit: 500 }));
    });

    const setPinned = facts.setPinned?.bind(facts);
    if (setPinned) {
      app.put('/api/projects/:key/pin', async (c) => {
        const body = PinRequest.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: body.error.flatten() }, 400);
        const key = c.req.param('key');
        // A folder under the roots, or a project the store knows (one imported, or whose folder is elsewhere).
        const known = (await facts.listProjects()).find((p) => p.key === key);
        const project = (await projectDirs()).find((p) => p.key === key) ?? (known && { key, name: key, repoPath: known.repoPath });
        if (!project || !(await shows(project.key))) return c.json({ error: 'no such project' }, 404);
        await setPinned(project, body.data.pinned);
        await activity?.record({
          kind: 'project_pinned', actor: 'you', projectKey: project.key,
          subject: `${body.data.pinned ? 'pinned' : 'unpinned'} ${project.key}`,
          why: body.data.pinned ? 'you pinned it: it comes first in every project list' : 'you unpinned it', details: { pinned: body.data.pinned }, targets: [],
        });
        return c.body(null, 204);
      });
    }

    const setRelevance = facts.setFactRelevance?.bind(facts);
    if (setRelevance) {
      app.patch('/api/projects/:key/facts/:id/relevance', async (c) => {
        const body = RelevanceRequest.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: body.error.flatten() }, 400);
        const projectKey = c.req.param('key');
        if (!(await shows(projectKey))) return c.json(NOT_SHOWN, 404);
        const id = c.req.param('id');
        const changed = await setRelevance([{ id, relevance: body.data.relevance, by: currentActor() as RelevanceBy, projectKey }]);
        if (!changed) return c.json({ error: 'no such fact in this project' }, 404);
        await activity?.record({
          kind: 'fact_relevance_set', actor: 'you', projectKey,
          subject: `set a fact to ${relevanceBand(body.data.relevance)} (${body.data.relevance})`,
          why: 'you set how often everyday coding needs it; agents get facts ranked by it, and the background scorer leaves it alone (a rescan replaces the fact with a new one, scored again)',
          details: { relevance: body.data.relevance }, targets: [id],
        });
        return c.body(null, 204);
      });
    }
  }

  if (docs && embed && projectDirs) {
    app.get('/api/projects/:key/docs', async (c) => {
      const key = c.req.param('key');
      return (await shows(key)) ? c.json(await docs.listDocs(key)) : c.json(NOT_SHOWN, 404);
    });

    app.post('/api/projects/:key/docs', async (c) => {
      const body = DocUpload.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: body.error.flatten() }, 400);
      const { image, title, name } = body.data;
      if (image && image.data.length > MAX_IMAGE_BASE64) return c.json({ error: `images can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB` }, 413);
      const project = (await projectDirs()).find((p) => p.key === c.req.param('key'));
      if (!project) return c.json({ error: 'no such project' }, 404);
      // An image is searchable by a placeholder until the worker reads it; its description then replaces it.
      const chunks = image ? [`Image "${title}" (${name}): not read yet.`] : chunkText(redactSecrets(body.data.text!));
      if (!chunks.length) return c.json({ error: 'document has no text' }, 400);
      const vectors = await embed(chunks);
      // Same file name, same doc: say so, rather than logging a fresh upload over a silent replacement.
      const previous = (await docs.listDocs(project.key)).find((d) => d.source === 'upload' && d.ref === name);
      const id = await docs.upsertDoc(
        { projectKey: project.key, source: 'upload', ref: name, title, url: null },
        chunks.map((text, i) => ({ text, embedding: vectors[i] })),
        { read: true, addedBy: currentActor(), ...(image && { image }) },
      );
      const what = image ? `image "${title}"` : `"${title}" (${chunks.length} chunk${chunks.length === 1 ? '' : 's'})`;
      await activity?.record({
        kind: 'doc_added', actor: 'you', projectKey: project.key,
        subject: `${previous ? `replaced "${previous.title}" with` : 'uploaded'} ${what}`,
        why: 'you added it as context; the worker reads it into facts, and agents get matching excerpts and facts with their task context',
        details: image ? { name, mediaType: image.mediaType, bytes: Math.floor((image.data.length * 3) / 4) } : { name, chars: body.data.text!.length }, targets: [id],
      });
      return c.json({ id, chunks: chunks.length }, 201);
    });

    const docImage = docs.docImage?.bind(docs);
    if (docImage) {
      app.get('/api/docs/:id/image', async (c) => {
        const id = c.req.param('id');
        // ids are doc:<project>:<source>:<ref>
        if (!(await shows(id.split(':')[1] ?? ''))) return c.json({ error: 'not found' }, 404);
        const img = await docImage(id);
        if (!img) return c.json({ error: 'not found' }, 404);
        return c.body(Buffer.from(img.data, 'base64'), 200, {
          'content-type': img.mediaType,
          'content-disposition': 'inline',
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, max-age=300',
        });
      });
    }

    // A failed reading, read again now (the owner changed DOCS_LLM to a model with vision, say): no re-upload needed.
    const requeueDocRead = docs.requeueDocRead?.bind(docs);
    if (requeueDocRead) {
      app.post('/api/docs/:id/reread', async (c) => {
        const id = c.req.param('id');
        // ids are doc:<project>:<source>:<ref>
        const [, projectKey = '', , ...ref] = id.split(':');
        if (!(await shows(projectKey))) return c.json({ error: 'not found' }, 404);
        if (!(await requeueDocRead(id))) return c.json({ error: 'not found, or not waiting to be read again' }, 404);
        await activity?.record({
          kind: 'doc_added', actor: 'you', projectKey,
          subject: `asked for ${ref.join(':') || id} to be read again`, why: 'its reading failed; the worker reads it again on its next cycle', details: {}, targets: [id],
        });
        return c.body(null, 204);
      });
    }

    app.delete('/api/docs/:id', async (c) => {
      const id = c.req.param('id');
      // ids are doc:<project>:<source>:<ref>
      if (!(await shows(id.split(':')[1] ?? ''))) return c.json({ error: 'not found' }, 404);
      if (!(await docs.deleteDoc(id))) return c.json({ error: 'not found' }, 404);
      // ids are doc:<project>:<source>:<ref>
      await activity?.record({
        kind: 'doc_removed', actor: 'you', projectKey: id.split(':')[1] ?? null,
        subject: `removed ${id.split(':').slice(3).join(':') || id}`, why: 'you removed it from the Projects page', details: {}, targets: [id],
      });
      return c.body(null, 204);
    });
  }

  if (links) {
    app.get('/api/projects/:key/links', async (c) => {
      const key = c.req.param('key');
      if (!(await shows(key))) return c.json(NOT_SHOWN, 404);
      const v = await view();
      // Only links whose other end you can see: a hidden project's name never shows through a link.
      return c.json((await links.listLinks({ projectKey: key })).filter((l) => !v || (v.has(l.a) && v.has(l.b))));
    });

    app.put('/api/links', async (c) => {
      const body = LinkRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: body.error.flatten() }, 400);
      const { a, b, ...patch } = body.data;
      if (a === b) return c.json({ error: 'a project cannot be linked to itself' }, 400);
      if (!(await shows(a)) || !(await shows(b))) return c.json({ error: 'both projects must be selected' }, 404);
      const link = await links.setLink(a, b, patch);
      const [x, y] = linkPair(a, b);
      const what = patch.status === 'confirmed' ? 'confirmed' : patch.status === 'dismissed' ? 'dismissed' : patch.status === 'suggested' ? 'reopened' : 'edited';
      await activity?.record({
        kind: 'link_decided', actor: 'you', projectKey: a,
        subject: `${what} the link ${x} ↔ ${y}`,
        why: link.status === 'confirmed' ? 'agents working in either project get the best matches from the other' : link.status === 'dismissed' ? 'you said they do not belong together: it is not suggested again' : 'you changed the link',
        details: { a: x, b: y, ...patch, status: link.status, relation: link.relation }, targets: [link.id],
      });
      return c.json(link);
    });

    app.delete('/api/links/:id', async (c) => {
      const id = c.req.param('id');
      const ends = /^link:([^|]+)\|(.+)$/.exec(id);
      if (!ends || !(await shows(ends[1])) || !(await shows(ends[2]))) return c.json({ error: 'not found' }, 404);
      if (!(await links.deleteLink(id))) return c.json({ error: 'not found' }, 404);
      await activity?.record({
        kind: 'link_decided', actor: 'you', projectKey: ends[1],
        subject: `removed the link ${ends[1]} ↔ ${ends[2]}`, why: 'you removed it; the worker may suggest it again if the evidence is still there', details: {}, targets: [id],
      });
      return c.body(null, 204);
    });
  }

  if (codegraph) {
    app.use('/api/projects/:key/codemap/*', async (c, next) => {
      if (!(await shows(c.req.param('key')!))) return c.json(NOT_SHOWN, 404);
      await next();
    });
    if (inScope) {
      app.use('/api/projects/:key/codemap/*', async (c, next) => {
        if (!(await inScope(c.req.param('key')!))) return c.json({ error: 'not a selected project: choose it in Settings to see its code map' }, 404);
        await next();
      });
    }
    const mapMaxFiles = opts.mapMaxFiles ?? null;
    const HotspotQuery = hotspotQuery(mapMaxFiles);
    app.get('/api/projects/:key/codemap/hotspots', async (c) => {
      const q = HotspotQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: q.error.flatten() }, 400);
      const key = c.req.param('key');
      const [meta, hotspots] = await Promise.all([codegraph.codeMapMeta(key), codegraph.hotspots(key, q.data.limit, { includeTests: q.data.tests })]);
      return c.json({ meta, capped: mapCapped(meta, mapMaxFiles), hotspots });
    });
    if (codegraph.requestCodeMapRebuild) {
      const request = codegraph.requestCodeMapRebuild.bind(codegraph);
      // Owner-only (OWNER_ROUTES, the operator's `scan` verb): the worker remaps the project from scratch at its next pass.
      app.post('/api/projects/:key/codemap/rebuild', async (c) => {
        if (!(await request(c.req.param('key')))) return c.json({ error: 'no code map yet: the worker builds the first one within a few minutes' }, 404);
        return c.json({ queued: true }, 202);
      });
    }
    if (codegraph.mapGraph) {
      const mapGraph = codegraph.mapGraph.bind(codegraph);
      app.get('/api/projects/:key/codemap/graph', async (c) => {
        const q = MapGraphQuery.safeParse(c.req.query());
        if (!q.success) return c.json({ error: q.error.flatten() }, 400);
        const key = c.req.param('key');
        const [graph, meta] = await Promise.all([mapGraph(key, { limit: q.data.limit, includeTests: q.data.tests }), codegraph.codeMapMeta(key)]);
        // The map's size too: the graph says when the map itself is capped (SCAN_MAX_FILES).
        const g = { ...graph, meta, capped: mapCapped(meta, mapMaxFiles) };
        const v = await view();
        if (!v || !knowledge || !g.lessons.length) return c.json(g);
        // The map holds ids only: the shown approved lessons say which of them were learned in a selected project.
        const ok = new Set((await knowledge.listLessons({ status: 'approved', projectKeys: v.keys, limit: 5000 })).filter((l) => showsLesson(v, l)).map((l) => l.id));
        return c.json({ ...g, lessons: g.lessons.filter((l) => ok.has(l.id)) });
      });
    }
    app.get('/api/projects/:key/codemap/module', async (c) => {
      const path = RepoPath.safeParse(c.req.query('path'));
      if (!path.success) return c.json({ error: 'path must be a repo-relative file path' }, 400);
      const m = await codegraph.moduleContext(c.req.param('key'), path.data);
      if (!m) return c.json({ error: 'not in the code map' }, 404);
      const v = await view();
      return c.json({ ...m, lessons: m.lessons.filter((l) => showsLesson(v, l)) });
    });
    app.get('/api/projects/:key/codemap/impact', async (c) => {
      const q = ImpactQuery.safeParse({ path: c.req.queries('path') ?? [], depth: c.req.query('depth') });
      if (!q.success) return c.json({ error: q.error.flatten() }, 400);
      const r = await codegraph.impact(c.req.param('key'), [...new Set(q.data.path)], q.data.depth);
      const v = await view();
      return c.json({ ...r, lessons: r.lessons.filter((l) => showsLesson(v, l)) });
    });
    if (projectDirs) {
      // The Patterns page: where agents struggle across the selected projects (or in one of them).
      app.get('/api/codemap/hotspots', async (c) => {
        const q = TopHotspotQuery.safeParse(c.req.query());
        if (!q.success) return c.json({ error: q.error.flatten() }, 400);
        const v = await view();
        const keys = (await projectDirs()).map((p) => p.key).filter((k) => (!q.data.project || k === q.data.project) && (!v || v.has(k)));
        if (q.data.project && !keys.length) return c.json({ error: 'no such selected project' }, 404);
        const per = await Promise.all(keys.map(async (k) => (await codegraph.hotspots(k, q.data.limit, { includeTests: q.data.tests })).map((h) => ({ projectKey: k, ...h }))));
        const all = per.flat().sort((a, b) => b.score - a.score || cmp(a.projectKey, b.projectKey) || cmp(a.path, b.path));
        return c.json(all.slice(0, q.data.limit));
      });
    }
  }

  if (portability) {
    app.get('/api/export', async (c) => {
      const q = ExportQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: q.error.flatten() }, 400);
      if (q.data.project && !(await shows(q.data.project))) return c.json(NOT_SHOWN, 404);
      const bundle = await portability.exportData({ projectKey: q.data.project, approvedOnly: !!q.data.approved });
      const name = `feedback-graph-${(q.data.project ?? 'all').replace(/[^\w.-]/g, '_')}-${bundle.exportedAt.slice(0, 10)}.json`;
      c.header('content-disposition', `attachment; filename="${name}"`);
      return c.json(bundle);
    });
    app.delete('/api/projects/:key', async (c) => {
      const key = c.req.param('key');
      const body = await c.req.json().catch(() => null);
      if (body?.confirm !== key) return c.json({ error: `type the project name (${key}) to confirm` }, 400);
      // Inside the store's exclusive section; an unselected project is read in full again if you select it later.
      const removed = settings
        ? await deleteProjects(settings, portability, [key], (scope) => (k) => !scope.folder(k))
        : await portability.deleteProject(key);
      await activity?.record({
        kind: 'project_deleted', actor: 'you', projectKey: null,
        subject: `deleted everything learned from ${key}`,
        why: 'you deleted the project from the Projects page; unselect it in Settings (or add it to EXCLUDE_PROJECTS) to stop new sessions being read',
        details: { project: key, nodesRemoved: removed }, targets: [],
      });
      return c.json({ removed, note: 'New sessions in this project will be read again while it is selected in Settings (and not in EXCLUDE_PROJECTS).' });
    });
  }

  if (settings) settingsRoutes(app, settings, { activity, portability });
  if (cloud) cloudState = cloudRoutes(app, cloud);
  if (integrations) integrationRoutes(app, integrations);
  if (importer) importRoutes(app, importer);
  if (sessions) sessionRoutes(app, sessions);
  if (opts.chat) chatRoutes(app, opts.chat, view);

  if (activity) {
    app.get('/api/activity', async (c) => {
      const q = ActivityQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: q.error.flatten() }, 400);
      const { project, ...rest } = q.data;
      const projectKeys = keysFor(await view(), project);
      return c.json(await activity.list({ projectKey: project, ...rest, ...(projectKeys && { projectKeys }) }));
    });
  }

  if (insights) {
    app.get('/api/graph', async (c) => {
      const q = ProjectParam.safeParse(c.req.query());
      if (!q.success) return c.json({ error: 'project is required' }, 400);
      if (!(await shows(q.data.project))) return c.json(NOT_SHOWN, 404);
      return c.json(await insights.projectGraph(q.data.project));
    });
    app.get('/api/patterns', async (c) => {
      const project = ProjectParam.safeParse(c.req.query());
      const key = project.success ? project.data.project : undefined;
      const projectKeys = keysFor(await view(), key);
      return c.json(await insights.patterns({ ...(key && { projectKey: key }), ...(projectKeys && { projectKeys }) }));
    });
  }

  if (classifyQueue) {
    // Turns skipped for good after failed classifications (say, while the model was misconfigured) get another go.
    app.post('/api/turns/requeue', async (c) => {
      const requeued = await classifyQueue.requeueGivenUpTurns();
      if (requeued) {
        await activity?.record({
          kind: 'turns_requeued',
          actor: 'you',
          projectKey: null,
          subject: `re-queued ${requeued} turn${requeued === 1 ? '' : 's'} the classifier had given up on`,
          why: 'you asked for it (the UI, or fg)',
          details: { requeued },
          targets: [],
        });
      }
      return c.json({ requeued });
    });
  }

  if (knowledge?.retryPostmortem) {
    const retry = knowledge.retryPostmortem.bind(knowledge);
    app.post('/api/feedback/:id/retry', async (c) => {
      const id = c.req.param('id');
      // Feedback ids are the Inbox item's.
      if (shown && !(await shownCandidate(id))) return c.json({ error: 'not found' }, 404);
      return (await retry(id)) ? c.json({ queued: true }, 202) : c.json({ error: 'not found or already done' }, 404);
    });
  }

  if (knowledge) {
    app.get('/api/lessons', async (c) => {
      const q = LessonQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: q.error.flatten() }, 400);
      const projectKeys = keysFor(await view(), q.data.project);
      return c.json(await knowledge.listLessons({ status: q.data.status, projectKey: q.data.project, ...(projectKeys && { projectKeys }) }));
    });

    /** A lesson, if it was learned in (or serves) a shown project, or has no project. */
    const shownLesson = async (id: string) => {
      const d = await knowledge.lessonDetail(id);
      return d && showsLesson(await view(), d.lesson) ? d : null;
    };

    app.get('/api/lessons/:id', async (c) => {
      const d = await shownLesson(c.req.param('id'));
      return d ? c.json(d) : c.json({ error: 'not found' }, 404);
    });

    app.patch('/api/lessons/:id', async (c) => {
      const body = LessonPatch.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: body.error.flatten() }, 400);
      const id = c.req.param('id');
      const current = await shownLesson(id);
      if (!current) return c.json({ error: 'not found' }, 404);
      const p = body.data;
      let reembed: number[] | undefined;
      if (embed && (p.title !== undefined || p.rule !== undefined || p.appliesWhen !== undefined)) {
        const l = { ...current.lesson, ...p };
        [reembed] = await embed([`${l.title}\n${l.rule}\nApplies when: ${l.appliesWhen}`]);
      }
      if (p.supersedes === id) return c.json({ error: 'a lesson cannot supersede itself' }, 400);
      if (p.supersedes !== undefined && !(await shownLesson(p.supersedes))) return c.json({ error: `no lesson ${p.supersedes} to supersede` }, 400);
      const by = currentActor();
      const { unscoped } = await knowledge.updateLesson(id, p, { reembed, by });
      if (unscoped) return c.json({ error: 'this lesson has no known project, so it cannot be narrowed; it was set back to proposed. Make it global or reject it.' }, 409);
      const changed = Object.fromEntries(
        (['title', 'rule', 'appliesWhen', 'scope', 'paths'] as const)
          .filter((k) => p[k] !== undefined && JSON.stringify(p[k]) !== JSON.stringify(current.lesson[k]))
          .map((k) => [k, { from: current.lesson[k], to: p[k] }]),
      );
      await activity?.record({
        kind: 'lesson_decided',
        actor: 'you',
        projectKey: current.lesson.projectKey,
        subject: `${p.status ?? 'edited'} lesson "${p.title ?? current.lesson.title}"`,
        why: by === 'you'
          ? (p.status === 'approved' ? 'you approved it, so agents will now be given it' : p.status === 'rejected' ? 'you rejected it; agents will not see it' : 'you edited it')
          : `an agent (${by}) ${p.status === 'approved' ? 'approved it with the operator token (OPERATOR_ALLOW has lesson_decide), so agents will now be given it' : p.status === 'rejected' ? 'rejected it with the operator token; agents will not see it' : 'edited it with the operator token'}`,
        details: { status: p.status ?? current.lesson.status, changed, supersedes: p.supersedes ?? null },
        targets: [id],
      });
      return c.body(null, 204);
    });

    // A proposed lesson that states how the code is (the lesson check's looks-like-a-fact) becomes a project fact you
    // wrote: no scan replaces it, agents get it with the facts, and the lesson is rejected so it is not served twice.
    const addOwnerFact = facts?.addOwnerFact?.bind(facts);
    if (addOwnerFact && embed) {
      app.post('/api/lessons/:id/to-fact', async (c) => {
        const body = LessonToFact.safeParse((await c.req.json().catch(() => null)) ?? {});
        if (!body.success) return c.json({ error: body.error.flatten() }, 400);
        const id = c.req.param('id');
        const d = await shownLesson(id);
        if (!d) return c.json({ error: 'not found' }, 404);
        const l = d.lesson;
        if (l.status === 'rejected' || l.status === 'superseded') return c.json({ error: `this lesson is already ${l.status}` }, 409);
        const projectKey = l.projectKey ?? l.origin ?? null;
        if (!projectKey) return c.json({ error: 'this lesson has no project, so there is no project to file the fact under' }, 409);
        const by = currentActor();
        const path = lessonFactPath(l.paths);
        const why = `From the lesson "${l.title}"${d.miss ? `: ${d.miss.missed}` : ''}`;
        const [embedding] = await embed([`${path}: ${l.rule}`]);
        const fact = await addOwnerFact(projectKey, {
          kind: body.data.kind, statement: l.rule, path, lines: null, confidence: 1, why, relevance: body.data.relevance, origin: 'you', embedding,
        }, by as RelevanceBy);
        await knowledge.updateLesson(id, { status: 'rejected' }, { by, note: 'converted to a fact' });
        await activity?.record({
          kind: 'lesson_to_fact',
          actor: 'you',
          projectKey,
          subject: `converted lesson "${l.title}" to a ${body.data.kind} fact`,
          why: 'you converted it: it states how the code is, so agents now get it with the project facts (no scan replaces it) and the lesson is rejected',
          details: { kind: body.data.kind, relevance: body.data.relevance, path, statement: l.rule },
          targets: [id, fact.id],
        });
        return c.json(fact, 201);
      });
    }
  }

  if (staticDir) {
    app.use('/*', serveStatic({ root: staticDir }));
    app.get('*', serveStatic({ root: staticDir, path: 'index.html' }));
  }

  return app;
}
