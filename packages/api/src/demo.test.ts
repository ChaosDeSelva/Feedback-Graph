import { Hono } from 'hono';
import type { ActivityInput, DemoMiss, LessonInput, SessionFile } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { DEMO_CORPUS, DEMO_PROJECT, demoRoutes, removeDemo, seedDemo, type DemoDeps } from './demo.ts';

const OP = 'o'.repeat(32);

function deps(over: Partial<DemoDeps> = {}) {
  const lessons: LessonInput[] = [];
  const misses: DemoMiss[] = [];
  const touched: [string, SessionFile[]][] = [];
  const facts: { key: string; path: string; source: string; statements: string[] }[] = [];
  const activity: ActivityInput[] = [];
  const d: DemoDeps = {
    knowledge: {
      upsertLesson: async (l) => { lessons.push(l); },
      saveDemoMiss: async (m) => { misses.push(m); return `miss:${m.id}`; },
      removeDemo: async () => ({ lessons: 4, misses: 1, facts: 3 }),
    },
    facts: {
      listFacts: async () => [],
      saveFileFacts: async (key, file, fx, source) => { facts.push({ key, path: file.path, source, statements: fx.map((f) => f.statement) }); },
    },
    codegraph: { recordSessionFiles: async (id, files) => { touched.push([id, files]); } },
    embed: async (texts) => texts.map(() => [1, 0]),
    activity: { record: async (a) => { activity.push(a); } },
    project: (key) => ({ key, name: key, repoPath: `/vibe/${key}` }),
    selected: async () => false,
    ...over,
  };
  return { d, lessons, misses, touched, facts, activity };
}

describe('seedDemo', () => {
  test('writes a labelled corpus into the demo project: approved lessons tied to files, a miss on a file, facts', async () => {
    const t = deps();
    const r = await seedDemo({}, t.d);
    expect(r.project).toBe(DEMO_PROJECT);
    expect(t.lessons.length).toBeGreaterThanOrEqual(3);
    for (const l of t.lessons) {
      expect(l).toMatchObject({ status: 'approved', source: 'demo', projectKey: DEMO_PROJECT, scope: 'project' });
      expect(l.id.startsWith(`demo:${DEMO_PROJECT}:`)).toBe(true);
      expect(l.title.startsWith('[demo] ')).toBe(true);
      expect(l.paths.length).toBeGreaterThan(0);
    }
    expect(t.misses).toHaveLength(1);
    expect(t.misses[0].id.startsWith(`demo:${DEMO_PROJECT}:`)).toBe(true);
    // The miss is tied to the file its session edited, so the code map shows it on that file.
    expect(t.touched[0][0]).toBe(t.misses[0].id);
    expect(t.touched[0][1].every((f) => f.edited)).toBe(true);
    expect(t.facts.length).toBeGreaterThan(0);
    expect(t.facts.every((f) => f.source === 'demo' && f.key === DEMO_PROJECT)).toBe(true);
    expect(r.lessons).toBe(t.lessons.length);
    // The owner approves by running it, and is told so, how to undo it, and that the project is not selected.
    expect(r.message).toMatch(/approved by you running fg demo seed/);
    expect(r.message).toMatch(/fg demo remove/);
    expect(r.message).toMatch(/not selected: .*fg projects select --key demo-shop/);
    expect(t.activity[0]).toMatchObject({ kind: 'demo_seeded', projectKey: DEMO_PROJECT });
    expect(t.activity[0].targets).toEqual(expect.arrayContaining(t.lessons.map((l) => l.id)));
  });

  test('never replaces facts a scan found: a file that has facts gets no demo facts', async () => {
    const t = deps({ facts: { listFacts: async (q) => (q.path === DEMO_CORPUS.facts[0].path ? [{ id: 'f' } as never] : []), saveFileFacts: async (key, file, fx, source) => { t.facts.push({ key, path: file.path, source, statements: fx.map((f) => f.statement) }); } } });
    await seedDemo({}, t.d);
    expect(t.facts.map((f) => f.path)).not.toContain(DEMO_CORPUS.facts[0].path);
  });

  test('another project only with --project and the owner, never by default', async () => {
    const t = deps();
    await expect(seedDemo({ project: 'acme', owner: false }, t.d)).rejects.toThrow(/owner/);
    expect(t.lessons).toEqual([]);
    const r = await seedDemo({ project: 'acme', owner: true }, t.d);
    expect(r.project).toBe('acme');
    expect(t.lessons.every((l) => l.projectKey === 'acme' && l.id.startsWith('demo:acme:'))).toBe(true);
    await expect(seedDemo({ project: '../etc', owner: true }, t.d)).rejects.toThrow(/project/);
  });

  test('a store without the demo methods says so instead of half-seeding', async () => {
    const t = deps({ knowledge: { upsertLesson: async () => {} } });
    await expect(seedDemo({}, t.d)).rejects.toThrow(/demo/);
  });
});

test('removeDemo removes what the seed wrote, says how much, and logs it', async () => {
  const t = deps();
  const r = await removeDemo({}, t.d);
  expect(r).toMatchObject({ project: DEMO_PROJECT, lessons: 4, misses: 1, facts: 3 });
  expect(r.message).toMatch(/Removed 4 demo lessons, 1 miss and 3 facts from demo-shop/);
  expect(t.activity[0]).toMatchObject({ kind: 'demo_removed', projectKey: DEMO_PROJECT });
  await expect(removeDemo({ project: 'acme', owner: false }, t.d)).rejects.toThrow(/owner/);
});

describe('routes', () => {
  const app = (t: ReturnType<typeof deps>, allow: string[] = []) => {
    const a = new Hono();
    demoRoutes(a, t.d, { operator: { token: OP, allow: allow as never } });
    return a;
  };
  const post = (path: string, body: unknown, h: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
  const bearer = { authorization: `Bearer ${OP}` };

  test('the operator token seeds the demo project; a real project needs lesson_decide', async () => {
    const t = deps();
    expect((await app(t).request('/api/demo/seed', post('/api/demo/seed', {}, bearer))).status).toBe(200);
    const refused = await app(t).request('/api/demo/seed', post('/api/demo/seed', { project: 'acme' }, bearer));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(/lesson_decide/);
    expect((await app(t, ['lesson_decide']).request('/api/demo/seed', post('/api/demo/seed', { project: 'acme' }, bearer))).status).toBe(200);
  });

  test('without the operator token only the owner in the UI may seed (a local client sending no Origin is refused)', async () => {
    const t = deps();
    expect((await app(t).request('/api/demo/seed', post('/api/demo/seed', {}))).status).toBe(403);
    expect((await app(t).request('/api/demo/seed', post('/api/demo/seed', { project: 'acme' }, { origin: 'http://localhost:8787' }))).status).toBe(200);
    expect((await app(t).request('/api/demo/remove', post('/api/demo/remove', {}, bearer))).status).toBe(200);
  });
});
