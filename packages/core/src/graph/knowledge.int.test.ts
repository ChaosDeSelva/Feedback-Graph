import { beforeAll, describe, expect, test } from 'vitest';
import type { GraphStore, KnowledgeStore } from '../store.ts';
import { describeStores, type StoreProbe } from '../testing/index.ts';
import type { Classification, ParsedSession, PostMortem, Project } from '../types.ts';
import { MAX_POSTMORTEM_ATTEMPTS } from './knowledge.ts';
import { LESSON_CHECKS_VERSION } from '../types.ts';

const project: Project = { key: 'demo', name: 'demo', repoPath: '/vibe/demo' };
const pushback: Classification = { label: 'pushback', confidence: 0.9, summary: 's', signals: [] };

/** Deterministic unit vector, 768-d, pointing mostly along `axis`. */
const vec = (axis: number, noise = 0) => {
  const v = Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : noise));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

function session(id: string, cwd = '/Users/j/Vibe/demo'): ParsedSession {
  const turns = [0, 1, 2, 3].map((i) => ({
    uuid: `${id}-t${i}`, sessionId: id, ts: `2026-10-01T10:0${i}:00Z`, index: i, text: `turn ${i}`,
    precedingAssistantText: i ? `reply ${i}` : '', precedingToolCalls: i === 2 ? [{ name: 'Read', ts: 't', filePath: '/a.ts' }] : [],
  }));
  return { sessionId: id, sourceFile: 'f', cwd, gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[3].ts, turns, toolCalls: [] };
}

const pm = (over: Partial<PostMortem> = {}): PostMortem => ({
  taskTitle: 'Customer search',
  missed: 'filtering was client-side',
  cause: 'requirement_unstated',
  causeExplanation: 'never stated',
  outcome: 'approved',
  lesson: { title: 'Server-side search', rule: 'Filter on the server', appliesWhen: 'search features', scope: 'project', paths: ['api/**'] },
  contextItems: [
    { kind: 'code', ref: 'api/search.ts', excerpt: 'export function search', why: 'endpoint existed', wasAvailable: true },
    { kind: 'claude_md', ref: 'CLAUDE.md', excerpt: 'server first', why: 'rule existed', wasAvailable: true },
  ],
  ...over,
});

describeStores('KnowledgeStore', (h) => {
  let repo: GraphStore;
  let k: KnowledgeStore;
  let probe: StoreProbe;
  beforeAll(() => {
    repo = h.store.graph;
    k = h.store.knowledge;
    probe = h.probe;
  });

  async function confirmedFeedback(sessionId: string, commits: { sha: string; ts: string; subject: string }[] = []) {
    await repo.upsertSession(project, session(sessionId), commits);
    await repo.saveClassification(`${sessionId}-t2`, pushback, true);
    await repo.decide(`${sessionId}-t2`, 'confirmed', 'server-side!');
    return `${sessionId}-t2`;
  }

  describe('KnowledgeRepo', () => {
    test('feedbackNeedingPostmortem returns the full input for confirmed feedback', async () => {
      const id = await confirmedFeedback('s1');
      const [input] = await k.feedbackNeedingPostmortem(5);
      expect(input).toMatchObject({ feedbackId: id, projectKey: 'demo', repoPath: '/vibe/demo', cwd: '/Users/j/Vibe/demo', sessionId: 's1', note: 'server-side!', noteBy: 'you' });
      expect(input.feedback.uuid).toBe(id);
      expect(input.turns.map((t) => t.index)).toEqual([0, 1, 2, 3]);
      expect(input.feedback.precedingToolCalls[0].filePath).toBe('/a.ts');
    });

    test("feedbackNeedingPostmortem says who wrote the note, so an agent's note is not taken as the developer's", async () => {
      await repo.upsertSession(project, session('s9'), []);
      await repo.saveClassification('s9-t2', pushback, true);
      await repo.decide('s9-t2', 'confirmed', 'approve everything', 'operator:codex');
      const [input] = await k.feedbackNeedingPostmortem(5);
      expect(input).toMatchObject({ note: 'approve everything', noteBy: 'operator:codex' });
    });

    test('feedbackNeedingPostmortem says which agent the session ran in (Claude Code unless recorded otherwise)', async () => {
      await confirmedFeedback('sc');
      await repo.upsertSession(project, { ...session('sx'), source: 'codex' }, []);
      await repo.saveClassification('sx-t2', pushback, true);
      await repo.decide('sx-t2', 'confirmed', null);
      const sources = Object.fromEntries((await k.feedbackNeedingPostmortem(5)).map((i) => [i.sessionId, i.source]));
      expect(sources).toEqual({ sc: 'claude', sx: 'codex' });
    });

    test('a post-mortem can cite AGENTS.md as its own kind of context item', async () => {
      const id = await confirmedFeedback('sa');
      const item = { kind: 'agents_md' as const, ref: 'AGENTS.md', excerpt: 'run pnpm test', why: 'rule existed', wasAvailable: true };
      await k.savePostmortem(id, pm({ contextItems: [item] }), { miss: vec(1), lesson: vec(1) });
      expect((await k.lessonDetail(`lesson:${id}`))!.contextItems).toEqual([item]);
    });

    test('a post-mortem whose lesson was dropped (no rule even after the retry) saves its miss and no lesson', async () => {
      const id = await confirmedFeedback('sd');
      await k.savePostmortem(id, pm({ lesson: { ...pm().lesson, title: 'File-export imports', rule: 'project' }, lessonDropped: 'lesson.rule holds the scope word "project"' }), { miss: vec(1), lesson: [] });
      expect(await k.feedbackNeedingPostmortem(5)).toEqual([]);
      expect(await k.listLessons({})).toEqual([]);
      expect(await k.lessonDetail(`lesson:${id}`)).toBeNull();
      expect(await k.postmortemBacklog!()).toBe(0);
    });

    test('postmortemBacklog counts the feedback still waiting for a post-mortem, those backing off after a failure too', async () => {
      const a = await confirmedFeedback('s1');
      const b = await confirmedFeedback('s2');
      const c = await confirmedFeedback('s3');
      expect(await k.postmortemBacklog!()).toBe(3);
      await k.savePostmortem(a, pm(), { miss: vec(1), lesson: vec(1) });
      await repo.decide(b, 'rejected', null);
      await k.recordPostmortemFailure(c, 'boom');
      expect(await k.postmortemBacklog!()).toBe(1);
      for (let i = 1; i < MAX_POSTMORTEM_ATTEMPTS; i++) await k.recordPostmortemFailure(c, 'boom');
      expect(await k.postmortemBacklog!()).toBe(0); // given up on
    });

    test('postmortemQueue says how many wait and since when the oldest has', async () => {
      expect(await k.postmortemQueue!()).toEqual({ waiting: 0, oldestAt: null });
      const started = new Date(Date.now() - 1000).toISOString();
      const a = await confirmedFeedback('s1');
      await confirmedFeedback('s2');
      const q = await k.postmortemQueue!();
      expect(q.waiting).toBe(2);
      expect(q.oldestAt! >= started && q.oldestAt! <= new Date().toISOString()).toBe(true);
      await k.savePostmortem(a, pm(), { miss: vec(1), lesson: vec(1) });
      expect((await k.postmortemQueue!()).waiting).toBe(1);
    });

    test('feedback you reject after confirming gets no post-mortem', async () => {
      const id = await confirmedFeedback('s1');
      await repo.decide(id, 'rejected', 'changed my mind');
      expect(await k.feedbackNeedingPostmortem(5)).toEqual([]);
    });

    test('rejecting after the post-mortem withdraws its proposed lesson but keeps one you approved', async () => {
      const a = await confirmedFeedback('s1');
      const b = await confirmedFeedback('s2');
      await k.savePostmortem(a, pm(), { miss: vec(1), lesson: vec(1) });
      await k.savePostmortem(b, pm({ lesson: { ...pm().lesson, title: 'Kept' } }), { miss: vec(2), lesson: vec(2) });
      const kept = (await k.listLessons({})).find((l) => l.title === 'Kept')!;
      await k.updateLesson(kept.id, { status: 'approved' }, {});
      await repo.decide(a, 'rejected', null);
      await repo.decide(b, 'rejected', null);
      const byTitle = Object.fromEntries((await k.listLessons({})).map((l) => [l.title, l.status]));
      expect(byTitle).toEqual({ 'Server-side search': 'rejected', Kept: 'approved' });
    });

    test('failures are retried up to MAX_POSTMORTEM_ATTEMPTS times then skipped', async () => {
      const id = await confirmedFeedback('s1');
      for (let i = 0; i < MAX_POSTMORTEM_ATTEMPTS; i++) await k.recordPostmortemFailure(id, 'boom');
      expect(await k.feedbackNeedingPostmortem(5, new Date('2100-01-01'))).toEqual([]);
    });

    test('savePostmortem writes the evidence chain and a proposed lesson', async () => {
      const id = await confirmedFeedback('s1', [
        { sha: 'b'.repeat(40), ts: '2026-10-01T10:00:30Z', subject: 'before' },
        { sha: 'c'.repeat(40), ts: '2026-10-01T10:02:30Z', subject: 'fix search' },
      ]);
      await k.savePostmortem(id, pm(), { miss: vec(1), lesson: vec(1) });
      expect(await k.feedbackNeedingPostmortem(5)).toEqual([]);
      const [lesson] = await k.listLessons({ status: 'proposed' });
      expect(lesson).toMatchObject({ title: 'Server-side search', scope: 'project', projectKey: 'demo', status: 'proposed', source: 'postmortem', cause: 'requirement_unstated' });
      const d = await k.lessonDetail(lesson.id);
      expect(d?.miss?.missed).toBe('filtering was client-side');
      expect(d?.feedback?.text).toBe('turn 2');
      expect(d?.feedback?.status).toBe('approved');
      expect(d?.contextItems.map((c) => c.ref).sort()).toEqual(['CLAUDE.md', 'api/search.ts']);
      expect(d?.contextItems.every((c) => c.wasAvailable)).toBe(true);
      expect(d?.fixCommits.map((c) => c.subject)).toEqual(['fix search']);
    });

    test('fix commits are found by real time, whatever time zone the committer was in', async () => {
      const id = await confirmedFeedback('s1', [
        { sha: 'd'.repeat(40), ts: '2026-10-01T03:01:00-07:00', subject: 'before (10:01Z)' },
        { sha: 'e'.repeat(40), ts: '2026-10-01T04:05:00-07:00', subject: 'after (11:05Z)' },
      ]);
      await k.savePostmortem(id, pm(), { miss: vec(1), lesson: vec(1) });
      const [lesson] = await k.listLessons({});
      expect((await k.lessonDetail(lesson.id))?.fixCommits.map((c) => c.subject)).toEqual(['after (11:05Z)']);
    });

    test('a lesson cannot supersede itself or a lesson that does not exist', async () => {
      const id = await confirmedFeedback('s1');
      await k.savePostmortem(id, pm(), { miss: vec(1), lesson: vec(1) });
      const [l] = await k.listLessons({});
      await expect(k.updateLesson(l.id, { status: 'approved', supersedes: l.id }, {})).rejects.toThrow(/itself/);
      await expect(k.updateLesson(l.id, { status: 'approved', supersedes: 'lesson:nope' }, {})).rejects.toThrow(/no lesson/);
      expect((await k.lessonDetail(l.id))?.lesson.status).toBe('proposed');
    });

    test('the task of a pre-done check is stored redacted', async () => {
      await k.recordPreDoneCheck({ projectKey: 'demo', task: 'deploy with ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', checkedLessonIds: [], gapLessonIds: [] });
      const [check] = await probe.preDoneChecks();
      expect(check.task).not.toContain('ghp_');
    });

    test('the lesson checks are stored with the lesson; a re-check replaces them; a lesson never checked reads null', async () => {
      const id = await confirmedFeedback('s1');
      await k.savePostmortem(id, pm(), { miss: vec(1), lesson: vec(1) });
      const [unchecked] = await k.listLessons({});
      expect(unchecked.checks ?? null).toBeNull();
      // Built at runtime: no token-shaped literal in the source.
      const secret = ['ghp', 'A'.repeat(36)].join('_');
      await k.savePostmortem(id, pm({ lessonChecks: [{ name: 'needs-path', why: `no file token ${secret}` }] }), { miss: vec(1), lesson: vec(1) });
      const [checked] = await k.listLessons({});
      expect(checked.checks?.map((c) => c.name)).toEqual(['needs-path']);
      expect(checked.checks?.[0].why).not.toContain('ghp_');
      expect(await k.setLessonChecks(checked.id, [])).toBe(true);
      expect((await k.lessonDetail(checked.id))?.lesson.checks).toEqual([]);
      expect(await k.setLessonChecks(checked.id, [{ name: 'meta-lesson', why: 'about feedback' }])).toBe(true);
      expect((await k.listLessons({}))[0].checks).toEqual([{ name: 'meta-lesson', why: 'about feedback' }]);
      expect(await k.setLessonChecks('lesson:nope', [])).toBe(false);
    });

    test('the checks version is stored; stale lessons are listed until re-checked; a recheck request makes them stale again', async () => {
      const a = await confirmedFeedback('s1');
      const b = await confirmedFeedback('s2');
      await k.savePostmortem(a, pm(), { miss: vec(1), lesson: vec(1) });
      await k.savePostmortem(b, pm({ lessonChecks: [] }), { miss: vec(2), lesson: vec(2) });
      const byId = async () => new Map((await k.listLessons({})).map((l) => [l.id, l]));
      // Never checked: no version. Checked by the post-mortem: the current version.
      expect((await byId()).get(`lesson:${a}`)?.checksVersion ?? null).toBeNull();
      expect((await byId()).get(`lesson:${b}`)?.checksVersion).toBe(LESSON_CHECKS_VERSION);
      expect((await k.staleLessonChecks!(LESSON_CHECKS_VERSION, 10)).map((l) => l.id)).toEqual([`lesson:${a}`]);
      expect(await k.setLessonChecks(`lesson:${a}`, [{ name: 'duplicate-of', why: 'repeats', of: `lesson:${b}` }])).toBe(true);
      expect((await byId()).get(`lesson:${a}`)).toMatchObject({ checksVersion: LESSON_CHECKS_VERSION, checks: [{ name: 'duplicate-of', why: 'repeats', of: `lesson:${b}` }] });
      expect(await k.staleLessonChecks!(LESSON_CHECKS_VERSION, 10)).toEqual([]);
      // An older version is stale under a newer one; rejected lessons never are.
      expect(await k.setLessonChecks(`lesson:${b}`, [], 1)).toBe(true);
      expect((await k.staleLessonChecks!(LESSON_CHECKS_VERSION, 10)).map((l) => l.id)).toEqual([`lesson:${b}`]);
      await k.updateLesson(`lesson:${b}`, { status: 'rejected' }, {});
      expect(await k.staleLessonChecks!(LESSON_CHECKS_VERSION, 10)).toEqual([]);
      expect(await k.requestLessonRecheck!()).toBe(1);
      expect((await k.staleLessonChecks!(LESSON_CHECKS_VERSION, 10)).map((l) => l.id)).toEqual([`lesson:${a}`]);
    });

    test('listLessons filters by a check flag and by where the feedback came from', async () => {
      const a = await confirmedFeedback('s1');
      await k.savePostmortem(a, pm({ lessonChecks: [{ name: 'platitude', why: 'vague' }, { name: 'needs-path', why: 'none' }] }), { miss: vec(1), lesson: vec(1) });
      await k.upsertLesson({ id: 'memory:x', projectKey: 'demo', title: 'M', rule: 'Use the gateway', appliesWhen: '', scope: 'project', paths: [], status: 'proposed', source: 'memory', embedding: vec(3) });
      const ids = async (f: Parameters<KnowledgeStore['listLessons']>[0]) => (await k.listLessons(f)).map((l) => l.id).sort();
      expect(await ids({ flag: 'platitude' })).toEqual([`lesson:${a}`]);
      expect(await ids({ flag: 'needs-path' })).toEqual([`lesson:${a}`]);
      expect(await ids({ flag: 'meta-lesson' })).toEqual([]);
      expect(await ids({ from: 'session' })).toEqual([`lesson:${a}`]);
      expect(await ids({ from: 'memory' })).toEqual(['memory:x']);
      expect(await ids({ from: 'github' })).toEqual([]);
      expect((await k.listLessons({})).find((l) => l.id === `lesson:${a}`)?.from).toBe('session');
    });

    test('similarLessons returns the nearest lessons of the same project by stored embedding, as a true cosine', async () => {
      const a = await confirmedFeedback('s1');
      const b = await confirmedFeedback('s2');
      const c = await confirmedFeedback('s3');
      await k.savePostmortem(a, pm(), { miss: vec(1), lesson: vec(1) });
      await k.savePostmortem(b, pm(), { miss: vec(1), lesson: vec(1, 0.001) });
      await k.savePostmortem(c, pm(), { miss: vec(5), lesson: vec(5) });
      await k.upsertLesson({ id: 'memory:other', projectKey: 'elsewhere', title: 'M', rule: 'r', appliesWhen: '', scope: 'project', paths: [], status: 'proposed', source: 'memory', embedding: vec(1) });
      const near = await k.similarLessons!(`lesson:${a}`, 5);
      expect(near[0]).toMatchObject({ id: `lesson:${b}`, status: 'proposed' });
      expect(near[0].cosine).toBeGreaterThan(0.92);
      expect(near.find((n) => n.id === `lesson:${c}`)!.cosine).toBeLessThan(0.1);
      expect(near.map((n) => n.id)).not.toContain('memory:other');
      expect(near.map((n) => n.id)).not.toContain(`lesson:${a}`);
      expect(await k.similarLessons!('lesson:nope', 5)).toEqual([]);
    });

    test('a global lesson has no project', async () => {
      const id = await confirmedFeedback('s1');
      await k.savePostmortem(id, pm({ lesson: { ...pm().lesson, scope: 'global' } }), { miss: vec(1), lesson: vec(1) });
      const [lesson] = await k.listLessons({});
      expect(lesson.projectKey).toBeNull();
    });

    test('updateLesson approves, edits, and supersedes', async () => {
      const a = await confirmedFeedback('s1');
      const b = await confirmedFeedback('s2');
      await k.savePostmortem(a, pm(), { miss: vec(1), lesson: vec(1) });
      await k.savePostmortem(b, pm({ lesson: { ...pm().lesson, title: 'Newer' } }), { miss: vec(2), lesson: vec(2) });
      const [la, lb] = (await k.listLessons({})).sort((x, y) => x.title.localeCompare(y.title));
      expect(lb.title).toBe('Server-side search');
      await k.updateLesson(lb.id, { status: 'approved', rule: 'Edited rule' }, { reembed: vec(1) });
      await k.updateLesson(la.id, { status: 'approved', supersedes: lb.id }, {});
      expect((await k.lessonDetail(lb.id))?.lesson).toMatchObject({ status: 'superseded', rule: 'Edited rule' });
      expect((await k.lessonDetail(la.id))?.lesson.status).toBe('approved');
      expect((await k.lessonDetail(la.id))?.supersedes).toEqual([lb.id]);
    });

    test('updateLesson keeps a note on the decision, cleared by the next decision without one', async () => {
      const a = await confirmedFeedback('s1');
      await k.savePostmortem(a, pm(), { miss: vec(1), lesson: vec(1) });
      const [l] = await k.listLessons({});
      expect(l.decisionNote ?? null).toBeNull();
      await k.updateLesson(l.id, { status: 'rejected' }, { by: 'you', note: 'converted to a fact' });
      expect((await k.lessonDetail(l.id))?.lesson).toMatchObject({ status: 'rejected', decisionNote: 'converted to a fact' });
      expect((await k.listLessons({ status: 'rejected' }))[0].decisionNote).toBe('converted to a fact');
      // An edit that decides nothing keeps it; the next decision without a note clears it.
      await k.updateLesson(l.id, { rule: 'Reworded' }, {});
      expect((await k.lessonDetail(l.id))?.lesson.decisionNote).toBe('converted to a fact');
      await k.updateLesson(l.id, { status: 'proposed' }, {});
      expect((await k.lessonDetail(l.id))?.lesson.decisionNote ?? null).toBeNull();
    });

    test('updateLesson records who decided: an agent with the operator token, until you decide again', async () => {
      const a = await confirmedFeedback('s1');
      await k.savePostmortem(a, pm(), { miss: vec(1), lesson: vec(1) });
      const [l] = await k.listLessons({});
      expect(l.decidedBy ?? null).toBeNull();
      await k.updateLesson(l.id, { status: 'approved' }, { by: 'operator:codex' });
      expect((await k.lessonDetail(l.id))?.lesson.decidedBy).toBe('operator:codex');
      expect((await k.listLessons({ status: 'approved' }))[0].decidedBy).toBe('operator:codex');
      // An edit that decides nothing leaves it; your own decision replaces it.
      await k.updateLesson(l.id, { rule: 'Reworded' }, { by: 'you' });
      expect((await k.lessonDetail(l.id))?.lesson.decidedBy).toBe('operator:codex');
      await k.updateLesson(l.id, { status: 'approved' }, { by: 'you' });
      expect((await k.lessonDetail(l.id))?.lesson.decidedBy).toBe('you');
      // No `by` (older callers): the owner.
      await k.updateLesson(l.id, { status: 'rejected' }, {});
      expect((await k.lessonDetail(l.id))?.lesson.decidedBy).toBe('you');
    });

    test('the first edit of a proposed lesson keeps what the writer proposed, redacted; later edits and decisions keep it', async () => {
      const a = await confirmedFeedback('s1');
      await k.savePostmortem(a, pm(), { miss: vec(1), lesson: vec(1) });
      const [l] = await k.listLessons({});
      expect(l.proposedAs ?? null).toBeNull();
      // Deciding without an edit keeps nothing.
      await k.updateLesson(l.id, { status: 'proposed' }, {});
      expect((await k.lessonDetail(l.id))?.lesson.proposedAs ?? null).toBeNull();
      await k.updateLesson(l.id, { rule: 'Filter in api/search.ts on the server', paths: ['api/search.ts'] }, { by: 'you' });
      const writer = { title: 'Server-side search', rule: 'Filter on the server', appliesWhen: 'search features', scope: 'project', paths: ['api/**'] };
      expect((await k.lessonDetail(l.id))?.lesson.proposedAs).toEqual(writer);
      await k.updateLesson(l.id, { status: 'approved', title: 'Search runs on the server' }, {});
      const after = (await k.lessonDetail(l.id))!.lesson;
      expect(after).toMatchObject({ status: 'approved', title: 'Search runs on the server', proposedAs: writer });
      expect((await k.listLessons({ status: 'approved' }))[0].proposedAs).toEqual(writer);

      const b = await confirmedFeedback('s2');
      const secret = 'x'.repeat(8);
      await k.savePostmortem(b, pm({ lesson: { ...pm().lesson, rule: `Set API_KEY=${secret}${secret}${secret} in api/env.ts` } }), { miss: vec(2), lesson: vec(2) });
      const lb = (await k.listLessons({ status: 'proposed' }))[0];
      await k.updateLesson(lb.id, { rule: 'Read the key from the environment in api/env.ts' }, {});
      expect((await k.lessonDetail(lb.id))?.lesson.proposedAs?.rule).toBe(lb.rule);
    });

    test('decidedLessons: the owner decisions on post-mortem lessons of these projects, newest first, never a sandbox run, with a score', async () => {
      const a = await confirmedFeedback('s1');
      const b = await confirmedFeedback('s2');
      const c = await confirmedFeedback('s3');
      const d = await confirmedFeedback('s4');
      await k.savePostmortem(a, pm(), { miss: vec(1), lesson: vec(1) });
      await k.savePostmortem(b, pm({ lesson: { ...pm().lesson, title: 'B' } }), { miss: vec(2), lesson: vec(2) });
      await k.savePostmortem(c, pm({ lesson: { ...pm().lesson, title: 'C' } }), { miss: vec(3), lesson: vec(3) });
      await k.savePostmortem(d, pm({ lesson: { ...pm().lesson, title: 'D' } }), { miss: vec(4), lesson: vec(4) });
      await k.updateLesson(`lesson:${a}`, { status: 'approved' }, {});
      await k.updateLesson(`lesson:${b}`, { rule: 'Owner wording' }, {});
      await k.updateLesson(`lesson:${b}`, { status: 'approved' }, {});
      await k.updateLesson(`lesson:${c}`, { status: 'rejected' }, { note: 'meta rule' });
      // d stays proposed; a memory lesson the owner approved is not the writer's.
      await k.upsertLesson({ id: 'memory:m', projectKey: 'demo', title: 'M', rule: 'r', appliesWhen: '', scope: 'project', paths: [], status: 'proposed', source: 'memory', embedding: vec(1) });
      await k.updateLesson('memory:m', { status: 'approved' }, {});
      const got = await k.decidedLessons!({ projectKeys: ['demo'], since: '2000-01-01T00:00:00.000Z', limit: 10, embedding: vec(3) });
      expect(got.map((g) => g.lesson.id)).toEqual([`lesson:${c}`, `lesson:${b}`, `lesson:${a}`]);
      expect(got[0].lesson).toMatchObject({ status: 'rejected', decisionNote: 'meta rule' });
      expect(got[1].lesson.proposedAs?.rule).toBe('Filter on the server');
      expect(got[0].score).toBeGreaterThan(0.99);
      expect(got[2].score).toBeLessThan(0.01);
      expect((await k.decidedLessons!({ projectKeys: ['demo'], since: '2000-01-01T00:00:00.000Z', limit: 1 }))[0]).toEqual({ lesson: expect.objectContaining({ id: `lesson:${c}` }), score: null });
      expect(await k.decidedLessons!({ projectKeys: ['elsewhere'], since: '2000-01-01T00:00:00.000Z', limit: 10 })).toEqual([]);
      expect(await k.decidedLessons!({ projectKeys: ['demo'], since: '2999-01-01T00:00:00.000Z', limit: 10 })).toEqual([]);
      expect((await k.decidedLessons!({ projectKeys: null, since: '2000-01-01T00:00:00.000Z', limit: 10 })).length).toBe(3);
      // A sandbox run's lesson never teaches the writer.
      const sbx = await k.createManualFeedback({ project, cwd: '/vibe/demo', text: 'sandbox miss', whatWasDone: 'x', run: { id: 'sbx-1', sandbox: true } });
      await repo.decide(sbx, 'confirmed', null);
      await k.savePostmortem(sbx, pm(), { miss: vec(5), lesson: vec(5) });
      await k.updateLesson(`lesson:${sbx}`, { status: 'rejected' }, { note: 'tester' });
      expect((await k.decidedLessons!({ projectKeys: ['demo'], since: '2000-01-01T00:00:00.000Z', limit: 10 })).map((g) => g.lesson.id)).not.toContain(`lesson:${sbx}`);
    });

    test("a machine's decision (no miss, the session re-match) is not the owner's: decidedLessons leaves it out, an operator's counts", async () => {
      const a = await confirmedFeedback('s1');
      const b = await confirmedFeedback('s2');
      const c = await confirmedFeedback('s3');
      for (const id of [a, b, c]) await k.savePostmortem(id, pm(), { miss: vec(1), lesson: vec(1) });
      await k.updateLesson(`lesson:${a}`, { status: 'rejected' }, { by: 'postmortem', note: 'no miss' });
      await k.updateLesson(`lesson:${b}`, { status: 'rejected' }, { by: 'operator:codex' });
      await new Promise((r) => setTimeout(r, 5));
      await k.updateLesson(`lesson:${c}`, { status: 'approved' }, { by: 'you' });
      expect((await k.lessonDetail(`lesson:${a}`))!.lesson).toMatchObject({ status: 'rejected', decidedBy: 'postmortem' });
      const got = await k.decidedLessons!({ projectKeys: ['demo'], since: '2000-01-01T00:00:00.000Z', limit: 10 });
      expect(got.map((g) => g.lesson.id)).toEqual([`lesson:${c}`, `lesson:${b}`]);
      // Nor do machine decisions take the limit's room: the one owner decision is still found with limit 1.
      await k.updateLesson(`lesson:${a}`, { status: 'rejected' }, { by: 'session-match' });
      expect((await k.decidedLessons!({ projectKeys: ['demo'], since: '2000-01-01T00:00:00.000Z', limit: 1 })).map((g) => g.lesson.id)).toEqual([`lesson:${c}`]);
    });

    test("a machine's decision does not mark the lesson yours: its memory file still updates it", async () => {
      const mem = (rule: string) => ({ id: 'memory:m.md', projectKey: 'demo', title: 'T', rule, appliesWhen: 'w', scope: 'project' as const, paths: [], status: 'proposed' as const, source: 'memory' as const, embedding: vec(2) });
      await k.upsertLesson(mem('v1'));
      await k.updateLesson('memory:m.md', { status: 'rejected' }, { by: 'postmortem' });
      await k.upsertLesson(mem('v2'));
      expect((await k.lessonDetail('memory:m.md'))!.lesson).toMatchObject({ rule: 'v2', status: 'rejected' });
    });

    test('clearMachineOwnerMarks: a lesson an older rule marked yours for a machine decision loses the mark, once; owner-decided or edited ones keep it', async () => {
      const mem = (id: string, rule: string) => ({ id, projectKey: 'demo', title: 'T', rule, appliesWhen: 'w', scope: 'project' as const, paths: [], status: 'proposed' as const, source: 'memory' as const, embedding: vec(2) });
      await k.upsertLesson(mem('memory:machine.md', 'v1'));
      await k.updateLesson('memory:machine.md', { status: 'rejected' }, { by: 'postmortem' });
      await probe.seedOwnerMark('memory:machine.md');
      await k.upsertLesson(mem('memory:yours.md', 'v1'));
      await k.updateLesson('memory:yours.md', { status: 'rejected' }, { by: 'you' });
      await k.upsertLesson(mem('memory:operator.md', 'v1'));
      await k.updateLesson('memory:operator.md', { status: 'rejected' }, { by: 'operator:codex' });
      // Edited by the owner while proposed, then rejected by a machine: the edit is the owner's, the mark stays.
      const a = await confirmedFeedback('s1');
      await k.savePostmortem(a, pm(), { miss: vec(1), lesson: vec(1) });
      await k.updateLesson(`lesson:${a}`, { rule: 'Owner words' }, { by: 'you' });
      await k.updateLesson(`lesson:${a}`, { status: 'rejected' }, { by: 'postmortem' });
      expect(await k.clearMachineOwnerMarks!()).toEqual(['memory:machine.md']);
      expect(await k.clearMachineOwnerMarks!()).toEqual([]);
      for (const id of ['memory:machine.md', 'memory:yours.md', 'memory:operator.md']) await k.upsertLesson(mem(id, 'v2'));
      const rule = async (id: string) => (await k.lessonDetail(id))!.lesson.rule;
      expect(await rule('memory:machine.md')).toBe('v2');
      expect(await rule('memory:yours.md')).toBe('v1');
      expect(await rule('memory:operator.md')).toBe('v1');
    });

    test("a re-saved post-mortem never overwrites the owner's edit: the edited lesson keeps its words and the draft they edited", async () => {
      const a = await confirmedFeedback('s1');
      const b = await confirmedFeedback('s2');
      await k.savePostmortem(a, pm(), { miss: vec(1), lesson: vec(1) });
      await k.savePostmortem(b, pm(), { miss: vec(1), lesson: vec(1) });
      await k.updateLesson(`lesson:${a}`, { rule: 'Filter in api/search.ts on the server', paths: ['api/search.ts'] }, { by: 'you' });
      const writer = { title: 'Server-side search', rule: 'Filter on the server', appliesWhen: 'search features', scope: 'project', paths: ['api/**'] };
      const again = pm({ lesson: { title: 'Search on the server, v2', rule: 'Push filters down', appliesWhen: 'lists', scope: 'project', paths: ['api/list.ts'] } });
      await k.savePostmortem(a, again, { miss: vec(3), lesson: vec(3) });
      await k.savePostmortem(b, again, { miss: vec(3), lesson: vec(3) });
      expect((await k.lessonDetail(`lesson:${a}`))!.lesson).toMatchObject({
        status: 'proposed', title: 'Server-side search', rule: 'Filter in api/search.ts on the server', paths: ['api/search.ts'], proposedAs: writer,
      });
      // Not edited by the owner: the re-save rewrites it, and there is no earlier draft to compare an approval against.
      const lb = (await k.lessonDetail(`lesson:${b}`))!.lesson;
      expect(lb).toMatchObject({ title: 'Search on the server, v2', rule: 'Push filters down', paths: ['api/list.ts'] });
      expect(lb.proposedAs ?? null).toBeNull();
    });

    test("setLessonPaths leaves a proposed lesson the owner edited alone: its paths are the owner's", async () => {
      const a = await confirmedFeedback('s1');
      await k.savePostmortem(a, pm(), { miss: vec(1), lesson: vec(1) });
      await k.updateLesson(`lesson:${a}`, { paths: ['api/new-file.ts'] }, { by: 'you' });
      expect(await k.setLessonPaths!(`lesson:${a}`, [])).toBe(false);
      expect((await k.lessonDetail(`lesson:${a}`))!.lesson.paths).toEqual(['api/new-file.ts']);
    });

    test('searchLessons returns approved lessons for the project and global ones, nearest first', async () => {
      const a = await confirmedFeedback('s1');
      const b = await confirmedFeedback('s2');
      const c = await confirmedFeedback('s3');
      await k.savePostmortem(a, pm({ lesson: { ...pm().lesson, title: 'near' } }), { miss: vec(1), lesson: vec(1) });
      await k.savePostmortem(b, pm({ lesson: { ...pm().lesson, title: 'far', scope: 'global' } }), { miss: vec(5), lesson: vec(5, 0.01) });
      await k.savePostmortem(c, pm({ lesson: { ...pm().lesson, title: 'unapproved' } }), { miss: vec(1), lesson: vec(1) });
      for (const l of await k.listLessons({})) if (l.title !== 'unapproved') await k.updateLesson(l.id, { status: 'approved' }, {});
      const hits = await k.searchLessons({ embedding: vec(1), projectKey: 'demo', k: 5 });
      expect(hits.map((h) => h.lesson.title)).toEqual(['near', 'far']);
      expect(hits[0].score).toBeGreaterThan(hits[1].score);
      expect(await k.searchLessons({ embedding: vec(1), projectKey: 'other', k: 5 })).toHaveLength(1);
    });

    test('relatedMisses finds similar past misses in the project with their feedback', async () => {
      const a = await confirmedFeedback('s1');
      await k.savePostmortem(a, pm(), { miss: vec(3), lesson: vec(3) });
      const [m] = await k.relatedMisses({ embedding: vec(3), projectKey: 'demo', k: 3 });
      expect(m.missed).toBe('filtering was client-side');
      expect(m.feedbackText).toBe('turn 2');
      expect(m.sessionId).toBe('s1');
    });

    test('relatedMisses marks a miss whose lesson you rejected as worked out from the wrong session', async () => {
      const a = await confirmedFeedback('s1');
      await k.savePostmortem(a, pm({ lessonChecks: [{ name: 'wrong-session', why: 'the matched session did other work' }] }), { miss: vec(3), lesson: vec(3) });
      const b = await confirmedFeedback('s2');
      await k.savePostmortem(b, pm({ lessonChecks: [{ name: 'wrong-session', why: 'x' }] }), { miss: vec(3), lesson: vec(3) });
      await k.updateLesson(`lesson:${a}`, { status: 'rejected' }, {});
      const misses = await k.relatedMisses({ embedding: vec(3), projectKey: 'demo', k: 5 });
      // Rejected with the check: marked. Flagged but still proposed: not (the owner has not said so).
      expect(Object.fromEntries(misses.map((m) => [m.missId, m.rejectedWrongSession]))).toEqual({ [`miss:${a}`]: true, [`miss:${b}`]: false });
    });

    test('missesWithoutSubject pages the misses with no subject, with their feedback, lesson rule and comment file', async () => {
      const a = await confirmedFeedback('s1');
      await k.savePostmortem(a, pm({ lesson: { ...pm().lesson, rule: 'Keep work on its own branch' } }), { miss: vec(1), lesson: vec(1) });
      const b = await confirmedFeedback('s2');
      await k.savePostmortem(b, pm({ subject: 'process' }), { miss: vec(1), lesson: vec(1) });
      const c = await confirmedFeedback('s3');
      await k.savePostmortem(c, pm(), { miss: vec(1), lesson: vec(1) });
      const first = await k.missesWithoutSubject({ limit: 1 });
      expect(first).toEqual([{ missId: `miss:${a}`, projectKey: 'demo', feedbackText: 'turn 2', rule: 'Keep work on its own branch', commentPath: null, paths: ['api/**'] }]);
      // b already has a subject; the next page starts after a.
      expect((await k.missesWithoutSubject({ limit: 10, afterId: first[0].missId })).map((m) => m.missId)).toEqual([`miss:${c}`]);
      // processMisses pages the others the same way.
      expect(await k.processMisses({ limit: 10 })).toEqual([expect.objectContaining({ missId: `miss:${b}`, projectKey: 'demo', rule: 'Filter on the server', paths: ['api/**'] })]);
      expect(await k.processMisses({ limit: 10, afterId: `miss:${b}` })).toEqual([]);
    });

    test('a miss can be code_not_read, and the lesson carries that cause', async () => {
      const id = await confirmedFeedback('s1');
      await k.savePostmortem(id, pm({ cause: 'code_not_read' }), { miss: vec(1), lesson: vec(1) });
      expect((await k.listLessons({ status: 'proposed' }))[0].cause).toBe('code_not_read');
    });

    test('a flagged turn nobody confirmed gets no post-mortem, no miss and no lesson', async () => {
      await repo.upsertSession(project, session('s1'), []);
      await repo.saveClassification('s1-t2', pushback, true);
      expect(await k.feedbackNeedingPostmortem(5)).toEqual([]);
      expect(await k.listLessons({})).toEqual([]);
      expect(await probe.count('Miss')).toBe(0);
    });

    test('createManualFeedback queues a pending candidate; only your confirmation starts a post-mortem', async () => {
      const id = await k.createManualFeedback({ project, cwd: '/Users/j/Vibe/demo', text: 'you missed auth checks', whatWasDone: 'added /api/orders' });
      expect((await repo.listCandidates({ status: 'pending' }))[0].id).toBe(id);
      expect(await k.feedbackNeedingPostmortem(5)).toEqual([]);
      await repo.decide(id, 'confirmed', null);
      const [input] = await k.feedbackNeedingPostmortem(5);
      expect(input.feedbackId).toBe(id);
      expect(input.feedback.text).toBe('you missed auth checks');
      expect(input.feedback.precedingAssistantText).toBe('added /api/orders');
      expect((await repo.listCandidates({ status: 'confirmed' }))[0].id).toBe(id);
      expect((await repo.listCandidates({ status: 'confirmed' }))[0]).toMatchObject({
        origins: ['agent'],
        agentReport: { text: 'you missed auth checks', whatWasDone: 'added /api/orders', sessionId: null },
      });
    });

    test('recordPreDoneCheck stores which lessons were checked and which were gaps', async () => {
      const a = await confirmedFeedback('s1');
      await k.savePostmortem(a, pm(), { miss: vec(1), lesson: vec(1) });
      const [l] = await k.listLessons({});
      await k.recordPreDoneCheck({ projectKey: 'demo', task: 't', checkedLessonIds: [l.id], gapLessonIds: [l.id] });
      const [check] = await probe.preDoneChecks();
      expect(check.gaps).toBe(1);
      expect(check.lessons).toEqual([{ lessonId: l.id, gap: true }]);
    });
  });

  describe('one miss reported twice (detector and report_feedback) is one Inbox item', () => {
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    /** A session whose turn 2 (`<id>-t2`), a few minutes ago, says `words`. */
    function liveSession(id: string, words: string, key = project): Promise<void> {
      const turns = [0, 1, 2, 3].map((i) => ({
        uuid: `${id}-t${i}`, sessionId: id, ts: ago(10 - i), index: i, text: i === 2 ? words : `turn ${i}`,
        precedingAssistantText: i ? `reply ${i}` : '', precedingToolCalls: [],
      }));
      return repo.upsertSession(key, { sessionId: id, sourceFile: 'f', cwd: '/Users/j/Vibe/demo', gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[3].ts, turns, toolCalls: [] }, []);
    }
    const report = (text: string, sessionId?: string) => k.createManualFeedback({ project, cwd: '/Users/j/Vibe/demo', text, whatWasDone: 'added the login page', sessionId });

    test('the detector flagged it first: the report is added to that item', async () => {
      await liveSession('d1', 'still broken, the login page 500s');
      // The Inbox item the turn is filed under, for the worker's activity entry.
      expect(await repo.saveClassification('d1-t2', pushback, true)).toBe('d1-t2');
      const id = await report('This is still broken: the login page 500s');
      expect(id).toBe('d1-t2');
      const all = await repo.listCandidates({});
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: 'd1-t2', turnUuid: 'd1-t2', sessionId: 'd1', origins: ['detector', 'agent'] });
      expect(all[0].agentReport).toMatchObject({ text: 'This is still broken: the login page 500s', whatWasDone: 'added the login page' });
    });

    test('the agent reported it first: the detector moves that item onto the real turn, keeping the report', async () => {
      const id = await report('This is still broken: the login page 500s', 'd2');
      await liveSession('d2', 'still broken, the login page 500s');
      // Merged: the item keeps the report's id, and that is the id the activity entry must point at.
      expect(await repo.saveClassification('d2-t2', pushback, true)).toBe(id);
      const all = await repo.listCandidates({});
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id, turnUuid: 'd2-t2', sessionId: 'd2', status: 'pending', origins: ['detector', 'agent'] });
      expect(all[0].agentReport).toMatchObject({ text: 'This is still broken: the login page 500s', whatWasDone: 'added the login page', sessionId: 'd2' });
      const detail = (await repo.candidateDetail(id))!;
      expect(detail.turn.text).toBe('still broken, the login page 500s');
      expect(detail.before.map((t) => t.index)).toEqual([0, 1]);
      // The report's stand-in session is gone; its words live on in agentReport.
      expect(await probe.count('Session')).toBe(1);
      expect(await probe.count('Turn')).toBe(4);
      // The post-mortem then sees the whole session, not just the report.
      await repo.decide(id, 'confirmed', null);
      const [input] = await k.feedbackNeedingPostmortem(5);
      expect(input).toMatchObject({ feedbackId: id, sessionId: 'd2' });
      expect(input.turns).toHaveLength(4);
    });

    test('a report you already confirmed stays as it is; the detector only adds itself as a second source', async () => {
      const id = await report('This is still broken: the login page 500s');
      await repo.decide(id, 'confirmed', null);
      await liveSession('d3', 'still broken, the login page 500s');
      expect(await repo.saveClassification('d3-t2', pushback, true)).toBe(id);
      const all = await repo.listCandidates({});
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id, status: 'confirmed', origins: ['detector', 'agent'] });
      expect(all[0].turnUuid).not.toBe('d3-t2');
      expect((await k.feedbackNeedingPostmortem(5)).map((i) => i.feedbackId)).toEqual([id]);
    });

    test('the same session merges even when the words differ', async () => {
      await liveSession('d4', 'why is the orders table missing?');
      await repo.saveClassification('d4-t2', pushback, true);
      expect(await report('agent did not run the migration', 'd4')).toBe('d4-t2');
      expect(await repo.listCandidates({})).toHaveLength(1);
    });

    test('different words, another project, or an item you rejected: two items', async () => {
      await liveSession('d5', 'still broken, the login page 500s');
      expect(await repo.saveClassification('d5-t1', { ...pushback, label: 'neutral' }, false)).toBeNull();
      await repo.saveClassification('d5-t2', pushback, true);
      expect(await report('the dark mode colours are wrong')).toMatch(/^manual:/);
      await liveSession('d6', 'the export button does nothing', { key: 'other', name: 'other', repoPath: '/vibe/other' });
      await repo.saveClassification('d6-t2', pushback, true);
      expect(await report('the export button does nothing at all')).toMatch(/^manual:/);
      await repo.decide('d5-t2', 'rejected', null);
      expect(await report('still broken, the login page 500s')).toMatch(/^manual:/);
      const all = await repo.listCandidates({});
      expect(all).toHaveLength(5);
      expect(all.find((c) => c.id === 'd5-t2')).toMatchObject({ origins: ['detector'], agentReport: null });
    });

  });

  test('post-mortem output, memory lessons and manual feedback are redacted before storage', async () => {
    const id = await confirmedFeedback('sx');
    const leak = 'sk-ant-api03-cccccccccccccccccccccccccccccccccccccccc';
    await k.savePostmortem(id, pm({
      missed: `missed ${leak}`, causeExplanation: leak,
      lesson: { title: leak, rule: leak, appliesWhen: leak, scope: 'project', paths: [] },
      contextItems: [{ kind: 'code', ref: 'a.ts', excerpt: `const k = "${leak}"`, why: leak, wasAvailable: false }],
    }), { miss: vec(1), lesson: vec(1) });
    await k.upsertLesson({ id: 'memory:x', projectKey: 'demo', title: leak, rule: leak, appliesWhen: leak, scope: 'project', paths: [], status: 'approved', source: 'memory', embedding: vec(2) });
    await k.createManualFeedback({ project, cwd: '/vibe/demo', text: `it broke, key ${leak}`, whatWasDone: leak });
    const rows = [];
    for (const kind of ['Miss', 'Lesson', 'ContextItem', 'Feedback', 'Turn'] as const) rows.push(...(await probe.rows(kind)));
    expect(rows.length).toBeGreaterThan(5);
    expect(JSON.stringify(rows)).not.toContain('sk-ant-api03');
  });

  test('re-importing a memory file never undoes your decision or your edits', async () => {
    const mem = (rule: string) => ({ id: 'memory:a.md', projectKey: 'demo', title: 'T', rule, appliesWhen: 'w', scope: 'project' as const, paths: [], status: 'approved' as const, source: 'memory' as const, embedding: vec(2) });
    await k.upsertLesson(mem('v1'));
    await k.upsertLesson(mem('v2'));
    expect((await k.lessonDetail('memory:a.md'))!.lesson).toMatchObject({ rule: 'v2', status: 'approved' });
    await k.updateLesson('memory:a.md', { status: 'rejected' }, {});
    await k.upsertLesson(mem('v3'));
    expect((await k.lessonDetail('memory:a.md'))!.lesson).toMatchObject({ rule: 'v2', status: 'rejected' });
  });

  test('a memory imported as proposed is undecided, is not served, and follows its file until you touch it', async () => {
    const mem = (rule: string) => ({ id: 'memory:p.md', projectKey: 'demo', title: 'T', rule, appliesWhen: 'w', scope: 'project' as const, paths: [], status: 'proposed' as const, source: 'memory' as const, embedding: vec(6) });
    await k.upsertLesson(mem('v1'));
    expect((await k.lessonDetail('memory:p.md'))!.lesson).toMatchObject({ rule: 'v1', status: 'proposed', decidedAt: null });
    expect(await k.searchLessons({ embedding: vec(6), projectKey: 'demo', k: 5 })).toEqual([]);
    await k.upsertLesson(mem('v2'));
    expect((await k.lessonDetail('memory:p.md'))!.lesson.rule).toBe('v2');
    // You edit the wording without deciding: a later import of the same file keeps your wording and leaves it proposed.
    await k.updateLesson('memory:p.md', { rule: 'my wording', title: 'Mine' }, {});
    await k.upsertLesson({ ...mem('v3'), status: 'approved' });
    expect((await k.lessonDetail('memory:p.md'))!.lesson).toMatchObject({ title: 'Mine', rule: 'my wording', status: 'proposed', decidedAt: null });
    await k.updateLesson('memory:p.md', { status: 'approved' }, {});
    await k.upsertLesson(mem('v4'));
    expect((await k.lessonDetail('memory:p.md'))!.lesson).toMatchObject({ rule: 'my wording', status: 'approved' });
  });

  test('a global lesson narrowed back to project scope belongs to its own project again', async () => {
    const id = await confirmedFeedback('sg');
    await k.savePostmortem(id, pm({ lesson: { ...pm().lesson, scope: 'global' } }), { miss: vec(1), lesson: vec(1) });
    const lid = `lesson:${id}`;
    await k.updateLesson(lid, { status: 'approved' }, {});
    expect((await k.searchLessons({ embedding: vec(1), projectKey: 'elsewhere', k: 5 })).map((h) => h.lesson.id)).toContain(lid);
    await k.updateLesson(lid, { scope: 'project' }, {});
    expect((await k.lessonDetail(lid))!.lesson.projectKey).toBe('demo');
    expect((await k.searchLessons({ embedding: vec(1), projectKey: 'elsewhere', k: 5 })).map((h) => h.lesson.id)).not.toContain(lid);
    expect((await k.searchLessons({ embedding: vec(1), projectKey: 'demo', k: 5 })).map((h) => h.lesson.id)).toContain(lid);
  });

  test('an approved project lesson is found even when many closer lessons belong elsewhere', async () => {
    for (let i = 0; i < 80; i++) {
      await k.upsertLesson({ id: `memory:noise${i}`, projectKey: 'noise', title: 'n', rule: 'n', appliesWhen: 'n', scope: 'project', paths: [], status: 'approved', source: 'memory', embedding: vec(1) });
    }
    await k.upsertLesson({ id: 'memory:mine', projectKey: 'demo', title: 'mine', rule: 'r', appliesWhen: 'w', scope: 'project', paths: [], status: 'approved', source: 'memory', embedding: vec(1, 0.05) });
    expect((await k.searchLessons({ embedding: vec(1), projectKey: 'demo', k: 6 })).map((h) => h.lesson.id)).toEqual(['memory:mine']);
  });

  test('a post-mortem failure is stored redacted: the error can quote what the model read', async () => {
    const id = await confirmedFeedback('sred');
    const key = `sk-ant-api03-${'A'.repeat(40)}`;
    await k.recordPostmortemFailure(id, `Error: claude exit 1: {"result":"found ${key} in config/settings.yaml"}`);
    const err = (await repo.candidateDetail(id))?.postmortem?.lastError ?? '';
    expect(err).toContain('[REDACTED]');
    expect(err).not.toContain(key);
  });

  test('a failed post-mortem waits with growing backoff before it is retried, then gives up', async () => {
    const id = await confirmedFeedback('sb');
    const t0 = new Date('2026-10-22T10:00:00Z');
    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    expect(await k.recordPostmortemFailure(id, 'ollama down', t0)).toEqual({ attempts: 1, retryAt: at(5).toISOString() });
    expect(await k.feedbackNeedingPostmortem(5, at(1))).toEqual([]);
    expect((await k.feedbackNeedingPostmortem(5, at(5))).map((i) => i.feedbackId)).toEqual([id]);
    expect(await k.recordPostmortemFailure(id, 'still down', at(5))).toEqual({ attempts: 2, retryAt: at(15).toISOString() });
    for (let i = 3; i <= 4; i++) await k.recordPostmortemFailure(id, 'x', at(100 * i));
    expect(await k.recordPostmortemFailure(id, 'x', at(1000))).toEqual({ attempts: 5, retryAt: null });
    expect(await k.feedbackNeedingPostmortem(5, at(100_000))).toEqual([]);
  });

  test('narrowing a lesson whose project cannot be traced fails closed: it is not served anywhere', async () => {
    // No project, no origin, no miss: nothing to trace it back to.
    await k.upsertLesson({ id: 'orphan', projectKey: null, title: 't', rule: 'r', appliesWhen: 'w', scope: 'global', paths: [], status: 'approved', source: 'postmortem', embedding: vec(3) });
    expect(await k.updateLesson('orphan', { scope: 'project' }, {})).toEqual({ unscoped: true });
    expect(await k.searchLessons({ embedding: vec(3), projectKey: 'anything', k: 5 })).toEqual([]);
    expect((await k.lessonDetail('orphan'))!.lesson.status).toBe('proposed');
  });

  test("setLessonPaths replaces a proposed lesson's paths only: an approved lesson's paths are the owner's", async () => {
    const one = (id: string, status: 'proposed' | 'approved') => ({ id, projectKey: 'demo', title: id, rule: 'r', appliesWhen: 'w', scope: 'project' as const, paths: ['schedule.go', 'AGENTS.md'], status, source: 'postmortem' as const, embedding: vec(6) });
    await k.upsertLesson(one('lesson:p', 'proposed'));
    await k.upsertLesson(one('lesson:a', 'approved'));
    expect(await k.setLessonPaths!('lesson:p', ['jobs/export/schedule.go'])).toBe(true);
    expect(await k.setLessonPaths!('lesson:a', ['jobs/export/schedule.go'])).toBe(false);
    expect(await k.setLessonPaths!('lesson:none', [])).toBe(false);
    const d = (id: string) => k.lessonDetail(id).then((x) => x!.lesson);
    expect(await d('lesson:p')).toMatchObject({ paths: ['jobs/export/schedule.go'], status: 'proposed' });
    expect((await d('lesson:p')).decidedBy ?? null).toBeNull();
    expect(await d('lesson:a')).toMatchObject({ paths: ['schedule.go', 'AGENTS.md'], status: 'approved' });
  });

  test('a global lesson with no project to trace is narrowed to the project the owner names, and served only there', async () => {
    await k.upsertLesson({ id: 'manual:g', projectKey: null, title: 't', rule: 'r', appliesWhen: 'w', scope: 'global', paths: [], status: 'approved', source: 'manual', embedding: vec(7) });
    expect(await k.updateLesson('manual:g', { scope: 'project', projectKey: 'web' }, {})).toEqual({ unscoped: false });
    const l = (await k.lessonDetail('manual:g'))!.lesson;
    expect(l).toMatchObject({ scope: 'project', projectKey: 'web', status: 'approved' });
    expect((await k.searchLessons({ embedding: vec(7), projectKey: 'web', k: 5 })).map((h) => h.lesson.id)).toEqual(['manual:g']);
    expect(await k.searchLessons({ embedding: vec(7), projectKey: 'demo', k: 5 })).toEqual([]);
  });

  test('a lesson stored with another embedding size is skipped, not a failed search', async () => {
    await k.upsertLesson({ id: 'memory:old', projectKey: 'demo', title: 'old', rule: 'r', appliesWhen: 'w', scope: 'project', paths: [], status: 'approved', source: 'memory', embedding: [1, 0, 0] });
    await k.upsertLesson({ id: 'memory:new', projectKey: 'demo', title: 'new', rule: 'r', appliesWhen: 'w', scope: 'project', paths: [], status: 'approved', source: 'memory', embedding: vec(1) });
    expect((await k.searchLessons({ embedding: vec(1), projectKey: 'demo', k: 5 })).map((h) => h.lesson.id)).toEqual(['memory:new']);
  });

  test('lesson scores are cosine similarity scaled to 0..1: same direction 1, orthogonal 0.5', async () => {
    const mem = (id: string, embedding: number[]) => ({ id, projectKey: 'demo', title: id, rule: 'r', appliesWhen: 'w', scope: 'project' as const, paths: [], status: 'approved' as const, source: 'memory' as const, embedding });
    await k.upsertLesson(mem('memory:same', vec(4)));
    await k.upsertLesson(mem('memory:orthogonal', vec(5)));
    const hits = await k.searchLessons({ embedding: vec(4), projectKey: 'demo', k: 2 });
    expect(hits.map((x) => [x.lesson.id, x.score])).toEqual([['memory:same', 1], ['memory:orthogonal', 0.5]]);
  });

  describe('the demo corpus (fg demo seed / remove)', () => {
    const demo = (over = {}) => ({
      project, id: 'demo:demo:tenant', ts: '2026-10-01T10:00:00.000Z', feedbackText: 'this reads every org', whatWasDone: 'added /orders',
      missed: 'the route used db.raw() and skipped tenant scoping', cause: 'context_available_ignored' as const, causeExplanation: 'CLAUDE.md says so',
      embedding: vec(7), ...over,
    });
    const fact = { kind: 'convention' as const, statement: 'routes use db.scoped', path: 'src/routes/orders.ts', lines: null, confidence: 1, why: 'demo', embedding: vec(8) };

    test('a demo miss is a confirmed miss found like any other, tied to the files its session touched, and written once', async () => {
      const id = await k.saveDemoMiss!(demo());
      expect(await k.saveDemoMiss!(demo({ missed: 'the route skipped tenant scoping' }))).toBe(id);
      expect(id).toBe('miss:demo:demo:tenant');
      const found = await k.relatedMisses({ embedding: vec(7), projectKey: 'demo', k: 5 });
      expect(found.map((m) => [m.missId, m.missed])).toEqual([[id, 'the route skipped tenant scoping']]);
      await h.store.codegraph.recordSessionFiles('demo:demo:tenant', [{ path: 'src/routes/orders.ts', read: true, edited: true, firstEditAt: '2026-10-01T09:59:00.000Z', lastEditAt: '2026-10-01T10:01:00.000Z' }]);
      expect((await h.store.codegraph.sessionFiles('demo:demo:tenant')).map((f) => f.path)).toEqual(['src/routes/orders.ts']);
      // Not waiting for a post-mortem, not in the Inbox as pending.
      expect(await k.feedbackNeedingPostmortem(5)).toEqual([]);
      await expect(k.saveDemoMiss!(demo({ id: 'manual:x' }))).rejects.toThrow(/demo:/);
    });

    test('removeDemo takes back exactly the demo lessons, misses and facts of that project', async () => {
      await k.saveDemoMiss!(demo());
      const lesson = (id: string, source: 'demo' | 'memory', projectKey = 'demo') => ({ id, projectKey, title: id, rule: 'r', appliesWhen: 'w', scope: 'project' as const, paths: [], status: 'approved' as const, source, embedding: vec(9) });
      await k.upsertLesson(lesson('demo:demo:l1', 'demo'));
      await k.upsertLesson(lesson('demo:other:l1', 'demo', 'other'));
      await k.upsertLesson(lesson('memory:keep', 'memory'));
      await h.store.facts.saveFileFacts('demo', { path: 'src/routes/orders.ts', hash: 'demo', summary: 's' }, [fact], 'demo');
      await h.store.facts.saveFileFacts('demo', { path: 'src/db.ts', hash: 'h', summary: 's' }, [{ ...fact, path: 'src/db.ts' }], 'ollama:x');
      const real = await confirmedFeedback('s-real');
      await k.savePostmortem(real, pm(), { miss: vec(7), lesson: vec(1) });

      expect(await k.removeDemo!('demo')).toEqual({ lessons: 1, misses: 1, facts: 1 });
      expect(await k.lessonDetail('demo:demo:l1')).toBeNull();
      expect(await k.lessonDetail('demo:other:l1')).not.toBeNull();
      expect(await k.lessonDetail('memory:keep')).not.toBeNull();
      expect((await k.relatedMisses({ embedding: vec(7), projectKey: 'demo', k: 5 })).map((m) => m.missId)).toEqual([`miss:${real}`]);
      expect((await h.store.facts.listFacts({ projectKey: 'demo' })).map((f) => f.path)).toEqual(['src/db.ts']);
      expect(await k.removeDemo!('demo')).toEqual({ lessons: 0, misses: 0, facts: 0 });
    });

    test("demo facts never touch a file a scan already recorded (its hash and summary stay), and removeDemo takes back only the file rows the demo added", async () => {
      const f = h.store.facts;
      // Scanned before, with no current facts (the scan found none, or they were closed since).
      await f.saveFileFacts('demo', { path: 'src/db.ts', hash: 'h-real', summary: 'the real summary', version: 'v1' }, [], 'ollama:x');
      await f.saveFileFacts('demo', { path: 'src/db.ts', hash: 'demo', summary: '[demo] seeded' }, [{ ...fact, path: 'src/db.ts' }], 'demo');
      await f.saveFileFacts('demo', { path: 'src/routes/orders.ts', hash: 'demo', summary: '[demo] seeded' }, [fact], 'demo');
      const listed = await f.listFacts({ projectKey: 'demo' });
      expect(listed.map((x) => [x.path, x.fileSummary])).toEqual([['src/db.ts', 'the real summary'], ['src/routes/orders.ts', '[demo] seeded']]);
      expect(Object.fromEntries(await f.fileHashes('demo'))).toEqual({ 'src/db.ts': 'h-real', 'src/routes/orders.ts': 'demo' });
      expect((await f.fileScanVersions('demo')).get('src/db.ts')).toBe('v1');

      expect(await k.removeDemo!('demo')).toMatchObject({ facts: 2 });
      // The scanned file is as the scan left it; the one the demo added is gone (the next scan reads it as new).
      expect(Object.fromEntries(await f.fileHashes('demo'))).toEqual({ 'src/db.ts': 'h-real' });
      expect((await f.fileScanVersions('demo')).get('src/db.ts')).toBe('v1');
      expect([...(await f.fileScanVersions('demo')).keys()]).toEqual(['src/db.ts']);
      await f.saveFileFacts('demo', { path: 'src/db.ts', hash: 'h-real', summary: 'the real summary', version: 'v1' }, [{ ...fact, path: 'src/db.ts', statement: 'scanned' }], 'ollama:x');
      expect((await f.listFacts({ projectKey: 'demo' })).map((x) => x.fileSummary)).toEqual(['the real summary']);
    });

    test('a file the demo added that a scan then read is the scan\'s: removeDemo leaves it', async () => {
      const f = h.store.facts;
      await f.saveFileFacts('demo', { path: 'src/routes/orders.ts', hash: 'demo', summary: '[demo] seeded' }, [fact], 'demo');
      await f.saveFileFacts('demo', { path: 'src/routes/orders.ts', hash: 'h-scan', summary: 'scanned' }, [{ ...fact, statement: 'scanned' }], 'ollama:x');
      await k.removeDemo!('demo');
      expect(Object.fromEntries(await f.fileHashes('demo'))).toEqual({ 'src/routes/orders.ts': 'h-scan' });
      expect((await f.listFacts({ projectKey: 'demo' })).map((x) => [x.statement, x.fileSummary])).toEqual([['scanned', 'scanned']]);
    });
  });
});
