import { Hono, type Context, type Next } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { ACTIVITY_KINDS, chunkText, MODEL_JOBS, cleanLessonPath, cmp, FACT_KINDS, redactSecrets, selectionNote, type ActivityStore, type CodeGraphStore, type DocsStore, type FactsStore, type GraphStore, type InsightsStore, type ModelHealth, type ModelJob, type OllamaHealth, type KnowledgeStore, type Lesson, type PortabilityStore, type Project, type ProjectSelection, type ProjectSummary, type ShownProjects, type StoreKind, type SystemStatus, type WorkerStatus } from '@fb/core';
import { trackedProject, type ContextDeps } from './context.ts';
import { authenticated, needsAuth, SECURITY_HEADERS, sessionCookie, tokenMatches, type AuthOpts } from './auth.ts';
import { cloudRoutes, cloudStatus, type CloudDeps } from './cloud.ts';
import { handleMcp } from './mcp.ts';
import { deleteProjects, settingsRoutes, type SettingsDeps } from './settings.ts';
import { importRoutes, type ImportDeps } from './import.ts';
import { sessionRoutes, type SessionsDeps } from './sessions.ts';
import { connectionsStatus, integrationRoutes, type IntegrationsDeps } from './integrations.ts';

export type { SettingsDeps } from './settings.ts';

export type ApiRepo = Pick<GraphStore, 'listCandidates' | 'candidateDetail' | 'decide' | 'stats'>;

const ListQuery = z.object({
  status: z.enum(['pending', 'confirmed', 'rejected']).optional(),
  project: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const Decision = z.object({
  status: z.enum(['confirmed', 'rejected']),
  note: z.string().max(4000).optional(),
});

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
  knowledge?: Pick<KnowledgeStore, 'listLessons' | 'lessonDetail' | 'updateLesson'> & Partial<Pick<KnowledgeStore, 'retryPostmortem'>>;
  embed?: (texts: string[]) => Promise<number[][]>;
  facts?: Pick<FactsStore, 'listProjects' | 'requestScan' | 'listFacts' | 'searchFacts'>;
  /** Folders under the configured roots that can be scanned. */
  projectDirs?: () => Promise<Project[]>;
  insights?: Pick<InsightsStore, 'projectGraph' | 'patterns'>;
  activity?: Pick<ActivityStore, 'record' | 'list'>;
  docs?: Pick<DocsStore, 'upsertDoc' | 'listDocs' | 'deleteDoc'>;
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
  codegraph?: Pick<CodeGraphStore, 'hotspots' | 'moduleContext' | 'impact' | 'codeMapMeta'> & Partial<Pick<CodeGraphStore, 'mapGraph'>>;
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
const HotspotQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), tests: IncludeTests });
const TopHotspotQuery = z.object({ project: z.string().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(10), tests: IncludeTests });
/** The Graph page's Code mode: up to `limit` top files and as many neighbours, so at most twice that many nodes. */
const MapGraphQuery = z.object({ limit: z.coerce.number().int().min(1).max(300).default(60), tests: IncludeTests });
const ImpactQuery = z.object({ path: z.array(RepoPath).min(1).max(50), depth: z.coerce.number().int().min(1).max(MAX_DEPTH).default(3) });

/** The worker beats every 30s; three minutes of silence means it is down or wedged. */
const WORKER_STALE_MS = 3 * 60_000;

const DocUpload = z
  .object({
    title: z.string().min(1).max(300),
    name: z.string().min(1).max(200).regex(/^[\w][\w .()-]*$/, 'a plain file name'),
    text: z.string().min(1).max(2_000_000),
  })
  .strict();

const ActivityQuery = z.object({
  project: z.string().min(1).max(200).optional(),
  kind: z.enum(ACTIVITY_KINDS).optional(),
  target: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const ScanRequest = z.object({ provider: z.string().regex(/^[a-z][a-z-]*(:[\w./:-]+)?$/).optional() }).strict();
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

/** Each job's model as the worker last reported it. A job with no model (it could not be built) is unavailable, and
 * so is an Ollama model while Ollama does not answer, whether or not a job has asked it yet. */
function modelHealth(w: WorkerStatus, ollama: OllamaHealth | null): Record<ModelJob, ModelHealth> {
  const out = {} as Record<ModelJob, ModelHealth>;
  for (const job of MODEL_JOBS) {
    const provider = w.providers[job] ?? null;
    const h = w.health?.[job];
    const current = h?.provider ?? provider;
    // A worker older than the summary report leaves the key out: unknown, not broken.
    const unbuilt = !provider && (job === 'classify' || (job === 'summary' && job in w.providers));
    out[job] = w.off?.includes(job)
      ? { provider: null, ok: true, reason: null, off: true }
      : unbuilt
      ? { provider: null, ok: false, reason: job === 'classify' ? 'no classifier is configured (see the worker log)' : 'no summary model could be built (SUMMARY_LLM; see the worker log): summaries are paused' }
      : ollama && !ollama.ok && current?.startsWith('ollama:')
        ? { provider: current, ok: false, reason: ollama.reason }
        : { provider: current, ok: h?.ok ?? true, reason: h?.reason ?? null };
  }
  return out;
}

export function createApp(repo: ApiRepo, opts: AppOpts = {}) {
  const { staticDir, context, knowledge, embed, facts, projectDirs, insights, activity, docs, auth = {}, system, portability, settings, log, codegraph, classifyQueue, inScope, importer, cloud, sessions, shown, integrations } = opts;
  /** null: no selection to apply (everything is shown). */
  const view = async (): Promise<ShownProjects | null> => (shown ? await shown() : null);
  const shows = async (key: string) => {
    const v = await view();
    return !v || v.has(key);
  };
  const app = new Hono();
  // Other host names are only safe once a token stands between them and the API.
  const hosts = new Set([...LOCAL_HOSTS, ...(auth.token ? (auth.publicHosts ?? []).map((h) => h.toLowerCase()) : [])]);

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
    const logged = c.req.path === '/mcp' || (c.req.path.startsWith('/api/') && c.req.path !== '/api/health');
    if (log && logged) {
      log('request', { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started });
    }
  });

  // Refuse DNS-rebinding hosts and cross-site writes; with a token configured, require it.
  app.use('*', async (c, next) => {
    const host = hostname(c.req.header('host') ?? new URL(c.req.url).host);
    if (!hosts.has(host)) return c.json({ error: 'forbidden host' }, 403);
    if (needsAuth(c.req.path) && !authenticated(c, auth.token)) return c.json({ error: 'sign in required' }, 401);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const site = c.req.header('sec-fetch-site');
      if (site === 'cross-site' || site === 'same-site') return c.json({ error: 'cross-site write' }, 403);
      // Browsers always send Origin on cross-origin writes; MCP/CLI clients send none.
      const origin = c.req.header('origin');
      if (origin !== undefined && !originAllowed(origin, c.req.header('host') ?? new URL(c.req.url).host)) {
        return c.json({ error: 'cross-origin write' }, 403);
      }
      if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'json required' }, 415);
    }
    await next();
  });

  // Decisions that teach agents are yours: they must come from the UI (browsers always send Origin on writes).
  // A local agent with curl sends none. This stops accidental self-approval; it cannot stop a process that
  // deliberately forges headers (that process could read .env and the database anyway).
  const ownerOnly = async (c: Context, next: Next) => {
    if (c.req.header('origin') === undefined) {
      return c.json({ error: 'only you can make this decision, from the Feedback Graph UI' }, 403);
    }
    await next();
  };
  for (const [method, path] of [
    ['POST', '/api/candidates/:id/decision'],
    ['PATCH', '/api/lessons/:id'],
    ['POST', '/api/projects/:key/scan'],
    ['POST', '/api/projects/:key/docs'],
    ['DELETE', '/api/docs/:id'],
    ['DELETE', '/api/projects/:key'],
    ['POST', '/api/feedback/:id/retry'],
    ['PUT', '/api/settings/projects'],
    ['PUT', '/api/settings/roots'],
    ['POST', '/api/settings/cleanup'],
    ['POST', '/api/cloud/sync'],
    ['POST', '/api/turns/requeue'],
    ['POST', '/api/import'],
    ['POST', '/api/sessions/:id/resummarize'],
    ['PUT', '/api/settings/integrations/:kind'],
    ['POST', '/api/settings/integrations/:kind/test'],
    ['DELETE', '/api/settings/integrations/:kind'],
    ['PUT', '/api/settings/integrations/projects/:key'],
  ] as const) app.on(method, path, ownerOnly);

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
    const s: SystemStatus = {
      version: system?.version ?? 'dev',
      store: system?.store ?? null,
      graph,
      worker,
      workerHealthy: !!worker && Date.now() - Date.parse(worker.lastBeat) < WORKER_STALE_MS,
      authRequired: !!auth.token,
      selection: sel && { initialized: sel.initialized, tracked: sel.tracked.length, ...(system?.roots === undefined ? {} : { roots: system.roots }), note: selectionNote(sel, system?.roots) },
      cloud: cloudStatus(cloud?.cloud ?? null),
      models: worker ? modelHealth(worker, ollama) : null,
      givenUpTurns,
      ollama,
      connections: await connectionsStatus({ integrations: graph ? (integrations?.integrations ?? null) : null, worker, ollama, cloud: cloud?.cloud ?? null }).catch(() => null),
    };
    return c.json(s);
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
    return c.json(await repo.listCandidates({ status: q.data.status, projectKey: q.data.project, limit: q.data.limit, ...(projectKeys && { projectKeys }) }));
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

  app.post('/api/candidates/:id/decision', async (c) => {
    const body = Decision.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const id = c.req.param('id');
    const detail = await shownCandidate(id);
    if (!detail) return c.json({ error: 'not found' }, 404);
    await repo.decide(id, body.data.status, body.data.note ?? null);
    const text = detail.turn.text ?? '';
    await activity?.record({
      kind: 'feedback_decided',
      actor: 'you',
      projectKey: detail.candidate.projectKey,
      subject: `${body.data.status}: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`,
      why: body.data.note || (body.data.status === 'confirmed' ? 'you confirmed this was real pushback' : 'you rejected it as not pushback'),
      details: { status: body.data.status, classifier: { label: detail.candidate.classification.label, confidence: detail.candidate.classification.confidence } },
      targets: [id],
    });
    return c.body(null, 204);
  });

  app.get('/api/stats', async (c) => {
    const v = await view();
    return c.json((await repo.stats()).filter((r) => !v || v.has(r.projectKey)));
  });

  if (context) app.all('/mcp', (c) => handleMcp(c.req.raw, context));
  // Read-only, for the Claude Code plugin's hooks: is this folder a selected project?
  if (context) app.get('/api/agent/project', async (c) => c.json(await trackedProject({ cwd: c.req.query('cwd') ?? undefined }, context)));

  if (facts && projectDirs) {
    // Every page's project list. Settings lists every folder (GET /api/settings/projects); this lists the shown ones.
    app.get('/api/projects', async (c) => {
      const v = await view();
      const known = (await facts.listProjects()).filter((p) => !v || v.has(p.key));
      // An alias folder is a second clone: its sessions are its project's, so it is not listed as one of its own.
      const keys = new Set(known.flatMap((p) => [p.key, ...p.aliases]));
      const fresh: ProjectSummary[] = (await projectDirs())
        .filter((d) => !keys.has(d.key) && (!v || v.has(d.key)))
        .map((d) => ({ key: d.key, repoPath: d.repoPath, remote: null, aliases: [], sessions: 0, feedback: 0, lessons: 0, facts: 0, lastScan: null }));
      return c.json([...known, ...fresh].sort((a, b) => a.key.localeCompare(b.key)));
    });

    app.post('/api/projects/:key/scan', async (c) => {
      const body = ScanRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!body.success) return c.json({ error: body.error.flatten() }, 400);
      const project = (await projectDirs()).find((p) => p.key === c.req.param('key'));
      if (!project) return c.json({ error: 'no such folder under the configured roots' }, 404);
      return c.json(await facts.requestScan(project, body.data.provider ?? null), 202);
    });

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
  }

  if (docs && embed && projectDirs) {
    app.get('/api/projects/:key/docs', async (c) => {
      const key = c.req.param('key');
      return (await shows(key)) ? c.json(await docs.listDocs(key)) : c.json(NOT_SHOWN, 404);
    });

    app.post('/api/projects/:key/docs', async (c) => {
      const body = DocUpload.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: body.error.flatten() }, 400);
      const project = (await projectDirs()).find((p) => p.key === c.req.param('key'));
      if (!project) return c.json({ error: 'no such project' }, 404);
      const chunks = chunkText(redactSecrets(body.data.text));
      if (!chunks.length) return c.json({ error: 'document has no text' }, 400);
      const vectors = await embed(chunks);
      // Same file name, same doc: say so, rather than logging a fresh upload over a silent replacement.
      const previous = (await docs.listDocs(project.key)).find((d) => d.source === 'upload' && d.ref === body.data.name);
      const id = await docs.upsertDoc(
        { projectKey: project.key, source: 'upload', ref: body.data.name, title: body.data.title, url: null },
        chunks.map((text, i) => ({ text, embedding: vectors[i] })),
      );
      await activity?.record({
        kind: 'doc_added', actor: 'you', projectKey: project.key,
        subject: `${previous ? `replaced "${previous.title}" with` : 'uploaded'} "${body.data.title}" (${chunks.length} chunk${chunks.length === 1 ? '' : 's'})`,
        why: 'you added it as context; agents get matching excerpts with their task context',
        details: { name: body.data.name, chars: body.data.text.length }, targets: [id],
      });
      return c.json({ id, chunks: chunks.length }, 201);
    });

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
    app.get('/api/projects/:key/codemap/hotspots', async (c) => {
      const q = HotspotQuery.safeParse(c.req.query());
      if (!q.success) return c.json({ error: q.error.flatten() }, 400);
      const key = c.req.param('key');
      const [meta, hotspots] = await Promise.all([codegraph.codeMapMeta(key), codegraph.hotspots(key, q.data.limit, { includeTests: q.data.tests })]);
      return c.json({ meta, hotspots });
    });
    if (codegraph.mapGraph) {
      const mapGraph = codegraph.mapGraph.bind(codegraph);
      app.get('/api/projects/:key/codemap/graph', async (c) => {
        const q = MapGraphQuery.safeParse(c.req.query());
        if (!q.success) return c.json({ error: q.error.flatten() }, 400);
        const g = await mapGraph(c.req.param('key'), { limit: q.data.limit, includeTests: q.data.tests });
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
    const ExportQuery = z.object({ project: z.string().min(1).max(200).optional(), approved: z.enum(['1', 'true']).optional() });
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
  if (cloud) cloudRoutes(app, cloud);
  if (integrations) integrationRoutes(app, integrations);
  if (importer) importRoutes(app, importer);
  if (sessions) sessionRoutes(app, sessions);

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
          why: 'asked from the UI',
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
      const { unscoped } = await knowledge.updateLesson(id, p, { reembed });
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
        why: p.status === 'approved' ? 'you approved it, so agents will now be given it' : p.status === 'rejected' ? 'you rejected it; agents will not see it' : 'you edited it',
        details: { status: p.status ?? current.lesson.status, changed, supersedes: p.supersedes ?? null },
        targets: [id],
      });
      return c.body(null, 204);
    });
  }

  if (staticDir) {
    app.use('/*', serveStatic({ root: staticDir }));
    app.get('*', serveStatic({ root: staticDir, path: 'index.html' }));
  }

  return app;
}
