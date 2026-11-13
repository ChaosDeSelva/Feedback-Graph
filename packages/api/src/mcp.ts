import { createHmac, randomBytes } from 'node:crypto';
import { currentCaller } from './operator.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { VERSION } from '@fb/core';
import { findContradictions, NOTES_MAX_BYTES, submitNotes, whatDoWeKnow } from './agentIntake.ts';
import { checkBeforeDone, getImpact, getModuleContext, getRecentSessions, getTaskContext, MAX_DEPTH, RECENT_MAX, reportFeedback, searchGraph, type ContextDeps } from './context.ts';

/**
 * Length limits on free text: every argument is embedded, searched or stored, so a runaway client (a 1 MB task was
 * seen) is refused here instead of costing an embedding and a megabyte Activity row.
 */
const MAX = { path: 1000, key: 200, task: 8000, query: 2000, prose: 20_000, diff: 900_000 } as const;
/**
 * The most a /mcp request body may be: a check_before_done at every limit, each character escaped as JSON's longest
 * form (\u001f, 6 bytes), plus room for the envelope, so a call the schema allows is never refused (413) before its
 * arguments are checked; one past a limit is a tool error naming it.
 */
export const MCP_BODY_LIMIT = 6 * (MAX.diff + MAX.prose + MAX.task + MAX.path + MAX.key + 50 * MAX.path + 200) + 64 * 1024;

const where = {
  cwd: z.string().max(MAX.path).optional().describe('Absolute path of the directory you are working in (preferred)'),
  project: z.string().max(MAX.key).optional().describe('Project key, if you know it instead of cwd'),
};

const text = (markdown: string) => ({ content: [{ type: 'text' as const, text: markdown }] });
const retryableToolError = (error: unknown) => {
  const e = error instanceof Error ? error : new Error(String(error));
  const code = (e as Error & { code?: string }).code;
  // The models first: an Ollama that cannot be reached in time (UND_ERR_CONNECT_TIMEOUT) or does not answer is no
  // fault of the graph store, which a retry would not help.
  if (e.name === 'ProviderUnavailableError' || e.name === 'ModelTimeoutError') {
    return { ...text(`The graph store is fine; the model this tool needs ${e.name === 'ModelTimeoutError' ? 'did not answer in time' : 'is unavailable'} (${e.message}). Retry once it answers.`), isError: true };
  }
  if (code === 'Neo.TransientError.General.MemoryPoolOutOfMemoryError' || /transaction(?:al)? memory|memory pool/i.test(e.message)) {
    return { ...text('The graph store is temporarily at its transaction-memory limit. Retry this tool call in about 2 seconds.'), isError: true };
  }
  if (e.name === 'StoreDeadlineError' || code === '57014' || /(?:timeout|timed out|deadline exceeded)/i.test(e.message)) {
    return { ...text('The graph request exceeded its deadline. Retry this tool call.'), isError: true };
  }
  if (e.name === 'ServiceUnavailable' || e.name === 'SessionExpired' || /^08/.test(code ?? '') || ['57P01', '57P02', '57P03'].includes(code ?? '')
    || /failed to connect to server|routing table|connection acquisition|database (?:is )?unavailable|connection terminated/i.test(e.message)) {
    return { ...text('The graph store is temporarily unavailable. Retry this tool call after the database is healthy.'), isError: true };
  }
  throw error;
};
const safe = <A, R>(fn: (args: A) => Promise<R>) => async (args: A): Promise<R | ReturnType<typeof retryableToolError>> => {
  try { return await fn(args); } catch (error) { return retryableToolError(error); }
};

/**
 * MCP ToolAnnotations. Codex will not call a tool without them, so every tool says what it is. The context tools change
 * nothing the developer owns: they only log what they served (Activity) and may queue a scan of files the code map
 * lacks, so they are read-only. report_feedback queues a new inbox item each call, but never removes or overwrites
 * anything. None reaches past this machine's graph.
 */
const read = (title: string) => ({ title, annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
const write = (title: string) => ({ title, annotations: { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } });

/** Sent once at initialize, for an agent with the tools but not the skill: which tool to call when. */
export const MCP_INSTRUCTIONS =
  'Feedback Graph holds lessons learned from the developer\'s past corrections of coding agents, and a map of the code. '
  + 'Call get_task_context before non-trivial work, naming the files you expect to change; get_module_context or impact before changing a file you do not know or others depend on; '
  + 'check_before_done with your git diff before saying a task is done. When your work missed something the developer did not type as pushback, report it with report_feedback.';

function buildServer(ctx: ContextDeps, client: string | undefined) {
  const server = new McpServer({ name: 'feedback-graph', version: VERSION }, { instructions: MCP_INSTRUCTIONS });

  server.registerTool(
    'get_task_context',
    {
      ...read('Task context'),
      description:
        'Before starting non-trivial work: returns approved lessons from past developer feedback and similar past misses in this project, with citations, the code and document facts that matter most for everyday work, and the best matches from projects the developer linked to this one. Name the files you expect to change: lessons tied to them come first, a short code map shows their importers, tests and past misses, and the AGENTS.md / CLAUDE.md files on their path are listed for you to read. brief: true returns only the lessons, the misses on the named files, their importers and tests, and PR discussions, in about 1,500 characters.',
      inputSchema: {
        ...where,
        task: z.string().max(MAX.task).describe('What you are about to build or change, in a sentence or two'),
        files: z.array(z.string().max(MAX.path)).max(50).optional().describe('Files you expect to read or change (repo-relative, or absolute inside the project)'),
        brief: z.boolean().optional().describe('Only lessons, misses on the named files, their importers and tests, and PR discussions (about 1,500 characters)'),
        session_id: z.string().min(1).max(200).regex(/^[\w.:-]+$/, 'a real session id').optional().describe('Your session id, if you know it: facts about files this session edited, refreshed since it started, are marked as your own change'),
      },
    },
    safe(async ({ session_id, ...a }) => { if (session_id) await ctx.registerSession?.(session_id); return text((await getTaskContext({ ...a, sessionId: session_id, client }, ctx)).markdown); }),
  );

  server.registerTool(
    'check_before_done',
    {
      ...read('Check before done'),
      description:
        'Before telling the developer a task is done: checks your work against lessons from past feedback on similar work and lists likely gaps, each with the diff lines it rests on (or the file a lesson requires that the diff lacks). Pass diff (your git diff) and files_changed; with no diff, the diff of files_changed is read from the repo. Also says which importers and tests of those files your change did not touch, and what past misses there were about.',
      inputSchema: {
        ...where,
        task: z.string().max(MAX.task).describe('The task you were given, in a sentence or two'),
        summary: z.string().max(MAX.prose).describe('What you built and how you verified it'),
        diff: z
          .string()
          .max(MAX.diff)
          .optional()
          .describe('Your change as a unified diff: `git diff <commit this session started from>` (staged, unstaged and committed; run `git add -N` on new files first). The judge reads about 32 KB of it, the files most related to the lessons first, then files_changed in order, and the answer names the files it cut. Omitted: the diff of files_changed is read from the repo.'),
        files_changed: z.array(z.string().max(MAX.path)).max(50).optional().describe('Files you changed (repo-relative, or absolute inside the project)'),
        session_id: z.string().min(1).max(200).regex(/^[\w.:-]+$/, 'a real session id').optional().describe("Your session id, if you know it: the check is recorded as your session's"),
      },
    },
    safe(async ({ files_changed, session_id, ...a }) => {
      if (session_id) await ctx.registerSession?.(session_id);
      const result = await checkBeforeDone({ ...a, filesChanged: files_changed, sessionId: session_id, client }, ctx);
      return { ...text(result.markdown), structuredContent: { ...result, queued: result.queued ?? false } };
    }),
  );

  server.registerTool(
    'get_module_context',
    {
      ...read('Module context'),
      description:
        'Before changing a file you do not know well: what it is (code facts), its exported symbols, who imports it, what it imports, the tests that cover it, and approved lessons and past misses tied to it, with citations. Not in the code map: lessons on its path, then the closest by meaning.',
      inputSchema: {
        ...where,
        path: z.string().max(1000).describe('The file (repo-relative, relative to cwd, or absolute inside the project)'),
      },
    },
    safe(async (a) => text((await getModuleContext({ ...a, client }, ctx)).markdown)),
  );

  server.registerTool(
    'impact',
    {
      ...read('Impact of a change'),
      description:
        'Before changing files others depend on: the files that import them (with how many hops away), the tests to run, and approved lessons and past misses on everything impacted.',
      inputSchema: {
        ...where,
        paths: z.array(z.string().max(1000)).min(1).max(50).describe('Files you are about to change'),
        depth: z.number().int().min(1).max(MAX_DEPTH).optional().describe('How many import hops to follow (default 3)'),
      },
    },
    safe(async (a) => text((await getImpact({ ...a, client }, ctx)).markdown)),
  );

  server.registerTool(
    'report_feedback',
    {
      ...write('Report feedback'),
      description:
        'When the developer runs /postmortem, or your work missed something the developer did not say in words (pushback they typed is picked up from the session on its own): queues it in the Feedback Graph inbox for the developer; once they confirm it, a post-mortem learns from it. A report of a miss already in the inbox, even reworded, joins that item.',
      inputSchema: {
        ...where,
        feedback: z.string().max(MAX.prose).describe("The developer's feedback, in their words"),
        what_was_done: z.string().max(MAX.prose).describe('What you had built or claimed before the feedback'),
        session_id: z.string().min(1).max(200).regex(/^[\w.:-]+$/, 'a real session id').optional().describe('Your session id, if you know it: lets the report join the same pushback flagged from this session'),
      },
    },
    safe(async (a) => { if (a.session_id) await ctx.registerSession?.(a.session_id); return text((await reportFeedback({ ...a, whatWasDone: a.what_was_done, sessionId: a.session_id, client }, ctx)).markdown); }),
  );

  server.registerTool(
    'get_recent_sessions',
    {
      ...read('Recent sessions'),
      description:
        'When picking up work in a project, or to see what earlier sessions did: the newest session summaries (goal, what was done and decided, open threads, pushback, files touched, outcome), newest first.',
      inputSchema: {
        ...where,
        limit: z.number().int().min(1).max(RECENT_MAX).optional().describe(`How many sessions (default 5, at most ${RECENT_MAX})`),
      },
    },
    safe(async (a) => text((await getRecentSessions(a, ctx)).markdown)),
  );

  server.registerTool(
    'search_graph',
    {
      ...read('Search the graph'),
      description: 'Search the feedback graph by meaning: approved lessons (those tied to a file the query names first), past misses, code facts and docs closest to the query, in about 3,000 characters. Each section says when nothing is close enough. A lesson found by meaning alone is a search match: check it applies.',
      inputSchema: { ...where, query: z.string().max(MAX.query).describe('What to look for, in plain words') },
    },
    safe(async (a) => text((await searchGraph({ ...a, client }, ctx)).markdown)),
  );

  // Knowledge intake's agent tools, only while INTAKE_ENABLED.
  if (ctx.intake) {
    server.registerTool(
      'find_contradictions',
      {
        ...read('Find contradictions'),
        description:
          'Before stating something as settled (a timeout, a version, a choice made): checks it against the facts and approved lessons agents are told on that scope, with no judge model (only an embedding), and lists what may contradict it (numbers, dates, versions, negations or named choices that differ) and the open conflicts there, which the developer has not settled. Send statement (what you are about to say is true) or topic.',
        inputSchema: {
          ...where,
          statement: z.string().max(MAX.query).optional().describe('What you are about to state as true, in one sentence'),
          topic: z.string().max(MAX.query).optional().describe('What it is about, when you have no statement yet'),
          files: z.array(z.string().max(MAX.path)).max(50).optional().describe('Files it concerns (repo-relative)'),
        },
      },
      safe(async (a) => text((await findContradictions({ ...a, client }, ctx)).markdown)),
    );
    if (ctx.intake.knowledge) {
      server.registerTool(
        'what_do_we_know',
        {
          ...read('What do we know'),
          description:
            'What the developer has accepted about a topic: decisions, plans and facts people stated (who said it and when), the code facts and approved lessons agents are told, and the open conflicts on them, which are not settled: present a disputed point as disputed. No opinion, quote, unreviewed claim or open question; the 30 closest items. Read-only; no judge model is asked.',
          inputSchema: { ...where, topic: z.string().min(1).max(MAX.query).describe('What you want to know about, in plain words') },
        },
        safe(async (a) => text((await whatDoWeKnow({ ...a, client }, ctx)).markdown)),
      );
    }
    server.registerTool(
      'submit_notes',
      {
        ...write('Submit notes'),
        description:
          `Hand the developer notes worth keeping (what was decided, who said what, open questions) as a source to review: it is read into proposed claims, marked as submitted by an agent and kept private (never synced), and nothing from it reaches agents until the developer accepts it. Up to ${NOTES_MAX_BYTES / 1024} KB.`,
        inputSchema: {
          ...where,
          notes: z.string().min(1).max(NOTES_MAX_BYTES).describe('The notes, as text or markdown (lines like "Name: what they said" keep who said it)'),
          title: z.string().max(300).optional().describe('A short title for the source'),
          occurred_at: z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}/, 'a date (YYYY-MM-DD)').optional().describe('When what the notes describe happened (YYYY-MM-DD)'),
        },
      },
      safe(async ({ occurred_at, ...a }) => {
        const r = await submitNotes({ ...a, occurredAt: occurred_at ?? null, client }, ctx);
        return { ...text(r.markdown), ...(r.isError && { isError: true }) };
      }),
    );
  }

  return server;
}

const SESSION_PREFIX = 'fg1.';
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[^\w .@/+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The Activity actor for an MCP client's `clientInfo` (`claude-code 2.1.309 (MCP)`), or undefined without a name. */
export function mcpClientLabel(info: unknown): string | undefined {
  const i = (info && typeof info === 'object' ? info : {}) as { name?: unknown; version?: unknown };
  const name = clean(i.name, 64);
  if (!name) return undefined;
  const version = clean(i.version, 32);
  return `${version ? `${name} ${version}` : name} (MCP)`;
}

/**
 * The server is stateless (a fresh one per request), so the client's name from `initialize` would be gone by its first
 * tool call. It rides along in the session id instead: the client echoes `Mcp-Session-Id` on every later request, the
 * stateless transport does not check it, and nothing is kept in memory, so it survives a restart. It is only a label
 * for the provenance log, claimed by the client like `clientInfo` itself, and is cleaned again when read.
 */
const encodeClient = (label: string) => SESSION_PREFIX + Buffer.from(label, 'utf8').toString('base64url');
function decodeClient(header: string | null): string | undefined {
  if (!header?.startsWith(SESSION_PREFIX) || header.length > 200) return undefined;
  const label = Buffer.from(header.slice(SESSION_PREFIX.length), 'base64url').toString('utf8');
  return /^[\w.@/+-][\w .@/+-]{0,96} \(MCP\)$/.test(label) ? label : undefined;
}

/** The `clientInfo` of an `initialize` request (as the client claims it, uncleaned); undefined for any other request. */
export async function initializeClientInfo(req: Request): Promise<{ found: boolean; info: unknown }> {
  if (req.method !== 'POST') return { found: false, info: undefined };
  const body = (await req.clone().json().catch(() => null)) as unknown;
  const msgs = (Array.isArray(body) ? body : [body]) as { method?: unknown; params?: { clientInfo?: unknown } }[];
  const init = msgs.find((m) => m && typeof m === 'object' && m.method === 'initialize');
  return init ? { found: true, info: init.params?.clientInfo } : { found: false, info: undefined };
}

const retryIdentitySalt = randomBytes(32);

/** Whether a request calls a tool (alone or in a batch). */
async function callsTool(req: Request): Promise<boolean> {
  const body = (await req.clone().json().catch(() => null)) as unknown;
  return (Array.isArray(body) ? body : [body]).some((m) => m && typeof m === 'object' && (m as { method?: unknown }).method === 'tools/call');
}

async function initializeClient(req: Request): Promise<string | undefined> {
  const init = await initializeClientInfo(req);
  return init.found ? mcpClientLabel(init.info) : undefined;
}

/**
 * Stateless Streamable HTTP: a fresh server + transport per request. onAgentCall: told the client's label when a client
 * that named itself at initialize calls a tool and the call answers; the fg CLI and probes never initialize, so never.
 */
export async function handleMcp(req: Request, ctx: ContextDeps, authenticatedIdentity?: string, onAgentCall?: (client: string) => Promise<void>): Promise<Response> {
  // A client ending its session (Codex does on every exit). Stateless: there is nothing to end, so it simply succeeds.
  if (req.method === 'DELETE') return new Response(null, { status: 204 });
  // The stream a GET opens is for messages the server sends unasked, and this one never does: the stateless transport
  // closed it at once, and every client reopened it, twice a second. 405 is the spec's way to say there is none.
  if (req.method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
  const initialized = await initializeClient(req);
  const capability = currentCaller();
  // Only the embedding authenticated route can vouch for a credential; arbitrary headers are not identity.
  const identity = authenticatedIdentity ? createHmac('sha256', retryIdentitySalt).update(JSON.stringify([authenticatedIdentity, capability, req.headers.get('origin')])).digest('hex') : undefined;
  const client = initialized ?? decodeClient(req.headers.get('mcp-session-id'));
  const agentCall = !!client && !!onAgentCall && (await callsTool(req));
  const server = buildServer({ ...ctx, checkRetryIdentity: identity }, client);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MCP_BODY_LIMIT });
  await server.connect(transport);
  try {
    const streamed = await transport.handleRequest(req);
    // JSON transport creates its Response before an async tool callback finishes. Wait for the JSON result so
    // request authorization and cleanup observe that callback's outcome; do not buffer event streams.
    const res = streamed.body && streamed.headers.get('content-type')?.includes('application/json')
      ? new Response(await streamed.text(), { status: streamed.status, statusText: streamed.statusText, headers: streamed.headers }) : streamed;
    if (agentCall && res.ok) await onAgentCall!(client!);
    if (!initialized || !res.ok) return res;
    const headers = new Headers(res.headers);
    headers.set('mcp-session-id', encodeClient(initialized));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } finally {
    void server.close();
  }
}
