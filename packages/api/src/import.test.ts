import { gradeLessons, EXPORT_FORMAT, type ActivityInput, type ExportBundle, type Lesson, type LessonInput } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { MAX_IMPORT_BYTES, type ImportDeps } from './import.ts';

const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;
const ui = { 'sec-fetch-site': 'same-origin', origin: 'http://localhost', 'content-type': 'application/json' };

const lesson = (id: string, over: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'demo', title: `T ${id}`, rule: `R ${id}`, appliesWhen: 'w', scope: 'project', paths: [], status: 'approved',
  source: 'postmortem', cause: null, missId: null, createdAt: '2026-10-01T00:00:00Z', decidedAt: null, ...over,
});

const bundle = (over: Partial<ExportBundle> = {}): ExportBundle => ({
  format: EXPORT_FORMAT, schemaVersion: 1, toolVersion: '0.2.0', exportedAt: '2026-10-20T00:00:00Z', projectKey: 'demo',
  projects: [{ key: 'demo', remote: null }],
  lessons: [lesson('lesson:a'), lesson('lesson:b', { status: 'proposed' }), lesson('lesson:c', { status: 'rejected' })],
  misses: [], facts: [], docs: [], codeFiles: [], ...over,
});

function deps(over: Partial<ImportDeps> = {}) {
  const upserted: LessonInput[] = [];
  const recorded: ActivityInput[] = [];
  const embedded: string[] = [];
  const d: ImportDeps = {
    knowledge: { lessonDetail: async () => null, upsertLesson: async (l) => { upserted.push(l); } },
    facts: { currentSources: async () => [], replaceProjectFacts: async () => {} },
    embed: async (t) => { embedded.push(...t); return t.map(() => [0.5, 0.5]); },
    activity: { record: async (a) => { recorded.push(a); } },
    excluded: [],
    ...over,
  };
  return { d, upserted, recorded, embedded, app: createApp(repo, { importer: d }) };
}

const post = (app: ReturnType<typeof createApp>, body: unknown, q = '', headers: Record<string, string> = ui) =>
  app.request(`/api/import${q}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('import is yours alone: a request without an Origin (an agent with curl) is refused', async () => {
  const { app, upserted } = deps();
  expect((await post(app, bundle(), '', { 'content-type': 'application/json' })).status).toBe(403);
  expect(upserted).toEqual([]);
});

test('imported lessons wait as proposed for your approval, re-embedded with the current model; rejected ones are skipped', async () => {
  const { app, upserted, embedded, recorded } = deps();
  const res = await post(app, bundle());
  expect(res.status).toBe(200);
  expect(upserted.map((l) => [l.id, l.status, l.embedding])).toEqual([['lesson:a', 'proposed', [0.5, 0.5]], ['lesson:b', 'proposed', [0.5, 0.5]]]);
  expect(embedded).toEqual(['T lesson:a\nR lesson:a\nApplies when: w', 'T lesson:b\nR lesson:b\nApplies when: w']);
  const body = (await res.json()) as { lessons: Record<string, number> };
  expect(body.lessons).toMatchObject({ added: 2, approved: 0, proposed: 2, skipped: 1 });
  expect(recorded).toEqual([expect.objectContaining({ kind: 'bundle_imported', actor: 'you', projectKey: 'demo', targets: ['lesson:a', 'lesson:b'] })]);
  expect(recorded[0].why).toMatch(/proposed/);
});

test('?keepApproved=1 keeps approved lessons approved, and says so in Activity', async () => {
  const { app, upserted, recorded } = deps();
  expect((await post(app, bundle(), '?keepApproved=1')).status).toBe(200);
  expect(upserted.map((l) => [l.id, l.status])).toEqual([['lesson:a', 'approved'], ['lesson:b', 'proposed']]);
  expect(recorded[0].why).toMatch(/kept/);
});

test('lessons already here (same id) are left alone, so importing twice changes nothing', async () => {
  const { app, upserted } = deps({ knowledge: { lessonDetail: async (id) => (id === 'lesson:a' ? ({ lesson: lesson(id) } as never) : null), upsertLesson: async (l) => { upserted.push(l); } } });
  const body = (await (await post(app, bundle())).json()) as { lessons: Record<string, number> };
  expect(upserted.map((l) => l.id)).toEqual(['lesson:b']);
  expect(body.lessons).toMatchObject({ added: 1, existing: 1 });
});

test('secrets in a bundle are redacted again before anything is stored or embedded', async () => {
  const { app, upserted, embedded } = deps();
  const key = 'sk-ant-api03-' + 'a'.repeat(90);
  await post(app, bundle({ lessons: [lesson('lesson:s', { rule: `call it with ${key}` })] }));
  expect(JSON.stringify(upserted)).not.toContain(key);
  expect(embedded.join('\n')).not.toContain(key);
});

test('EXCLUDE_PROJECTS holds for imports too: an excluded project\'s lessons and facts are not imported', async () => {
  const replaced: string[] = [];
  const { app, upserted } = deps({ excluded: ['secret'], facts: { currentSources: async () => [], replaceProjectFacts: async (k) => { replaced.push(k); } } });
  const fact = { path: 'a.ts', lines: null, kind: 'convention', statement: 's', why: 'w', confidence: 1, source: 'ollama:gemma4', createdAt: 't', projectKey: 'secret' };
  await post(app, bundle({ lessons: [lesson('lesson:x', { projectKey: 'secret' }), lesson('lesson:g', { projectKey: null, scope: 'global' })], facts: [fact] }));
  expect(upserted.map((l) => l.id)).toEqual(['lesson:g']);
  expect(replaced).toEqual([]);
});

test('facts are imported per project only when it has none yet, re-embedded, and attributed to the import', async () => {
  const calls: [string, string[], string][] = [];
  const { app } = deps({
    facts: { currentSources: async (k) => (k === 'busy' ? ['ollama:gemma4'] : []), replaceProjectFacts: async (k, facts, source) => { calls.push([k, facts.map((f) => `${f.path}:${f.statement}:${f.embedding.length}`), source]); } },
  });
  const fact = (projectKey: string, statement: string) => ({ path: 'src/a.ts', lines: '1', kind: 'convention', statement, why: 'w', confidence: 0.9, source: 'ollama:gemma4', createdAt: 't', projectKey });
  const body = (await (await post(app, bundle({ lessons: [], facts: [fact('demo', 'one'), fact('demo', 'two'), fact('busy', 'three')] }))).json()) as { facts: Record<string, unknown> };
  expect(calls).toEqual([['demo', ['src/a.ts:one:2', 'src/a.ts:two:2'], 'import:ollama:gemma4']]);
  expect(body.facts).toMatchObject({ added: 2, projects: ['demo'], skippedProjects: ['busy'] });
});

test('a bundle from a newer version, of another format, or malformed is refused before anything is stored', async () => {
  const { app, upserted } = deps();
  const newer = await post(app, { ...bundle(), schemaVersion: 2 });
  expect(newer.status).toBe(400);
  expect(((await newer.json()) as { error: string }).error).toMatch(/schemaVersion 2/);
  expect((await post(app, { ...bundle(), format: 'something-else' })).status).toBe(400);
  expect((await post(app, { ...bundle(), lessons: [{ id: 'x' }] })).status).toBe(400);
  expect((await post(app, { ...bundle(), lessons: [lesson('../x', { projectKey: '../etc' })] })).status).toBe(400);
  expect((await post(app, 'not json')).status).toBe(400);
  expect(upserted).toEqual([]);
});

test('a bundle over the size limit is refused with 413', async () => {
  const { app, upserted } = deps();
  const res = await app.request('/api/import', { method: 'POST', headers: { ...ui, 'content-length': String(MAX_IMPORT_BYTES + 1) }, body: JSON.stringify(bundle()) });
  expect(res.status).toBe(413);
  const big = JSON.stringify({ ...bundle(), pad: 'x'.repeat(MAX_IMPORT_BYTES) });
  expect((await post(app, big)).status).toBe(413);
  expect(upserted).toEqual([]);
});

test('fields a newer export adds are ignored; misses, docs and the code map are counted but not imported', async () => {
  const { app } = deps();
  const res = await post(app, { ...bundle({ lessons: [], misses: [{ id: 'miss:1' } as never], docs: [{ id: 'doc:1' } as never], codeFiles: [{ path: 'a' } as never] }), futureField: { x: 1 } });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { notImported: Record<string, number> }).notImported).toEqual({ misses: 1, docs: 1, codeFiles: 1 });
});

test('a JSON backup roundtrip preserves no-miss quarantine even when keeping approved status', async () => {
  const checks = [{ name: 'no-miss' as const, why: 'false claim; review this approval' }];
  const backup = JSON.parse(JSON.stringify(bundle({ lessons: [lesson('lesson:quarantine', { paths: ['src/orders.ts'], checks })] })));
  const { app, upserted } = deps();
  expect((await post(app, backup, '?keepApproved=1')).status).toBe(200);
  expect(upserted[0]).toMatchObject({ status: 'approved', checks });
  const { run: _run, ...fields } = upserted[0];
  const restored: Lesson = { ...lesson('lesson:quarantine'), ...fields };
  expect(gradeLessons([{ lesson: restored, score: 1 }], 'orders', { projectKey: 'demo', files: ['src/orders.ts'] })).toEqual({ follow: [], related: [] });
});


test('backup imports preserve revoked lessons as revoked, even with keepApproved', async () => {
  const { app, upserted } = deps();
  const res = await post(app, bundle({ lessons: [lesson('lesson:revoked', { status: 'revoked' })] }), '?keepApproved=1');
  expect(res.status).toBe(200);
  expect(upserted).toMatchObject([{ id: 'lesson:revoked', status: 'revoked' }]);
  expect((await res.json()).lessons.revoked).toBe(1);
});


test('backup import retains private-project provenance through the creation-only restore hook', async () => {
  const restored: { key: string; remote: string | null }[] = [];
  const { app } = deps({ portability: { restorePrivateProject: async project => { restored.push(project); } } });
  const b = bundle({ projects: [{ key: 'private-demo', remote: null, demoCreated: true }], lessons: [], facts: [] });
  const response = await app.request('/api/import', { method: 'POST', body: JSON.stringify(b), headers: { 'sec-fetch-site': 'same-origin', origin: 'http://localhost', 'content-type': 'application/json' } });
  expect(response.status).toBe(200);
  expect(restored).toEqual([{ key: 'private-demo', remote: null }]);
});
