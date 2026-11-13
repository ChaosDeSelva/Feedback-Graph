import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { CLAIM_STATUSES, CLAIM_TYPES, CONFLICT_CHOICES, CONFLICT_DISMISS_REASONS, CONFLICT_STATUSES, INTAKE_KINDS, QUESTION_STATUSES, DECISION_NOTE_REASONS, DECISION_STATUSES, DECISION_TYPES, FEEDBACK_SOURCES, isoOffsetValid, LINK_RELATIONS, VERSION, type OperatorVerb } from '@fb/core';
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
  /** INTAKE_ENABLED: knowledge intake's tools are offered (intake_submit, claims_list, ... conflict_resolve). */
  intake: boolean;
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
  decisions_list: ['GET', '/api/decisions'],
  decision_get: ['GET', '/api/decisions/:id'],
  loop_status: ['GET', '/api/loop'],
  // approve, reject and keep are three routes under one verb (loop_decide).
  decision_decide: ['POST', '/api/decisions/:id/approve'],
  decision_rollback: ['POST', '/api/decisions/:id/rollback'],
  decision_note: ['POST', '/api/decisions/:id/notes'],
  loop_pause: ['POST', '/api/loop/pause'],
  // Knowledge intake (INTAKE_ENABLED; otherwise these routes answer 404).
  intake_submit: ['POST', '/api/intake'],
  claims_list: ['GET', '/api/claims'],
  claim_decide: ['PATCH', '/api/claims/:id'],
  questions_list: ['GET', '/api/questions'],
  question_answer: ['POST', '/api/questions/:id/answer'],
  conflicts_list: ['GET', '/api/conflicts'],
  conflict_resolve: ['POST', '/api/conflicts/:id/resolve'],
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

/** A learning loop decision as a list row: what it does to what, how sure, and where it stands (decision_get has the rest). */
const decisionRow = (d: Record<string, any>) => ({
  id: d.id, type: d.type, status: d.status, tier: d.tier, mode: d.mode, projectKey: d.projectKey,
  target: (d.targets?.find((t: { role: string }) => t.role === 'primary') ?? d.targets?.[0])?.id ?? null,
  confidence: d.confidence, rationale: cut(d.rationale, 240), createdAt: d.createdAt, decidedBy: d.decidedBy ?? null,
});

/** A claim as a list row: what was said, by whom (a Person id), and where it stands (claims_list). */
const claimRow = (c: Record<string, any>) => ({
  id: c.id, projectKey: c.projectKey, type: c.type, status: c.status, statement: cut(c.statement, 300), quote: cut(c.quote, 200), speakerId: c.speakerId,
  assertedAt: c.assertedAt, flags: c.flags, factId: c.factId, conflicts: (c.conflicts ?? []).map((k: { id: string }) => k.id),
});
/** A conflict as a list row: both sides in a line each, and whether agents see them. */
const conflictRow = (k: Record<string, any>) => ({
  id: k.id, kind: k.kind, status: k.status, projectKey: k.projectKey, fingerprint: k.fingerprint, explanation: cut(k.judge?.explanation, 240),
  a: { kind: k.sides?.a?.kind, id: k.sides?.a?.id, text: cut(k.sides?.a?.text, 240), speaker: k.sides?.a?.speaker?.displayName ?? null, agentsSee: k.sides?.a?.agentsSee },
  b: { kind: k.sides?.b?.kind, id: k.sides?.b?.id, text: cut(k.sides?.b?.text, 240), speaker: k.sides?.b?.speaker?.displayName ?? null, agentsSee: k.sides?.b?.agentsSee },
  resolution: k.resolution, decisionId: k.decisionId,
});
/** A list route paged by offset (x-next-offset): limit + 1 asked, so `more` is known. */
const pagedList = async (call: Call, path: string, q: Record<string, string | number | undefined>, a: { limit?: number; offset?: number }, row: (x: Record<string, any>) => unknown) => {
  const offset = a.offset ?? 0;
  const limit = a.limit ?? PAGE_DEFAULT;
  const r = await call('GET', `${path}${qs({ ...q, limit: limit + 1, offset })}`);
  if (!r.ok) return fail(r);
  const rows = r.data as Record<string, any>[];
  const more = rows.length > limit;
  return json({ offset, items: rows.slice(0, limit).map(row), more, ...(more && { note: `more: pass offset: ${offset + limit} for the next page` }) });
};

/** What a client may assume about a tool (MCP ToolAnnotations): a read needs no approval; a write says how far it reaches. */
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const write = (o: { destructive?: boolean; idempotent?: boolean; openWorld?: boolean } = {}) =>
  ({ readOnlyHint: false, destructiveHint: !!o.destructive, idempotentHint: !!o.idempotent, openWorldHint: !!o.openWorld });
type Annotations = typeof READ | ReturnType<typeof write>;

function buildServer(call: Call, sleep: (ms: number) => Promise<void>, intake: boolean) {
  const server = new McpServer({ name: 'feedback-graph-admin', version: VERSION });
  /** A decision's status now, for a call that did not say what it expects; the failed read when there is none. */
  const statusOf = async (id: string): Promise<string | Answer> => {
    const r = await call('GET', `/api/decisions/${enc(id)}`);
    return r.ok ? (r.data as { decision: { status: string } }).decision.status : r;
  };
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

  reg('inbox_list', 'Inbox items (flagged developer pushback; all statuses unless filtered), newest first, one compact row each: id, project, source, label, summary, author and link. inbox_get gives one item in full. Paged.', {
    status: z.enum(['pending', 'confirmed', 'rejected']).optional().describe('Omit for all statuses'),
    source: z.enum(FEEDBACK_SOURCES as [string, ...string[]]).optional().describe('Only items from this source'),
    project: z.string().min(1).max(MAX.key).optional(),
    pr: z.number().int().positive().optional(),
    author: z.string().trim().min(1).max(200).optional(),
    ...Paging,
  }, READ, async (a) => {
    const r = await call('GET', `/api/candidates${qs({ status: a.status, project: a.project, source: a.source, pr: a.pr, author: a.author, limit: LIST_MAX })}`);
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

  reg('lesson_decide', 'Approval updates local agents immediately. It does not trigger cloud sync: eligible projects share on the next schedule or cloud_sync_now. Approve a proposed lesson (agents are given it from then on), reject it, or revoke an approved one (agents stop getting it at once). Off by default: lessons are the owner\'s decision.', {
    id: z.string().min(1).max(MAX.id),
    decision: z.enum(['approve', 'reject', 'revoke']),
    note: z.string().trim().min(1).max(MAX.reason).optional().describe('Why: kept as the lesson\'s decision note and on its Activity entry'),
  }, write({ destructive: true, idempotent: true }), async (a) => {
    const r = await call('PATCH', `/api/lessons/${enc(a.id)}`, { status: a.decision === 'approve' ? 'approved' : a.decision === 'revoke' ? 'revoked' : 'rejected', ...(a.note && { note: a.note }) });
    return r.ok ? json({ id: a.id, sharing: 'Local decision saved. Cloud sharing, if enabled for this project, waits for the next scheduled sync or cloud_sync_now.', status: a.decision === 'approve' ? 'approved' : a.decision === 'revoke' ? 'revoked' : 'rejected' }) : fail(r);
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

  reg('decisions_list', "The learning loop's decisions, newest first (the audit log: every status unless filtered), one compact row each: type, status, target, confidence, rationale. decision_get gives one in full. Paged.", {
    status: z.enum(DECISION_STATUSES).optional(),
    type: z.enum(DECISION_TYPES).optional(),
    project: z.string().min(1).max(MAX.key).optional(),
    target: z.string().min(1).max(MAX.id).optional().describe('Only decisions about this lesson, fact, miss or Inbox item id'),
    since: z.string().datetime({ offset: true }).refine(isoOffsetValid, { message: 'the offset must be within ±14:00' }).optional().describe('Created at or after (ISO time)'),
    q: z.string().trim().min(1).max(200).optional().describe('Text in the rationale or a target id'),
    ...Paging,
  }, READ, async (a) => {
    const offset = a.offset ?? 0;
    const limit = a.limit ?? PAGE_DEFAULT;
    const r = await call('GET', `/api/decisions${qs({ status: a.status, type: a.type, project: a.project, target: a.target, since: a.since, q: a.q, limit: limit + 1, offset })}`);
    if (!r.ok) return fail(r);
    const rows = r.data as Record<string, any>[];
    const more = rows.length > limit;
    return json({ offset, items: rows.slice(0, limit).map(decisionRow), more, ...(more && { note: `more: pass offset: ${offset + limit} for the next page` }) });
  });

  reg('decision_get', 'One learning loop decision in full: before and after snapshots, its targets now, the evidence it rests on, rationale and confidence, what it depends on and what depends on it, and its notes.', {
    id: z.string().min(1).max(MAX.id),
  }, READ, async (a) => answer(await call('GET', `/api/decisions/${enc(a.id)}`)));

  reg('loop_status', "The learning loop's state: its mode as set and as it runs (paused, LOOP_DISABLED, the tokenless cap), each decision type's mode, calibration and breaker, the budget, this week's counts and the current round.", {}, READ,
    async () => answer(await call('GET', '/api/loop')));

  reg('decision_decide', "Approve a proposed or observed decision (it is applied: approving one that changes a lesson changes what agents are told), reject it, or keep (ratify) an applied one. Your verdicts are recorded as the operator's and never count toward the loop earning auto-apply. Off by default.", {
    id: z.string().min(1).max(MAX.id),
    decision: z.enum(['approve', 'reject', 'keep']),
    expect: z.enum(DECISION_STATUSES).optional().describe('The status you saw (decision_get); a decision that has moved since is refused. Default: its status now'),
    note: z.string().trim().min(1).max(MAX.reason).optional(),
    reason: z.enum(DECISION_NOTE_REASONS).optional().describe('With reject: why'),
  }, write({ destructive: true }), async (a) => {
    const expect = a.expect ?? await statusOf(a.id);
    if (typeof expect !== 'string') return fail(expect);
    return answer(await call('POST', `/api/decisions/${enc(a.id)}/${a.decision}`, { expect, ...(a.note && { note: a.note }), ...(a.reason && { reason: a.reason }) }));
  });

  reg('decision_rollback', 'Roll back an applied decision, and the later decisions that depend on it, all or nothing. A preview unless apply is true: it lists what else would be undone and what blocks it. Refused when its target was changed since (the decision is then overridden; restore_anyway writes what it was before over that change). Off by default.', {
    id: z.string().min(1).max(MAX.id),
    apply: z.boolean().optional().describe('Default false: only say what would be undone'),
    reason: z.enum(DECISION_NOTE_REASONS).optional(),
    note: z.string().trim().min(1).max(MAX.reason).optional(),
    restore_anyway: z.literal(true).optional().describe('For an overridden decision: write what it was before over the later change'),
    expect: z.enum(DECISION_STATUSES).optional().describe('The status you saw; default: its status now'),
  }, write({ destructive: true }), async (a) => {
    const expect = a.expect ?? await statusOf(a.id);
    if (typeof expect !== 'string') return fail(expect);
    return answer(await call('POST', `/api/decisions/${enc(a.id)}/rollback`, {
      expect, cascade: a.apply ? 'apply' : 'preview', ...(a.reason && { reason: a.reason }), ...(a.note && { note: a.note }), ...(a.restore_anyway && { restoreAnyway: true }),
    }));
  });

  reg('decision_note', 'Add a note to a learning loop decision: agree or disagree (with a reason). The note is kept in the decision\'s record; the loop reads only the owner\'s own notes, never an operator\'s, and a note\'s verdict never counts toward it earning auto-apply.', {
    id: z.string().min(1).max(MAX.id),
    text: z.string().trim().min(1).max(MAX.reason),
    verdict: z.enum(['agree', 'disagree']).optional(),
    reason: z.enum(DECISION_NOTE_REASONS).optional().describe('With verdict disagree: why'),
  }, write(), async (a) => answer(await call('POST', `/api/decisions/${enc(a.id)}/notes`, { text: a.text, ...(a.verdict && { verdict: a.verdict }), ...(a.reason && { reason: a.reason }) })));

  reg('loop_pause', 'Pause the learning loop at once: it records, proposes and applies nothing until the owner resumes it. Off by default.', {}, write({ idempotent: true }),
    async () => answer(await call('POST', '/api/loop/pause', {})));

  // Knowledge intake's tools exist only while INTAKE_ENABLED is on, as its routes do.
  if (intake) {
    reg('intake_submit', 'Add a transcript, notes or a doc (pasted text: txt, md, vtt or srt) to knowledge intake: it is redacted, stored and read into proposed claims and questions for the owner to review; agents see none of it until a claim is accepted. A transcript is private (never synced); notes and docs follow SYNC_CLAIMS.', {
      project: z.string().min(1).max(MAX.key),
      title: z.string().min(1).max(300),
      text: z.string().min(1).max(2_000_000),
      kind: z.enum(INTAKE_KINDS).optional().describe('Default transcript'),
      occurred_at: z.string().max(40).optional().describe('When it happened (YYYY-MM-DD)'),
      participants: z.array(z.string().min(1).max(200)).max(100).optional(),
      origin: z.string().min(1).max(500).optional().describe('Where it came from ("weekly sync", a URL)'),
    }, write(), async (a) => answer(await call('POST', '/api/intake', {
      projectKey: a.project, title: a.title, text: a.text, ...(a.kind && { kind: a.kind }), ...(a.occurred_at && { occurredAt: a.occurred_at }),
      ...(a.participants && { participants: a.participants }), ...(a.origin && { origin: a.origin }),
    })));

    reg('claims_list', 'Claims drawn from what people said, newest first, one compact row each (statement, quote, type, status, speaker, open conflicts). Paged.', {
      status: z.enum(CLAIM_STATUSES).optional().describe('Default proposed'),
      type: z.enum(CLAIM_TYPES).optional(),
      project: z.string().min(1).max(MAX.key).optional(),
      source: z.string().min(1).max(MAX.id).optional().describe('One source (its doc id)'),
      ...Paging,
    }, READ, (a) => pagedList(call, '/api/claims', { status: a.status ?? 'proposed', type: a.type, project: a.project, source: a.source }, a, claimRow));

    reg('claim_decide', "Accept, reject or edit a claim. Accepting one that is not an opinion files it as a project fact agents are given; as_fact false keeps it as an opinion (never given to agents). Off by default.", {
      id: z.string().min(1).max(MAX.id),
      status: z.enum(['accepted', 'rejected', 'proposed']).optional(),
      statement: z.string().trim().min(1).max(2000).optional(),
      type: z.enum(CLAIM_TYPES).optional(),
      as_fact: z.boolean().optional(),
    }, write(), async (a) => answer(await call('PATCH', `/api/claims/${enc(a.id)}`, {
      ...(a.status && { status: a.status }), ...(a.statement && { statement: a.statement }), ...(a.type && { type: a.type }), ...(a.as_fact !== undefined && { asFact: a.as_fact }),
    })));

    reg('questions_list', 'Questions a source left open (unanswered, contradictory, needing an owner), newest first. Paged.', {
      status: z.enum(QUESTION_STATUSES).optional().describe('Default open'),
      project: z.string().min(1).max(MAX.key).optional(),
      ...Paging,
    }, READ, (a) => pagedList(call, '/api/questions', { status: a.status ?? 'open', project: a.project }, a, (q) => ({
      id: q.id, projectKey: q.projectKey, kind: q.kind, status: q.status, text: cut(q.text, 300), quote: cut(q.quote, 200), askedBy: q.askedBy, assignee: q.assignee,
    })));

    reg('question_answer', "Answer a question as the owner: the answer is an accepted claim, and one that is not an opinion is filed as a project fact agents are given. Off by default.", {
      id: z.string().min(1).max(MAX.id),
      text: z.string().trim().min(1).max(4000),
      type: z.enum(CLAIM_TYPES).optional().describe('Default fact'),
    }, write(), async (a) => answer(await call('POST', `/api/questions/${enc(a.id)}/answer`, { text: a.text, ...(a.type && { type: a.type }) })));

    reg('conflicts_list', 'Conflicts between things agents may be told, newest first: both sides, who said them, and whether agents see each. Paged.', {
      status: z.enum(CONFLICT_STATUSES).optional().describe('Default open'),
      project: z.string().min(1).max(MAX.key).optional(),
      ...Paging,
    }, READ, (a) => pagedList(call, '/api/conflicts', { status: a.status ?? 'open', project: a.project }, a, conflictRow));

    reg('conflict_resolve', "Settle a conflict: a or b is true (the other is superseded, never deleted), both partly (a note is required), or none (not a conflict, with a reason). Recorded as a resolve_conflict decision; decision_rollback undoes it. Choosing what is true is the owner's call: off by default.", {
      id: z.string().min(1).max(MAX.id),
      choice: z.enum(CONFLICT_CHOICES),
      note: z.string().trim().min(1).max(2000).optional(),
      reason: z.enum(CONFLICT_DISMISS_REASONS).optional().describe('With none'),
      statement: z.string().trim().min(1).max(2000).optional().describe('With both: a reconciled statement filed as the owner\'s fact'),
      expect: z.string().min(1).max(200).optional().describe('The fingerprint conflicts_list showed: a conflict changed since is refused'),
    }, write({ destructive: true }), async (a) => answer(await call('POST', `/api/conflicts/${enc(a.id)}/resolve`, {
      choice: a.choice, ...(a.note && { note: a.note }), ...(a.reason && { reason: a.reason }), ...(a.statement && { statement: a.statement }), ...(a.expect && { expect: a.expect }),
    })));
  }

  reg('rebuild_code_map', "Remap a project's code from scratch at the worker's next pass.", {
    project: z.string().min(1).max(MAX.key),
  }, write({ idempotent: true }), async (a) => answer(await call('POST', `/api/projects/${enc(a.project)}/codemap/rebuild`, {})));

  // fg demo seed / remove (demo.ts): the owner route needs `demo`; another project than demo-shop also needs lesson_decide.
  const DEMO_NEEDS = ' Needs OPERATOR_ALLOW: demo (on by default); another project (project) also needs lesson_decide. An explicit OPERATOR_ALLOW replaces the defaults, so list both.';
  const demoArgs = { project: z.string().min(1).max(MAX.key).optional().describe('Another project than demo-shop (needs lesson_decide as well as demo)') };
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
  const server = buildServer(call, deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), deps.intake);
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
