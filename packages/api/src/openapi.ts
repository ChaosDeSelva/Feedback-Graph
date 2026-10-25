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
 * zod schemas the routes validate with; the route table below adds what zod cannot say (summary, response), and every
 * 2xx body has a schema (components.schemas, SCHEMA_OF). Owner-only routes (OWNER_ROUTES) carry `x-owner-only: true` and
 * `x-operator-verb`, the OPERATOR_ALLOW verb that lets the operator token make that decision. openapi.test.ts fails when
 * a registered route is missing here or an operation has no response schema.
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
/**
 * schema: the 2xx body's JSON Schema. Unset: read from `response` when it starts with a type named in SCHEMAS
 * (`Lesson`, `Candidate[]`).
 */
type Route = { summary: string; tag: string; body?: ZodTypeAny; query?: z.AnyZodObject; response: string; status?: number; type?: string; schema?: JsonSchema; description?: string };

// ── Response shapes (components.schemas) ───────────────────────────────
// The main objects spelled out from the core types (types.ts, graph/*.ts); the bigger composites are objects with a
// description. A property marked nullable may be null; one not in `required` may be missing (older records).

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (s: JsonSchema): JsonSchema => ({ type: 'array', items: s });
const str: JsonSchema = { type: 'string' };
const num: JsonSchema = { type: 'number' };
const int: JsonSchema = { type: 'integer' };
const bool: JsonSchema = { type: 'boolean' };
const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: 'null' }] });
const time: JsonSchema = { type: 'string', format: 'date-time' };
const obj = (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties), description?: string): JsonSchema =>
  ({ type: 'object', ...(description && { description }), properties, required });
/** An object this document does not spell out field by field. */
const loose = (description: string): JsonSchema => ({ type: 'object', description, additionalProperties: true });

const SCHEMAS: Record<string, JsonSchema> = {
  Error: obj({ error: { anyOf: [str, { type: 'object', description: 'zod flatten(): formErrors and fieldErrors' }] } }, ['error'], 'Every refusal: 4xx or 5xx'),
  Classification: obj({ label: str, confidence: num, summary: str, signals: arrayOf(str) }),
  Candidate: obj({
    id: str, turnUuid: str, sessionId: str, projectKey: str, source: { type: 'string', enum: ['claude', 'codex', 'github', 'linear'] },
    external: nullable(loose('The GitHub or Linear comment: author, url, thread, title, path, line, diffHunk, description (the PR or ticket text), ticket, authorKind')),
    classification: ref('Classification'), status: { type: 'string', enum: ['pending', 'confirmed', 'rejected'] },
    createdAt: time, decidedAt: nullable(time), note: nullable(str), decidedBy: nullable(str),
    origins: arrayOf({ type: 'string', enum: ['detector', 'agent'] }), agentReport: nullable(loose('What the agent reported through report_feedback')),
  }, ['id', 'turnUuid', 'sessionId', 'projectKey', 'source', 'classification', 'status', 'createdAt', 'decidedAt', 'note']),
  CandidateDetail: obj({ candidate: ref('Candidate'), turn: loose('The flagged turn (text, role, ts)'), before: arrayOf(loose('A turn')), after: arrayOf(loose('A turn')), commits: arrayOf(loose('A commit')), postmortem: nullable(loose('Post-mortem progress')) }, ['candidate', 'turn']),
  ProjectStats: obj({ projectKey: str, week: str, humanTurns: int, pushback: int }),
  LessonCheck: obj({ name: str, why: str }),
  Lesson: obj({
    id: str, projectKey: nullable(str), origin: nullable(str), title: str, rule: str, appliesWhen: str,
    scope: { type: 'string', enum: ['task', 'project', 'global'] }, paths: arrayOf(str),
    status: { type: 'string', enum: ['proposed', 'approved', 'rejected', 'superseded'] }, source: { type: 'string', enum: ['postmortem', 'memory', 'manual'] },
    cause: nullable(str), missId: nullable(str), createdAt: time, decidedAt: nullable(time), decidedBy: nullable(str),
    checks: nullable(arrayOf(ref('LessonCheck'))), decisionNote: nullable(str),
  }, ['id', 'projectKey', 'title', 'rule', 'appliesWhen', 'scope', 'paths', 'status', 'source', 'cause', 'missId', 'createdAt', 'decidedAt']),
  LessonDetail: obj({ lesson: ref('Lesson'), miss: nullable(loose('The miss it was learned from')), feedback: nullable(loose('The feedback behind it')), contextItems: arrayOf(loose('What the agent had')), fixCommits: arrayOf(loose('A commit')), supersedes: arrayOf(ref('Lesson')) }, ['lesson']),
  ScanShards: obj({ total: int, rescanned: int, failed: int, done: { type: 'integer', description: 'While it runs: shards got through so far' } }, ['total', 'rescanned', 'failed']),
  ScanJob: obj({
    id: str, projectKey: str, repoPath: str, provider: nullable(str), status: { type: 'string', enum: ['queued', 'running', 'done', 'failed'] },
    requestedAt: time, startedAt: nullable(time), finishedAt: nullable(time), filesScanned: int, factsAdded: int, error: nullable(str),
    attempts: int, retryAt: nullable(time), shards: nullable(ref('ScanShards')),
  }, ['id', 'projectKey', 'status', 'requestedAt', 'filesScanned', 'factsAdded', 'error']),
  ProjectSummary: obj({
    key: str, repoPath: str, remote: nullable(str), aliases: arrayOf(str), sessions: int, feedback: int, lessons: int, facts: int,
    factsByOrigin: { type: 'object', additionalProperties: int }, lastScan: nullable(ref('ScanJob')), pinned: bool, links: int,
  }, ['key', 'repoPath', 'remote', 'sessions', 'feedback', 'lessons', 'facts', 'lastScan', 'pinned']),
  StoredFact: obj({
    id: str, kind: str, statement: str, path: str, lines: nullable(str), why: str, confidence: num, relevance: nullable(num), relevanceBy: nullable(str),
    origin: { type: 'string', enum: ['model', 'manifest', 'document', 'you'] }, evidence: nullable({ type: 'string', enum: ['line', 'file', 'none'] }),
    source: str, createdAt: time, scanJobId: nullable(str), fileHash: nullable(str), fileSummary: nullable(str), docId: nullable(str),
  }, ['id', 'kind', 'statement', 'path', 'relevance', 'source', 'createdAt']),
  FactHit: obj({ fact: ref('StoredFact'), score: num }, ['fact', 'score'], 'A search hit (?q=): the fact and how close it is'),
  Doc: obj({
    id: str, projectKey: str, source: str, ref: str, title: str, url: nullable(str), addedAt: time, addedBy: nullable(str), chunks: int,
    kind: { type: 'string', enum: ['text', 'image'] }, mediaType: nullable(str), read: nullable(loose('How the worker read it: status, facts, error')),
  }, ['id', 'projectKey', 'source', 'ref', 'title', 'addedAt', 'chunks']),
  ProjectLink: obj({
    id: str, a: str, b: str, relation: { type: 'string', enum: ['depends_on', 'same_product', 'shares_code', 'related'] }, note: str,
    status: { type: 'string', enum: ['suggested', 'confirmed', 'dismissed'] }, source: { type: 'string', enum: ['detected', 'you'] }, score: num,
    evidence: arrayOf(obj({ signal: str, detail: str, path: nullable(str), from: str })), createdAt: time, updatedAt: time, decidedBy: nullable(str),
  }, ['id', 'a', 'b', 'relation', 'note', 'status', 'source', 'score', 'evidence', 'createdAt', 'updatedAt']),
  Activity: obj({
    id: str, ts: time, kind: str, actor: { type: 'string', description: "'you', 'operator:<name>', a model id or an MCP client" }, projectKey: nullable(str),
    subject: str, why: str, details: { type: 'object', description: 'Per kind; details.via says how a write arrived: operator, browser or api', additionalProperties: true }, targets: arrayOf(str),
  }),
  SystemStatus: obj({
    version: str, store: nullable({ type: 'string', enum: ['neo4j', 'postgres'] }), graph: bool, worker: nullable(loose('The worker heartbeat')), workerHealthy: bool,
    authRequired: bool, selection: nullable(obj({ initialized: bool, tracked: int, roots: int, note: nullable(str) }, ['initialized', 'tracked', 'note'])),
    cloud: nullable(loose('Cloud sync: host, interval, last Sync now, progress (token always [REDACTED])')), models: nullable(loose('Each job\'s model and whether it answers')),
    givenUpTurns: nullable(int), ollama: nullable(loose('Whether Ollama answers')), connections: nullable(loose('GitHub, Linear, Claude, Codex, Ollama and cloud')),
    stage: nullable(obj({ name: str, startedAt: time, current: nullable(str) })), progress: nullable(obj({ done: int, total: nullable(int) })),
  }, ['version', 'store', 'graph', 'worker', 'workerHealthy', 'authRequired', 'selection']),
  PipelineStatus: obj({
    stage: nullable(obj({ name: str, startedAt: time, current: nullable(str) })), progress: nullable(obj({ done: int, total: nullable(int) })), sessions: nullable(int),
    classify: nullable(obj({ backlog: int, capped: bool })), inbox: nullable(obj({ pending: int, confirmed: int })), postmortems: nullable(obj({ queued: int })),
    lessons: nullable(obj({ proposed: int, approved: int })), scans: nullable(obj({ done: int, queued: int, running: int, failed: int, never: int })),
  }),
  SessionSummary: loose('A session summary: id, projectKey, source, state, turnCount, lastActivityAt, snippet'),
  SessionDetail: loose('One session: its summary and history'),
  SettingsBody: obj({ tracked: arrayOf(str), candidates: arrayOf(loose('A project folder: key, path, exists, tracked, excluded, aliasOf, sessions')) }, ['tracked', 'candidates']),
  IntegrationsView: loose('GitHub and Linear: connection state, where the token comes from, per-project links, skip rules'),
  CloudInfo: loose('Cloud sync: enabled, host, schedule, projects, preview counts, last result'),
  CloudSyncResult: loose('One sync: ok, error, per-project status, what was sent'),
  ExportBundle: loose('An export bundle: format, schemaVersion, lessons, facts, misses, docs, codeFiles'),
  ImportResult: loose('What an import added and skipped'),
  ChatConversation: loose('An Ask conversation: id, projectKey, title, provider, timestamps'),
  ChatThread: loose('An Ask conversation with its turns'),
  ModuleContext: loose('A file in the code map: its module, imports, importers, symbols, lessons and misses'),
  Impact: loose('What changing the files touches: dependents by depth'),
  MapGraph: loose('The Graph page\'s code mode: nodes, edges, lessons'),
  Hotspot: loose('A file ranked by how much it is touched'),
  ProjectGraph: loose('A project\'s knowledge graph: nodes and edges'),
  Patterns: loose('Recurring patterns'),
  LinearTeam: obj({ id: str, key: str, name: str }),
  JsonRpc: obj({ jsonrpc: { const: '2.0' }, id: { anyOf: [str, int, { type: 'null' }] }, method: str, params: { type: 'object', additionalProperties: true } }, ['jsonrpc', 'method'], 'A JSON-RPC 2.0 message (MCP Streamable HTTP)'),
  JsonRpcResult: loose('A JSON-RPC 2.0 answer: result, or error { code, message }'),
};

const QUEUED = obj({ queued: { const: true } });
const RESULTS = (item: JsonSchema) => obj({ results: arrayOf(item) });

/** DELETE /api/projects/:key checks this by hand: the project's name, typed again. */
const ConfirmKey = z.object({ confirm: z.string().describe('the project key, typed again') });
const SessionToken = z.object({ token: z.string() });
const ProjectQuery = z.object({ project: z.string().min(1).max(200).optional() });
const CwdQuery = z.object({ cwd: z.string().optional() });
const KeepApproved = z.object({ keepApproved: z.enum(['1', 'true']).optional() });

/**
 * Every REST route of createApp (the MCP endpoints are mcpPath below; the UI's files are not described). A function:
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
  '/api/lessons/decisions': { POST: { tag: 'lessons', summary: 'Approve or reject many lessons in one call, each recorded on its own (decidedBy, Activity); one not found does not stop the rest', body: a.LessonDecisions, response: '{ results: [{ id, ok, status? | error? }] }' } },
  '/api/lessons/recheck': { POST: { tag: 'lessons', summary: 'Re-run the lesson checks on every proposed and approved lesson at the worker\'s next round (flags only)', response: '{ queued: number }', status: 202 } },
  '/api/lessons/{id}/to-fact': {
    POST: { tag: 'lessons', summary: 'Turn a lesson that states how the code is into a project fact you wrote; the lesson is rejected with the note "converted to a fact"', body: a.LessonToFact, response: 'StoredFact; 409 when the lesson is already rejected or superseded, or has no project', status: 201 },
  },

  '/api/projects': { GET: { tag: 'projects', summary: 'The shown projects, pinned first', response: 'ProjectSummary[]' } },
  '/api/projects/scan': { POST: { tag: 'projects', summary: 'Queue scans of many folders (keys, or all: true)', body: a.BatchScanRequest, response: '{ results: [{ key, queued, job? | error? }] }', status: 202 } },
  '/api/projects/{key}': { DELETE: { tag: 'projects', summary: 'Delete everything learned from a project', body: ConfirmKey, response: '{ removed, note }' } },
  '/api/projects/{key}/scan': { POST: { tag: 'projects', summary: 'Queue a scan of one folder', body: a.ScanRequest, response: 'ScanJob', status: 202 } },
  '/api/scans/{id}': { GET: { tag: 'projects', summary: 'One scan job, with its place in the queue while queued', response: 'ScanJob & { queuePosition }' } },
  '/api/projects/{key}/facts': { GET: { tag: 'projects', summary: 'A project\'s facts (q: semantic search; else paged by limit and offset, X-Next-Offset names the next page; origin: model, manifest, document or you)', query: a.FactsQuery, response: 'Fact[]' } },
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
  '/api/activity': { GET: { tag: 'activity', summary: 'The activity log of the shown projects, newest first; details over 1 KB are left out (detailsOmitted) unless details=1', query: a.ActivityQuery, response: 'Activity[]' } },
  '/api/activity/{id}': { GET: { tag: 'activity', summary: 'One activity entry with all its details', response: 'Activity' } },

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

/** The 2xx bodies `response` describes in words, as JSON Schema (by "METHOD path"). */
const SCHEMA_OF: Record<string, JsonSchema> = {
  'GET /api/health': obj({ ok: { const: true } }),
  'GET /api/ready': obj({ ok: bool, store: { type: 'string', enum: ['neo4j', 'postgres'] } }, ['ok']),
  'GET /api/events': { type: 'string', description: 'text/event-stream: events stage, pipeline, scan, chat, activity; data is JSON' },
  'GET /api/openapi.json': { type: 'object', description: 'An OpenAPI 3.1 document', additionalProperties: true },
  'GET /api/session': obj({ authRequired: bool, authenticated: bool }),
  'GET /api/agent/project': loose('The selected project the folder belongs to, or why it is not one'),
  'POST /api/lessons/decisions': RESULTS(obj({ id: str, ok: bool, status: str, error: str }, ['id', 'ok'])),
  'POST /api/lessons/recheck': obj({ queued: int }),
  'POST /api/candidates/decisions': RESULTS(obj({ id: str, ok: bool, status: str, error: str }, ['id', 'ok'])),
  'POST /api/feedback/{id}/retry': QUEUED,
  'POST /api/turns/requeue': obj({ requeued: int }),
  'POST /api/projects/scan': RESULTS(obj({ key: str, queued: bool, job: ref('ScanJob'), error: str }, ['key', 'queued'])),
  'DELETE /api/projects/{key}': obj({ removed: loose('What was deleted, by kind'), note: str }),
  'GET /api/scans/{id}': { allOf: [ref('ScanJob'), obj({ queuePosition: nullable(int) })] },
  'GET /api/projects/{key}/facts': { anyOf: [arrayOf(ref('StoredFact')), arrayOf(ref('FactHit'))], description: 'StoredFact[]; with ?q= the search hits, best first' },
  'POST /api/projects/{key}/docs': obj({ id: str, chunks: int }),
  'GET /api/docs/{id}/image': { type: 'string', format: 'binary' },
  'GET /api/projects/{key}/codemap/hotspots': obj({ meta: nullable(loose('The map: files, symbols, imports, built at')), capped: bool, hotspots: arrayOf(ref('Hotspot')) }),
  'POST /api/projects/{key}/codemap/rebuild': QUEUED,
  'POST /api/settings/cleanup': obj({ removed: arrayOf(str), nodesRemoved: int }),
  'GET /api/cloud/progress': obj({ running: nullable(obj({ done: int, total: int, current: nullable(str) })), lastManual: nullable(loose('The last Sync now')) }),
  'GET /api/sessions': obj({ sessions: arrayOf(ref('SessionSummary')), next: nullable(str) }),
  'POST /api/sessions/{id}/resummarize': QUEUED,
};

/** The 2xx body's schema: the route's own, else the type `response` starts with (`Lesson`, `Candidate[]`). */
function responseSchema(method: Method, path: string, r: Route): JsonSchema | undefined {
  const own = r.schema ?? SCHEMA_OF[`${method} ${path}`];
  if (own) return own;
  const m = /^(\w+)(\[\])?/.exec(r.response);
  if (!m || !SCHEMAS[m[1]]) return undefined;
  return m[2] ? arrayOf(ref(m[1])) : ref(m[1]);
}

const verbs = new Map(OWNER_ROUTES.map(([m, p, verb]) => [`${m} ${p.replace(/:(\w+)/g, '{$1}')}`, verb]));

function operation(method: Method, path: string, r: Route) {
  const verb = verbs.get(`${method} ${path}`);
  const params = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
  const shape = (r.query?.shape ?? {}) as Record<string, ZodTypeAny>;
  const query = Object.entries(shape).map(([name, s]) => ({ name, in: 'query', required: !s.isOptional(), schema: jsonSchema(s) }));
  const status = String(r.status ?? 200);
  const noContent = r.status === 204;
  const schema = noContent ? undefined : responseSchema(method, path, r);
  if (!noContent && !schema) throw new Error(`openapi: no response schema for ${method} ${path} (${r.response})`);
  return {
    summary: r.summary,
    tags: [r.tag],
    ...(r.description && { description: r.description }),
    ...(params.length || query.length ? { parameters: [...params, ...query] } : {}),
    ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(r.body) } } } } : {}),
    responses: {
      [status]: { description: r.response, ...(noContent ? {} : { content: { [r.type ?? 'application/json']: { schema } } }) },
      default: { description: 'an error: { error: string | zod flatten() }', content: { 'application/json': { schema: ref('Error') } } },
    },
    'x-owner-only': verb !== undefined,
    ...(verb && {
      'x-operator-verb': verb,
      description: `Owner-only: from the Feedback Graph UI, or with FG_OPERATOR_TOKEN as the Bearer when OPERATOR_ALLOW includes ${verb}.`,
    }),
  };
}

/** /mcp and /mcp/admin: MCP over Streamable HTTP, stateless (each POST answered on its own, as JSON). */
function mcpPath(admin: boolean) {
  const rpc = { 'application/json': { schema: ref('JsonRpc') } };
  return {
    post: {
      summary: admin
        ? 'The admin MCP endpoint: the owner decisions OPERATOR_ALLOW names, as tools (inbox_list, inbox_decide, lessons_list, scan_projects, ...)'
        : 'The MCP endpoint agents use: task context, search, check_before_done, report_feedback (read and report only)',
      tags: ['mcp'],
      description: admin
        ? 'Only while FG_OPERATOR_TOKEN is set, and only with it as the Bearer (404 without a bearer, 401 with another). Tools carry annotations (readOnlyHint on the reads); list tools are paged (20 rows, a note with the next offset).'
        : 'With API_TOKEN set it needs the token like every route. The tools never change an owner decision.',
      requestBody: { required: true, content: rpc },
      responses: {
        200: { description: 'The JSON-RPC answer', content: { 'application/json': { schema: ref('JsonRpcResult') } } },
        413: { description: 'The body is over 1 MB: a JSON-RPC error', content: { 'application/json': { schema: ref('JsonRpcResult') } } },
        default: { description: 'an error: { error }', content: { 'application/json': { schema: ref('Error') } } },
      },
      'x-owner-only': false,
    },
    get: { summary: 'No server-sent stream: always 405', tags: ['mcp'], responses: { 405: { description: 'Method not allowed (Allow: POST, DELETE)' } }, 'x-owner-only': false },
    delete: { summary: 'End the MCP session (nothing is kept, so this only answers)', tags: ['mcp'], responses: { 204: { description: 'no content' } }, 'x-owner-only': false },
  };
}

let cached: { version: string; doc: object } | null = null;

export function openApiDocument(version: string): object {
  if (cached?.version === version) return cached.doc;
  const paths = {
    ...Object.fromEntries(Object.entries(routes()).map(([p, ops]) => [
      p,
      Object.fromEntries(Object.entries(ops).map(([m, r]) => [m.toLowerCase(), operation(m as Method, p, r!)])),
    ])),
    '/mcp': mcpPath(false),
    '/mcp/admin': mcpPath(true),
  };
  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'Feedback Graph local API',
      version,
      description: 'The REST API the UI and the fg CLI use. With API_TOKEN set every route but /api/health, /api/ready and /api/session needs it (Bearer, or the UI session cookie). A bearer that matches neither API_TOKEN nor FG_OPERATOR_TOKEN is refused (401) on every route. Writes need Content-Type: application/json; a body is at most 1 MB (16 MB for a document upload, 256 MB for an import). An unknown /api path is a JSON 404.',
    },
    servers: [{ url: '/' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas: SCHEMAS },
    security: [{ bearer: [] }, {}],
    paths,
  };
  cached = { version, doc };
  return doc;
}
