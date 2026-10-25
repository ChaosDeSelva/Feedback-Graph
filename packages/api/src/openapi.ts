import { z, type ZodTypeAny } from 'zod';
import { appSchemas } from './app.ts';
import { chatSchemas } from './chat.ts';
import { cloudSchemas } from './cloud.ts';
import { importSchemas } from './import.ts';
import { integrationSchemas } from './integrations.ts';
import { OWNER_ROUTES } from './operator.ts';
import { sessionSchemas } from './sessions.ts';
import { settingsSchemas } from './settings.ts';

/**
 * GET /api/openapi.json: the local REST API as an OpenAPI 3.1 document. Request bodies and query strings come from the
 * zod schemas the routes validate with; the route table below adds what zod cannot say (summary, response). Owner-only
 * routes (OWNER_ROUTES) carry `x-owner-only: true` and `x-operator-verb`, the OPERATOR_ALLOW verb that lets the operator
 * token make that decision. openapi.test.ts fails when a registered route is missing here.
 */

type JsonSchema = Record<string, unknown>;

/** A zod v3 schema as JSON Schema: the subset the routes use. A refinement or transform is its inner schema. */
export function jsonSchema(s: ZodTypeAny): JsonSchema {
  const d = s._def as Record<string, any>;
  switch (d.typeName) {
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      for (const c of d.checks) {
        if (c.kind === 'min') out.minLength = c.value;
        else if (c.kind === 'max') out.maxLength = c.value;
        else if (c.kind === 'length') out.minLength = out.maxLength = c.value;
        else if (c.kind === 'regex') out.pattern = c.regex.source;
      }
      return out;
    }
    case 'ZodNumber': {
      const out: JsonSchema = { type: d.checks.some((c: { kind: string }) => c.kind === 'int') ? 'integer' : 'number' };
      for (const c of d.checks) {
        if (c.kind === 'min') out[c.inclusive ? 'minimum' : 'exclusiveMinimum'] = c.value;
        else if (c.kind === 'max') out[c.inclusive ? 'maximum' : 'exclusiveMaximum'] = c.value;
      }
      return out;
    }
    case 'ZodBoolean': return { type: 'boolean' };
    case 'ZodEnum': return { type: 'string', enum: [...d.values] };
    case 'ZodLiteral': return { const: d.value };
    case 'ZodArray': {
      const out: JsonSchema = { type: 'array', items: jsonSchema(d.type) };
      if (d.minLength) out.minItems = d.minLength.value;
      if (d.maxLength) out.maxItems = d.maxLength.value;
      return out;
    }
    case 'ZodObject': {
      const shape = d.shape() as Record<string, ZodTypeAny>;
      const out: JsonSchema = { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, jsonSchema(v)])) };
      const required = Object.entries(shape).filter(([, v]) => !v.isOptional()).map(([k]) => k);
      if (required.length) out.required = required;
      if (d.unknownKeys === 'strict') out.additionalProperties = false;
      return out;
    }
    case 'ZodOptional': return jsonSchema(d.innerType);
    case 'ZodNullable': return { anyOf: [jsonSchema(d.innerType), { type: 'null' }] };
    case 'ZodDefault': return { ...jsonSchema(d.innerType), default: d.defaultValue() };
    case 'ZodEffects': return jsonSchema(d.schema);
    case 'ZodUnion': return { anyOf: d.options.map(jsonSchema) };
    case 'ZodRecord': return { type: 'object', additionalProperties: jsonSchema(d.valueType) };
    default: return {};
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Route = { summary: string; tag: string; body?: ZodTypeAny; query?: z.AnyZodObject; response: string; status?: number; type?: string };

/** DELETE /api/projects/:key checks this by hand: the project's name, typed again. */
const ConfirmKey = z.object({ confirm: z.string().describe('the project key, typed again') });
const SessionToken = z.object({ token: z.string() });
const ProjectQuery = z.object({ project: z.string().min(1).max(200).optional() });
const CwdQuery = z.object({ cwd: z.string().optional() });
const KeepApproved = z.object({ keepApproved: z.enum(['1', 'true']).optional() });

/**
 * Every route of createApp but the UI's files and /mcp (the MCP endpoint, described by its own protocol). A function:
 * app.ts imports this module, so its schemas are read only once both are loaded.
 */
const routes = (a = appSchemas): Record<string, Partial<Record<Method, Route>>> => ({
  '/api/health': { GET: { tag: 'system', summary: 'Liveness (no sign-in needed)', response: '{ ok: true }' } },
  '/api/ready': { GET: { tag: 'system', summary: 'Readiness: the store answers (no sign-in needed)', response: '{ ok, store? }; 503 while the store is down' } },
  '/api/status': { GET: { tag: 'system', summary: 'Store, worker heartbeat and stage, model health, selection, connections', response: 'SystemStatus' } },
  '/api/pipeline': { GET: { tag: 'system', summary: 'Every stage\'s count (sessions, classify backlog, Inbox, post-mortems, lessons, scans)', query: ProjectQuery, response: 'PipelineStatus; a count that could not be read is null' } },
  '/api/events': { GET: { tag: 'system', summary: 'Server-sent events: stage, pipeline, scan, chat, activity (of the shown projects); a heartbeat comment every 15 s; at most 20 streams', response: 'text/event-stream; 503 when 20 streams are open', type: 'text/event-stream' } },
  '/api/openapi.json': { GET: { tag: 'system', summary: 'This document', response: 'OpenAPI 3.1 document' } },
  '/api/session': {
    GET: { tag: 'system', summary: 'Whether sign-in is needed and whether this request is signed in', response: '{ authRequired, authenticated }' },
    POST: { tag: 'system', summary: 'Sign in with API_TOKEN: sets the UI session cookie', body: SessionToken, response: 'no content; 401 on a wrong token', status: 204 },
    DELETE: { tag: 'system', summary: 'Sign out: clears the session cookie', response: 'no content', status: 204 },
  },
  '/api/agent/project': { GET: { tag: 'system', summary: 'Whether a folder (cwd) is a selected project (for the plugin hooks)', query: CwdQuery, response: 'the tracked project, or why not' } },

  '/api/candidates': { GET: { tag: 'inbox', summary: 'Inbox items of the shown projects', query: a.ListQuery, response: 'Candidate[]' } },
  '/api/candidates/{id}': { GET: { tag: 'inbox', summary: 'One Inbox item with its turn and surrounding conversation', response: 'CandidateDetail; 404 when missing or not shown' } },
  '/api/candidates/{id}/decision': { POST: { tag: 'inbox', summary: 'Confirm or reject one Inbox item', body: a.Decision, response: 'no content', status: 204 } },
  '/api/candidates/decisions': { POST: { tag: 'inbox', summary: 'Many Inbox decisions in one call; one not found does not stop the rest', body: a.Decisions, response: '{ results: [{ id, ok, status? | error? }] }' } },
  '/api/stats': { GET: { tag: 'inbox', summary: 'Per-project Inbox counts', response: 'ProjectStats[]' } },
  '/api/feedback/{id}/retry': { POST: { tag: 'inbox', summary: 'Retry a given-up post-mortem', response: '{ queued: true }', status: 202 } },
  '/api/turns/requeue': { POST: { tag: 'inbox', summary: 'Re-queue the turns the classifier gave up on', response: '{ requeued: number }' } },

  '/api/lessons': { GET: { tag: 'lessons', summary: 'Lessons of the shown projects (and global ones)', query: a.LessonQuery, response: 'Lesson[]' } },
  '/api/lessons/{id}': {
    GET: { tag: 'lessons', summary: 'One lesson with its evidence', response: 'LessonDetail' },
    PATCH: { tag: 'lessons', summary: 'Approve, reject or edit a lesson', body: a.LessonPatch, response: 'no content; 409 when a lesson with no project is narrowed', status: 204 },
  },
  '/api/lessons/{id}/to-fact': {
    POST: { tag: 'lessons', summary: 'Turn a lesson that states how the code is into a project fact you wrote; the lesson is rejected with the note "converted to a fact"', body: a.LessonToFact, response: 'StoredFact; 409 when the lesson is already rejected or superseded, or has no project', status: 201 },
  },

  '/api/projects': { GET: { tag: 'projects', summary: 'The shown projects, pinned first', response: 'ProjectSummary[]' } },
  '/api/projects/scan': { POST: { tag: 'projects', summary: 'Queue scans of many folders (keys, or all: true)', body: a.BatchScanRequest, response: '{ results: [{ key, queued, job? | error? }] }', status: 202 } },
  '/api/projects/{key}': { DELETE: { tag: 'projects', summary: 'Delete everything learned from a project', body: ConfirmKey, response: '{ removed, note }' } },
  '/api/projects/{key}/scan': { POST: { tag: 'projects', summary: 'Queue a scan of one folder', body: a.ScanRequest, response: 'ScanJob', status: 202 } },
  '/api/scans/{id}': { GET: { tag: 'projects', summary: 'One scan job, with its place in the queue while queued', response: 'ScanJob & { queuePosition }' } },
  '/api/projects/{key}/facts': { GET: { tag: 'projects', summary: 'A project\'s facts (q: semantic search)', query: a.FactsQuery, response: 'Fact[]' } },
  '/api/projects/{key}/facts/{id}/relevance': { PATCH: { tag: 'projects', summary: 'Set how often everyday coding needs a fact', body: a.RelevanceRequest, response: 'no content', status: 204 } },
  '/api/projects/{key}/pin': { PUT: { tag: 'projects', summary: 'Pin or unpin a project', body: a.PinRequest, response: 'no content', status: 204 } },
  '/api/projects/{key}/docs': {
    GET: { tag: 'docs', summary: 'A project\'s documents', response: 'Doc[]' },
    POST: { tag: 'docs', summary: 'Upload a text document or an image', body: a.DocUpload, response: '{ id, chunks }', status: 201 },
  },
  '/api/docs/{id}': { DELETE: { tag: 'docs', summary: 'Remove a document', response: 'no content', status: 204 } },
  '/api/docs/{id}/image': { GET: { tag: 'docs', summary: 'An uploaded image', response: 'the image bytes', type: 'image/*' } },
  '/api/docs/{id}/reread': { POST: { tag: 'docs', summary: 'Read a document whose reading failed again', response: 'no content', status: 204 } },
  '/api/projects/{key}/links': { GET: { tag: 'links', summary: 'A project\'s links to other shown projects', response: 'ProjectLink[]' } },
  '/api/links': { PUT: { tag: 'links', summary: 'Confirm, dismiss or edit a link between two projects', body: a.LinkRequest, response: 'ProjectLink' } },
  '/api/links/{id}': { DELETE: { tag: 'links', summary: 'Remove a link', response: 'no content', status: 204 } },

  '/api/projects/{key}/codemap/hotspots': { GET: { tag: 'codemap', summary: 'A project\'s hotspots', query: a.hotspotQuery(null), response: '{ meta, capped, hotspots }' } },
  '/api/projects/{key}/codemap/rebuild': { POST: { tag: 'codemap', summary: 'Remap a project from scratch at the worker\'s next pass', response: '{ queued: true }', status: 202 } },
  '/api/projects/{key}/codemap/graph': { GET: { tag: 'codemap', summary: 'The Graph page\'s code mode', query: a.MapGraphQuery, response: 'MapGraph & { meta, capped }' } },
  '/api/projects/{key}/codemap/module': { GET: { tag: 'codemap', summary: 'One file\'s module context', query: z.object({ path: a.RepoPath }), response: 'ModuleContext' } },
  '/api/projects/{key}/codemap/impact': { GET: { tag: 'codemap', summary: 'What changing these files touches', query: a.ImpactQuery, response: 'Impact' } },
  '/api/codemap/hotspots': { GET: { tag: 'codemap', summary: 'Hotspots across the shown projects', query: a.TopHotspotQuery, response: 'Hotspot[] with projectKey' } },

  '/api/graph': { GET: { tag: 'insights', summary: 'A project\'s knowledge graph', query: a.ProjectParam, response: 'ProjectGraph' } },
  '/api/patterns': { GET: { tag: 'insights', summary: 'Recurring patterns', query: ProjectQuery, response: 'Patterns' } },
  '/api/activity': { GET: { tag: 'activity', summary: 'The activity log of the shown projects, newest first', query: a.ActivityQuery, response: 'Activity[]' } },

  '/api/export': { GET: { tag: 'portability', summary: 'An export bundle (attachment)', query: a.ExportQuery, response: 'ExportBundle' } },
  '/api/import': { POST: { tag: 'portability', summary: 'Import an export bundle; its lessons arrive proposed unless keepApproved', query: KeepApproved, body: importSchemas.Bundle, response: 'ImportResult' } },

  '/api/settings/projects': {
    GET: { tag: 'settings', summary: 'Every project folder and which are selected', response: 'SettingsBody' },
    PUT: { tag: 'settings', summary: 'Choose which project folders are read', body: settingsSchemas.Selection, response: 'SettingsBody' },
  },
  '/api/settings/roots': { PUT: { tag: 'settings', summary: 'Save the project roots (mounted at the next setup run)', body: settingsSchemas.Roots, response: 'SettingsBody' } },
  '/api/settings/cleanup': { POST: { tag: 'settings', summary: 'Delete everything learned from unselected projects', body: settingsSchemas.Cleanup, response: '{ removed: string[], nodesRemoved }' } },
  '/api/settings/integrations': { GET: { tag: 'integrations', summary: 'GitHub and Linear: connection state and per-project links', response: 'IntegrationsView' } },
  '/api/settings/integrations/{kind}': {
    PUT: { tag: 'integrations', summary: 'Save a token (github or linear)', body: integrationSchemas.Token, response: 'IntegrationsView' },
    DELETE: { tag: 'integrations', summary: 'Remove a saved token', response: 'IntegrationsView' },
  },
  '/api/settings/integrations/{kind}/test': { POST: { tag: 'integrations', summary: 'Check a token against the service', response: 'IntegrationsView' } },
  '/api/settings/integrations/linear/teams': { GET: { tag: 'integrations', summary: 'The Linear teams the token can read', response: 'LinearTeam[]' } },
  '/api/settings/integrations/projects/{key}': { PUT: { tag: 'integrations', summary: 'A project\'s GitHub switch and Linear team', body: integrationSchemas.LinkPatch, response: 'IntegrationsView' } },

  '/api/cloud': { GET: { tag: 'cloud', summary: 'Cloud sync: settings, preview and last run', response: 'CloudInfo' } },
  '/api/cloud/progress': { GET: { tag: 'cloud', summary: 'Sync now\'s progress', response: '{ running, lastManual }' } },
  '/api/cloud/sync': { POST: { tag: 'cloud', summary: 'Sync now', body: cloudSchemas.SyncRequest, response: 'CloudSyncResult' } },

  '/api/sessions': { GET: { tag: 'sessions', summary: 'Session summaries, newest first, paged by cursor', query: sessionSchemas.ListQuery, response: '{ sessions, next }' } },
  '/api/sessions/{id}': { GET: { tag: 'sessions', summary: 'One session\'s summary and history', response: 'SessionDetail' } },
  '/api/sessions/{id}/resummarize': { POST: { tag: 'sessions', summary: 'Rebuild a session summary from scratch', response: '{ queued: true }', status: 202 } },

  '/api/chats': {
    GET: { tag: 'ask', summary: 'Ask conversations of the shown projects', query: chatSchemas.ListChats, response: 'ChatConversation[]' },
    POST: { tag: 'ask', summary: 'Start a conversation', body: chatSchemas.CreateChat, response: 'ChatConversation', status: 201 },
  },
  '/api/chats/{id}': {
    GET: { tag: 'ask', summary: 'A conversation with its turns', response: 'ChatThread' },
    PATCH: { tag: 'ask', summary: 'Rename a conversation or switch its provider', body: chatSchemas.PatchChat, response: 'ChatConversation' },
    DELETE: { tag: 'ask', summary: 'Delete a conversation', response: 'no content', status: 204 },
  },
  '/api/chats/{id}/messages': { POST: { tag: 'ask', summary: 'Ask a question; the worker answers it', body: chatSchemas.Message, response: 'ChatThread; 409 while a question is being answered', status: 202 } },
  '/api/chats/{id}/turns/{turnId}/retry': { POST: { tag: 'ask', summary: 'Retry a failed answer', response: 'ChatThread', status: 202 } },
});

const verbs = new Map(OWNER_ROUTES.map(([m, p, verb]) => [`${m} ${p.replace(/:(\w+)/g, '{$1}')}`, verb]));

function operation(method: Method, path: string, r: Route) {
  const verb = verbs.get(`${method} ${path}`);
  const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
  const shape = (r.query?.shape ?? {}) as Record<string, ZodTypeAny>;
  const query = Object.entries(shape).map(([name, s]) => ({ name, in: 'query', required: !s.isOptional(), schema: jsonSchema(s) }));
  const status = String(r.status ?? 200);
  const noContent = r.status === 204;
  return {
    summary: r.summary,
    tags: [r.tag],
    ...(params.length || query.length ? { parameters: [...params, ...query] } : {}),
    ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(r.body) } } } } : {}),
    responses: {
      [status]: { description: r.response, ...(noContent ? {} : { content: { [r.type ?? 'application/json']: {} } }) },
      default: { description: 'an error: { error: string | zod flatten() }' },
    },
    'x-owner-only': verb !== undefined,
    ...(verb && {
      'x-operator-verb': verb,
      description: `Owner-only: from the Feedback Graph UI, or with FG_OPERATOR_TOKEN as the Bearer when OPERATOR_ALLOW includes ${verb}.`,
    }),
  };
}

let cached: { version: string; doc: object } | null = null;

export function openApiDocument(version: string): object {
  if (cached?.version === version) return cached.doc;
  const paths = Object.fromEntries(Object.entries(routes()).map(([p, ops]) => [
    p,
    Object.fromEntries(Object.entries(ops).map(([m, r]) => [m.toLowerCase(), operation(m as Method, p, r!)])),
  ]));
  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'Feedback Graph local API',
      version,
      description: 'The REST API the UI and the fg CLI use. With API_TOKEN set every route but /api/health, /api/ready and /api/session needs it (Bearer, or the UI session cookie). Writes need Content-Type: application/json.',
    },
    servers: [{ url: '/' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearer: [] }, {}],
    paths,
  };
  cached = { version, doc };
  return doc;
}
