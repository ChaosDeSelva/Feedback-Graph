import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { demoRoutes, removeDemo, type DemoDeps } from './demo.ts';

const OP = 'o'.repeat(32);
function deps(removeDemo: DemoDeps['knowledge']['removeDemo']): DemoDeps {
  return {
    knowledge: { upsertLesson: async () => {}, saveDemoMiss: async () => 'miss:demo', removeDemo },
    facts: { listFacts: async () => [], saveFileFacts: async () => {} },
    embed: async (texts) => texts.map(() => [1, 0]),
    project: (key) => ({ key, name: key, repoPath: `/vibe/${key}` }),
  } as DemoDeps;
}

test('removing a demo that was never seeded says nothing was removed', async () => {
  const r = await removeDemo({}, deps(async () => ({ lessons: 0, misses: 0, facts: 0, projectRemoved: false })));
  expect(r.message).toBe('No demo corpus in demo-shop: nothing removed.');
});

test('a remove the store fails answers 500 with what happened, not a bare crash', async () => {
  const app = new Hono();
  demoRoutes(app, deps(async () => { throw new Error('store down'); }), { operator: { token: OP, allow: ['demo'] } });
  const res = await app.request('/api/demo/remove', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OP}` }, body: '{}' });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: 'fg demo: store down' });
});

const post = (app: Hono, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
function seedable(o: Partial<DemoDeps['knowledge']> = {}, factsThere: false | true | 'demo' = false): DemoDeps {
  const d = deps(async () => ({ lessons: 0, misses: 0, facts: 0, projectRemoved: false }));
  return {
    ...d,
    knowledge: { ...d.knowledge, saveDemoMiss: async () => 'miss:demo', ...o },
    facts: { listFacts: async () => (factsThere ? [{ statement: factsThere === 'demo' ? '[demo] Routes read through db.scoped' : 'Routes read through db.scoped' } as never] : []), saveFileFacts: async () => {} },
  } as DemoDeps;
}

test('seeding where a scan already read every demo file adds no demo facts and says whose facts it kept', async () => {
  const app = new Hono();
  demoRoutes(app, seedable({}, true), {});
  const r = await (await post(app, '/api/demo/seed', {})).json();
  expect(r.facts).toBe(0);
  expect(r.message).toMatch(/no new demo facts; kept the existing scan facts for /);
});

test('seeding again keeps the demo\'s own facts and says so, never calling them scan facts', async () => {
  const app = new Hono();
  demoRoutes(app, seedable({}, 'demo'), {});
  const r = await (await post(app, '/api/demo/seed', {})).json();
  expect(r.facts).toBe(0);
  expect(r.message).toMatch(/no new demo facts; the demo facts for \S.* were already there\./);
  expect(r.message).not.toContain('scan facts');
});

test('a seed that fails with a bare value says what failed and that its writes were taken back', async () => {
  const app = new Hono();
  demoRoutes(app, seedable({ upsertLesson: async () => { throw 'disk full'; } }), {});
  const res = await post(app, '/api/demo/seed', {});
  expect(res.status).toBe(500);
  expect((await res.json()).error).toBe('demo seed failed in demo-shop: disk full; what it had written was taken back');
});

test('a body with fields the demo routes do not take is a 400', async () => {
  const app = new Hono();
  demoRoutes(app, seedable(), {});
  expect((await post(app, '/api/demo/seed', { project: 'demo-shop', force: true })).status).toBe(400);
});

test('with API_TOKEN configured, a request without a bearer is not taken for the agent: it is the owner\'s UI request', async () => {
  const app = new Hono();
  demoRoutes(app, seedable(), { token: 't'.repeat(32) });
  const res = await post(app, '/api/demo/seed', { project: 'other' });
  expect(res.status).toBe(200);
  expect((await res.json()).project).toBe('other');
});

test('a store failure that is not an Error is still a 500 that says what happened', async () => {
  const app = new Hono();
  demoRoutes(app, deps(async () => { throw 'gone'; }), { operator: { token: OP, allow: ['demo'] } });
  const res = await post(app, '/api/demo/remove', {}, { authorization: `Bearer ${OP}` });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: 'fg demo: gone' });
});
