import { beforeAll, expect, test } from 'vitest';
import type { ActivityStore, GraphStore, SelectionStore } from '../store.ts';
import { describeStores, type StoreProbe } from '../testing/index.ts';
import type { ParsedSession } from '../types.ts';
import type { CandidateSnapshot } from './selection.ts';

const session = (id: string): ParsedSession => ({
  sessionId: id, sourceFile: 'f', cwd: '/x', gitBranch: null, startedAt: '2026-10-01T10:00:00Z', endedAt: '2026-10-01T10:00:00Z',
  turns: [{ uuid: `${id}-t0`, sessionId: id, ts: '2026-10-01T10:00:00Z', index: 0, text: 'hi', precedingAssistantText: '', precedingToolCalls: [] }],
  toolCalls: [],
});

describeStores('SelectionStore', (h) => {
  let repo: GraphStore;
  let sel: SelectionStore;
  let activity: ActivityStore;
  let probe: StoreProbe;
  beforeAll(() => {
    repo = h.store.graph;
    sel = h.store.selection;
    activity = h.store.activity;
    probe = h.probe;
  });

  test('a first start with INGEST_PROJECTS keeps reading exactly those projects, and says so once', async () => {
    const r = await sel.ensure({ ingestProjects: ['demo-shop'], excludeProjects: [] }, activity);
    expect(r.seeded).toBe(true);
    expect(r.selection).toMatchObject({ tracked: ['demo-shop'], initialized: true });
    const again = await sel.ensure({ ingestProjects: ['other'], excludeProjects: [] }, activity);
    expect(again.seeded).toBe(false);
    expect(again.selection.tracked).toEqual(['demo-shop']);
    const log = await activity.list({ kind: 'projects_selected' });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: 'deterministic', projectKey: null, details: { tracked: ['demo-shop'], seededFrom: 'INGEST_PROJECTS' } });
  });

  test('an existing graph without INGEST_PROJECTS starts with nothing selected, and the log says nothing is being read', async () => {
    await repo.upsertSession({ key: 'old', name: 'old', repoPath: '/vibe/old' }, session('s1'), []);
    const r = await sel.ensure({ ingestProjects: [], excludeProjects: [] }, activity);
    expect(r.selection).toMatchObject({ tracked: [], initialized: false });
    const [entry] = await activity.list({ kind: 'projects_selected' });
    expect(entry.subject).toMatch(/no projects are selected/i);
    expect(entry.why).toMatch(/1 project already in the graph/);
  });

  test('an upgrade without INGEST_PROJECTS keeps serving the projects you invested in (approved lessons, confirmed feedback, docs, scans), and says why', async () => {
    const vec = Array.from({ length: 768 }, (_, i) => (i === 1 ? 1 : 0));
    const base = { title: 't', rule: 'r', appliesWhen: '', paths: [], source: 'postmortem' as const, embedding: vec };
    for (const k of ['lessons', 'proposed-only', 'feedback', 'docs', 'scanned', 'sessions-only', 'secret']) {
      await repo.upsertSession({ key: k, name: k, repoPath: `/vibe/${k}` }, session(`s-${k}`), []);
    }
    await h.store.knowledge.upsertLesson({ ...base, id: 'l1', projectKey: 'lessons', scope: 'project', status: 'approved' });
    await h.store.knowledge.upsertLesson({ ...base, id: 'l2', projectKey: 'proposed-only', scope: 'project', status: 'proposed' });
    await h.store.knowledge.upsertLesson({ ...base, id: 'l3', projectKey: 'secret', scope: 'project', status: 'approved' });
    await repo.saveClassification('s-feedback-t0', { label: 'pushback', confidence: 0.9, summary: 's', signals: [] }, true);
    await repo.decide('s-feedback-t0', 'confirmed', null);
    await h.store.docs.upsertDoc({ projectKey: 'docs', source: 'upload', ref: 'spec.md', title: 'Spec', url: null }, [{ text: 'x', embedding: vec }]);
    await h.store.facts.requestScan({ key: 'scanned', name: 'scanned', repoPath: '/vibe/scanned' }, null);

    const r = await sel.ensure({ ingestProjects: [], excludeProjects: ['secret'] }, activity);
    expect(r.selection).toMatchObject({ tracked: ['docs', 'feedback', 'lessons', 'scanned'], initialized: true });
    const [entry] = await activity.list({ kind: 'projects_selected' });
    expect(entry.subject).toMatch(/reading 4 projects/);
    expect(entry.why).toMatch(/approved lessons/);
    expect(entry.why).toMatch(/Settings/);
    expect(entry.details).toMatchObject({ seededFrom: 'existing data', tracked: ['docs', 'feedback', 'lessons', 'scanned'] });
  });

  test('a new install tracks nothing until you choose', async () => {
    expect(await sel.get()).toBeNull();
    const r = await sel.ensure({ ingestProjects: [], excludeProjects: [] }, activity);
    expect(r.selection).toMatchObject({ tracked: [], initialized: false });
  });

  test('a selection never made takes INGEST_PROJECTS set after the first start (setup.sh --select), once; a made one never does', async () => {
    // Started with nothing chosen: stored empty and not initialized.
    await sel.ensure({ ingestProjects: [], excludeProjects: [] }, activity);
    const r = await sel.ensure({ ingestProjects: ['demo-shop', 'secret'], excludeProjects: ['secret'] }, activity);
    expect(r.seeded).toBe(true);
    expect(r.selection).toMatchObject({ tracked: ['demo-shop'], initialized: true });
    const log = await activity.list({ kind: 'projects_selected' });
    expect(log).toHaveLength(2);
    expect(log.find((e) => (e.details as { seededFrom?: string }).seededFrom === 'INGEST_PROJECTS')).toMatchObject({ actor: 'deterministic', details: { tracked: ['demo-shop'] } });
    // Made now: INGEST_PROJECTS changing later does nothing, and nothing more is logged.
    const again = await sel.ensure({ ingestProjects: ['other'], excludeProjects: [] }, activity);
    expect(again).toMatchObject({ seeded: false, selection: { tracked: ['demo-shop'] } });
    // Chosen in Settings, even as nothing at all, is a selection made.
    await sel.setTracked([]);
    const kept = await sel.ensure({ ingestProjects: ['other'], excludeProjects: [] }, activity);
    expect(kept).toMatchObject({ seeded: false, selection: { tracked: [], initialized: true } });
    expect(await activity.list({ kind: 'projects_selected' })).toHaveLength(2);
  });

  test('setting the selection marks it chosen and returns what it was before', async () => {
    await sel.ensure({ ingestProjects: ['a'], excludeProjects: [] });
    const r = await sel.setTracked(['b', 'a', 'b']);
    expect(r.before).toEqual(['a']);
    expect(r.selection).toMatchObject({ tracked: ['a', 'b'], initialized: true });
    expect((await sel.get())?.updatedAt).toEqual(expect.any(String));
  });

  test('scope combines the selection, EXCLUDE_PROJECTS and the aliases recorded on projects', async () => {
    await repo.upsertSession({ key: 'demo', name: 'demo', repoPath: '/vibe/demo', remote: 'github.com/o/demo' }, session('s1'), []);
    await repo.canonicalProject({ key: 'demo-2', name: 'demo-2', repoPath: '/vibe/demo-2', remote: 'github.com/o/demo' });
    await sel.setTracked(['demo']);
    const s = await sel.scope({ excludeProjects: [] });
    expect(s.folder('demo-2')).toBe(true);
    expect(s.project('demo')).toBe(true);
    expect((await sel.scope({ excludeProjects: ['demo-2'] })).folder('demo-2')).toBe(false);
    expect(await sel.aliases()).toEqual(new Map([['demo-2', 'demo']]));
  });

  test('the candidate snapshot round-trips', async () => {
    const snap: CandidateSnapshot = {
      builtAt: '2026-10-23T00:00:00Z', roots: ['/Users/me/Vibe'],
      candidates: [{ key: 'a', path: '/Users/me/Vibe/a', exists: true, git: true, remote: 'github.com/o/a', claudeSessions: 2, codexSessions: 1, lastActivity: '2026-10-22T00:00:00Z' }],
      outsideRoots: { claudeSessions: 3, codexSessions: 0 },
      codexSessionsFound: true,
    };
    expect(await sel.candidates()).toBeNull();
    await sel.saveCandidates(snap);
    expect(await sel.candidates()).toEqual(snap);
  });

  test('keysWithData lists projects and anything else filed under a project key', async () => {
    await repo.upsertSession({ key: 'a', name: 'a', repoPath: '/vibe/a' }, session('s1'), []);
    // Filed under a key with no project of its own, as older graphs hold them.
    await probe.seedOrphan({ kind: 'Lesson', id: 'l1', projectKey: 'b' });
    await probe.seedOrphan({ kind: 'Doc', id: 'd1', projectKey: 'c' });
    await activity.record({ kind: 'doc_added', actor: 'you', projectKey: 'only-activity', subject: 's', why: 'w' });
    expect((await sel.keysWithData()).sort()).toEqual(['a', 'b', 'c']);
  });

  test('a folder the worker found to be a clone of an existing project follows it before anything of it is read', async () => {
    await repo.upsertSession({ key: 'demo', name: 'demo', repoPath: '/vibe/demo', remote: 'github.com/o/demo' }, session('s1'), []);
    await repo.upsertSession({ key: 'mine', name: 'mine', repoPath: '/vibe/mine', remote: 'github.com/o/mine' }, session('s2'), []);
    await repo.canonicalProject({ key: 'mine-2', name: 'mine-2', repoPath: '/vibe/mine-2', remote: 'github.com/o/mine' });
    const row = (key: string, cloneOf: string | null) => ({ key, path: `/v/${key}`, exists: true, git: true, remote: null, claudeSessions: 0, codexSessions: 0, lastActivity: null, cloneOf });
    await sel.saveCandidates({
      builtAt: '2026-10-23T00:00:00Z', roots: ['/v'], outsideRoots: { claudeSessions: 0, codexSessions: 0 }, codexSessionsFound: true,
      // A recorded alias wins over the snapshot; a row naming itself is no clone.
      candidates: [row('demo', 'demo'), row('demo-2', 'demo'), row('mine-2', 'demo')],
    });
    expect(await sel.aliases()).toEqual(new Map([['demo-2', 'demo'], ['mine-2', 'mine']]));
    await sel.setTracked(['demo-2']);
    expect((await sel.scope({ excludeProjects: [] })).folder('demo-2')).toBe(false);
    await sel.setTracked(['demo']);
    expect((await sel.scope({ excludeProjects: [] })).folder('demo-2')).toBe(true);
  });

  test('exclusive sections run one at a time, and a failing one lets the next in', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const a = sel.exclusive(async () => { order.push('a starts'); await gate; order.push('a ends'); return 'a'; });
    await new Promise((r) => setTimeout(r, 150));
    const b = sel.exclusive(async () => { order.push('b'); return 'b'; });
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual(['a starts']);
    release();
    expect(await Promise.all([a, b])).toEqual(['a', 'b']);
    expect(order).toEqual(['a starts', 'a ends', 'b']);

    await expect(sel.exclusive(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await sel.exclusive(async () => 'after')).toBe('after');
  });

  test('forgotten reads are handed out in order, each once per cursor', async () => {
    expect(await sel.forgottenReads(0)).toEqual({ seq: 0, keys: [] });
    await sel.forgetReads(['b', 'a']);
    await sel.forgetReads([]);
    const first = await sel.forgottenReads(0);
    expect(first.keys.sort()).toEqual(['a', 'b']);
    expect(await sel.forgottenReads(first.seq)).toEqual({ seq: first.seq, keys: [] });
    await sel.exclusive(() => sel.forgetReads(['c'])); // cleanup records it while holding the section
    const next = await sel.forgottenReads(first.seq);
    expect(next.keys).toEqual(['c']);
    expect(next.seq).toBeGreaterThan(first.seq);
    // A cursor ahead of the store (a restored or replaced graph) starts over rather than missing anything.
    expect((await sel.forgottenReads(next.seq + 100)).keys.sort()).toEqual(['a', 'b', 'c']);
  });
});
