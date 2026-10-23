import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { VERSION } from '@fb/core';
import { checkBeforeDone, getImpact, getModuleContext, getTaskContext, MAX_DEPTH, reportFeedback, type ContextDeps } from './context.ts';

const where = {
  cwd: z.string().optional().describe('Absolute path of the directory you are working in (preferred)'),
  project: z.string().optional().describe('Project key, if you know it instead of cwd'),
};

const text = (markdown: string) => ({ content: [{ type: 'text' as const, text: markdown }] });

function buildServer(ctx: ContextDeps) {
  const server = new McpServer({ name: 'feedback-graph', version: VERSION });

  server.registerTool(
    'get_task_context',
    {
      description:
        'Before starting non-trivial work: returns approved lessons from past developer feedback and similar past misses in this project, with citations. Name the files you expect to change: lessons tied to them come first, and a short code map shows their importers, tests and last misses.',
      inputSchema: {
        ...where,
        task: z.string().describe('What you are about to build or change, in a sentence or two'),
        files: z.array(z.string()).max(50).optional().describe('Files you expect to read or change (repo-relative, or absolute inside the project)'),
      },
    },
    async (a) => text((await getTaskContext(a, ctx)).markdown),
  );

  server.registerTool(
    'check_before_done',
    {
      description:
        'Before telling the developer a task is done: checks your work against lessons from past feedback on similar work and lists likely gaps. Pass files_changed to also hear which importers and tests of those files your change did not touch, and what past misses there were about.',
      inputSchema: {
        ...where,
        task: z.string(),
        summary: z.string().describe('What you built and how you verified it'),
        diff: z.string().optional().describe('Optional unified diff of your changes'),
        files_changed: z.array(z.string()).max(50).optional().describe('Files you changed (repo-relative, or absolute inside the project)'),
      },
    },
    async ({ files_changed, ...a }) => text((await checkBeforeDone({ ...a, filesChanged: files_changed }, ctx)).markdown),
  );

  server.registerTool(
    'get_module_context',
    {
      description:
        'Before changing a file you do not know well: what it is (code facts), its exported symbols, who imports it, what it imports, the tests that cover it, and approved lessons and past misses tied to it, with citations.',
      inputSchema: {
        ...where,
        path: z.string().max(1000).describe('The file (repo-relative, relative to cwd, or absolute inside the project)'),
      },
    },
    async (a) => text((await getModuleContext(a, ctx)).markdown),
  );

  server.registerTool(
    'impact',
    {
      description:
        'Before changing files others depend on: the files that import them (with how many hops away), the tests to run, and approved lessons and past misses on everything impacted.',
      inputSchema: {
        ...where,
        paths: z.array(z.string().max(1000)).min(1).max(50).describe('Files you are about to change'),
        depth: z.number().int().min(1).max(MAX_DEPTH).optional().describe('How many import hops to follow (default 3)'),
      },
    },
    async (a) => text((await getImpact(a, ctx)).markdown),
  );

  server.registerTool(
    'report_feedback',
    {
      description:
        'When the developer runs /postmortem, or your work missed something the developer did not say in words (pushback they typed is picked up from the session on its own): queues it in the Feedback Graph inbox for the developer; once they confirm it, a post-mortem learns from it. A report of pushback already flagged from the session joins that inbox item.',
      inputSchema: {
        ...where,
        feedback: z.string().describe("The developer's feedback, in their words"),
        what_was_done: z.string().describe('What you had built or claimed before the feedback'),
        session_id: z.string().optional().describe('Your session id, if you know it: lets the report join the same pushback flagged from this session'),
      },
    },
    async (a) => text((await reportFeedback({ ...a, whatWasDone: a.what_was_done, sessionId: a.session_id }, ctx)).markdown),
  );

  server.registerTool(
    'search_graph',
    {
      description: 'Search lessons and past misses in the feedback graph by meaning.',
      inputSchema: { ...where, query: z.string() },
    },
    async (a) => text((await getTaskContext({ ...a, task: a.query }, ctx)).markdown),
  );

  return server;
}

/** Stateless Streamable HTTP: a fresh server + transport per request. */
export async function handleMcp(req: Request, ctx: ContextDeps): Promise<Response> {
  const server = buildServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}
