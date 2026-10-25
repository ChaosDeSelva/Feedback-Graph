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
    context: anything, knowledge: anything, embed: async () => [], facts: anything, projectDirs: async () => [], insights: anything,
    activity: anything, docs: anything, links: anything, portability: anything, auth: {}, log: () => {},
    system: { version: '9.9.9', ping: async () => true, worker: async () => null },
    classifyQueue: anything, settings: anything, codegraph: anything, mapMaxFiles: null, cloud: anything, inScope: () => true,
    importer: anything, sessions: anything, shown: undefined, integrations: anything, chat: anything,
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

  test('describes every route the app registers (but the UI files and /mcp)', () => {
    const doc = openApiDocument('dev') as { paths: Record<string, Record<string, unknown>> };
    const registered = fullApp().routes
      .filter((r) => r.method !== 'ALL' && r.path !== '*' && r.path !== '/*' && r.path !== '/mcp')
      .map((r) => `${r.method} ${r.path}`);
    expect(registered.length).toBeGreaterThan(60);
    const missing = [...new Set(registered)].filter((r) => {
      const [method, path] = r.split(' ');
      return !doc.paths[openApiPath(path)]?.[method.toLowerCase()];
    });
    expect(missing).toEqual([]);
  });

  test('describes no route the app does not have', () => {
    const doc = openApiDocument('dev') as { paths: Record<string, Record<string, unknown>> };
    const registered = new Set(fullApp().routes.map((r) => `${r.method.toLowerCase()} ${openApiPath(r.path)}`));
    const extra = Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => m !== 'parameters').map((m) => `${m} ${p}`)).filter((r) => !registered.has(r));
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

  test('request bodies come from the zod schemas the routes validate with', () => {
    const doc = openApiDocument('dev') as any;
    const decisions = doc.paths['/api/candidates/decisions'].post.requestBody.content['application/json'].schema;
    expect(decisions.required).toEqual(['items']);
    expect(decisions.properties.items).toMatchObject({ type: 'array', minItems: 1, maxItems: 500 });
    expect(decisions.properties.items.items.properties.decision).toEqual({ type: 'string', enum: ['confirm', 'reject'] });
    const lessons = doc.paths['/api/lessons'].get.parameters;
    expect(lessons).toContainEqual({ name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['proposed', 'approved', 'rejected', 'superseded'] } });
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
