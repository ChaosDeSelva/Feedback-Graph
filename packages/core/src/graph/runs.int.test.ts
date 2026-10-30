import { beforeAll, expect, test } from 'vitest';
import { sessionFiles } from '../codegraph.ts';
import type { Store } from '../store.ts';
import { describeStores, type StoreProbe } from '../testing/index.ts';
import { NotTheRunsError, type Classification, type ParsedSession, type PostMortem, type Project, type RunTag } from '../types.ts';

const project: Project = { key: 'shop', name: 'shop', repoPath: '/vibe/shop' };
const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const tester: RunTag = { id: 'run-1', sandbox: false };
const sandbox: RunTag = { id: 'sbx-1', sandbox: true };

const pm = (title: string): PostMortem => ({
  taskTitle: 'Checkout', missed: 'totals were rounded', cause: 'requirement_unstated', causeExplanation: 'never stated', outcome: 'approved',
  lesson: { title, rule: 'Keep cents', appliesWhen: 'money', scope: 'project', paths: ['src/**'] },
  contextItems: [{ kind: 'code', ref: 'src/total.ts', excerpt: 'round()', why: 'it rounds', wasAvailable: true }],
});

/** now: turns of the last few minutes (an agent's report merges only with pushback this close in time). */
function session(id: string, now = false): ParsedSession {
  const ts = (i: number) => (now ? new Date(Date.now() - (3 - i) * 60_000).toISOString() : `2026-10-01T10:0${i}:00Z`);
  const turns = [0, 1, 2].map((i) => ({
    uuid: `${id}-t${i}`, sessionId: id, ts: ts(i), index: i, text: `turn ${i}`, precedingAssistantText: i ? `reply ${i}` : '', precedingToolCalls: [],
  }));
  return { sessionId: id, sourceFile: 'f', cwd: '/vibe/shop', gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[2].ts, turns, toolCalls: [] };
}

/** An agent's report in `run`, confirmed and post-mortemed into an approved lesson (the loop a tester exercises). */
async function learned(s: Store, text: string, run: RunTag | null, axis: number): Promise<string> {
  const id = await s.knowledge.createManualFeedback({ project, cwd: '/vibe/shop', text, whatWasDone: 'shipped it', run });
  await s.graph.decide(id, 'confirmed', null, 'operator:tester');
  await s.knowledge.savePostmortem(id, pm(text), { miss: vec(axis), lesson: vec(axis) });
  await s.knowledge.updateLesson(`lesson:${id}`, { status: 'approved' }, { by: 'operator:tester' });
  return id;
}

/** An approved lesson from a report made in `run` against session `id`, whose session edited src/total.ts. */
async function learnedOnFile(s: Store, id: string, title: string, run: RunTag | null, axis: number): Promise<string> {
  const sess = { ...session(id, true), toolCalls: [{ name: 'Edit', ts: new Date().toISOString(), filePath: '/vibe/shop/src/total.ts' }] };
  if (run) expect(await s.sessions.claimRun(id, run)).toBe(true);
  await s.graph.upsertSession(project, sess, []);
  await s.codegraph.recordSessionFiles(id, sessionFiles(sess, '/vibe/shop'));
  const report = await s.knowledge.createManualFeedback({ project, cwd: '/vibe/shop', text: 'turn 2', whatWasDone: 'x', sessionId: id, run });
  // The detector finds the same pushback in the session: the report moves onto its turn (and keeps its run).
  expect(await s.graph.saveClassification(`${id}-t2`, { label: 'pushback', confidence: 0.9, summary: 's', signals: [] }, true)).toBe(report);
  await s.graph.decide(report, 'confirmed', null, 'operator:tester');
  await s.knowledge.savePostmortem(report, pm(title), { miss: vec(axis), lesson: vec(axis) });
  await s.knowledge.updateLesson(`lesson:${report}`, { status: 'approved' }, { by: 'operator:tester' });
  return report;
}

describeStores('RunsStore and run attribution', (h) => {
  let s: Store;
  let probe: StoreProbe;
  beforeAll(() => {
    s = h.store;
    probe = h.probe;
  });

  test('concurrent sandbox demo facts stay visible only to their run and cleanup preserves the other run', async () => {
    const write = (id: string) => s.facts.saveFileFacts('shop', { path: 'src/probe.ts', hash: 'demo', summary: 'fixture' }, [
      { kind: 'convention', statement: id, path: 'src/probe.ts', lines: null, confidence: 1, why: 'fixture', embedding: vec(1) },
    ], 'demo', null, { id, sandbox: true });
    await Promise.all([write('fact-one'), write('fact-two')]);
    expect(await s.facts.listFacts({ projectKey: 'shop', path: 'src/probe.ts' })).toEqual([]);
    expect((await s.facts.listFacts({ projectKey: 'shop', path: 'src/probe.ts', run: 'fact-one' })).map(f => f.statement)).toEqual(['fact-one']);
    expect((await s.facts.listFacts({ projectKey: 'shop', path: 'src/probe.ts', run: 'fact-two' })).map(f => f.statement)).toEqual(['fact-two']);
    await s.facts.replaceProjectFacts('shop', [], 'model', []);
    expect((await s.facts.listFacts({ projectKey: 'shop', path: 'src/probe.ts', run: 'fact-two' })).map(f => f.statement)).toEqual(['fact-two']);
    expect((await s.runs.remove('fact-one', [])).fact).toBe(1);
    expect((await s.facts.listFacts({ projectKey: 'shop', path: 'src/probe.ts', run: 'fact-two' })).map(f => f.statement)).toEqual(['fact-two']);
  });

  test('removing a labelled demo seed preserves another run in the same demo project', async () => {
    for (const id of ['demo-one', 'demo-two']) {
      const run = { id, sandbox: true };
      await s.knowledge.saveDemoMiss!({ project, id: `demo:shop:run:${id}:miss`, ts: '2026-10-01T10:00:00Z', feedbackText: 'fixture', whatWasDone: 'fixture', missed: 'fixture', cause: 'requirement_unstated', causeExplanation: 'fixture', embedding: vec(1), run });
      await s.knowledge.upsertLesson({ id: `demo:shop:run:${id}:lesson`, projectKey: 'shop', title: id, rule: 'Fixture', appliesWhen: 'fixture', scope: 'project', paths: ['src/probe.ts'], status: 'approved', source: 'demo', embedding: vec(1), run });
    }
    await s.knowledge.removeDemo!('shop', { id: 'demo-one', sandbox: true });
    expect(await s.runs.items('demo-one')).toEqual([]);
    expect((await s.runs.items('demo-two')).map(x => x.kind)).toEqual(expect.arrayContaining(['feedback', 'lesson', 'miss']));
  });

  test('undo reopens only an unchanged unprocessed Inbox decision', async () => {
    const id = await s.knowledge.createManualFeedback({ project, cwd: '/vibe/shop', text: 'undo fixture', whatWasDone: 'fixture' });
    await s.graph.decide(id, 'confirmed', null);
    const decidedAt = (await s.graph.candidateDetail(id))!.candidate.decidedAt!;
    expect(await s.graph.undoDecision!(id, '2000-01-01T00:00:00.000Z')).toBe(false);
    expect(await s.graph.undoDecision!(id, decidedAt)).toBe(true);
    expect((await s.graph.candidateDetail(id))!.candidate.status).toBe('pending');
    expect(await s.knowledge.savePostmortem(id, pm('Late model'), { miss: vec(1), lesson: vec(1) })).toBe(false);
    expect(await s.knowledge.lessonDetail(`lesson:${id}`)).toBeNull();
    expect(await s.graph.undoDecision!(id, decidedAt)).toBe(false);
    await s.graph.decide(id, 'confirmed', null);
    await s.knowledge.savePostmortem(id, pm('Already processed'), { miss: vec(1), lesson: vec(1) });
    const processed = (await s.graph.candidateDetail(id))!.candidate.decidedAt!;
    expect(await s.graph.undoDecision!(id, processed)).toBe(false);
    expect(await s.knowledge.lessonDetail(`lesson:${id}`)).not.toBeNull();
  });

  test('persisted memory writes inherit their own session run and a later owner write clears attribution', async () => {
    const path = '/transcripts/project/memory/probe.md';
    const run = { id: 'memory-probe', sandbox: true };
    await s.sessions.claimRun('memory-session', run);
    const first = { ...session('memory-session'), toolCalls: [{ name: 'Write', ts: '2026-10-01T10:03:00Z', filePath: path }] };
    await s.graph.upsertSession(project, first, []);
    expect(await s.graph.memoryWriteRun?.('shop', path)).toEqual(run);
    const owner = { ...session('memory-owner'), endedAt: '2026-10-02T10:03:00Z', toolCalls: [{ name: 'Edit', ts: '2026-10-02T10:02:00Z', filePath: path }] };
    await s.graph.upsertSession(project, owner, []);
    expect(await s.graph.memoryWriteRun?.('shop', path)).toBeNull();
    expect(await s.graph.memoryWriteRun?.('shop', '/memory/other.md')).toBeNull();
  });

  test('sandbox provenance includes session-only registrations', async () => {
    expect(await s.sessions.claimRun('sandbox-only-session', { id: 'sandbox-only', sandbox: true })).toBe(true);
    expect(await s.sessions.claimRun('ordinary-only-session', { id: 'ordinary-only', sandbox: false })).toBe(true);
    expect(await s.runs.items('sandbox-only')).toEqual([]);
    expect(await s.activity.list({ run: 'sandbox-only' })).toEqual([]);
    expect(await s.runs.sandbox?.('sandbox-only')).toBe(true);
    expect(await s.runs.sandbox?.('ordinary-only')).toBe(false);
    expect(await s.runs.sandbox?.('unknown-run')).toBe(false);
  });

  test('activity records the run, lists it back, and filters by it', async () => {
    await s.activity.record({ kind: 'context_served', actor: 'agent (MCP)', projectKey: 'shop', subject: 'a', why: 'w', run: 'run-1' });
    await s.activity.record({ kind: 'context_served', actor: 'agent (MCP)', projectKey: 'shop', subject: 'b', why: 'w', run: 'sbx-1', sandbox: true });
    await s.activity.record({ kind: 'context_served', actor: 'agent (MCP)', projectKey: 'shop', subject: 'c', why: 'w' });
    const all = await s.activity.list({});
    expect(all.map((a) => [a.subject, a.run ?? null, a.sandbox ?? false])).toEqual([['c', null, false], ['b', 'sbx-1', true], ['a', 'run-1', false]]);
    expect((await s.activity.list({ run: 'run-1' })).map((a) => a.subject)).toEqual(['a']);
    expect((await s.activity.get(all[1].id))).toMatchObject({ run: 'sbx-1', sandbox: true });
  });

  test("the default feed leaves out every run's entries (unlabelled), a record's history leaves out sandbox runs' (noSandbox), and removeRun removes one run's entries only", async () => {
    await s.activity.record({ kind: 'context_served', actor: 'agent (MCP)', projectKey: 'shop', subject: 'a', why: 'w', run: 'run-1', targets: ['l1'] });
    await s.activity.record({ kind: 'context_served', actor: 'agent (MCP)', projectKey: 'shop', subject: 'b', why: 'w', run: 'sbx-1', sandbox: true, targets: ['l1'] });
    await s.activity.record({ kind: 'context_served', actor: 'agent (MCP)', projectKey: 'shop', subject: 'c', why: 'w', targets: ['l1'] });
    await s.activity.record({ kind: 'context_served', actor: 'agent (MCP)', projectKey: 'shop', subject: 'd', why: 'w', run: 'run-1' });
    const subjects = async (q: Parameters<Store['activity']['list']>[0]) => (await s.activity.list(q)).map((a) => a.subject);
    expect(await subjects({ unlabelled: true })).toEqual(['c']);
    expect(await subjects({ unlabelled: true, limit: 1 })).toEqual(['c']);
    expect(await subjects({ target: 'l1', noSandbox: true })).toEqual(['c', 'a']);
    expect(await subjects({ run: 'sbx-1' })).toEqual(['b']);
    expect(await s.activity.removeRun!('run-1')).toBe(2);
    expect(await subjects({})).toEqual(['c', 'b']);
    expect(await s.activity.removeRun!('run-1')).toBe(0);
  });

  test('removeRun keeps the entries of the kinds it is told to keep: a decision a run made on a record it does not own stays on the record', async () => {
    await s.activity.record({ kind: 'context_served', actor: 'agent (MCP)', projectKey: 'shop', subject: 'served', why: 'w', run: 'run-2' });
    await s.activity.record({ kind: 'feedback_decided', actor: 'operator:bot', projectKey: 'shop', subject: 'decided', why: 'w', run: 'run-2', targets: ['c1'] });
    expect(await s.activity.removeRun!('run-2', ['feedback_decided', 'lesson_decided'])).toBe(1);
    expect((await s.activity.list({ run: 'run-2' })).map((a) => a.subject)).toEqual(['decided']);
  });

  test('removeRun keeps the entries about records the cleanup keeps, and removes only the entries it is given', async () => {
    await s.activity.record({ kind: 'postmortem_done', actor: 'ollama:m', projectKey: 'shop', subject: 'created kept', why: 'w', run: 'run-3', targets: ['manual:b', 'lesson:manual:b'] });
    await s.activity.record({ kind: 'postmortem_done', actor: 'ollama:m', projectKey: 'shop', subject: 'created gone', why: 'w', run: 'run-3', targets: ['lesson:manual:a'] });
    await s.activity.record({ kind: 'context_served', actor: 'agent (MCP)', projectKey: 'shop', subject: 'unread', why: 'w', run: 'run-3' });
    const read = (await s.activity.list({ run: 'run-3' })).filter((a) => a.subject !== 'unread').map((a) => a.id);
    expect(await s.activity.removeRun!('run-3', [], { ids: read, targets: ['manual:b', 'lesson:manual:b'] })).toBe(1);
    expect((await s.activity.list({ run: 'run-3' })).map((a) => a.subject).sort()).toEqual(['created kept', 'unread']);
  });

  test("a report's run is carried to the miss and lesson its post-mortem makes; items lists them by kind", async () => {
    const id = await learned(s, 'totals must keep cents', tester, 1);
    await learned(s, 'the owner one', null, 2);
    const lesson = (await s.knowledge.listLessons({})).find((l) => l.id === `lesson:${id}`)!;
    expect(lesson).toMatchObject({ run: 'run-1' });
    expect(lesson.sandbox).toBeUndefined();
    const items = await s.runs.items('run-1');
    expect(items.map((i) => [i.kind, i.id, i.group]).sort()).toEqual([
      ['feedback', id, null], ['lesson', `lesson:${id}`, id], ['miss', `miss:${id}`, id],
    ].sort());
    expect(items.every((i) => i.projectKey === 'shop' && !i.sandbox && !i.merged)).toBe(true);
    expect(await s.runs.items('nobody')).toEqual([]);
  });

  test('every other run write is listed: a pre-done check, an owner fact, an upload, a link, a conversation', async () => {
    await s.knowledge.recordPreDoneCheck({ projectKey: 'shop', task: 't', checkedLessonIds: [], gapLessonIds: [], run: tester });
    const fact = await s.facts.addOwnerFact('shop', { kind: 'convention', statement: 'cents', path: '.', lines: null, confidence: 1, why: 'w', embedding: vec(3) }, 'operator:tester', tester);
    const doc = await s.docs.upsertDoc({ projectKey: 'shop', source: 'upload', ref: 'spec.md', title: 'Spec', url: null }, [{ text: 'keep cents', embedding: vec(4) }], { read: true, addedBy: 'operator:tester', run: tester });
    const link = await s.links.setLink('shop', 'web', { status: 'confirmed', decidedBy: 'operator:tester', run: tester });
    const chat = await s.chats.createConversation({ projectKey: 'shop', title: 'q', provider: null, run: 'run-1' });
    // Written without the run: not the run's.
    await s.facts.addOwnerFact('shop', { kind: 'convention', statement: 'mine', path: '.', lines: null, confidence: 1, why: 'w', embedding: vec(3) }, 'you');
    const kinds = Object.fromEntries((await s.runs.items('run-1')).map((i) => [i.kind, i.id]));
    expect(Object.keys(kinds).sort()).toEqual(['chat', 'doc', 'fact', 'link', 'predone_check'].sort());
    expect(kinds).toMatchObject({ fact: fact.id, doc, link: link.id, chat: chat.id });
    // A link that already existed is never the run's: its decision on the owner's is refused (runOwnership.int.test.ts).
    await s.links.setLink('shop', 'blog', { status: 'confirmed' });
    await expect(s.links.setLink('shop', 'blog', { status: 'dismissed', run: tester })).rejects.toBeInstanceOf(NotTheRunsError);
    expect((await s.runs.items('run-1')).filter((i) => i.kind === 'link')).toHaveLength(1);
  });

  test('remove deletes exactly what the run wrote (a report with its session, post-mortem and lesson), keeps what it is told to, and nothing else', async () => {
    const gone = await learned(s, 'totals must keep cents', tester, 1);
    const kept = await learned(s, 'the owner approved this one', tester, 2);
    const owner = await learned(s, 'the owner one', null, 3);
    await s.knowledge.recordPreDoneCheck({ projectKey: 'shop', task: 't', checkedLessonIds: [`lesson:${owner}`], gapLessonIds: [], run: tester });
    const fact = await s.facts.addOwnerFact('shop', { kind: 'convention', statement: 'cents', path: '.', lines: null, confidence: 1, why: 'w', embedding: vec(3) }, 'operator:tester', tester);
    await s.docs.upsertDoc({ projectKey: 'shop', source: 'upload', ref: 'spec.md', title: 'Spec', url: null }, [{ text: 'keep cents', embedding: vec(4) }], { run: tester });
    await s.links.setLink('shop', 'web', { status: 'confirmed', run: tester });
    await s.chats.createConversation({ projectKey: 'shop', title: 'q', provider: null, run: 'run-1' });

    const removed = await s.runs.remove('run-1', [kept]);
    expect(removed).toEqual({ feedback: 1, lesson: 1, miss: 1, predone_check: 1, fact: 1, doc: 1, link: 1, chat: 1 });
    expect(await s.graph.candidateDetail(gone)).toBeNull();
    expect(await s.knowledge.lessonDetail(`lesson:${gone}`)).toBeNull();
    expect((await s.knowledge.lessonDetail(`lesson:${kept}`))?.lesson.status).toBe('approved');
    expect((await s.knowledge.lessonDetail(`lesson:${owner}`))?.lesson.status).toBe('approved');
    expect((await s.facts.listFacts({ projectKey: 'shop' })).map((f) => f.id)).not.toContain(fact.id);
    expect(await s.docs.listDocs('shop')).toEqual([]);
    expect(await s.links.listLinks({ projectKey: 'shop' })).toEqual([]);
    expect(await s.chats.listConversations({})).toEqual([]);
    expect((await s.runs.items('run-1')).map((i) => i.id).sort()).toEqual([kept, `lesson:${kept}`, `miss:${kept}`].sort());
    // Activity is the provenance log: it is never removed.
    expect(await s.runs.remove('run-1', [kept])).toEqual({ feedback: 0, lesson: 0, miss: 0, predone_check: 0, fact: 0, doc: 0, link: 0, chat: 0 });
  });

  test("a labelled report cannot merge into an owner session or mutate its candidate", async () => {
    await s.graph.upsertSession(project, session('s1', true), []);
    const id = await s.knowledge.createManualFeedback({ project, cwd: '/vibe/shop', text: 'turn 2', whatWasDone: 'x', sessionId: 's1', run: tester });
    expect(await s.graph.saveClassification('s1-t2', { label: 'pushback', confidence: 0.9, summary: 's', signals: [] } as Classification, true)).toBe('s1-t2');
    expect((await s.runs.items('run-1')).find((i) => i.id === id)).toMatchObject({ kind: 'feedback', merged: false });
    expect((await s.graph.candidateDetail('s1-t2'))?.candidate.run).toBeUndefined();
    await s.runs.remove('run-1', []);
    expect(await s.graph.candidateDetail(id)).toBeNull();
    expect(await s.graph.candidateDetail('s1-t2')).not.toBeNull();
    expect((await s.sessions.detail('s1'))?.turnCount).toBe(3);
  });

  test('a sandbox run is served only to itself: searches leave out other runs\' sandbox lessons, misses, facts and docs', async () => {
    await learned(s, 'sandbox lesson', sandbox, 1);
    await learned(s, 'real lesson', null, 1);
    const lessons = (run?: string | null) => s.knowledge.searchLessons({ embedding: vec(1), projectKey: 'shop', k: 10, run }).then((r) => r.map((x) => x.lesson.title).sort());
    expect(await lessons()).toEqual(['real lesson']);
    expect(await lessons(null)).toEqual(['real lesson']);
    expect(await lessons('other-run')).toEqual(['real lesson']);
    expect(await lessons('sbx-1')).toEqual(['real lesson', 'sandbox lesson']);
    const misses = (run?: string | null) => s.knowledge.relatedMisses({ embedding: vec(1), projectKey: 'shop', k: 10, run }).then((r) => r.length);
    expect(await misses()).toBe(1);
    expect(await misses('sbx-1')).toBe(2);
    expect((await s.knowledge.listLessons({ run: 'sbx-1' })).find((l) => l.title === 'sandbox lesson')).toMatchObject({ run: 'sbx-1', sandbox: true });

    await s.facts.addOwnerFact('shop', { kind: 'convention', statement: 'sandbox fact', path: '.', lines: null, confidence: 1, why: 'w', embedding: vec(2) }, 'operator:tester', sandbox);
    await s.facts.addOwnerFact('shop', { kind: 'convention', statement: 'real fact', path: '.', lines: null, confidence: 1, why: 'w', embedding: vec(2) }, 'you');
    const facts = (run?: string) => s.facts.searchFacts({ embedding: vec(2), projectKey: 'shop', k: 10, run }).then((r) => r.map((x) => x.fact.statement).sort());
    expect(await facts()).toEqual(['real fact']);
    expect(await facts('sbx-1')).toEqual(['real fact', 'sandbox fact']);

    await s.docs.upsertDoc({ projectKey: 'shop', source: 'upload', ref: 'sbx.md', title: 'Sandbox', url: null }, [{ text: 'sandbox doc', embedding: vec(3) }], { read: true, run: sandbox });
    await s.docs.upsertDoc({ projectKey: 'shop', source: 'upload', ref: 'real.md', title: 'Real', url: null }, [{ text: 'real doc', embedding: vec(3) }], { read: true });
    const docs = (run?: string) => s.docs.searchDocs({ embedding: vec(3), projectKey: 'shop', k: 10, run }).then((r) => r.map((x) => x.text).sort());
    expect(await docs()).toEqual(['real doc']);
    expect(await docs('sbx-1')).toEqual(['real doc', 'sandbox doc']);

    // What the reader makes of a sandbox upload is sandbox too.
    const next = await s.docs.nextDocToRead();
    const sbx = next!.ref === 'sbx.md' ? next! : null;
    if (sbx) {
      await s.docs.saveDocReading(sbx.id, { version: sbx.version, facts: [{ kind: 'convention', statement: 'read from sandbox', path: 'sbx.md', lines: null, confidence: 1, why: 'w', embedding: vec(2) }], source: 'm' });
      expect(await facts()).toEqual(['real fact']);
    }

    const link = await s.links.setLink('shop', 'web', { status: 'confirmed', run: sandbox });
    expect(link).toMatchObject({ run: 'sbx-1', sandbox: true });
  });

  test("another run's sandbox chunks nearest the query never crowd the project's own out of the k nearest", async () => {
    await s.docs.upsertDoc({ projectKey: 'shop', source: 'upload', ref: 'sbx.md', title: 'Sandbox', url: null }, [{ text: 'sandbox doc', embedding: vec(3) }], { run: sandbox });
    const near = Array.from({ length: 768 }, (_, i) => (i === 3 ? 0.8 : i === 4 ? 0.6 : 0));
    await s.docs.upsertDoc({ projectKey: 'shop', source: 'upload', ref: 'real.md', title: 'Real', url: null }, [{ text: 'real doc', embedding: near }]);
    const docs = (run?: string) => s.docs.searchDocs({ embedding: vec(3), projectKey: 'shop', k: 1, run }).then((r) => r.map((x) => x.text));
    expect(await docs()).toEqual(['real doc']);
    expect(await docs('other-run')).toEqual(['real doc']);
    expect(await docs('sbx-1')).toEqual(['sandbox doc']);
  });

  test("the code map's per-file views leave out other runs' sandbox misses, lessons and facts: lessonsForPaths, moduleContext, impact, hotspots, mapGraph", async () => {
    await s.codegraph.replaceCodeMap('shop', {
      files: [{ path: 'src/total.ts', lang: 'typescript', hash: 'h1', loc: 10, isTest: false }, { path: 'src/cart.ts', lang: 'typescript', hash: 'h2', loc: 10, isTest: false }],
      symbols: [], imports: [{ from: 'src/cart.ts', to: 'src/total.ts', names: ['total'], spec: './total.ts' }], tests: [], churn: {}, fingerprint: 'head:abc',
    });
    await learnedOnFile(s, 'sx', 'sandbox lesson', sandbox, 1);
    await learnedOnFile(s, 'rx', 'real lesson', null, 2);
    await s.facts.addOwnerFact('shop', { kind: 'convention', statement: 'sandbox fact', path: 'src/total.ts', lines: null, confidence: 1, why: 'w', embedding: vec(5) }, 'operator:tester', sandbox);
    await s.facts.addOwnerFact('shop', { kind: 'convention', statement: 'real fact', path: 'src/total.ts', lines: null, confidence: 1, why: 'w', embedding: vec(5) }, 'you');

    const forPaths = (run?: string | null) => s.codegraph.lessonsForPaths('shop', ['src/total.ts'], run).then((r) => r.map((x) => x.lesson.title).sort());
    expect(await forPaths()).toEqual(['real lesson']);
    expect(await forPaths('other-run')).toEqual(['real lesson']);
    expect(await forPaths('sbx-1')).toEqual(['real lesson', 'sandbox lesson']);

    const mod = (run?: string | null) => s.codegraph.moduleContext('shop', 'src/total.ts', run);
    const plain = (await mod())!;
    expect(plain.misses).toHaveLength(1);
    expect(plain.lessons.map((l) => l.title)).toEqual(['real lesson']);
    expect(plain.facts.map((f) => f.statement)).toEqual(['real fact']);
    const mine = (await mod('sbx-1'))!;
    expect(mine.misses).toHaveLength(2);
    expect(mine.lessons.map((l) => l.title).sort()).toEqual(['real lesson', 'sandbox lesson']);
    expect(mine.facts.map((f) => f.statement).sort()).toEqual(['real fact', 'sandbox fact']);

    const imp = (run?: string | null) => s.codegraph.impact('shop', ['src/total.ts'], 2, run);
    expect((await imp()).misses).toHaveLength(1);
    expect((await imp()).lessons.map((l) => l.title)).toEqual(['real lesson']);
    expect((await imp('sbx-1')).misses).toHaveLength(2);

    const hot = (run?: string | null) => s.codegraph.hotspots('shop', 5, { run }).then((r) => r.find((x) => x.path === 'src/total.ts')?.misses);
    expect(await hot()).toBe(1);
    expect(await hot('sbx-1')).toBe(2);
    const graph = await s.codegraph.mapGraph('shop', { limit: 5 });
    expect(graph.misses).toHaveLength(1);
    expect(graph.lessons.map((l) => l.title)).toEqual(['real lesson']);
  });

  test("lists leave out other runs' sandbox records unless that run asks: lessons, the Inbox, facts, documents, links, patterns, the evidence graph", async () => {
    const sbx = await learned(s, 'sandbox lesson', sandbox, 1);
    await learned(s, 'real lesson', null, 2);
    const titles = (run?: string | null) => s.knowledge.listLessons({ run }).then((r) => r.map((l) => l.title).sort());
    expect(await titles()).toEqual(['real lesson']);
    expect(await titles('other-run')).toEqual(['real lesson']);
    expect(await titles('sbx-1')).toEqual(['real lesson', 'sandbox lesson']);

    const inbox = (run?: string | null) => s.graph.listCandidates({ run }).then((r) => r.map((c) => c.id));
    expect(await inbox()).not.toContain(sbx);
    expect(await inbox()).toHaveLength(1);
    expect(await inbox('sbx-1')).toContain(sbx);

    await s.facts.addOwnerFact('shop', { kind: 'convention', statement: 'sandbox fact', path: '.', lines: null, confidence: 1, why: 'w', embedding: vec(2) }, 'operator:tester', sandbox);
    await s.facts.addOwnerFact('shop', { kind: 'convention', statement: 'real fact', path: '.', lines: null, confidence: 1, why: 'w', embedding: vec(2) }, 'you');
    const facts = (run?: string | null) => s.facts.listFacts({ projectKey: 'shop', run }).then((r) => r.map((f) => f.statement).sort());
    expect(await facts()).toEqual(['real fact']);
    expect(await facts('sbx-1')).toEqual(['real fact', 'sandbox fact']);

    const pr = await s.docs.upsertDoc({ projectKey: 'shop', source: 'github', ref: 'pr:1', title: 'PR', url: null }, [{ text: 'pr', embedding: vec(3) }], { tickets: ['ACME-1'] });
    await s.docs.upsertDoc({ projectKey: 'shop', source: 'linear', ref: 'linear:ACME-1', title: 'Ticket', url: null }, [{ text: 't', embedding: vec(3) }], { run: sandbox });
    await s.docs.upsertDoc({ projectKey: 'shop', source: 'upload', ref: 'real.md', title: 'Real', url: null }, [{ text: 'real doc', embedding: vec(3) }]);
    const docs = (run?: string | null) => s.docs.listDocs('shop', { run }).then((r) => r.map((d) => d.title).sort());
    expect(await docs()).toEqual(['PR', 'Real']);
    expect(await docs('sbx-1')).toEqual(['PR', 'Real', 'Ticket']);
    expect(await s.docs.linkedDocs({ projectKey: 'shop', docIds: [pr] })).toEqual([]);
    expect((await s.docs.linkedDocs({ projectKey: 'shop', docIds: [pr], run: 'sbx-1' })).map((l) => l.linked.title)).toEqual(['Ticket']);

    await s.links.setLink('shop', 'web', { status: 'confirmed', run: sandbox });
    await s.links.setLink('shop', 'blog', { status: 'confirmed' });
    const links = (run?: string | null) => s.links.listLinks({ projectKey: 'shop', run }).then((r) => r.map((l) => (l.a === 'shop' ? l.b : l.a)).sort());
    expect(await links()).toEqual(['blog']);
    expect(await links('sbx-1')).toEqual(['blog', 'web']);

    await s.knowledge.recordPreDoneCheck({ projectKey: 'shop', task: 't', checkedLessonIds: [], gapLessonIds: [], run: sandbox });
    await s.knowledge.recordPreDoneCheck({ projectKey: 'shop', task: 't', checkedLessonIds: [], gapLessonIds: [] });
    const p = await s.insights.patterns({ projectKey: 'shop' });
    expect(p.causes.reduce((n, c) => n + c.count, 0)).toBe(1);
    expect(p.weekly.reduce((n, w) => n + w.feedback, 0)).toBe(1);
    expect(p.preDone.checks).toBe(1);
    const g = await s.insights.projectGraph('shop');
    expect(g.nodes.filter((n) => n.kind === 'lesson').map((n) => n.label)).toEqual(['real lesson']);
    // The Dashboard's weekly pushback and the Projects page count the owner's records only.
    expect((await s.graph.stats()).filter((r) => r.projectKey === 'shop').reduce((n, r) => n + r.pushback, 0)).toBe(1);
    expect((await s.facts.listProjects()).find((x) => x.key === 'shop')).toMatchObject({ feedback: 1, lessons: 1, facts: 1 });
  });

  test("a pre-done check records the agent's session when it gives one", async () => {
    await s.knowledge.recordPreDoneCheck({ projectKey: 'shop', task: 'a', checkedLessonIds: [], gapLessonIds: [], sessionId: 's-7' });
    await s.knowledge.recordPreDoneCheck({ projectKey: 'shop', task: 'b', checkedLessonIds: [], gapLessonIds: [] });
    expect((await probe.preDoneChecks()).map((r) => [r.task, r.sessionId ?? null])).toEqual([['a', 's-7'], ['b', null]]);
  });

  test('a sandbox run is never exported (nor, through the export, synced to the cloud)', async () => {
    await learned(s, 'sandbox lesson', sandbox, 1);
    await learned(s, 'real lesson', null, 2);
    await s.facts.addOwnerFact('shop', { kind: 'convention', statement: 'sandbox fact', path: '.', lines: null, confidence: 1, why: 'w', embedding: vec(2) }, 'operator:tester', sandbox);
    await s.docs.upsertDoc({ projectKey: 'shop', source: 'upload', ref: 'sbx.md', title: 'Sandbox', url: null }, [{ text: 'x', embedding: vec(3) }], { run: sandbox });
    const b = await s.portability.exportData({ projectKey: 'shop' });
    expect(b.lessons.map((l) => l.title)).toEqual(['real lesson']);
    expect(b.misses).toHaveLength(1);
    expect(b.facts.map((f) => f.statement)).not.toContain('sandbox fact');
    expect(b.docs).toEqual([]);
  });

  test("turnEvidence: each turn of a session, in order, with what the detector made of it and the Inbox item it filed", async () => {
    await s.graph.upsertSession(project, session('s2'), []);
    await s.graph.saveClassification('s2-t1', { label: 'neutral', confidence: 0.7, summary: 'an instruction', signals: ['skip:git-instruction'] }, false);
    await s.graph.saveClassification('s2-t2', { label: 'pushback', confidence: 0.9, summary: 'no, keep cents', signals: [] }, true);
    await s.graph.recordClassifyFailure('s2-t1');
    const turns = await s.sessions.turnEvidence('s2');
    expect(turns.map((t) => [t.index, t.label, t.candidateId])).toEqual([[0, null, null], [1, 'neutral', null], [2, 'pushback', 's2-t2']]);
    expect(turns[1]).toMatchObject({ uuid: 's2-t1', ts: '2026-10-01T10:01:00Z', confidence: 0.7, summary: 'an instruction', signals: ['skip:git-instruction'], classifyAttempts: 1 });
    expect(turns[0]).toMatchObject({ signals: [], classifyAttempts: 0, summary: null, confidence: null });
    expect(await s.sessions.turnEvidence('nope')).toEqual([]);
  });

  test('claim records who opened a run once: a later claim by anyone (even at the same time) gets the first owner back; owner reads it', async () => {
    expect(await s.runs.owner('run-own')).toBeNull();
    const first = await s.runs.claim('run-own', 'operator', 'operator:tester');
    expect(first).toMatchObject({ run: 'run-own', principal: 'operator', actor: 'operator:tester' });
    expect(await s.runs.claim('run-own', 'operator', 'operator:other')).toEqual(first);
    expect(Number.isNaN(Date.parse(first.firstSeen))).toBe(false);
    expect(await s.runs.claim('run-own', 'agent')).toEqual(first);
    expect(await s.runs.claim('run-own', 'operator')).toEqual(first);
    expect(await s.runs.owner('run-own')).toEqual(first);
    // Two first writes racing: one owner, and both are told the same one.
    const raced = await Promise.all([s.runs.claim('run-race', 'browser'), s.runs.claim('run-race', 'owner_token')]);
    expect(raced[0]).toEqual(raced[1]);
    expect(await s.runs.owner('run-race')).toEqual(raced[0]);
    // Cleaning up a run keeps its owner: the run id stays the opener's.
    await s.runs.remove('run-own', []);
    expect(await s.runs.owner('run-own')).toEqual(first);
    // Only an operator run records a name; none given: null (any operator name may use it).
    expect(await s.runs.claim('run-agent', 'agent', 'operator:x')).toMatchObject({ principal: 'agent', actor: null });
    expect(await s.runs.claim('run-anon', 'operator')).toMatchObject({ principal: 'operator', actor: null });
  });
});
