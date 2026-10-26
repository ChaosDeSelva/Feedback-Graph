import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { VERSION } from '@fb/core';
import { checkBeforeDone, getImpact, getModuleContext, getRecentSessions, getTaskContext, MAX_DEPTH, RECENT_MAX, reportFeedback, searchGraph, type ContextDeps } from './context.ts';

/**
 * Length limits on free text: every argument is embedded, searched or stored, so a runaway client (a 1 MB task was
 * seen) is refused here instead of costing an embedding and a megabyte Activity row.
 */
const MAX = { path: 1000, key: 200, task: 8000, query: 2000, prose: 20_000, diff: 900_000 } as const;

const where = {
  cwd: z.string().max(MAX.path).optional().describe('Absolute path of the directory you are working in (preferred)'),
  project: z.string().max(MAX.key).optional().describe('Project key, if you know it instead of cwd'),
};

const text = (markdown: string) => ({ content: [{ type: 'text' as const, text: markdown }] });

/**
 * MCP ToolAnnotations. Codex will not call a tool without them, so every tool says what it is: the reads change nothing
 * the agent would notice (the provenance log aside) and may be repeated; report_feedback queues a new inbox item each
 * call, but never removes or overwrites anything. None reaches past this machine's graph.
 */
const read = (title: string) => ({ title, annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
const write = (title: string) => ({ title, annotations: { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } });

function buildServer(ctx: ContextDeps, client: string | undefined) {
  const server = new McpServer({ name: 'feedback-graph', version: VERSION });

  server.registerTool(
    'get_task_context',
    {
      ...read('Task context'),
      description:
        'Before starting non-trivial work: returns approved lessons from past developer feedback and similar past misses in this project, with citations, the code and document facts that matter most for everyday work, and the best matches from projects the developer linked to this one. Name the files you expect to change: lessons tied to them come first, and a short code map shows their importers, tests and past misses. brief: true returns only the lessons, the misses on the named files, their importers and tests, and PR discussions, in about 1,500 characters.',
      inputSchema: {
        ...where,
        task: z.string().max(MAX.task).describe('What you are about to build or change, in a sentence or two'),
        files: z.array(z.string().max(MAX.path)).max(50).optional().describe('Files you expect to read or change (repo-relative, or absolute inside the project)'),
        brief: z.boolean().optional().describe('Only lessons, misses on the named files, their importers and tests, and PR discussions (about 1,500 characters)'),
        session_id: z.string().max(MAX.key).optional().describe('Your session id, if you know it: facts refreshed since it started are marked as your own change'),
      },
    },
    async ({ session_id, ...a }) => text((await getTaskContext({ ...a, sessionId: session_id, client }, ctx)).markdown),
  );

  server.registerTool(
    'check_before_done',
    {
      ...read('Check before done'),
      description:
        'Before telling the developer a task is done: checks your work against lessons from past feedback on similar work and lists likely gaps, each with the diff lines it rests on. Pass diff (your git diff) and files_changed; with no diff, the diff of files_changed is read from the repo. Also says which importers and tests of those files your change did not touch, and what past misses there were about.',
      inputSchema: {
        ...where,
        task: z.string().max(MAX.task),
        summary: z.string().max(MAX.prose).describe('What you built and how you verified it'),
        diff: z
          .string()
          .max(MAX.diff)
          .optional()
          .describe('Your change as a unified diff: `git diff <commit this session started from>` (staged, unstaged and committed; run `git add -N` on new files first). The judge reads about 32 KB of it, the files most related to the lessons first, then files_changed in order, and the answer names the files it cut. Omitted: the diff of files_changed is read from the repo.'),
        files_changed: z.array(z.string().max(MAX.path)).max(50).optional().describe('Files you changed (repo-relative, or absolute inside the project)'),
        session_id: z.string().max(MAX.key).optional().describe("Your session id, if you know it: the check is recorded as your session's"),
      },
    },
    async ({ files_changed, session_id, ...a }) => text((await checkBeforeDone({ ...a, filesChanged: files_changed, sessionId: session_id, client }, ctx)).markdown),
  );

  server.registerTool(
    'get_module_context',
    {
      ...read('Module context'),
      description:
        'Before changing a file you do not know well: what it is (code facts), its exported symbols, who imports it, what it imports, the tests that cover it, and approved lessons and past misses tied to it, with citations.',
      inputSchema: {
        ...where,
        path: z.string().max(1000).describe('The file (repo-relative, relative to cwd, or absolute inside the project)'),
      },
    },
    async (a) => text((await getModuleContext({ ...a, client }, ctx)).markdown),
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
    async (a) => text((await getImpact({ ...a, client }, ctx)).markdown),
  );

  server.registerTool(
    'report_feedback',
    {
      ...write('Report feedback'),
      description:
        'When the developer runs /postmortem, or your work missed something the developer did not say in words (pushback they typed is picked up from the session on its own): queues it in the Feedback Graph inbox for the developer; once they confirm it, a post-mortem learns from it. A report of pushback already flagged from the session joins that inbox item.',
      inputSchema: {
        ...where,
        feedback: z.string().max(MAX.prose).describe("The developer's feedback, in their words"),
        what_was_done: z.string().max(MAX.prose).describe('What you had built or claimed before the feedback'),
        session_id: z.string().max(MAX.key).optional().describe('Your session id, if you know it: lets the report join the same pushback flagged from this session'),
      },
    },
    async (a) => text((await reportFeedback({ ...a, whatWasDone: a.what_was_done, sessionId: a.session_id, client }, ctx)).markdown),
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
    async (a) => text((await getRecentSessions(a, ctx)).markdown),
  );

  server.registerTool(
    'search_graph',
    {
      ...read('Search the graph'),
      description: 'Search the feedback graph by meaning: approved lessons, past misses, code facts and docs closest to the query, in about 3,000 characters. Each section says when nothing is close enough.',
      inputSchema: { ...where, query: z.string().max(MAX.query) },
    },
    async (a) => text((await searchGraph({ ...a, client }, ctx)).markdown),
  );

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

async function initializeClient(req: Request): Promise<string | undefined> {
  const init = await initializeClientInfo(req);
  return init.found ? mcpClientLabel(init.info) : undefined;
}

/** Stateless Streamable HTTP: a fresh server + transport per request. */
export async function handleMcp(req: Request, ctx: ContextDeps): Promise<Response> {
  // A client ending its session (Codex does on every exit). Stateless: there is nothing to end, so it simply succeeds.
  if (req.method === 'DELETE') return new Response(null, { status: 204 });
  // The stream a GET opens is for messages the server sends unasked, and this one never does: the stateless transport
  // closed it at once, and every client reopened it, twice a second. 405 is the spec's way to say there is none.
  if (req.method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
  const initialized = await initializeClient(req);
  const server = buildServer(ctx, initialized ?? decodeClient(req.headers.get('mcp-session-id')));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req);
    if (!initialized || !res.ok) return res;
    const headers = new Headers(res.headers);
    headers.set('mcp-session-id', encodeClient(initialized));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } finally {
    void server.close();
  }
}
