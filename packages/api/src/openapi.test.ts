import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { createApp, type ApiRepo } from './app.ts';
import { jsonSchema, openApiDocument } from './openapi.ts';
import { OWNER_ROUTES } from './operator.ts';

/** Every store method answers null: enough for createApp to register every optional route. */
const anything: any = new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : async () => null) });

/** The app with every optional dependency given, so every route there is gets registered. */
function fullApp() {
  return createApp(anything as ApiRepo, {
    context: { roots: [], embed: async () => [], judge: async () => [], k: anything, activity: anything }, knowledge: anything, embed: async () => [], facts: anything, projectDirs: async () => [], insights: anything,
    activity: anything, docs: anything, links: anything, portability: anything, auth: { operator: { token: 'o'.repeat(32), allow: [] } }, log: () => {},
    system: { version: '9.9.9', ping: async () => true, worker: async () => null },
    classifyQueue: anything, settings: anything, codegraph: anything, mapMaxFiles: null, cloud: anything, inScope: () => true,
    importer: anything, sessions: anything, shown: undefined, integrations: anything, chat: anything, runs: anything, evidence: anything,
  });
}

const openApiPath = (p: string) => p.replace(/:(\w+)/g, '{$1}');

describe('GET /api/openapi.json', () => {
  test('is an OpenAPI 3.1 document with the running version', async () => {
    const res = await fullApp().request('/api/openapi.json');
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe('9.9.9');
  });

  test('needs the token like every other read', async () => {
    const app = createApp(anything as ApiRepo, { auth: { token: 'x'.repeat(30) } });
    expect((await app.request('/api/openapi.json')).status).toBe(401);
    expect((await app.request('/api/openapi.json', { headers: { authorization: `Bearer ${'x'.repeat(30)}` } })).status).toBe(200);
  });

  test('describes every route the app registers (but the UI files)', () => {
    const doc = openApiDocument('dev') as { paths: Record<string, Record<string, unknown>> };
    // An ALL route (the MCP endpoints) counts as described by its POST; /api/* is the JSON 404 for every other path.
    const registered = fullApp().routes
      .filter((r) => r.path !== '*' && r.path !== '/*' && r.path !== '/api/*' && (r.method !== 'ALL' || r.path.startsWith('/mcp')))
      .map((r) => `${r.method === 'ALL' ? 'POST' : r.method} ${r.path}`);
    expect(registered.length).toBeGreaterThan(60);
    const missing = [...new Set(registered)].filter((r) => {
      const [method, path] = r.split(' ');
      return !doc.paths[openApiPath(path)]?.[method.toLowerCase()];
    });
    expect(missing).toEqual([]);
  });

  test('describes no route the app does not have', () => {
    const doc = openApiDocument('dev') as { paths: Record<string, Record<string, unknown>> };
    const routes = fullApp().routes;
    const registered = new Set(routes.map((r) => `${r.method.toLowerCase()} ${openApiPath(r.path)}`));
    const all = new Set(routes.filter((r) => r.method === 'ALL').map((r) => openApiPath(r.path)));
    const extra = Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => m !== 'parameters').map((m) => `${m} ${p}`))
      .filter((r) => !registered.has(r) && !all.has(r.split(' ')[1]));
    expect(extra).toEqual([]);
  });

  test('marks every owner-only route, with its OPERATOR_ALLOW verb, and no other', () => {
    const doc = openApiDocument('dev') as { paths: Record<string, Record<string, { 'x-owner-only'?: boolean; 'x-operator-verb'?: string }>> };
    for (const [method, path, verb] of OWNER_ROUTES) {
      const op = doc.paths[openApiPath(path)]?.[method.toLowerCase()];
      expect(op, `${method} ${path}`).toBeDefined();
      expect(op!['x-owner-only'], `${method} ${path}`).toBe(true);
      expect(op!['x-operator-verb']).toBe(verb);
    }
    const owner = new Set(OWNER_ROUTES.map(([m, p]) => `${m.toLowerCase()} ${openApiPath(p)}`));
    for (const [p, ops] of Object.entries(doc.paths)) {
      for (const [m, op] of Object.entries(ops)) if (!owner.has(`${m} ${p}`)) expect(op['x-owner-only'], `${m} ${p}`).toBe(false);
    }
  });

  test('every operation has a 2xx response with a schema (but no content), and every $ref resolves', () => {
    const doc = openApiDocument('dev') as any;
    // GET on an MCP endpoint is refused (405: no server-sent stream), so it has no 2xx.
    const ops = Object.entries(doc.paths as Record<string, Record<string, any>>).flatMap(([p, o]) => Object.entries(o).map(([m, op]) => [`${m} ${p}`, op] as const))
      .filter(([name]) => !name.startsWith('get /mcp'));
    expect(ops.length).toBeGreaterThan(70);
    const refs: string[] = [];
    const walk = (x: unknown) => {
      if (!x || typeof x !== 'object') return;
      for (const [k, v] of Object.entries(x)) {
        if (k === '$ref' && typeof v === 'string') refs.push(v);
        else walk(v);
      }
    };
    for (const [name, op] of ops) {
      const ok = Object.entries(op.responses).filter(([code]) => /^2\d\d$/.test(code));
      expect(ok, name).toHaveLength(1);
      const [code, res] = ok[0] as [string, any];
      if (code === '204') { expect(res.content, name).toBeUndefined(); continue; }
      const [schema] = Object.values(res.content ?? {}).map((c: any) => c.schema);
      expect(schema, name).toBeDefined();
      expect(Object.keys(schema).length, name).toBeGreaterThan(0);
      walk(schema);
    }
    walk(doc.components.schemas);
    const missing = [...new Set(refs)].filter((r) => !doc.components.schemas[r.replace('#/components/schemas/', '')]);
    expect(missing).toEqual([]);
    // The main shapes are spelled out, not left as an empty object.
    for (const name of ['Candidate', 'Lesson', 'ProjectSummary', 'ScanJob', 'StoredFact', 'ProjectLink', 'Activity', 'SystemStatus', 'PipelineStatus', 'Error']) {
      expect(doc.components.schemas[name]?.properties, name).toBeDefined();
    }
    expect(doc.paths['/api/candidates'].get.responses['200'].content['application/json'].schema).toEqual({ type: 'array', items: { $ref: '#/components/schemas/Candidate' } });
    expect(doc.paths['/api/links'].put.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/ProjectLink');
    expect(doc.paths['/api/lessons'].get.responses.default.content['application/json'].schema.$ref).toBe('#/components/schemas/Error');
  });

  test('the MCP endpoints are described: /mcp, and /mcp/admin with the operator token', () => {
    const doc = openApiDocument('dev') as any;
    for (const p of ['/mcp', '/mcp/admin']) {
      expect(doc.paths[p].post.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/JsonRpc');
      expect(doc.paths[p].get.responses['405']).toBeDefined();
    }
    expect(doc.components.schemas.JsonRpc.properties.jsonrpc).toEqual({ const: '2.0' });
    expect(doc.paths['/mcp/admin'].post.description).toMatch(/FG_OPERATOR_TOKEN/);
  });

  test('request bodies come from the zod schemas the routes validate with', () => {
    const doc = openApiDocument('dev') as any;
    const decisions = doc.paths['/api/candidates/decisions'].post.requestBody.content['application/json'].schema;
    expect(decisions.required).toEqual(['items']);
    expect(decisions.properties.items).toMatchObject({ type: 'array', minItems: 1, maxItems: 500 });
    expect(decisions.properties.items.items.properties.decision).toEqual({ type: 'string', enum: ['confirm', 'reject'] });
    const lessons = doc.paths['/api/lessons'].get.parameters;
    expect(lessons).toContainEqual({ name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['proposed', 'approved', 'rejected', 'revoked', 'superseded'] } });
    expect(doc.paths['/api/lessons/{id}'].patch.parameters).toContainEqual({ name: 'id', in: 'path', required: true, schema: { type: 'string' } });
  });
});

describe('jsonSchema', () => {
  test('converts the zod subset the routes use', () => {
    expect(jsonSchema(z.object({
      a: z.string().min(1).max(5).regex(/^x/),
      b: z.coerce.number().int().min(1).max(9).default(3),
      c: z.boolean().optional(),
      d: z.enum(['p', 'q']).nullable(),
      e: z.array(z.literal(true)).max(2),
      f: z.number().min(0).max(1),
    }).strict())).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string', minLength: 1, maxLength: 5, pattern: '^x' },
        b: { type: 'integer', minimum: 1, maximum: 9, default: 3 },
        c: { type: 'boolean' },
        d: { anyOf: [{ type: 'string', enum: ['p', 'q'] }, { type: 'null' }] },
        e: { type: 'array', items: { const: true }, maxItems: 2 },
        f: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['a', 'd', 'e', 'f'],
      additionalProperties: false,
    });
  });

  test('a refinement or transform is described by the schema it wraps', () => {
    expect(jsonSchema(z.string().refine((s) => s !== 'x', 'not x'))).toEqual({ type: 'string' });
    expect(jsonSchema(z.enum(['0', '1']).optional().transform((v) => v === '1'))).toEqual({ type: 'string', enum: ['0', '1'] });
  });
});
