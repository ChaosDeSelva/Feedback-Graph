import { requestDeadline } from './requestDeadline.ts';
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { ACTIVITY_KINDS, EVERYDAY_FROM, chunkText, mapCapped, MAX_AUTO_MAP_FILES, MODEL_JOBS, cleanLessonPath, cmp, FACT_KINDS, LESSON_CHECKS, LESSON_FROM, redactSecrets, relevanceBand, selectionNote, type ActivityStore, type CodeGraphStore, type DocsStore, type FactsStore, type GraphStore, type InsightsStore, type ModelHealth, type ModelJob, type OllamaHealth, type PipelineStatus, type ProviderHealth, type KnowledgeStore, type Lesson, type LinksStore, IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, LINK_RELATIONS, LINK_STATUSES, linkPair, linkEnds, docIdOf, NotTheRunsError, type PortabilityStore, type Project, type ProjectSelection, type RelevanceBy, type ProjectSummary, type ScanQueueEntry, type ShownProjects, type WorkQueue, type WorkQueues, type StoreKind, type SystemStatus, type WorkerStatus, contextWhy, FACT_ORIGINS, SCANNER_VERSION, RUN_ID, type RunPrincipal, type RunsStore, LESSON_QUALITY_DAYS, lessonQualityReport, type LessonQualityReport, type Candidate } from '@fb/core';
import { chatRoutes, type ChatRouteDeps } from './chat.ts';
import { trackedProject, type ContextDeps } from './context.ts';
import { authenticated, needsAuth, SECURITY_HEADERS, sessionCookie, tokenMatches, type AuthOpts } from './auth.ts';
import { cloudRoutes, cloudStatus, type CloudDeps, type CloudState } from './cloud.ts';
import { createEventHub, type FgEvent } from './events.ts';
import { demoRoutes, type DemoDeps } from './demo.ts';
import { handleMcp } from './mcp.ts';
import { handleAdminMcp } from './adminMcp.ts';
import { openApiDocument } from './openapi.ts';
import { runCaller, runKey, actingAsOperator, asActor, currentActor, currentRun, hasOperatorToken, mayChange, mayChangeAny, operatorName, OWNER_ROUTES, refusedVerb, runAs, runFromOwner, runIn, runLabel, runVia } from './operator.ts';
import { askingRun, openerOf, runAsked, runRoutes, runScoped, sameCaller } from './runs.ts';
import { evidenceRoutes, type EvidenceDeps } from './evidence.ts';
import { deleteProjects, settingsRoutes, type SettingsDeps } from './settings.ts';
import { importRoutes, type ImportDeps } from './import.ts';
import { sessionRoutes, type SessionsDeps } from './sessions.ts';
import { connectionsStatus, integrationRoutes, type IntegrationsDeps } from './integrations.ts';

export type { SettingsDeps } from './settings.ts';

export type ApiRepo = Pick<GraphStore, 'listCandidates' | 'candidateDetail' | 'decide' | 'stats'>;

const ReviewFilters = { pr: z.coerce.number().int().positive().optional(), author: z.string().trim().min(1).max(200).optional() };
const ListQuery = z.object({
  ...ReviewFilters,
  status: z.enum(['pending', 'confirmed', 'rejected']).optional(),
  project: z.string().min(1).optional(),
  source: z.enum(['claude', 'codex', 'github', 'linear']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  /** Skip this many (newest first): the next page starts where the x-next-offset header of the last one says. */
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});
/** An Inbox page when the request names no limit. */
const CANDIDATE_PAGE = 200;

/** A project's documents per page (a GitHub sync adds one per PR, so a project can hold thousands). */
const DOCS_PAGE = 100;
const DOCS_MAX_PAGE = 500;
const DocsQuery = z.object({ limit: z.coerce.number().int().min(1).max(DOCS_MAX_PAGE).optional(), cursor: z.string().min(1).max(1000).optional() });
/** Where the next page of documents starts: the addedAt and id of the last one shown, opaque to the client. */
const toDocCursor = (d: { addedAt: string; id: string }) => Buffer.from(JSON.stringify([d.addedAt, d.id])).toString('base64url');
function docCursor(s: string): { addedAt: string; id: string } | null {
  try {
    const [addedAt, id] = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown[];
    return typeof addedAt === 'string' && !Number.isNaN(Date.parse(addedAt)) && typeof id === 'string' ? { addedAt, id } : null;
  } catch {
    return null;
  }
}

const Decision = z.object({
  status: z.enum(['confirmed', 'rejected']),
  note: z.string().max(4000).optional(),
});

const Decisions = z.object({
  items: z.array(z.object({ id: z.string().min(1).max(500), decision: z.enum(['confirm', 'reject']), reason: z.string().max(4000).optional() }).strict()).min(1).max(500),
}).strict();

const MB = 1024 * 1024;
/** Chunks per embedding call; an upload of more is answered 202 and embedded in the background. */
const EMBED_BATCH = 64;
/** How long a large upload's failed embedding is said on the document (GET /api/docs/:id, the docs list). */
const EMBED_FAILED_KEPT_MS = 60 * 60_000;
const DocSourceParam = z.enum(['upload', 'github', 'linear']);
/** The most any request body may be; the upload routes below take more. */
export const BODY_LIMIT = 1 * MB;
/** A document upload (2,000,000 characters of text, or an 8 MB image as base64) and an export bundle being imported. */
const UPLOAD_LIMITS: readonly [RegExp, number][] = [
  [/^\/api\/projects\/[^/]+\/docs$/, 16 * MB],
  [/^\/api\/import$/, 256 * MB],
];
export const bodyLimitFor = (path: string) => UPLOAD_LIMITS.find(([re]) => re.test(path))?.[1] ?? BODY_LIMIT;

/** The admin MCP endpoint (owner decisions, operator token only); /mcp stays read-and-report only. */
const ADMIN_MCP = '/mcp/admin';
/** GET and DELETE /api/runs/:id: what a run wrote, and its cleanup. */
const RUN_PATH = /^\/api\/runs\/[^/]+\/?$/;

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
  /** Entire HTTP request, including middleware/store waits; defaults to55seconds. */
  requestTimeoutMs?: number;
  staticDir?: string;
  context?: ContextDeps;
  knowledge?: Pick<KnowledgeStore, 'listLessons' | 'lessonDetail' | 'updateLesson'> & Partial<Pick<KnowledgeStore, 'retryPostmortem' | 'postmortemBacklog' | 'postmortemQueue' | 'requestLessonRecheck' | 'decidedLessons'>>;
  embed?: (texts: string[]) => Promise<number[][]>;
  facts?: Pick<FactsStore, 'listProjects' | 'requestScan' | 'listFacts' | 'searchFacts'> & Partial<Pick<FactsStore, 'setFactRelevance' | 'setPinned' | 'scanJob' | 'addOwnerFact' | 'olderScannerFiles' | 'scanQueue'>>;
  /** Folders under the configured roots that can be scanned. */
  projectDirs?: () => Promise<Project[]>;
  insights?: Pick<InsightsStore, 'projectGraph' | 'patterns'>;
  activity?: Pick<ActivityStore, 'record' | 'list'> & Partial<Pick<ActivityStore, 'get' | 'removeRun'>>;
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
    runner?(): Promise<{ ok: boolean; reason: string | null }>;
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
  /** fg demo seed / remove (demo.ts). */
  demo?: DemoDeps;
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
  /** What labelled runs wrote (x-fg-run): GET and DELETE /api/runs/:id, `fg cleanup --run` (runs.ts). */
  runs?: Pick<RunsStore, 'items' | 'remove' | 'claim' | 'owner'>;
  /** GET /api/sessions/:id/evidence: what the tool saw in one session and decided (evidence.ts). */
  evidence?: EvidenceDeps;
  /** Aborted when the server shuts down: every open event stream ends at once, and no new one opens. */
  closing?: AbortSignal;
};

/**
 * `run` for a store write made in a labelled run (x-fg-run), nothing outside one so other writes stay as they were;
 * plus byOwner when the owner opened the run: the store may then replace the owner's record (it stays theirs).
 */
const runWrite = () => {
  const run = currentRun();
  return run ? { run, ...(mayChangeAny() && { byOwner: true }) } : {};
};
/** A store delete's ownership filter: in a run that may not change everything, only what the run wrote. */
const runOnly = () => (mayChangeAny() ? {} : { run: currentRun()!.id });
/** The 409 for a run's change to a record it does not own (NotTheRunsError). */
const notTheRuns = (c: Context, what: string) => c.json({ error: new NotTheRunsError(what, currentRun()?.id ?? '').message }, 409);

/** Characters of each free-text field an Inbox list row carries; GET /api/candidates/:id has them whole. */
const LIST_TEXT = 500;
const LIST_SIGNALS = 10;
const clipped = (t: string, max = LIST_TEXT) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

/**
 * An Inbox item as a list row: the summary, signals, the agent's report and a comment's title cut short, and no diff
 * hunk, so a page of the Inbox stays small whatever an agent or a model wrote (a 1 MB report once made every poll 1 MB).
 */
export function listedCandidate(k: Candidate): Candidate {
  return {
    ...k,
    classification: { ...k.classification, summary: clipped(k.classification.summary), signals: k.classification.signals.slice(0, LIST_SIGNALS).map((x) => clipped(x, 200)) },
    ...(k.agentReport && { agentReport: { ...k.agentReport, text: clipped(k.agentReport.text), whatWasDone: clipped(k.agentReport.whatWasDone) } }),
    ...(k.external && { external: { ...k.external, title: clipped(k.external.title, 300), diffHunk: null } }),
  };
}

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

/** Activity's why for a lesson decision, by you or by an agent with the operator token. */
function decidedWhy(by: string, status: 'approved' | 'rejected' | 'revoked' | 'proposed' | undefined): string {
  if (by === 'you') return status === 'revoked' ? 'you revoked a previously approved lesson; agents stop receiving it' : status === 'approved' ? 'you approved it, so agents will now be given it' : status === 'rejected' ? 'you rejected it; agents will not see it' : 'you edited it';
  return `an agent (${by}) ${status === 'revoked' ? 'revoked a previously approved lesson; agents stop receiving it' : status === 'approved' ? 'approved it with the operator token (OPERATOR_ALLOW has lesson_decide), so agents will now be given it' : status === 'rejected' ? 'rejected it with the operator token; agents will not see it' : 'edited it with the operator token'}`;
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
/** misses=1: only files a confirmed miss touched ("where agents struggle"), not the busiest ones. */
const TopHotspotQuery = z.object({ project: z.string().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(10), tests: IncludeTests, misses: IncludeTests });
/** The Graph page's Code mode: up to `limit` top files and as many neighbours, so at most twice that many nodes. */
const MapGraphQuery = z.object({ limit: z.coerce.number().int().min(1).max(300).default(60), tests: IncludeTests });
const ImpactQuery = z.object({ path: z.array(RepoPath).min(1).max(50), depth: z.coerce.number().int().min(1).max(MAX_DEPTH).default(3) });

/** The worker beats every 30s; three minutes of silence means it is down or wedged. */
const WORKER_STALE_MS = 3 * 60_000;
/** /api/pipeline counts Inbox items and lessons up to this many each (the panel only needs to know there are some). */
const PIPELINE_LIMIT = 1000;
/** /api/lessons/quality counts at most this many decisions (it says when there were more). */
const QUALITY_LIMIT = 5000;
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
  /** One run's entries (x-fg-run). */
  run: z.string().regex(RUN_ID, 'a run id: 1 to 64 letters, digits, dots, dashes or underscores').optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  /** 1: every row with its details, however big (the CLI's --json); else rows over LIST_DETAIL_BYTES leave them out. */
  details: IncludeTests,
  /** 1: labelled runs' entries too (the Activity page with "hide labelled runs" off); never another run's sandbox. */
  runs: IncludeTests,
});
/** Details bigger than this stay out of an activity list (a scan's whole report is 1 MB): GET /api/activity/:id has them. */
const LIST_DETAIL_BYTES = 1024;

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
/** Facts per page at most. A listing says where the next page starts in X-Next-Offset; no header: that was the last. */
const MAX_FACTS_PAGE = 500;
const FactsQuery = z.object({
  q: z.string().min(1).max(500).optional(),
  kind: z.enum(FACT_KINDS).optional(),
  origin: z.enum(FACT_ORIGINS).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_FACTS_PAGE).default(MAX_FACTS_PAGE),
  offset: z.coerce.number().int().min(0).default(0),
});
/** A fact as served: without `confidence`, which the extractor always set to 1 and so says nothing (still stored). */
const servedFact = <T extends { confidence?: number }>({ confidence: _, ...f }: T) => f;

const ProjectParam = z.object({ project: z.string().min(1).max(200) });
/** GET /api/lessons/quality: one project, or (unset) every shown one. */
const QualityQuery = z.object({ project: z.string().min(1).max(200).optional() });

const LessonQuery = z.object({
  ...ReviewFilters,
  status: z.enum(['proposed', 'approved', 'rejected', 'revoked', 'superseded']).optional(),
  project: z.string().min(1).optional(),
  /** Only lessons whose checks hold this flag. */
  flag: z.enum(LESSON_CHECKS).optional(),
  /** Only lessons whose feedback came from there: a GitHub or Linear comment, session pushback, memory, by hand. */
  source: z.enum(LESSON_FROM).optional(),
});

/** Many lesson decisions at once (the Lessons page's selection, `fg lessons approve|reject <id>...`). */
const LessonDecisions = z.object({
  items: z.array(z.object({
    id: z.string().min(1).max(500),
    status: z.enum(['approved', 'rejected', 'revoked']),
    note: z.string().max(4000).optional(),
  }).strict()).min(1).max(500),
}).strict();

const LessonPatch = z
  .object({
    status: z.enum(['approved', 'rejected', 'revoked', 'proposed']).optional(),
    title: z.string().min(1).max(300).optional(),
    rule: z.string().min(1).max(4000).optional(),
    appliesWhen: z.string().max(1000).optional(),
    scope: z.enum(['task', 'project', 'global']).optional(),
    paths: z.array(z.string().max(300)).max(50).optional(),
    supersedes: z.string().optional(),
    // Narrowing a global lesson (scope project or task): the project it now serves. Only for a lesson that is global.
    projectKey: z.string().min(1).max(200).optional(),
  })
  .strict();

const ExportQuery = z.object({ project: z.string().min(1).max(200).optional(), approved: z.enum(['1', 'true']).optional() });

/** For the OpenAPI document (openapi.ts). */
export const appSchemas = {
  ListQuery, Decision, Decisions, RepoPath, hotspotQuery, TopHotspotQuery, MapGraphQuery, ImpactQuery, DocUpload, ActivityQuery, ScanRequest,
  BatchScanRequest, LinkRequest, PinRequest, RelevanceRequest, FactsQuery, ProjectParam, LessonQuery, LessonPatch, LessonDecisions, LessonToFact, ExportQuery, QualityQuery, DocsQuery,
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
function modelHealth(w: WorkerStatus, ollama: OllamaHealth | null, runner: { ok: boolean; reason: string | null } | null = null): Record<ModelJob, ModelHealth> {
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
      : runner && !runner.ok && current?.startsWith('codex-cli')
        ? { provider: current, ok: false, reason: runner.reason ?? 'codex runner sandbox unavailable' }
      : ollama && !ollama.ok && current?.startsWith('ollama:')
        ? { provider: current, ok: false, reason: ollama.reason }
        : h && !h.ok
          ? { provider: current, ok: false, reason: h.reason, since: h.since ?? h.at, checkedAt: h.at }
          : { provider: current, ok: true, reason: null };
  }
  return out;
}

/** What a project not shown is called where a queue counts its work: counted, never named. */
const NOT_SHOWN_PROJECT = 'a project not shown';

/**
 * The scan queue from FactsStore.scanQueue (in the shown projects): how many wait and since when the oldest has, the
 * running scans with their shards, and every one by project.
 */
export function scanQueueOf(entries: ScanQueueEntry[]): NonNullable<WorkQueues['scans']> {
  const shards = (j: ScanQueueEntry) => (j.shards && j.shards.done !== undefined ? { done: j.shards.done, total: j.shards.total } : null);
  const since = (j: ScanQueueEntry) => (j.status === 'running' ? (j.startedAt ?? j.waitingSince) : j.waitingSince);
  const queued = entries.filter((j) => j.status === 'queued');
  const running = entries.filter((j) => j.status === 'running');
  return {
    waiting: queued.length,
    oldestAt: queued.reduce<string | null>((m, j) => (m === null || j.waitingSince < m ? j.waitingSince : m), null),
    running: running.map((j) => ({ what: j.projectKey, since: since(j), shards: shards(j) })),
    projects: entries.map((j) => ({ project: j.projectKey, status: j.status as 'queued' | 'running', since: since(j), shards: shards(j) })),
  };
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
  app.onError((error, c) => {
    const code = (error as { code?: string }).code;
    if (error.name === 'StoreDeadlineError' || code === '57014' || /(?:timeout|timed out|deadline exceeded)/i.test(error.message)) {
      return c.json({ error: 'request deadline exceeded; retry the request', retryable: true }, 504);
    }
    log?.('request failed', { error: redactSecrets(error.message).slice(0, 500) });
    return c.text('Internal Server Error', 500);
  });
  app.use('*', requestDeadline(opts.requestTimeoutMs));
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
    const operator = hasOperatorToken(c, auth.operator);
    if (c.req.header('x-fg-owner-cleanup') === 'true' && !(auth.token && tokenMatches(bearerOf(c) ?? '', auth.token))) return c.json({ error: 'owner cleanup requires the configured API_TOKEN' }, 403);
    if (needsAuth(c.req.path)) {
      if (!authenticated(c, auth.token) && !operator) return bearerOf(c) ? unrecognised(c) : c.json({ error: 'sign in required' }, 401);
      // A bearer that is neither configured token is refused on reads too (an agent with a stale token would otherwise
      // read on and never learn its writes will fail). With no token configured there is nothing to check it against;
      // "Bearer none" is the plugin's placeholder for no token.
      const offered = bearerOf(c);
      if (offered && offered !== 'none' && !operator && (auth.token || auth.operator?.token) && !(auth.token && tokenMatches(offered, auth.token))) return unrecognised(c);
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
    // A run label (x-fg-run, and on the MCP endpoints ?run=): what the request writes records it (runs.ts).
    const mcp = c.req.path === '/mcp' || c.req.path === ADMIN_MCP;
    const label = runLabel((h) => c.req.header(h), mcp ? (k) => c.req.query(k) : undefined);
    if (label && 'error' in label) return mcp ? c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: label.error } }, 400) : c.json({ error: label.error }, 400);
    // Cleaning a run up is not part of any run: a label there would claim the run for whoever cleans it (409 for the
    // owner on an agent's run; a dry run of an unused id would open it).
    const run = RUN_PATH.test(c.req.path) ? null : label;
    const browser = c.req.header('origin') !== undefined;
    const principal: RunPrincipal = operator ? 'operator' : browser ? 'browser' : auth.token && authenticated(c, auth.token) ? 'owner_token' : 'agent';
    // A run id belongs to whoever opened it (its first labelled write): a write under it by anyone else is refused, so
    // a run cannot be hijacked or mixed. With the operator token, ownership is bound to a private
    // X-FG-Run-Key capability, so a copied display name cannot hijack a run; the cleanup rules are in runs.ts.
    // Activity says how each write arrived (operator.ts runVia).
    // A run changes only what it wrote, unless the owner opened it (operator.ts mayChange).
    const fromOwner = principal === 'browser' || principal === 'owner_token';
    await runCaller(operator ? runKey(c.req.header('x-fg-run-key'), auth.runKeySalt) : null, () => runVia(operator ? 'operator' : browser ? 'browser' : 'api', () => runFromOwner(fromOwner, () => runIn(run, next))));
  });

  // Every body has a size limit, checked before anything reads it (the Content-Length, else counted as it arrives):
  // a 3 MB note is refused here, not read whole before the 4,000-character check.
  app.use('*', (c, next) => {
    const maxSize = bodyLimitFor(c.req.path);
    const error = `request body too large: this route takes at most ${maxSize / MB} MB`;
    return bodyLimit({
      maxSize,
      // An MCP client reads a JSON-RPC error, not a REST one.
      onError: (c) => (c.req.path === '/mcp' || c.req.path === ADMIN_MCP
        ? c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: error } }, 413)
        : c.json({ error }, 413)),
    })(c, next);
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

  // Claim only after body limits and owner-only authorization. MCP discovery/initialization are reads,
  // so a stale or unlabelled initialization cannot reserve a run id or make the client's tools disappear.
  app.use('*', async (c, next) => {
    const run = currentRun();
    const mcp = c.req.path === '/mcp' || c.req.path === ADMIN_MCP;
    if (mcp && c.req.method === 'POST') {
      const body = await c.req.raw.clone().json().catch(() => null) as { method?: string } | null;
      if (body?.method !== 'tools/call') return next();
    }
    const operator = hasOperatorToken(c, auth.operator);
    const browser = c.req.header('origin') !== undefined;
    const principal: RunPrincipal = operator ? 'operator' : browser ? 'browser' : auth.token && authenticated(c, auth.token) ? 'owner_token' : 'agent';
    if (run && opts.runs && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const actor = operator ? runKey(c.req.header('x-fg-run-key'), auth.runKeySalt) : null;
      if (operator && !actor) return c.json({ error: 'labelled operator writes require X-FG-Run-Key (FG_RUN_KEY): a private random secret of at least 32 characters with adequate diversity (generate: openssl rand -hex 32)' }, 403);
      // Refused attempts to edit an owner's existing record must not reserve an otherwise unused run id.
      if (!(await opts.runs.owner(run.id)) && !mayChangeAny()) {
        const lessonPath = /^\/api\/lessons\/([^/]+)(?:\/to-fact)?$/.exec(c.req.path);
        const candidatePath = /^\/api\/candidates\/([^/]+)\/decision$/.exec(c.req.path);
        const sessionPath = /^\/api\/sessions\/([^/]+)\/run$/.exec(c.req.path);
        if (sessionPath && sessions?.store.runFor && c.req.method === 'POST') {
          const id = decodeURIComponent(sessionPath[1]);
          const binding = await sessions.store.runFor(id);
          const existing = await sessions.store.detail(id);
          if ((binding && (binding.id !== run.id || binding.sandbox !== run.sandbox)) || (existing && !binding)) return c.json({ error: 'session already belongs to the owner or another run; start a new labelled session' }, 409);
        }
        if (lessonPath && !['decisions', 'recheck'].includes(lessonPath[1]) && knowledge && ['PATCH', 'POST'].includes(c.req.method)) {
          const existing = await knowledge.lessonDetail(decodeURIComponent(lessonPath[1]));
          if (existing && !mayChange(existing.lesson)) return notTheRuns(c, `the lesson ${existing.lesson.id}`);
        }
        if (candidatePath && c.req.method === 'POST') {
          const existing = await repo.candidateDetail(decodeURIComponent(candidatePath[1]));
          if (existing && !mayChange(existing.candidate)) return notTheRuns(c, `the Inbox item ${existing.candidate.id}`);
        }
        if (/^\/api\/projects\/[^/]+\/pin$/.test(c.req.path)) return notTheRuns(c, 'the project pin');
      }
      const owner = await opts.runs.claim(run.id, principal, actor);
      if (!sameCaller(owner, principal, actor)) {
        const error = `run id belongs to another caller: ${run.id} was opened by ${openerOf(owner)} at ${owner.firstSeen}; label this one with a run id of its own`;
        log?.('run refused', { method: c.req.method, path: c.req.path, run: run.id, owner: owner.principal, caller: principal });
        return mcp ? c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: error } }, 409) : c.json({ error }, 409);
      }
    }
    await next();
  });

  app.use('/mcp', async (c, next) => {
    const run = currentRun();
    if (run && sessions?.store.claimRun && c.req.method === 'POST') {
      const body = await c.req.raw.clone().json().catch(() => null) as { method?: string; params?: { arguments?: { session_id?: unknown } } } | null;
      const id = body?.method === 'tools/call' ? body.params?.arguments?.session_id : null;
      if (typeof id === 'string' && /^[\w.:-]{1,200}$/.test(id) && !await sessions.store.claimRun(id, run)) {
        return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'session already belongs to the owner or another run; start a new labelled session' } }, 409);
      }
    }
    await next();
  });

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
    const runner = system?.runner ? await system.runner().catch(() => ({ ok: false, reason: 'codex runner health check failed' })) : null;
    const workerHealthy = !!worker && Date.now() - Date.parse(worker.lastBeat) < WORKER_STALE_MS;
    const s: SystemStatus = {
      version: system?.version ?? 'dev',
      store: system?.store ?? null,
      graph,
      worker,
      workerHealthy,
      ...stageOf(workerHealthy ? worker : null),
      authRequired: !!auth.token,
      judge: context?.judgeId ?? null,
      selection: sel && { initialized: sel.initialized, tracked: sel.tracked.length, ...(system?.roots === undefined ? {} : { roots: system.roots }), note: selectionNote(sel, system?.roots) },
      cloud: cloudStatus(cloud?.cloud ?? null, cloudState),
      models: worker ? modelHealth(worker, ollama, runner) : null,
      givenUpTurns,
      ollama,
      connections: await connectionsStatus({ integrations: graph ? (integrations?.integrations ?? null) : null, deps: integrations, worker, ollama, cloud: cloud?.cloud ?? null, manualSync: cloudState?.lastManual() ?? null }).catch(() => null),
    };
    return c.json(s);
  });

  // The first-run panel: every stage's count in one call. Each count fails on its own (null), never the whole answer.
  // ?project=: one project's counts (an empty state filtered to it); the classify backlog and the stage stay worker-wide.
  // How the owner decided the post-mortem's lessons (approved as written, after an edit, rejected), in the shown
  // projects or the one asked for. Null: the store cannot tell.
  const lessonQualityFor = async (project?: string): Promise<LessonQualityReport | null> => {
    if (!knowledge?.decidedLessons) return null;
    const v = await view();
    const keys = project ? (keysFor(v, project) ?? [project]) : keysFor(v);
    const since = new Date(Date.now() - Math.max(...LESSON_QUALITY_DAYS) * 86_400_000).toISOString();
    const rows = await knowledge.decidedLessons({ projectKeys: keys ?? null, since, limit: QUALITY_LIMIT });
    return lessonQualityReport(rows.map((r) => r.lesson).filter((l) => showsLesson(v, l)), { capped: rows.length >= QUALITY_LIMIT });
  };

  const pipelineStatus = async (project?: string): Promise<PipelineStatus> => {
    const v = await view();
    const keys = project ? (keysFor(v, project) ?? [project]) : keysFor(v);
    const graph = (await system?.ping().catch(() => false)) ?? false;
    const worker = graph ? ((await system?.worker().catch(() => null)) ?? null) : null;
    const live = !!worker && Date.now() - Date.parse(worker.lastBeat) < WORKER_STALE_MS;
    const count = async <T>(fn: () => Promise<T>): Promise<T | null> => fn().catch(() => null);
    const pending = (status: 'pending' | 'confirmed') => repo.listCandidates({ status, limit: PIPELINE_LIMIT, ...(keys && { projectKeys: keys }), ...runAsked() }).then((r) => r.length);
    const lessons = (status: 'proposed' | 'approved') =>
      knowledge!.listLessons({ status, limit: PIPELINE_LIMIT, ...(keys && { projectKeys: keys }), ...runAsked() }).then((r) => r.filter((l) => showsLesson(v, l)));
    const projects = facts ? await count(async () => (await facts.listProjects()).filter((p) => (!v || v.has(p.key)) && (!project || p.key === project))) : null;
    const scans: PipelineStatus['scans'] = projects && { done: 0, queued: 0, running: 0, failed: 0, never: 0 };
    for (const p of projects ?? []) scans![p.lastScan?.status ?? 'never']++;
    // Files an older scanner read: never rescanned on their own (a scan spends your model budget), so it is said.
    const older = projects && facts?.olderScannerFiles ? await count(() => facts.olderScannerFiles!(SCANNER_VERSION)) : null;
    const olderIn = (projects ?? []).filter((p) => (older?.get(p.key) ?? 0) > 0).map((p) => [p.key, older!.get(p.key)!] as const);
    if (scans && olderIn.length) scans.olderScanner = { files: olderIn.reduce((n, [, c]) => n + c, 0), projects: Object.fromEntries(olderIn) };
    const [inboxPending, inboxConfirmed, proposed, approved, queued, scanQueue, pmQueue, chatQueue, quality] = await Promise.all([
      count(() => pending('pending')),
      count(() => pending('confirmed')),
      knowledge ? count(() => lessons('proposed')) : null,
      knowledge ? count(() => lessons('approved')) : null,
      knowledge?.postmortemBacklog ? count(() => knowledge.postmortemBacklog!()) : null,
      facts?.scanQueue ? count(() => facts.scanQueue!()) : null,
      knowledge?.postmortemQueue ? count(() => knowledge.postmortemQueue!()) : null,
      opts.chat?.store.chatQueue ? count(() => opts.chat!.store.chatQueue!()) : null,
      count(() => lessonQualityFor(project)),
    ]);
    // Back-pressure: what waits in each queue and since when, and what runs now (the worker's stage for the steps of
    // its loop). Scans count the shown projects (or the one asked for); an answer for a hidden project is not named.
    const stage = live ? worker?.stage : null;
    const runningIn = (name: string) => (stage?.name === name ? [{ what: stage.current ?? name, since: stage.startedAt }] : []);
    const backlog = worker?.backlog ?? null;
    const queues: WorkQueues = {
      scans: scanQueue && scanQueueOf(scanQueue.filter((j) => (!v || v.has(j.projectKey)) && (!project || j.projectKey === project))),
      classify: backlog ? { waiting: backlog.classify, capped: backlog.classifyCapped, oldestAt: backlog.oldestAt ?? null, running: runningIn('classify') } : null,
      postmortems: pmQueue ? { ...pmQueue, running: runningIn('postmortem') }
        : queued !== null ? { waiting: queued, oldestAt: null, running: runningIn('postmortem') } : null,
      chats: chatQueue && ({
        waiting: chatQueue.waiting, oldestAt: chatQueue.oldestAt,
        running: chatQueue.running.map((t) => ({ what: !v || v.has(t.projectKey) ? t.projectKey : NOT_SHOWN_PROJECT, since: t.startedAt })),
      } satisfies WorkQueue),
    };
    return {
      ...stageOf(live ? worker : null),
      sessions: projects ? projects.reduce((n, p) => n + p.sessions, 0) : null,
      classify: worker?.backlog ? { backlog: worker.backlog.classify, capped: worker.backlog.classifyCapped } : null,
      inbox: inboxPending === null || inboxConfirmed === null ? null : { pending: inboxPending, confirmed: inboxConfirmed },
      postmortems: queued === null ? null : { queued },
      // global: the lessons with no project of their own (they serve every project), which no project's row counts.
      lessons: proposed === null || approved === null ? null : {
        proposed: proposed.length, approved: approved.length, global: [...proposed, ...approved].filter((l) => !l.projectKey).length,
        ...(quality && { quality: quality.windows }),
      },
      scans,
      queues,
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
        // The default feed's entries: none made in a labelled run (GET /api/activity).
        const entries = await activity.list({ limit: EVENT_ACTIVITY_WINDOW, unlabelled: true, ...(v && { projectKeys: v.keys }) });
        return entries.filter((a) => !v || a.projectKey === null || v.has(a.projectKey));
      },
    }),
  });
  let streams = 0;
  app.get('/api/events', (c) => {
    if (opts.closing?.aborted) return c.json({ error: 'the API is shutting down' }, 503);
    if (streams >= MAX_EVENT_STREAMS) return c.json({ error: `too many event streams are open (${MAX_EVENT_STREAMS}): close one, or poll /api/status` }, 503);
    streams++;
    return streamSSE(c, async (stream) => {
      let close = () => {};
      const closed = new Promise<void>((resolve) => { close = resolve; });
      stream.onAbort(() => close());
      // A shutdown does not wait for the browser to hang up: the stream ends, and EventSource reconnects to the new one.
      opts.closing?.addEventListener('abort', () => close(), { once: true });
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
    // One more than the page tells whether another follows: the x-next-offset header says where it starts.
    const limit = q.data.limit ?? CANDIDATE_PAGE;
    const offset = q.data.offset ?? 0;
    const rows = await repo.listCandidates({ status: q.data.status, projectKey: q.data.project, source: q.data.source, pr: q.data.pr, author: q.data.author, limit: limit + 1, offset, ...(projectKeys && { projectKeys }), ...runAsked() });
    if (rows.length > limit) c.header('x-next-offset', String(offset + limit));
    return c.json(rows.slice(0, limit).map(listedCandidate));
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
    if (!mayChange(detail.candidate)) throw new NotTheRunsError(`the Inbox item ${id}`, currentRun()!.id);
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
    try {
      if (!(await decideCandidate(c.req.param('id'), body.data.status, body.data.note ?? null))) return c.json({ error: 'not found' }, 404);
    } catch (err) {
      if (err instanceof NotTheRunsError) return c.json({ error: err.message }, 409);
      throw err;
    }
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
      try {
        results.push((await decideCandidate(item.id, status, item.reason ?? null)) ? { id: item.id, ok: true, status } : { id: item.id, ok: false, error: 'not found' });
      } catch (err) {
        if (!(err instanceof NotTheRunsError)) throw err;
        results.push({ id: item.id, ok: false, error: err.message });
      }
    }
    return c.json({ results });
  });

  app.get('/api/stats', async (c) => {
    const v = await view();
    return c.json((await repo.stats()).filter((r) => !v || v.has(r.projectKey)));
  });

  // A labelled run's writes carry it, and a sandbox run's records are served only to that run (runs.ts).
  const mcpContext = context && runScoped(context);
  if (mcpContext) app.all('/mcp', (c) => handleMcp(c.req.raw, mcpContext));
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
        for (const l of await links.listLinks(runAsked())) {
          if (l.status !== 'confirmed' || (v && !(v.has(l.a) && v.has(l.b)))) continue;
          for (const k of [l.a, l.b]) linkCount.set(k, (linkCount.get(k) ?? 0) + 1);
        }
      }
      const linked = links ? [...known, ...fresh].map((p) => ({ ...p, links: linkCount.get(p.key) ?? 0 })) : [...known, ...fresh];
      // Files an older scanner read: the next scan you start reads them again (none starts on its own).
      const older = facts.olderScannerFiles ? await facts.olderScannerFiles(SCANNER_VERSION).catch(() => null) : null;
      const all = older ? linked.map((p) => (older.get(p.key) ? { ...p, olderScanner: older.get(p.key) } : p)) : linked;
      // Pinned first: every page lists projects in this order.
      return c.json(all.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.key.localeCompare(b.key)));
    });

    const scanReadiness = async (provider?: string | null) => {
      const selected = provider ?? (await system?.worker().catch(() => null))?.providers.scan;
      const runner = selected?.startsWith('codex-cli') ? await system?.runner?.().catch(() => ({ ok: false, reason: 'runner readiness could not be checked' })) : null;
      return runner && !runner.ok ? { blocked: true, warning: `Scan queued but parked: ${runner.reason}. No repository will be copied until runner readiness succeeds.` } : {};
    };

    app.post('/api/projects/:key/scan', async (c) => {
      const body = ScanRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!body.success) return c.json({ error: body.error.flatten() }, 400);
      const project = (await projectDirs()).find((p) => p.key === c.req.param('key'));
      if (!project) return c.json({ error: 'no such folder under the configured roots' }, 404);
      const job = await facts.requestScan(project, body.data.provider ?? null);
      return c.json({ ...job, ...await scanReadiness(body.data.provider) }, 202);
    });

    // Scan many folders in one call: `all` (every selected folder) or `keys`. Each is queued like the route above;
    // a folder that is not selected is skipped, and the answer says per key what happened.
    app.post('/api/projects/scan', async (c) => {
      const body = BatchScanRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: body.error.flatten() }, 400);
      const folders = await projectDirs();
      const v = await view();
      const keys = body.data.all ? folders.map((p) => p.key).filter((k) => !v || v.has(k)) : [...new Set(body.data.keys)];
      const readiness = await scanReadiness(body.data.provider);
      const results = [];
      for (const key of keys) {
        const project = folders.find((p) => p.key === key);
        if (!project) results.push({ key, queued: false, error: 'no such folder under the configured roots' });
        else if (v && !v.has(key)) results.push({ key, queued: false, error: 'not selected: choose it in Settings first' });
        else results.push({ key, queued: true, ...readiness, job: { ...await facts.requestScan(project, body.data.provider ?? null), ...readiness } });
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
        if (job.status === 'queued' && facts.scanQueue) {
          // The order the queue serves (a scan that gave way waits behind those queued since); every project counts.
          const queued = (await facts.scanQueue()).filter((j) => j.status === 'queued');
          const at = queued.findIndex((j) => j.id === job.id);
          queuePosition = at < 0 ? null : at + 1;
        } else if (job.status === 'queued') {
          const ahead = (await facts.listProjects()).filter((p) => p.lastScan?.status === 'queued' && p.lastScan.id !== job.id && p.lastScan.requestedAt < job.requestedAt).length;
          queuePosition = ahead + 1;
        }
        return c.json({ ...job, queuePosition, ...(job.status === 'queued' ? await scanReadiness(job.provider) : {}) });
      });
    }

    app.get('/api/projects/:key/facts', async (c) => {
      const q = FactsQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: q.error.flatten() }, 400);
      const projectKey = c.req.param('key');
      if (!(await shows(projectKey))) return c.json(NOT_SHOWN, 404);
      if (q.data.q && embed) {
        const [embedding] = await embed([q.data.q]);
        return c.json((await facts.searchFacts({ embedding, projectKey, k: 30 })).map((h) => ({ ...h, fact: servedFact(h.fact) })));
      }
      const { kind, origin, limit, offset } = q.data;
      // One more than asked, so the page can say whether another follows.
      const rows = await facts.listFacts({ projectKey, ...(kind && { kind }), ...(origin && { origin }), limit: limit + 1, offset, ...runAsked() });
      if (rows.length > limit) c.header('X-Next-Offset', String(offset + limit));
      return c.json(rows.slice(0, limit).map(servedFact));
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
        // A project's pin is the owner's: no run's record, so a run cannot change it (nor cleanup undo it).
        if (!mayChangeAny()) return notTheRuns(c, `the pin of ${project.key}`);
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
        // In a run, only a fact the run wrote; otherwise the owner's setting (a run's fact becomes the owner's).
        const changed = await setRelevance([{ id, relevance: body.data.relevance, by: currentActor() as RelevanceBy, projectKey, run: mayChangeAny() ? null : currentRun()!.id }]);
        if (!changed) return c.json({ error: currentRun() ? 'no such fact in this project among the facts this run wrote' : 'no such fact in this project' }, 404);
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
    /**
     * Large uploads being embedded in the background (202), and those that failed, by doc id: the status the docs list
     * and GET /api/docs/:id carry (embed). Kept in this process, which is where the embedding runs: if it stops, so does
     * the embedding, and the document is either stored or not there. A failure is kept for EMBED_FAILED_KEPT_MS.
     */
    type Embedding = { status: 'pending' | 'failed'; error?: string; chunks: number; at: number; doc: { projectKey: string; ref: string; title: string; addedBy: string | null; kind: 'text' | 'image'; mediaType: string | null } };
    const embedding = new Map<string, Embedding>();
    const embedOf = (id: string) => {
      const e = embedding.get(id);
      if (e?.status === 'failed' && Date.now() - e.at > EMBED_FAILED_KEPT_MS) embedding.delete(id);
      const kept = embedding.get(id);
      return kept && { status: kept.status, ...(kept.error && { error: kept.error }), chunks: kept.chunks };
    };
    const withEmbed = <D extends { id: string }>(d: D) => {
      const e = embedOf(d.id);
      return e ? { ...d, embed: e } : d;
    };

    app.get('/api/projects/:key/docs', async (c) => {
      const key = c.req.param('key');
      if (!(await shows(key))) return c.json(NOT_SHOWN, 404);
      const q = DocsQuery.safeParse(c.req.query());
      const after = q.success && q.data.cursor ? docCursor(q.data.cursor) : null;
      if (!q.success || (q.data.cursor && !after)) return c.json({ error: `send limit (1-${DOCS_MAX_PAGE}) and the cursor of the page before (x-next-cursor)` }, 400);
      // One more than the page tells whether another follows: the x-next-cursor header says where it starts.
      const limit = q.data.limit ?? DOCS_PAGE;
      const rows = await docs.listDocs(key, { limit: limit + 1, after, run: askingRun() });
      const page = rows.slice(0, limit);
      if (rows.length > limit) c.header('x-next-cursor', toDocCursor(page.at(-1)!));
      return c.json(page.map(withEmbed));
    });

    // One document by id, with its embed status: what the Projects page checks while a large upload is embedded (the
    // document may be past the list's first page). Not stored yet: what is known of the upload, while it is pending or failed.
    app.get('/api/docs/:id', async (c) => {
      const id = c.req.param('id');
      // ids are doc[@<run>]:<project>:<source>:<ref>
      const [, projectKey = '', source = '', ...ref] = id.split(':');
      if (!(await shows(projectKey))) return c.json({ error: 'not found' }, 404);
      const src = DocSourceParam.safeParse(source);
      const stored = src.success ? (await docs.listDocs(projectKey, { source: src.data, ref: ref.join(':'), limit: 5, run: askingRun() })).find((d) => d.id === id) : undefined;
      if (stored) return c.json(withEmbed(stored));
      // Another run's sandbox upload (doc@<run>:...) is not shown, as in the list.
      const run = id.startsWith('doc@') ? id.slice(4, id.indexOf(':')) : null;
      const e = run === null || run === askingRun() ? embedOf(id) : undefined;
      const known = embedding.get(id);
      if (!e || !known) return c.json({ error: 'not found' }, 404);
      return c.json({ id, ...known.doc, source: 'upload', url: null, addedAt: new Date(known.at).toISOString(), chunks: 0, read: null, embed: e });
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
      // Same file name, same doc: say so, rather than logging a fresh upload over a silent replacement. A sandbox run's
      // upload is its own document beside the owner's of that name (docIdOf), so only that one is a replacement.
      const replaces = docIdOf({ projectKey: project.key, source: 'upload', ref: redactSecrets(name) }, currentRun());
      const add = async (): Promise<string> => {
        // In batches: one embedding call for a 2,000,000-character upload (1,300+ chunks) outlasts any timeout.
        const vectors: number[][] = [];
        for (let i = 0; i < chunks.length; i += EMBED_BATCH) vectors.push(...(await embed(chunks.slice(i, i + EMBED_BATCH))));
        const previous = (await docs.listDocs(project.key, { source: 'upload', ref: name, limit: 2, run: askingRun() })).find((d) => d.id === replaces);
        const id = await docs.upsertDoc(
          { projectKey: project.key, source: 'upload', ref: name, title, url: null },
          chunks.map((text, i) => ({ text, embedding: vectors[i] })),
          { read: true, addedBy: currentActor(), ...runWrite(), ...(image && { image }) },
        );
        const what = image ? `image "${title}"` : `"${title}" (${chunks.length} chunk${chunks.length === 1 ? '' : 's'})`;
        await activity?.record({
          kind: 'doc_added', actor: 'you', projectKey: project.key,
          subject: `${previous ? `replaced "${previous.title}" with` : 'uploaded'} ${what}`,
          why: 'you added it as context; the worker reads it into facts, and agents get matching excerpts and facts with their task context',
          details: image ? { name, mediaType: image.mediaType, bytes: Math.floor((image.data.length * 3) / 4) } : { name, chars: body.data.text!.length }, targets: [id],
        });
        return id;
      };
      if (chunks.length > EMBED_BATCH) {
        // A large upload is answered now and embedded in the background (the request's run and actor go with it): it is
        // pending (embed) until stored, the earlier version of that name meanwhile marked so in the list; a failure is
        // kept on it with why, and logged in Activity.
        const doc = { projectKey: project.key, ref: name, title, addedBy: currentActor(), kind: image ? 'image' as const : 'text' as const, mediaType: image?.mediaType ?? null };
        const started = { status: 'pending' as const, chunks: chunks.length, at: Date.now(), doc };
        embedding.set(replaces, started);
        void add().then(() => {
          if (embedding.get(replaces) === started) embedding.delete(replaces);
        }, async (err) => {
          const reason = err instanceof NotTheRunsError ? err.message : redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300);
          if (embedding.get(replaces) === started) embedding.set(replaces, { ...started, status: 'failed', error: reason, at: Date.now() });
          log?.('upload failed', { project: project.key, name, error: reason });
          await activity?.record({
            kind: 'doc_added', actor: 'you', projectKey: project.key, subject: `could not add "${title}": ${reason}`,
            why: 'the upload was accepted, but embedding or storing its text failed; upload it again', details: { name, failed: true }, targets: [replaces],
          }).catch(() => {});
        });
        return c.json({ id: replaces, chunks: chunks.length, pending: true }, 202);
      }
      try {
        return c.json({ id: await add(), chunks: chunks.length }, 201);
      } catch (err) {
        if (err instanceof NotTheRunsError) return c.json({ error: err.message }, 409);
        throw err;
      }
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
      // In a run, only a document the run uploaded (runOnly).
      if (!(await docs.deleteDoc(id, runOnly()))) return c.json({ error: currentRun() ? 'not found among the documents this run uploaded' : 'not found' }, 404);
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
      return c.json((await links.listLinks({ projectKey: key, ...runAsked() })).filter((l) => !v || (v.has(l.a) && v.has(l.b))));
    });

    app.put('/api/links', async (c) => {
      const body = LinkRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: body.error.flatten() }, 400);
      const { a, b, ...patch } = body.data;
      if (a === b) return c.json({ error: 'a project cannot be linked to itself' }, 400);
      if (!(await shows(a)) || !(await shows(b))) return c.json({ error: 'both projects must be selected' }, 404);
      let link;
      try {
        link = await links.setLink(a, b, { ...patch, decidedBy: currentActor(), ...runWrite() });
      } catch (err) {
        if (err instanceof NotTheRunsError) return c.json({ error: err.message }, 409);
        throw err;
      }
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
      const ends = linkEnds(id);
      if (!ends || !(await shows(ends[0])) || !(await shows(ends[1]))) return c.json({ error: 'not found' }, 404);
      // In a run, only a link the run made (runOnly).
      if (!(await links.deleteLink(id, runOnly()))) return c.json({ error: currentRun() ? 'not found among the links this run made' : 'not found' }, 404);
      await activity?.record({
        kind: 'link_decided', actor: 'you', projectKey: ends[0],
        subject: `removed the link ${ends[0]} ↔ ${ends[1]}`, why: 'you removed it; the worker may suggest it again if the evidence is still there', details: {}, targets: [id],
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
      const [meta, hotspots] = await Promise.all([codegraph.codeMapMeta(key), codegraph.hotspots(key, q.data.limit, { includeTests: q.data.tests, ...runAsked() })]);
      return c.json({ meta, capped: mapCapped(meta, mapMaxFiles), hotspots });
    });
    if (codegraph.requestCodeMapRebuild) {
      const request = codegraph.requestCodeMapRebuild.bind(codegraph);
      // Owner-only (OWNER_ROUTES, the operator's `scan` verb): the worker remaps the project from scratch at its next pass.
      app.post('/api/projects/:key/codemap/rebuild', async (c) => {
        const key = c.req.param('key');
        if (!(await request(key))) return c.json({ error: 'no code map yet: the worker builds the first one within a few minutes' }, 404);
        await activity?.record({
          kind: 'code_mapped', actor: 'you', projectKey: key,
          subject: `asked for a rebuild of the code map of ${key}`,
          why: 'you asked for it: the worker remaps the project from scratch at its next pass (a code_mapped entry follows when it is done)',
          details: { requested: true }, targets: [],
        });
        return c.json({ queued: true }, 202);
      });
    }
    if (codegraph.mapGraph) {
      const mapGraph = codegraph.mapGraph.bind(codegraph);
      app.get('/api/projects/:key/codemap/graph', async (c) => {
        const q = MapGraphQuery.safeParse(c.req.query());
        if (!q.success) return c.json({ error: q.error.flatten() }, 400);
        const key = c.req.param('key');
        const [graph, meta] = await Promise.all([mapGraph(key, { limit: q.data.limit, includeTests: q.data.tests, ...runAsked() }), codegraph.codeMapMeta(key)]);
        // The map's size too: the graph says when the map itself is capped (SCAN_MAX_FILES).
        const g = { ...graph, meta, capped: mapCapped(meta, mapMaxFiles) };
        const v = await view();
        if (!v || !knowledge || !g.lessons.length) return c.json(g);
        // The map holds ids only: the shown approved lessons say which of them were learned in a selected project.
        const ok = new Set((await knowledge.listLessons({ status: 'approved', projectKeys: v.keys, limit: 5000, ...runAsked() })).filter((l) => showsLesson(v, l)).map((l) => l.id));
        return c.json({ ...g, lessons: g.lessons.filter((l) => ok.has(l.id)) });
      });
    }
    app.get('/api/projects/:key/codemap/module', async (c) => {
      const path = RepoPath.safeParse(c.req.query('path'));
      if (!path.success) return c.json({ error: 'path must be a repo-relative file path' }, 400);
      const m = await codegraph.moduleContext(c.req.param('key'), path.data, askingRun());
      if (!m) return c.json({ error: 'not in the code map' }, 404);
      const v = await view();
      return c.json({ ...m, lessons: m.lessons.filter((l) => showsLesson(v, l)) });
    });
    app.get('/api/projects/:key/codemap/impact', async (c) => {
      const q = ImpactQuery.safeParse({ path: c.req.queries('path') ?? [], depth: c.req.query('depth') });
      if (!q.success) return c.json({ error: q.error.flatten() }, 400);
      const r = await codegraph.impact(c.req.param('key'), [...new Set(q.data.path)], q.data.depth, askingRun());
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
        const per = await Promise.all(keys.map(async (k) => (await codegraph.hotspots(k, q.data.limit, { includeTests: q.data.tests, ...(q.data.misses && { missesOnly: true }), ...runAsked() })).map((h) => ({ projectKey: k, ...h }))));
        const all = per.flat().sort((a, b) => b.score - a.score || cmp(a.projectKey, b.projectKey) || cmp(a.path, b.path));
        return c.json(all.slice(0, q.data.limit));
      });
    }
  }

  if (portability) {
    app.get('/api/export', async (c) => {
      const q = ExportQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: q.error.flatten() }, 400);
      const approvedOnly = !!q.data.approved;
      let bundle;
      if (q.data.project) {
        if (!(await shows(q.data.project))) return c.json(NOT_SHOWN, 404);
        bundle = await portability.exportData({ projectKey: q.data.project, approvedOnly });
      } else {
        // Everything means every selected project: one you unselected stays out, though its data is still stored.
        const v = await view();
        bundle = await portability.exportData(v ? { projectKeys: v.keys, approvedOnly } : { approvedOnly });
      }
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
  if (opts.demo) demoRoutes(app, { ...opts.demo, activity: opts.demo.activity ? asActor(opts.demo.activity) : activity }, { operator: auth.operator });
  if (sessions) sessionRoutes(app, sessions);
  if (opts.chat) chatRoutes(app, opts.chat, view);
  if (opts.runs && activity) runRoutes(app, { store: opts.runs, activity });
  if (opts.evidence) evidenceRoutes(app, opts.evidence);

  if (activity) {
    app.get('/api/activity', async (c) => {
      const q = ActivityQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: q.error.flatten() }, 400);
      const { project, details, runs: withRuns, ...rest } = q.data;
      const projectKeys = keysFor(await view(), project);
      // The default feed is what happened outside test runs: a stress run's thousands of entries never fill it, and
      // a sandbox run's reach no one but a request for that run (?run=). A record's history (target=) keeps the runs
      // that touched it, but not a sandbox run's.
      const runs = rest.run ? {} : rest.target || withRuns ? { noSandbox: true } : { unlabelled: true };
      return c.json(await activity.list({ projectKey: project, ...rest, ...runs, ...(!details && { maxDetailBytes: LIST_DETAIL_BYTES }), ...(projectKeys && { projectKeys }) }));
    });
    // One entry, details and all (a row the list left them out of: detailsOmitted).
    app.get('/api/activity/:id', async (c) => {
      const a = await activity.get?.(c.req.param('id'));
      const v = await view();
      return a && (!v || a.projectKey === null || v.has(a.projectKey)) ? c.json(a) : c.json({ error: 'not found' }, 404);
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
      const { status, project, flag, source, pr, author } = q.data;
      return c.json(await knowledge.listLessons({
        status, pr, author, projectKey: project, ...(projectKeys && { projectKeys }), ...(flag && { flag }), ...(source && { from: source }), ...runAsked(),
      }));
    });

    // Before /api/lessons/:id, which would take "quality" for a lesson id.
    app.get('/api/lessons/quality', async (c) => {
      const p = QualityQuery.safeParse(c.req.query());
      if (!p.success) return c.json({ error: p.error.flatten() }, 400);
      const q = await lessonQualityFor(p.data.project);
      return q ? c.json(q) : c.json({ error: 'this store cannot count lesson decisions' }, 404);
    });
    /** A project a lesson can be narrowed to: a folder under the roots or one the store knows, and selected. */
    const knownProject = async (key: string) => {
      if (!(await shows(key))) return false;
      if ((await projectDirs?.().catch(() => []))?.some((p) => p.key === key)) return true;
      return !!(await facts?.listProjects().catch(() => []))?.some((p) => p.key === key);
    };

    /** A lesson, if it was learned in (or serves) a shown project, or has no project. */
    const shownLesson = async (id: string) => {
      const d = await knowledge.lessonDetail(id);
      // A why stored before the worker checked it (a model's echoed field name) reads as no reason, not as the word.
      return d && showsLesson(await view(), d.lesson) ? { ...d, contextItems: (d.contextItems ?? []).map((ci) => ({ ...ci, why: contextWhy(ci.why) })) } : null;
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
      if (!mayChange(current.lesson)) return notTheRuns(c, `the lesson ${id}`);
      const p = body.data;
      if (p.status === 'revoked' && current.lesson.status !== 'approved') return c.json({ error: 'only a previously approved lesson can be revoked; reject a proposal instead' }, 409);
      let reembed: number[] | undefined;
      if (embed && (p.title !== undefined || p.rule !== undefined || p.appliesWhen !== undefined)) {
        const l = { ...current.lesson, ...p };
        [reembed] = await embed([`${l.title}\n${l.rule}\nApplies when: ${l.appliesWhen}`]);
      }
      if (p.projectKey !== undefined) {
        const narrowing = current.lesson.scope === 'global' && (p.scope === 'project' || p.scope === 'task');
        if (!narrowing) return c.json({ error: 'projectKey only narrows a global lesson: send it with scope project or task' }, 400);
        if (!(await knownProject(p.projectKey))) return c.json({ error: `no project ${p.projectKey} (or it is not selected): choose one from Settings` }, 400);
      }
      if (p.supersedes === id) return c.json({ error: 'a lesson cannot supersede itself' }, 400);
      if (p.supersedes !== undefined && !(await shownLesson(p.supersedes))) return c.json({ error: `no lesson ${p.supersedes} to supersede` }, 400);
      const by = currentActor();
      const { unscoped } = await knowledge.updateLesson(id, p, { reembed, by });
      if (unscoped) return c.json({ error: 'this lesson has no known project, so it cannot be narrowed without one; it was set back to proposed. Name the project (projectKey), make it global, or reject it.' }, 409);
      const changed = Object.fromEntries(
        (['title', 'rule', 'appliesWhen', 'scope', 'paths', 'projectKey'] as const)
          .filter((k) => p[k] !== undefined && JSON.stringify(p[k]) !== JSON.stringify(current.lesson[k]))
          .map((k) => [k, { from: current.lesson[k], to: p[k] }]),
      );
      await activity?.record({
        kind: 'lesson_decided',
        actor: 'you',
        projectKey: p.projectKey ?? current.lesson.projectKey,
        subject: `${p.status ?? 'edited'} lesson "${p.title ?? current.lesson.title}"`,
        why: decidedWhy(by, p.status),
        details: { status: p.status ?? current.lesson.status, changed, supersedes: p.supersedes ?? null },
        targets: [id],
      });
      return c.body(null, 204);
    });

    // Owner-only (OWNER_ROUTES, the operator's lesson_decide, off by default). Each lesson is decided and recorded on
    // its own (decidedBy, Activity), as if decided one at a time; one not found (or not shown) does not stop the rest.
    app.post('/api/lessons/decisions', async (c) => {
      const body = LessonDecisions.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: body.error.flatten() }, 400);
      const by = currentActor();
      const results = [];
      for (const item of body.data.items) {
        const current = await shownLesson(item.id);
        if (!current) {
          results.push({ id: item.id, ok: false, error: 'not found' });
          continue;
        }
        if (!mayChange(current.lesson)) {
          results.push({ id: item.id, ok: false, error: new NotTheRunsError(`the lesson ${item.id}`, currentRun()!.id).message });
          continue;
        }
        if (item.status === 'revoked' && current.lesson.status !== 'approved') { results.push({ id: item.id, ok: false, error: 'only a previously approved lesson can be revoked' }); continue; }
        await knowledge.updateLesson(item.id, { status: item.status }, { by, ...(item.note && { note: item.note }) });
        await activity?.record({
          kind: 'lesson_decided',
          actor: 'you',
          projectKey: current.lesson.projectKey,
          subject: `${item.status} lesson "${current.lesson.title}"`,
          why: decidedWhy(by, item.status),
          details: { status: item.status, changed: {}, supersedes: null, bulk: true, ...(item.note && { note: item.note }) },
          targets: [item.id],
        });
        results.push({ id: item.id, ok: true, status: item.status });
      }
      return c.json({ results });
    });

    // Owner-only (the operator's `retry`): flags only, so not a decision. The worker re-checks them at its next round.
    const requestRecheck = knowledge.requestLessonRecheck?.bind(knowledge);
    if (requestRecheck) {
      app.post('/api/lessons/recheck', async (c) => {
        const queued = await requestRecheck();
        await activity?.record({
          kind: 'lessons_checked',
          actor: 'you',
          projectKey: null,
          subject: `${queued} lesson${queued === 1 ? '' : 's'} queued for a re-check`,
          why: 'you asked for it (the UI, or fg lessons recheck): the worker re-runs the lesson checks on every proposed and approved lesson at its next round',
          details: { queued },
          targets: [],
        });
        return c.json({ queued }, 202);
      });
    }

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
        // Converting rejects the lesson: a run may do that only to its own.
        if (!mayChange(d.lesson)) return notTheRuns(c, `the lesson ${id}`);
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
        }, by as RelevanceBy, ...(currentRun() ? [currentRun()] : []));
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

  // Last of the API: a path no route above answers is a JSON 404, not the UI's page with a 200.
  app.all('/api/*', (c) => c.json({ error: `not found: no such API route (${c.req.method} ${c.req.path}); the routes are listed at /api/openapi.json` }, 404));

  if (staticDir) {
    app.use('/*', serveStatic({ root: staticDir }));
    app.get('*', serveStatic({ root: staticDir, path: 'index.html' }));
  }

  return app;
}
