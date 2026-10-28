import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { FEEDBACK_SOURCES, LINK_RELATIONS, VERSION, type OperatorVerb } from '@fb/core';
import { initializeClientInfo } from './mcp.ts';
import { operatorName, OWNER_ROUTES } from './operator.ts';

/**
 * The admin MCP endpoint (/mcp/admin): the `fg` CLI's owner decisions as MCP tools, for a coding agent the owner lets
 * run scans and decide the Inbox from inside a session. createApp mounts it only while FG_OPERATOR_TOKEN is set and
 * answers it only to that token as the Bearer. /mcp stays read-and-report only.
 *
 * Every tool is a thin wrapper over the REST route: it calls the app in-process with the same Bearer and an
 * X-FG-Operator name, so validation, the OPERATOR_ALLOW gate, attribution (operator:<name>) and Activity are the
 * route's own. A refused verb comes back as a tool error carrying the route's refusal, which names the verb and how to
 * allow it.
 */

export type AdminMcpDeps = {
  /** The app, in-process (app.request). */
  request: (path: string, init: RequestInit) => Response | Promise<Response>;
  /** For scan_projects' wait; default: a timer. */
  sleep?: (ms: number) => Promise<void>;
};

type Route = readonly ['GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string];
type Answer = { ok: boolean; status: number; data: unknown };
type Call = (method: Route[0], path: string, body?: unknown) => Promise<Answer>;

/** The OPERATOR_ALLOW verb a route needs (OWNER_ROUTES), or null for a read. */
const verbOf = ([method, path]: Route): OperatorVerb | null => OWNER_ROUTES.find(([m, p]) => m === method && p === path)?.[2] ?? null;

/** Each tool's REST route: the one whose verb gates it (or none, for a read). */
const ROUTES = {
  pipeline_status: ['GET', '/api/pipeline'],
  list_projects: ['GET', '/api/projects'],
  select_projects: ['PUT', '/api/settings/projects'],
  scan_projects: ['POST', '/api/projects/scan'],
  inbox_list: ['GET', '/api/candidates'],
  inbox_get: ['GET', '/api/candidates/:id'],
  inbox_decide: ['POST', '/api/candidates/decisions'],
  lessons_list: ['GET', '/api/lessons'],
  lesson_get: ['GET', '/api/lessons/:id'],
  lesson_decide: ['PATCH', '/api/lessons/:id'],
  link_decide: ['PUT', '/api/links'],
  set_fact_relevance: ['PATCH', '/api/projects/:key/facts/:id/relevance'],
  cloud_sync_now: ['POST', '/api/cloud/sync'],
  rebuild_code_map: ['POST', '/api/projects/:key/codemap/rebuild'],
  run_cleanup: ['DELETE', '/api/runs/:id'],
  session_evidence: ['GET', '/api/sessions/:id/evidence'],
} as const satisfies Record<string, Route>;
type ToolName = keyof typeof ROUTES;

/** Which OPERATOR_ALLOW verb each admin tool needs (null: a read, the token alone is enough). */
export const ADMIN_TOOLS = Object.fromEntries(Object.entries(ROUTES).map(([name, r]) => [name, verbOf(r)])) as Record<ToolName, OperatorVerb | null>;

/** Same limits as the REST bodies the tools turn into. */
const MAX = { key: 200, id: 500, reason: 4000, note: 500, provider: 200, run: 64 } as const;
/** How many rows the store is asked for when a list tool counts what it did not show (the Inbox route's own cap). */
const LIST_MAX = 1000;
/** A list tool's page: this many rows unless asked, at most PAGE_MAX. */
const PAGE_DEFAULT = 20;
const PAGE_MAX = 200;
/** scan_projects' wait: how often a job is checked, and how long it waits by default and at most. */
const POLL_MS = 3000;
const WAIT_DEFAULT_S = 300;
const WAIT_MAX_S = 1800;

type Result = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: true };
const text = (s: string, isError = false): Result => ({ content: [{ type: 'text' as const, text: s }], ...(isError && { isError: true as const }) });
/** The answer as structuredContent (an object: a list is wrapped as { items }) and as the same JSON in text. */
const json = (data: unknown): Result => {
  const structured = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : { items: data };
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
};
const fail = (a: Answer) => {
  const e = (a.data as { error?: unknown } | null)?.error ?? a.data;
  return text(`${a.status}: ${typeof e === 'string' ? e : JSON.stringify(e)}`, true);
};
const answer = (a: Answer) => (a.ok ? json(a.data) : fail(a));
const enc = encodeURIComponent;
const qs = (o: Record<string, string | number | undefined>) => {
  const p = Object.entries(o).filter((e): e is [string, string | number] => e[1] !== undefined).map(([k, v]) => [k, String(v)]);
  return p.length ? `?${new URLSearchParams(p)}` : '';
};

/** The description's last sentence: what lets the token make this call. */
const needs = (name: ToolName) => {
  const verb = ADMIN_TOOLS[name];
  return verb ? ` Needs OPERATOR_ALLOW: ${verb}.` : ' Read-only: the operator token alone is enough.';
};

const Keys = z.array(z.string().min(1).max(MAX.key)).min(1).max(2000);

/** A list tool's paging arguments. */
const Paging = {
  limit: z.number().int().min(1).max(PAGE_MAX).optional().describe(`Rows per page (default ${PAGE_DEFAULT}, at most ${PAGE_MAX})`),
  offset: z.number().int().min(0).optional().describe('Rows to skip: the note on a page says which offset gives the next one'),
};

/**
 * One page of a list, and what the page left out: `more` rows after it and the offset that gives them. `atLeast`: the
 * store was asked for at most LIST_MAX rows and gave that many, so the total may be higher.
 */
export function page<T>(all: T[], a: { limit?: number; offset?: number }, row: (t: T) => unknown, atLeast = false) {
  const offset = a.offset ?? 0;
  const items = all.slice(offset, offset + (a.limit ?? PAGE_DEFAULT)).map(row);
  const more = Math.max(0, all.length - offset - items.length);
  return {
    total: all.length, ...(atLeast && { totalIsAtLeast: true }), offset, more, items,
    ...(more > 0 && { note: `${more}${atLeast ? '+' : ''} more: pass offset: ${offset + items.length} for the next page` }),
  };
}

/** Cut a server string for a list row; the get tools give the whole thing. */
const cut = (s: unknown, n: number) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null);

/** An Inbox item as a list row: what to decide on, not the PR's description, diff or thread (inbox_get has those). */
const inboxRow = (c: Record<string, any>) => ({
  id: c.id, projectKey: c.projectKey, source: c.source, status: c.status,
  label: c.classification?.label ?? null, confidence: c.classification?.confidence ?? null, summary: cut(c.classification?.summary, 240),
  ...(c.external && { author: c.external.author ?? null, authorKind: c.external.authorKind ?? null, title: cut(c.external.title, 120), url: c.external.url ?? null }),
  createdAt: c.createdAt ?? null, decidedBy: c.decidedBy ?? null,
});

/** A lesson as a list row: the rule cut short and its check flags by name (lesson_get has the evidence). */
const lessonRow = (l: Record<string, any>) => ({
  id: l.id, status: l.status, projectKey: l.projectKey ?? null, scope: l.scope, title: cut(l.title, 160), rule: cut(l.rule, 300),
  cause: l.cause ?? null, paths: (l.paths ?? []).slice(0, 5), checks: l.checks ? l.checks.map((c: { name: string }) => c.name) : null,
  createdAt: l.createdAt, decidedBy: l.decidedBy ?? null,
});

/** What a client may assume about a tool (MCP ToolAnnotations): a read needs no approval; a write says how far it reaches. */
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const write = (o: { destructive?: boolean; idempotent?: boolean; openWorld?: boolean } = {}) =>
  ({ readOnlyHint: false, destructiveHint: !!o.destructive, idempotentHint: !!o.idempotent, openWorldHint: !!o.openWorld });
type Annotations = typeof READ | ReturnType<typeof write>;

function buildServer(call: Call, sleep: (ms: number) => Promise<void>) {
  const server = new McpServer({ name: 'feedback-graph-admin', version: VERSION });
  const reg = <S extends z.ZodRawShape>(name: ToolName, description: string, inputSchema: S, annotations: Annotations, fn: (a: z.objectOutputType<S, z.ZodTypeAny>) => Promise<Result>) =>
    server.registerTool(name, { description: description + needs(name), inputSchema, annotations }, fn as never);

  reg('pipeline_status', "Feedback Graph's health and every pipeline stage's backlog (fg status and fg pipeline): worker stage, models, Inbox, post-mortems, lessons, scans.", {
    project: z.string().min(1).max(MAX.key).optional().describe("One project's counts only"),
  }, READ, async (a) => {
    const [status, pipeline] = await Promise.all([call('GET', '/api/status'), call('GET', `/api/pipeline${qs({ project: a.project })}`)]);
    if (!status.ok) return fail(status);
    if (!pipeline.ok) return fail(pipeline);
    return json({ status: status.data, pipeline: pipeline.data });
  });

  reg('list_projects', 'Every project folder, one row each: whether it is selected (read), pinned, its sessions, feedback, lessons and facts, and its last scan. Paged.', {
    selected_only: z.boolean().optional().describe('Only the selected folders'),
    ...Paging,
  }, READ, async (a) => {
    const [settings, shown] = await Promise.all([call('GET', '/api/settings/projects'), call('GET', '/api/projects')]);
    if (!shown.ok) return fail(shown);
    type Folder = { key: string; exists?: boolean; tracked?: boolean; excluded?: boolean; aliasOf?: string | null; claudeSessions?: number; codexSessions?: number };
    const s = settings.ok ? (settings.data as { tracked?: string[]; candidates?: Folder[] }) : null;
    const projects = new Map((shown.data as Record<string, any>[]).map((p) => [p.key as string, p]));
    const folders = new Map((s?.candidates ?? []).map((f) => [f.key, f]));
    const keys = [...folders.keys(), ...[...projects.keys()].filter((k) => !folders.has(k))];
    const rows = keys.map((key) => {
      const f = folders.get(key);
      const p = projects.get(key);
      const scan = p?.lastScan;
      return {
        key, selected: f ? !!f.tracked || !!s?.tracked?.includes(key) : true, pinned: !!p?.pinned,
        sessions: p?.sessions ?? (f ? (f.claudeSessions ?? 0) + (f.codexSessions ?? 0) : null),
        feedback: p?.feedback ?? null, lessons: p?.lessons ?? null, facts: p?.facts ?? null,
        lastScan: scan ? { status: scan.status, at: scan.finishedAt ?? scan.startedAt ?? scan.requestedAt ?? null } : null,
        ...(f?.excluded && { note: 'excluded (EXCLUDE_PROJECTS)' }), ...(f?.aliasOf && { note: `clone of ${f.aliasOf}` }), ...(f && f.exists === false && { note: 'folder gone' }),
      };
    });
    return json({ tracked: s?.tracked ?? null, ...page(a.selected_only ? rows.filter((r) => r.selected) : rows, a, (r) => r) });
  });

  reg('select_projects', 'Choose which project folders are read (opt-in). mode add (default) adds keys to the selection, only makes it exactly these, remove takes them out. all: every selectable folder.', {
    keys: Keys.optional(),
    all: z.literal(true).optional(),
    mode: z.enum(['add', 'only', 'remove']).optional(),
  }, write({ idempotent: true }), async (a) => {
    if ((a.keys === undefined) === (a.all === undefined)) return text('send either keys or all: true', true);
    const current = await call('GET', '/api/settings/projects');
    if (!current.ok) return fail(current);
    const s = current.data as { tracked: string[]; candidates: { key: string; exists: boolean; excluded: boolean; aliasOf: string | null }[] };
    const asked = a.all ? s.candidates.filter((c) => c.exists && !c.excluded && !c.aliasOf).map((c) => c.key) : a.keys!;
    const mode = a.mode ?? 'add';
    const tracked = mode === 'remove' ? s.tracked.filter((k) => !asked.includes(k)) : [...new Set([...(mode === 'only' ? [] : s.tracked), ...asked])].sort();
    const saved = await call('PUT', '/api/settings/projects', { tracked });
    return saved.ok ? json({ tracked: (saved.data as { tracked: string[] }).tracked }) : fail(saved);
  });

  reg('scan_projects', 'Queue a code and document scan of selected folders (keys, or all). wait: follow each job until it is done or failed (up to timeout_seconds).', {
    keys: Keys.optional(),
    all: z.literal(true).optional(),
    provider: z.string().min(1).max(MAX.provider).optional().describe('The model to scan with, e.g. codex-cli or ollama:<model>; default: the configured one'),
    wait: z.boolean().optional().describe('Default false: return once queued'),
    timeout_seconds: z.number().int().min(1).max(WAIT_MAX_S).optional().describe(`How long wait follows the jobs (default ${WAIT_DEFAULT_S})`),
  }, write(), async (a) => {
    const queued = await call('POST', '/api/projects/scan', { ...(a.keys && { keys: a.keys }), ...(a.all && { all: true }), ...(a.provider && { provider: a.provider }) });
    if (!queued.ok || !a.wait) return answer(queued);
    type Result = { key: string; queued: boolean; job?: { id: string; status: string } };
    type Job = { id: string; projectKey?: string; status: string } & Record<string, unknown>;
    const results = (queued.data as { results: Result[] }).results;
    const jobs = new Map<string, Job>();
    for (const r of results) if (r.queued && r.job) jobs.set(r.job.id, { id: r.job.id, projectKey: r.key, status: r.job.status });
    const finished = (j: Job) => j.status === 'done' || j.status === 'failed';
    const timeout = (a.timeout_seconds ?? WAIT_DEFAULT_S) * 1000;
    for (let waited = 0; ;) {
      for (const j of [...jobs.values()].filter((x) => !finished(x))) {
        const r = await call('GET', `/api/scans/${enc(j.id)}`);
        if (!r.ok) return json({ jobs: [...jobs.values()], refused: results.filter((x) => !x.queued), note: `cannot follow job ${j.id}: ${r.status}` });
        jobs.set(j.id, r.data as Job);
      }
      if ([...jobs.values()].every(finished) || waited + POLL_MS > timeout) break;
      await sleep(POLL_MS);
      waited += POLL_MS;
    }
    return json({ jobs: [...jobs.values()], refused: results.filter((x) => !x.queued) });
  });

  reg('inbox_list', 'Inbox items (flagged developer pushback waiting for a decision), newest first, one compact row each: id, project, source, label, summary, author and link. inbox_get gives one item in full. Paged.', {
    status: z.enum(['pending', 'confirmed', 'rejected']).optional().describe('Default pending'),
    source: z.enum(FEEDBACK_SOURCES as [string, ...string[]]).optional().describe('Only items from this source'),
    project: z.string().min(1).max(MAX.key).optional(),
    pr: z.number().int().positive().optional(),
    author: z.string().trim().min(1).max(200).optional(),
    ...Paging,
  }, READ, async (a) => {
    const r = await call('GET', `/api/candidates${qs({ status: a.status ?? 'pending', project: a.project, source: a.source, pr: a.pr, author: a.author, limit: LIST_MAX })}`);
    if (!r.ok) return fail(r);
    const all = r.data as Record<string, any>[];
    return json(page(all.filter((c) => !a.source || c.source === a.source), a, inboxRow, all.length >= LIST_MAX));
  });

  reg('inbox_get', 'One Inbox item in full: the comment, the conversation or PR around it (description, diff), and its post-mortem.', {
    id: z.string().min(1).max(MAX.id),
  }, READ, async (a) => answer(await call('GET', `/api/candidates/${enc(a.id)}`)));

  reg('inbox_decide', 'Confirm or reject Inbox items (confirmed ones feed a post-mortem that proposes lessons for the owner to approve). Says per item what happened.', {
    items: z.array(z.object({
      id: z.string().min(1).max(MAX.id),
      decision: z.enum(['confirm', 'reject']),
      reason: z.string().max(MAX.reason).optional(),
    }).strict()).min(1).max(500),
  }, write({ destructive: true }), async (a) => answer(await call('POST', '/api/candidates/decisions', { items: a.items })));

  reg('lessons_list', 'Lessons learned from post-mortems, one compact row each (the rule cut short, check flags by name): proposed ones wait for the owner; approved ones reach agents. lesson_get gives one in full. Paged.', {
    status: z.enum(['proposed', 'approved', 'rejected', 'revoked', 'superseded']).optional(),
    project: z.string().min(1).max(MAX.key).optional(),
    pr: z.number().int().positive().optional(),
    author: z.string().trim().min(1).max(200).optional(),
    ...Paging,
  }, READ, async (a) => {
    const r = await call('GET', `/api/lessons${qs({ status: a.status, project: a.project, pr: a.pr, author: a.author })}`);
    return r.ok ? json(page(r.data as Record<string, any>[], a, lessonRow)) : fail(r);
  });

  reg('lesson_get', 'One lesson in full, with the miss and the feedback it was learned from.', {
    id: z.string().min(1).max(MAX.id),
  }, READ, async (a) => answer(await call('GET', `/api/lessons/${enc(a.id)}`)));

  reg('lesson_decide', 'Approve a proposed lesson (agents are given it from then on) or reject it. Off by default: lessons are the owner\'s decision.', {
    id: z.string().min(1).max(MAX.id),
    decision: z.enum(['approve', 'reject', 'revoke']),
  }, write({ destructive: true, idempotent: true }), async (a) => {
    const r = await call('PATCH', `/api/lessons/${enc(a.id)}`, { status: a.decision === 'approve' ? 'approved' : a.decision === 'revoke' ? 'revoked' : 'rejected' });
    return r.ok ? json({ id: a.id, status: a.decision === 'approve' ? 'approved' : a.decision === 'revoke' ? 'revoked' : 'rejected' }) : fail(r);
  });

  reg('link_decide', 'Confirm a link between two projects (agents in either get the best matches from the other), dismiss it, or reopen it as a suggestion.', {
    a: z.string().min(1).max(MAX.key),
    b: z.string().min(1).max(MAX.key),
    decision: z.enum(['confirm', 'dismiss', 'reopen']),
    relation: z.enum(LINK_RELATIONS).optional(),
    note: z.string().max(MAX.note).optional(),
  }, write({ idempotent: true }), async (a) => {
    const status = a.decision === 'confirm' ? 'confirmed' : a.decision === 'dismiss' ? 'dismissed' : 'suggested';
    return answer(await call('PUT', '/api/links', { a: a.a, b: a.b, status, ...(a.relation && { relation: a.relation }), ...(a.note !== undefined && { note: a.note }) }));
  });

  reg('set_fact_relevance', 'Set how often everyday coding in a project needs a code or document fact (0 to 1); agents get facts ranked by it.', {
    project: z.string().min(1).max(MAX.key),
    id: z.string().min(1).max(MAX.id),
    relevance: z.number().min(0).max(1),
  }, write({ idempotent: true }), async (a) => {
    const r = await call('PATCH', `/api/projects/${enc(a.project)}/facts/${enc(a.id)}/relevance`, { relevance: a.relevance });
    return r.ok ? json({ id: a.id, relevance: a.relevance }) : fail(r);
  });

  reg('cloud_sync_now', 'Send what changed since the last Feedback Graph Cloud sync now (force: everything). Only when cloud sync is configured.', {
    force: z.boolean().optional(),
  }, write({ idempotent: true, openWorld: true }), async (a) => answer(await call('POST', '/api/cloud/sync', a.force === undefined ? {} : { force: a.force })));

  reg('run_cleanup', 'After a test run (requests labelled x-fg-run): remove exactly what that run wrote (its reports with their post-mortems, misses and lessons, pre-done checks, facts, uploads, links, conversations). A dry run unless apply is true: it lists per kind what would go, what stays because someone outside the run touched it since (a lesson the owner approved), and what the run changed that is not its own (never undone). Its Activity entries go too with apply; the run_cleaned entry records the cleanup. Your own runs (the same X-FG-Run-Key capability).', {
    run: z.string().min(1).max(MAX.run).describe('The run id the requests were labelled with'),
    apply: z.boolean().optional().describe('Default false: only say what would go'),
  }, write({ destructive: true, idempotent: true }), async (a) => answer(await call('DELETE', `/api/runs/${enc(a.run)}`, { dryRun: !a.apply })));

  reg('session_evidence', 'For one ingested session: the turns read (count, first and last, the files), what the detector made of each turn and why (pushback, correction, an instruction; the skip rules applied), its Inbox items with their decision, post-mortem, miss and lesson, and the context served to it when the agent passed session_id. Redacted.', {
    id: z.string().min(1).max(MAX.id).describe('The session id'),
  }, READ, async (a) => answer(await call('GET', `/api/sessions/${enc(a.id)}/evidence`)));

  reg('rebuild_code_map', "Remap a project's code from scratch at the worker's next pass.", {
    project: z.string().min(1).max(MAX.key),
  }, write({ idempotent: true }), async (a) => answer(await call('POST', `/api/projects/${enc(a.project)}/codemap/rebuild`, {})));

  // fg demo seed / remove (demo.ts): gated by the route itself, not by one OPERATOR_ALLOW verb (see DEMO_NEEDS).
  const DEMO_NEEDS = ' The demo project needs only the operator token; another project (project) needs OPERATOR_ALLOW: lesson_decide.';
  const demoArgs = { project: z.string().min(1).max(MAX.key).optional().describe('Another project than demo-shop (needs lesson_decide)') };
  const demoAnswer = (a: Answer) => (a.ok ? text((a.data as { message: string }).message) : fail(a));
  server.registerTool('demo_seed', {
    description: 'fg demo seed: a small corpus marked demo in demo-shop (approved lessons tied to files, a miss on a file, facts), so the lesson path fires on a project that has no approved lesson. The owner approves its lessons by having you run it: say so.' + DEMO_NEEDS,
    inputSchema: demoArgs,
    annotations: write({ idempotent: true }),
  }, (async (a: { project?: string }) => demoAnswer(await call('POST', '/api/demo/seed', a.project ? { project: a.project } : {}))) as never);
  server.registerTool('demo_remove', {
    description: 'fg demo remove: take back exactly what demo_seed wrote (demo lessons, the demo miss, demo facts), nothing else.' + DEMO_NEEDS,
    inputSchema: demoArgs,
    annotations: write({ destructive: true, idempotent: true }),
  }, (async (a: { project?: string }) => demoAnswer(await call('POST', '/api/demo/remove', a.project ? { project: a.project } : {}))) as never);

  return server;
}

const SESSION_PREFIX = 'fga1.';
/** An agent name as the routes record it (operatorName's rules), without the `operator:` prefix; '' when none is usable. */
const cleanName = (raw: unknown) => (typeof raw === 'string' ? operatorName(raw).replace(/^operator:?/, '') : '');

/**
 * Stateless like /mcp: the client's name from `initialize` rides along in the session id the client echoes. It is only
 * a label, claimed by the client, and cleaned again when read.
 */
function decodeName(header: string | null): string {
  if (!header?.startsWith(SESSION_PREFIX) || header.length > 120) return '';
  return cleanName(Buffer.from(header.slice(SESSION_PREFIX.length), 'base64url').toString('utf8'));
}

/**
 * Stateless Streamable HTTP: a fresh server + transport per request. createApp has checked the operator token before
 * this runs; the tools forward it.
 */
export async function handleAdminMcp(req: Request, deps: AdminMcpDeps): Promise<Response> {
  if (req.method === 'DELETE') return new Response(null, { status: 204 });
  if (req.method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
  const init = await initializeClientInfo(req);
  const fromClient = init.found ? cleanName((init.info as { name?: unknown } | null)?.name) : decodeName(req.headers.get('mcp-session-id'));
  // X-FG-Operator, when the client sends it, names the agent like it does for the REST routes and fg.
  const header = req.headers.get('x-fg-operator');
  const name = header?.trim() ? header : fromClient;
  const authorization = req.headers.get('authorization') ?? '';
  // The run label (x-fg-run, ?run=) needs no forwarding: each in-process route call runs inside this request's run.
  const call: Call = async (method, path, body) => {
    const headers: Record<string, string> = { accept: 'application/json', authorization, ...(req.headers.get('x-fg-run-key') && { 'x-fg-run-key': req.headers.get('x-fg-run-key')! }), ...(name && { 'x-fg-operator': name }) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await deps.request(path, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const raw = await res.text();
    let data: unknown;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    return { ok: res.ok, status: res.status, data };
  };
  const server = buildServer(call, deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req);
    const label = init.found ? cleanName((init.info as { name?: unknown } | null)?.name) : '';
    if (!label || !res.ok) return res;
    const headers = new Headers(res.headers);
    headers.set('mcp-session-id', SESSION_PREFIX + Buffer.from(label, 'utf8').toString('base64url'));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } finally {
    void server.close();
  }
}
