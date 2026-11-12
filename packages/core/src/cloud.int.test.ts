import { beforeAll, beforeEach, expect, test } from 'vitest';
import { runCloudSync, storedSyncMemory, syncBundle } from './cloud.ts';
import type { CloudConfig } from './config.ts';
import { decisionExecutor } from './decisions/executor.ts';
import { handlerContext } from './decisions/apply.ts';
import { genericHandler } from './decisions/types/generic.ts';
import { absentSnapshot, lessonSnapshot, snapshotTargets } from './decisions/snapshot.ts';
import type { Store } from './store.ts';
import { describeStores } from './testing/index.ts';
import type { Classification, DecisionTarget, DecisionType, ParsedSession, PostMortem, TargetSnapshot } from './types.ts';

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
const fake: CloudConfig = { url: 'https://cloud.example.com', token: TOKEN, intervalMinutes: null, projects: [], suggestions: false, claims: false, people: false, machine: null };

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

  test('the sync hold: what the loop changed on its own is exported as it was before, until you keep it or the hold passes', async () => {
    const day = 86_400_000;
    /** A decision the loop applied on its own: `change` is its target write; held until `hold`. */
    const loopApplied = async (type: DecisionType, targets: DecisionTarget[], before: TargetSnapshot[], change: () => Promise<unknown>, hold: number) => {
      const { decision } = await store.decisions.propose({
        type, projectKey: 'demo', targets, before, after: [], evidence: [], features: {}, score: 0.9, confidence: { p: 0.9, lower: 0.8, n: 30, band: 4 },
        tier: 'A', mode: 'auto', rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'proposed',
      });
      await change();
      expect(await store.decisions.markApplying(decision.id)).toBe(true);
      expect(await store.decisions.markApplied(decision.id, await snapshotTargets(store, before), { syncHoldUntil: new Date(Date.now() + hold).toISOString() })).toBe(true);
      return decision.id;
    };
    const lessons = await store.knowledge.listLessons({ projectKey: 'demo' });
    const approved = lessons.find((l) => l.title === 'Scope by org')!;
    const proposed = lessons.find((l) => l.title === 'Scope by org (proposed)')!;
    const [fact] = await h.probe.ids('Fact');
    const lessonTarget = (id: string): DecisionTarget[] => [{ kind: 'lesson', id, role: 'primary' }];
    // Retired (revoked, reworded) and a fact recorded, both held; a proposed lesson approved, whose hold has passed.
    const retired = await loopApplied('retire_lesson', lessonTarget(approved.id), [lessonSnapshot(approved)],
      () => store.knowledge.updateLesson(approved.id, { status: 'revoked', rule: 'Loop words' }, {}), 7 * day);
    await loopApplied('approve_lesson', lessonTarget(proposed.id), [lessonSnapshot(proposed)], () => store.knowledge.updateLesson(proposed.id, { status: 'approved' }, {}), -day);
    await loopApplied('record_fact', [{ kind: 'fact', id: fact, role: 'created' }], [absentSnapshot({ kind: 'fact', id: fact })], async () => {}, 7 * day);

    const sent = (await syncBundle(store.portability, 'demo'))!;
    expect(sent.lessons.map((l) => [l.id, l.status, l.rule])).toEqual([[approved.id, 'approved', approved.rule], [proposed.id, 'approved', proposed.rule]]);
    expect(sent.facts).toEqual([]);
    const file = await store.portability.exportData({ projectKey: 'demo', approvedOnly: true });
    expect(file.lessons.map((l) => [l.id, l.status])).toEqual([[approved.id, 'approved'], [proposed.id, 'approved']]);
    expect(file.facts).toEqual([]);

    // You keep the retirement: the team copy is revoked, in the loop's words, now.
    expect(await store.decisions.ratify(retired, 'you')).toBe(true);
    const kept = (await syncBundle(store.portability, 'demo', { fingerprint: '', lessons: [approved.id], misses: [], docs: [], files: [], remote: null }))!;
    expect(kept.lessons.map((l) => [l.id, l.status, l.rule])).toEqual([[approved.id, 'revoked', 'Loop words'], [proposed.id, 'approved', proposed.rule]]);
    expect((await store.portability.exportData({ projectKey: 'demo', approvedOnly: true })).lessons.map((l) => l.id)).toEqual([proposed.id]);
  });

  test('the sync hold covers a loop decision still applying: a crash after its write sends the team nothing until reconcile settles it', async () => {
    const [approved] = await store.knowledge.listLessons({ projectKey: 'demo', status: 'approved' });
    const hold = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const { decision } = await store.decisions.propose({
      type: 'retire_lesson', projectKey: 'demo', targets: [{ kind: 'lesson', id: approved.id, role: 'primary' }], before: [lessonSnapshot(approved)],
      after: [lessonSnapshot({ ...approved, status: 'revoked', decidedAt: '2026-11-01T00:00:00.000Z', decidedBy: 'loop:1', decisionNote: 'retired' })],
      evidence: [{ kind: 'lesson', id: approved.id, role: 'retire', weight: 1, observedAt: 't' }], features: {}, score: 0.9, confidence: { p: 0.9, lower: 0.8, n: 30, band: 4 },
      tier: 'H', mode: 'auto', rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'proposed',
    });
    // The loop's apply: markApplying with its hold, the lesson revoked, and the worker dies before markApplied.
    expect(await store.decisions.markApplying(decision.id, { by: 'loop:1', syncHoldUntil: hold })).toBe(true);
    await genericHandler.apply(handlerContext(store, {}, 'loop:1'), decision);
    expect((await store.knowledge.lessonDetail(approved.id))!.lesson.status).toBe('revoked');
    const sent = (await syncBundle(store.portability, 'demo'))!;
    expect(sent.lessons.map((l) => [l.id, l.status])).toEqual([[approved.id, 'approved']]);
    // Reconcile applies it, held as before: the team copy never flips.
    expect(await decisionExecutor(store).reconcile(Date.now() + 3 * 60_000)).toMatchObject({ applied: 1 });
    expect((await syncBundle(store.portability, 'demo'))!.lessons.map((l) => [l.id, l.status])).toEqual([[approved.id, 'approved']]);
  });

  test('the sync hold lets your own change through: a revoke or an edit of a lesson the loop changed is sent on the next sync', async () => {
    const x = decisionExecutor(store);
    const [approved] = await store.knowledge.listLessons({ projectKey: 'demo', status: 'approved' });
    const held = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const loop = async (type: DecisionType, patch: Record<string, unknown>) => {
      const l = (await store.knowledge.lessonDetail(approved.id))!.lesson;
      const { decision } = await store.decisions.propose({
        type, projectKey: 'demo', targets: [{ kind: 'lesson', id: l.id, role: 'primary' }], before: [lessonSnapshot(l)], after: [lessonSnapshot({ ...l, ...patch })],
        evidence: [{ kind: 'lesson', id: l.id, role: type, weight: 1, observedAt: 't' }], features: {}, score: 0.9, confidence: { p: 0.9, lower: 0.8, n: 30, band: 4 },
        tier: 'A', mode: 'auto', rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'proposed',
      });
      return x.apply(decision, { by: 'loop:1', syncHoldUntil: held });
    };
    const first = (await syncBundle(store.portability, 'demo'))!;
    // The loop re-weights the lesson (not exported) and rewords it (held: the team keeps the old words).
    await loop('rank_weight', { servingWeight: 0.9 });
    await loop('reword_lesson', { rule: 'Loop words' });
    const sent = { fingerprint: '', lessons: first.lessons.map((l) => l.id), misses: [], docs: [], files: [], remote: null };
    expect((await syncBundle(store.portability, 'demo', sent))!.lessons.map((l) => [l.id, l.status, l.rule])).toEqual([[approved.id, 'approved', approved.rule]]);
    // You rewrite it on the Lessons page: your words go out.
    await store.knowledge.updateLesson(approved.id, { rule: 'Your words' }, { by: 'you' });
    const edited = (await syncBundle(store.portability, 'demo', sent))!;
    expect(edited.lessons.map((l) => [l.id, l.status, l.rule])).toEqual([[approved.id, 'approved', 'Your words']]);
    // You revoke it: the team copy is revoked now, not when the hold passes.
    await store.knowledge.updateLesson(approved.id, { status: 'revoked' }, { by: 'you' });
    const revoked = (await syncBundle(store.portability, 'demo', sent))!;
    expect(revoked.lessons.map((l) => [l.id, l.status])).toEqual([[approved.id, 'revoked']]);
    expect((await store.portability.exportData({ projectKey: 'demo', approvedOnly: true })).lessons).toEqual([]);
  });

  test('the sync hold keeps a global lesson the loop moved to another project in the project it came from, until it is kept', async () => {
    await store.graph.upsertSession({ key: 'other', name: 'other', repoPath: '/vibe/other' }, session('other-s1'), []);
    await store.graph.saveClassification('other-s1-t2', pushback, true);
    await store.graph.decide('other-s1-t2', 'confirmed', null);
    await store.knowledge.savePostmortem('other-s1-t2', pm('Other rule'), { miss: vec(1), lesson: vec(1) });
    await store.graph.saveClassification('demo-s1-t1', pushback, true);
    await store.graph.decide('demo-s1-t1', 'confirmed', null);
    await store.knowledge.savePostmortem('demo-s1-t1', { ...pm('Global one'), lesson: { ...pm('Global one').lesson, scope: 'global' } }, { miss: vec(5), lesson: vec(5) });
    const g = (await store.knowledge.listLessons({})).find((l) => l.title === 'Global one')!;
    await store.knowledge.updateLesson(g.id, { status: 'approved' }, { by: 'you' });
    const l = (await store.knowledge.lessonDetail(g.id))!.lesson;
    const ids = async (key: string) => (await store.portability.exportData({ projectKey: key, approvedOnly: true })).lessons.map((x) => x.id);
    expect(await ids('demo')).toContain(g.id);
    expect(await ids('other')).not.toContain(g.id);
    const { decision } = await store.decisions.propose({
      type: 'narrow_scope', projectKey: 'other', targets: [{ kind: 'lesson', id: g.id, role: 'primary' }], before: [lessonSnapshot(l)],
      after: [lessonSnapshot({ ...l, projectKey: 'other', scope: 'project' })], evidence: [{ kind: 'lesson', id: g.id, role: 'n', weight: 1, observedAt: 't' }],
      features: {}, score: 0.9, confidence: { p: 0.9, lower: 0.8, n: 30, band: 4 }, tier: 'A', mode: 'auto', rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'proposed',
    });
    await decisionExecutor(store).apply(decision, { by: 'loop:1', syncHoldUntil: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    const demo = (await store.portability.exportData({ projectKey: 'demo', approvedOnly: true })).lessons.find((x) => x.id === g.id);
    expect(demo).toMatchObject({ projectKey: null, scope: 'global' });
    expect(await ids('other')).not.toContain(g.id);
    expect((await syncBundle(store.portability, 'demo', { fingerprint: '', lessons: [g.id], misses: [], docs: [], files: [], remote: null }))!.withdrawn).toEqual([]);
    await store.decisions.ratify(decision.id, 'you');
    expect(await ids('demo')).not.toContain(g.id);
    expect(await ids('other')).toContain(g.id);
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
    const cloud: CloudConfig = { url: process.env.CLOUD_E2E_URL!, token: process.env.CLOUD_E2E_TOKEN!, intervalMinutes: null, projects: [], suggestions: false, claims: false, people: false, machine: null };
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
