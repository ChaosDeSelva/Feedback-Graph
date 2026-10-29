import { beforeAll, beforeEach, expect, test } from 'vitest';
import { runCloudSync, storedSyncMemory } from './cloud.ts';
import type { CloudConfig } from './config.ts';
import type { Store } from './store.ts';
import { describeStores } from './testing/index.ts';
import type { Classification, ParsedSession, PostMortem } from './types.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const pushback: Classification = { label: 'pushback', confidence: 0.9, summary: 's', signals: [] };
const FEEDBACK = 'no, every list must be scoped by org, read CLAUDE.md';
const EXCERPT = 'every query filters by orgId';
const SECRET_TURN = 'the earlier turn nobody flagged';

function session(id: string): ParsedSession {
  const text = [SECRET_TURN, 'ok', FEEDBACK];
  const turns = [0, 1, 2].map((i) => ({
    uuid: `${id}-t${i}`, sessionId: id, ts: `2026-10-01T10:0${i}:00Z`, index: i, text: text[i], precedingAssistantText: 'r', precedingToolCalls: [],
  }));
  return { sessionId: id, sourceFile: 'f', cwd: '/x', gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[2].ts, turns, toolCalls: [] };
}

const pm = (title: string): PostMortem => ({
  taskTitle: 'Orders list', missed: 'no tenant scoping', cause: 'context_available_ignored', causeExplanation: 'CLAUDE.md said so', outcome: 'approved',
  lesson: { title, rule: 'Filter every list by orgId', appliesWhen: 'list endpoints', scope: 'project', paths: [] },
  contextItems: [{ kind: 'claude_md', ref: 'CLAUDE.md', excerpt: EXCERPT, why: 'rule existed', wasAvailable: true }],
});

/** One project with an approved lesson, a proposed one, a miss, a fact and a doc. */
export async function seedSyncProject(store: Store, key: string, remote: string | null, approvedTitle: string) {
  const project = { key, name: key, repoPath: `/vibe/${key}` };
  for (const [sid, title] of [[`${key}-s1`, approvedTitle], [`${key}-s2`, `${approvedTitle} (proposed)`]] as const) {
    await store.graph.upsertSession(project, session(sid), []);
    await store.graph.saveClassification(`${sid}-t2`, pushback, true);
    await store.graph.decide(`${sid}-t2`, 'confirmed', null);
    await store.knowledge.savePostmortem(`${sid}-t2`, pm(title), { miss: vec(1), lesson: vec(1) });
  }
  if (remote) await store.graph.setProjectRemote(key, remote);
  const lessons = await store.knowledge.listLessons({ projectKey: key });
  const approved = lessons.find((l) => l.title === approvedTitle)!;
  await store.knowledge.updateLesson(approved.id, { status: 'approved' }, {});
  await store.facts.saveFileFacts(key, { path: 'src/a.ts', hash: 'h', summary: 'A' }, [{ path: 'src/a.ts', lines: '1', kind: 'convention', statement: 'use scoped()', why: 'w', confidence: 1, embedding: vec(2) }], 'ollama:gemma4');
  await store.docs.upsertDoc({ projectKey: key, source: 'upload', ref: 'spec.md', title: 'Spec', url: null }, [{ text: 'the orders spec body', embedding: vec(3) }]);
  return approved;
}

const TOKEN = `fgc_pat_0123456789abcdef_${'A'.repeat(43)}`;
const POLICY_REVISION = 'a'.repeat(64);
const fake: CloudConfig = { url: 'https://cloud.example.com', token: TOKEN, intervalMinutes: null, projects: [], suggestions: false, machine: null };

describeStores('cloud sync', (h) => {
  let store: Store;
  beforeAll(() => {
    store = h.store;
  });
  beforeEach(async () => {
    await seedSyncProject(store, 'demo', 'github.com/acme/demo', 'Scope by org');
  });

  test('a demo-only project stays local without creating a cloud project from its leftover metadata', async () => {
    const key = 'isolated-demo';
    await store.knowledge.saveDemoMiss!({ project: { key, name: key, repoPath: '' }, id: `demo:${key}:probe`, ts: '2026-10-01T00:00:00Z', feedbackText: '[demo] probe', whatWasDone: 'fixture only', missed: '[demo] no-console probe', cause: 'verification_gap', causeExplanation: 'fixture', embedding: vec(1) });
    await store.knowledge.upsertLesson({ id: `lesson:demo:${key}:probe`, projectKey: key, title: '[demo] No console', rule: 'Do not call console.log.', appliesWhen: 'editing probe.ts', scope: 'project', paths: ['probe.ts'], status: 'approved', source: 'demo', embedding: vec(1) });
    await store.facts.saveFileFacts(key, { path: 'probe.ts', hash: 'demo', summary: '[demo]' }, [{ path: 'probe.ts', lines: null, kind: 'convention', statement: '[demo] fixture', why: '', confidence: 1, embedding: vec(2) }], 'demo');
    await store.codegraph.replaceCodeMap(key, { files: [{ path: 'probe.ts', lang: 'typescript', hash: 'fixture', loc: 1, isTest: false }], symbols: [], imports: [], tests: [], churn: {}, fingerprint: 'fixture-map' });
    const exported = await store.portability.exportData({ projectKey: key });
    expect(exported.projects[0]).toMatchObject({ demoCreated: true });
    expect(exported.codeFiles).toHaveLength(1);
    expect(exported.projects.map(project => project.key)).toEqual([key]);
    expect([exported.lessons, exported.misses, exported.facts, exported.docs]).toEqual([[], [], [], []]);
    let posts = 0;
    const fetcher = (async (_url: string, init: RequestInit) => {
      if (init.method === 'POST') posts++;
      return Response.json({ revision: POLICY_REVISION });
    }) as unknown as typeof fetch;
    const result = await runCloudSync({ cloud: fake, portability: store.portability, projects: async () => [key], trigger: 'manual', force: true, fetch: fetcher });
    expect(result.projects).toMatchObject([{ key, status: 'empty' }]);
    expect(posts).toBe(0);
    // A background scan produces ordinary-source facts; it must not silently promote the probe into sharing.
    await store.facts.saveFileFacts(key, { path: 'probe.ts', hash: 'real-scan', summary: 'scanned fixture' }, [{ path: 'probe.ts', lines: null, kind: 'convention', statement: 'background scan fact', why: '', confidence: 1, embedding: vec(2) }], 'ollama:scanner');
    await runCloudSync({ cloud: fake, portability: store.portability, projects: async () => [key], trigger: 'manual', force: true, fetch: fetcher });
    expect(posts).toBe(0);

  });

  test('what is sent is the project with its approved lessons only: no proposed lesson, no transcript text, no excerpts, no document text, no vectors', async () => {
    const bodies: string[] = [];
    const policyRequests: RequestInit[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      if (_url.endsWith('/api/v1/sync-policy')) { policyRequests.push(init); return Response.json({ revision: POLICY_REVISION }); }
      expect(init.method).toBe('POST');
      bodies.push(init.body as string);
      return Response.json({ syncId: 's', org: 'acme', projects: [{ localKey: 'demo', key: 'github.com/acme/demo', remote: 'github.com/acme/demo', namespace: 'team' }], lessons: { team: 1, suggested: 0, skipped: 0 }, misses: 2, facts: { files: 1, unchanged: 0 }, docs: 1 });
    }) as unknown as typeof fetch;
    const r = await runCloudSync({ cloud: fake, portability: store.portability, activity: store.activity, projects: async () => ['demo'], trigger: 'manual', fetch: f });
    expect(r.ok).toBe(true);
    expect(policyRequests).toHaveLength(1);
    expect(policyRequests[0].body).toBeUndefined();
    expect(policyRequests[0].headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]);
    expect(body.lessons.map((l: { title: string; status: string }) => [l.title, l.status])).toEqual([['Scope by org', 'approved']]);
    expect(bodies[0]).not.toContain('Scope by org (proposed)');
    expect(body.complete).toBe(true);
    expect(body.withdrawn).toEqual([]);
    expect(body.projects).toEqual([{ key: 'demo', remote: 'github.com/acme/demo' }]);
    expect(body.misses).toHaveLength(2);
    expect(body.facts.map((x: { statement: string }) => x.statement)).toEqual(['use scoped()']);
    expect(body.docs.map((d: { title: string }) => d.title)).toEqual(['Spec']);
    for (const never of [FEEDBACK, EXCERPT, SECRET_TURN, 'the orders spec body', '"embedding"']) expect(bodies[0]).not.toContain(never);

    // One Activity entry, on either backend, with what was sent and where.
    const [a] = await store.activity.list({ kind: 'cloud_synced' });
    expect(a).toMatchObject({ kind: 'cloud_synced', actor: 'you', projectKey: null });
    expect(a.subject).toContain('cloud.example.com');
    expect(a.details).toMatchObject({ host: 'cloud.example.com', ok: true, projects: ['demo'], sent: { lessons: 1, misses: 2, facts: 1, docs: 1 } });
    expect(JSON.stringify(a)).not.toContain(TOKEN);
  });

  test('a lesson approved and then revoked here goes to the cloud as revoked; a removed doc is withdrawn', async () => {
    const bodies: { lessons: { id: string; status: string }[]; withdrawn: { kind: string; id: string }[]; complete: boolean }[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      if (_url.endsWith('/api/v1/sync-policy')) return Response.json({ revision: POLICY_REVISION });
      expect(init.method).toBe('POST');
      bodies.push(JSON.parse(init.body as string));
      return Response.json({ syncId: 's', org: 'acme', projects: [], lessons: { team: 0, suggested: 0, skipped: 0 }, misses: 0, facts: { files: 0, unchanged: 0 }, docs: 0 });
    }) as unknown as typeof fetch;
    const memory = new Map();
    const run = () => runCloudSync({ cloud: fake, portability: store.portability, projects: async () => ['demo'], trigger: 'schedule', fetch: f, memory });
    await run();
    const approved = bodies[0].lessons.find((l) => l.status === 'approved')!;
    await store.knowledge.updateLesson(approved.id, { status: 'revoked' }, {});
    const [doc] = (await store.portability.exportData({ projectKey: 'demo' })).docs;
    await store.docs.deleteDoc(doc.id);
    await run();
    expect(bodies).toHaveLength(2);
    expect(bodies[1].complete).toBe(true);
    expect(bodies[1].lessons.find((l) => l.id === approved.id)?.status).toBe('revoked');
    expect(bodies[1].withdrawn).toEqual([{ kind: 'doc', id: doc.id }]);
  });

  test('what the cloud accepted is kept in the store: after a restart a removed doc is still withdrawn, and an unselected project is taken back out', async () => {
    await seedSyncProject(store, 'blog', 'github.com/acme/blog', 'Blog lesson');
    const bodies: { projectKey: string; lessons: unknown[]; withdrawn: { kind: string; id: string }[]; complete: boolean }[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      if (_url.endsWith('/api/v1/sync-policy')) return Response.json({ revision: POLICY_REVISION });
      expect(init.method).toBe('POST');
      bodies.push(JSON.parse(init.body as string));
      return Response.json({ syncId: 's', org: 'acme', projects: [], lessons: { team: 0, suggested: 0, skipped: 0 }, misses: 0, facts: { files: 0, unchanged: 0 }, docs: 0 });
    }) as unknown as typeof fetch;
    // A fresh memory each run, as a restarted worker or the api's Sync now would have: only the store carries over.
    const run = (projects: string[], force = false) => runCloudSync({ cloud: fake, portability: store.portability, projects: async () => projects, trigger: 'manual', fetch: f, memory: storedSyncMemory(store.docs, fake), force });
    await run(['demo', 'blog']);
    expect(await storedSyncMemory(store.docs, fake).get('demo')).toMatchObject({ policyRevision: POLICY_REVISION });
    const [doc] = (await store.portability.exportData({ projectKey: 'demo' })).docs;
    await store.docs.deleteDoc(doc.id);
    const r = await run(['demo']);
    expect(r.projects.map((p) => [p.key, p.status])).toEqual([['demo', 'sent'], ['blog', 'withdrawn']]);
    expect(bodies[2]).toMatchObject({ projectKey: 'demo', withdrawn: [{ kind: 'doc', id: doc.id }] });
    expect(bodies[3]).toMatchObject({ projectKey: 'blog', complete: true, lessons: [] });
    expect(bodies[3].withdrawn.length).toBeGreaterThan(0);
    // Nothing changed since: the stored memory skips it, unless the sync is forced.
    expect((await run(['demo'])).projects.map((p) => p.status)).toEqual(['unchanged']);
    expect(bodies).toHaveLength(4);
    await run(['demo'], true);
    expect(bodies.slice(4).map((b) => b.projectKey)).toEqual(['demo']);
  });

  // End to end against a running cloud (scripts/cloud-sync-e2e.sh starts one in Docker, makes an org and a token, and
  // sets these). Skipped otherwise: the open-source suite never needs the hosted service.
  const e2e = process.env.CLOUD_E2E_URL && process.env.CLOUD_E2E_TOKEN && process.env.CLOUD_E2E_ORG;
  test.skipIf(!e2e)('end to end: the approved lesson arrives in the cloud org as a team lesson', async () => {
    const cloud: CloudConfig = { url: process.env.CLOUD_E2E_URL!, token: process.env.CLOUD_E2E_TOKEN!, intervalMinutes: null, projects: [], suggestions: false, machine: null };
    const org = process.env.CLOUD_E2E_ORG!;
    const title = `E2E lesson ${h.kind}`;
    await seedSyncProject(store, `e2e-${h.kind}`, `github.com/acme/e2e-${h.kind}`, title);
    const r = await runCloudSync({ cloud, portability: store.portability, activity: store.activity, projects: async () => [`e2e-${h.kind}`], trigger: 'manual' });
    expect(r.error).toBeNull();
    expect(r.projects[0]).toMatchObject({ status: 'sent', namespace: 'team', cloudKey: expect.stringContaining(`e2e-${h.kind}`), lessons: { team: 1 } });
    const res = await fetch(`${cloud.url}/api/v1/orgs/${org}/lessons?status=approved`, { headers: { authorization: `Bearer ${cloud.token}` } });
    expect(res.status).toBe(200);
    const json = JSON.stringify(await res.json());
    expect(json).toContain(title);
    expect(json).not.toContain(`${title} (proposed)`);
    expect(json).not.toContain(FEEDBACK);
    // Sending the same bundle again changes nothing.
    const memory = storedSyncMemory(store.docs, cloud);
    const again = await runCloudSync({ cloud, portability: store.portability, activity: store.activity, projects: async () => [`e2e-${h.kind}`], trigger: 'manual', memory });
    expect(again.projects[0]).toMatchObject({ status: 'sent', lessons: { team: 1 } });
    // Unselected: its last, empty bundle takes the lesson back out of the team graph.
    const gone = await runCloudSync({ cloud, portability: store.portability, activity: store.activity, projects: async () => [], trigger: 'manual', memory });
    expect(gone.error).toBeNull();
    expect(gone.projects[0]).toMatchObject({ key: `e2e-${h.kind}`, status: 'withdrawn' });
    const after = await fetch(`${cloud.url}/api/v1/orgs/${org}/lessons?status=approved`, { headers: { authorization: `Bearer ${cloud.token}` } });
    expect(JSON.stringify(await after.json())).not.toContain(title);
  });
});
