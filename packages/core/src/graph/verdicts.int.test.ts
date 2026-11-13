import { beforeEach, expect, test } from 'vitest';
import type { Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import { fixtureVector, SCORE_FIXTURE_TOPICS, seedScoreFixture, type ScoreFixtureItem } from '../testing/scoreFixture.ts';

/** VerdictsStore over each backend: your verdicts found by meaning, as the approve score reads them. */
describeStores('verdicts store', (h) => {
  let store: Store;
  let seeded: { candidates: ScoreFixtureItem[]; lessons: ScoreFixtureItem[] };
  const project = { key: 'score-fixture', name: 'score-fixture', repoPath: '/fixture/score-fixture' };
  const pending = (text: string, embedding?: number[]) =>
    store.knowledge.createManualFeedback({ project, cwd: project.repoPath, text, whatWasDone: 'x', ...(embedding && { embedding }) });

  // The harness wipes the store before each test: the history is seeded again for each.
  beforeEach(async () => {
    store = h.store;
    seeded = await seedScoreFixture(store, { items: 24 });
  });

  test('an Inbox item: your verdicts on its topic, its project first, nearest first; never itself, an operator\'s or a sandbox one', async () => {
    const id = await pending('a new miss on topic 0', fixtureVector(SCORE_FIXTURE_TOPICS[0].axis, 700));
    const byOperator = await pending('decided by an agent', fixtureVector(SCORE_FIXTURE_TOPICS[0].axis, 701));
    await store.graph.decide(byOperator, 'confirmed', null, 'operator:bot');
    const sandbox = await store.knowledge.createManualFeedback({ project, cwd: project.repoPath, text: 'sandbox', whatWasDone: 'x', embedding: fixtureVector(SCORE_FIXTURE_TOPICS[0].axis, 702), run: { id: 'sbx-score', sandbox: true } });
    await store.graph.decide(sandbox, 'confirmed', null, 'you');
    const near = (await store.verdicts.neighbours({ kind: 'candidate', ids: [id, 'no-such-item'], k: 10, minCosine: 0.4 }))[id];
    const topic0 = seeded.candidates.filter((c) => c.topic === 0);
    expect(near.map((n) => n.id).sort()).toEqual(topic0.map((c) => c.id).sort());
    expect(near.every((n) => Math.abs(n.cosine - 0.85 * 0.85) < 1e-3)).toBe(true);
    // Its own project's verdicts come before the other project's.
    const firstOther = near.findIndex((n) => !n.sameProject);
    expect(firstOther).toBeGreaterThan(0);
    expect(near.slice(firstOther).every((n) => !n.sameProject && n.projectKey === 'score-fixture-other')).toBe(true);
    expect(near.map((n) => n.approved)).toEqual(near.map((n) => topic0.find((c) => c.id === n.id)!.approved));
    // k cuts the list; a floor above the topic's cosine leaves none.
    expect((await store.verdicts.neighbours({ kind: 'candidate', ids: [id], k: 3, minCosine: 0.4 }))[id]).toHaveLength(3);
    expect(await store.verdicts.neighbours({ kind: 'candidate', ids: [id], k: 3, minCosine: 0.9 })).toEqual({ [id]: [] });
  });

  test('priorOnly: a decided item sees only the verdicts made before its own; ownerVerdicts lists yours oldest first', async () => {
    const mine = await store.verdicts.ownerVerdicts('candidate');
    expect(mine.map((v) => v.id)).toEqual(seeded.candidates.map((c) => c.id));
    expect(mine.map((v) => v.approved)).toEqual(seeded.candidates.map((c) => c.approved));
    const last = seeded.candidates.filter((c) => c.topic === 1).at(-1)!;
    const first = seeded.candidates.find((c) => c.topic === 1)!;
    const near = await store.verdicts.neighbours({ kind: 'candidate', ids: [first.id, last.id], k: 20, minCosine: 0.4, priorOnly: true });
    expect(near[first.id]).toEqual([]);
    const at = new Map(mine.map((v) => [v.id, v.decidedAt]));
    expect(near[last.id].length).toBe(seeded.candidates.filter((c) => c.topic === 1).length - 1);
    expect(near[last.id].every((n) => Date.parse(n.decidedAt) < Date.parse(at.get(last.id)!))).toBe(true);
  });

  test('lessons: your approved and rejected ones by meaning', async () => {
    await store.knowledge.upsertLesson({
      id: 'lesson:score-new', projectKey: 'score-fixture', title: 'new', rule: 'new rule', appliesWhen: 'x', scope: 'project', paths: [], status: 'proposed', source: 'memory',
      embedding: fixtureVector(SCORE_FIXTURE_TOPICS[1].axis, 703),
    });
    const near = (await store.verdicts.neighbours({ kind: 'lesson', ids: ['lesson:score-new'], k: 20, minCosine: 0.5 }))['lesson:score-new'];
    const topic1 = seeded.lessons.filter((l) => l.topic === 1);
    expect(near.map((n) => n.id).sort()).toEqual(topic1.map((l) => l.id).sort());
    expect(near.filter((n) => n.approved).length).toBe(topic1.filter((l) => l.approved).length);
    expect((await store.verdicts.ownerVerdicts('lesson')).length).toBe(seeded.lessons.length);
  });

  test('claims: your accepted and rejected ones by meaning', async () => {
    const docId = await store.docs.upsertDoc({ projectKey: 'score-fixture', source: 'intake', ref: 'verdicts.md', title: 'v', url: null }, [{ text: 'notes', embedding: fixtureVector(1, 2) }]);
    await store.intake.upsertMeta({ docId, kind: 'notes', format: 'md', occurredAt: '2026-11-10', origin: 'test', private: true, participants: [] });
    const { version } = (await store.intake.nextWindow(docId))!;
    const draft = (statement: string, item: number) => ({
      type: 'fact' as const, statement, quote: statement, speakerId: null, span: null, assertedAt: null, confidence: 0.8,
      scope: { area: null, files: [] }, about: 'x', due: null, flags: [], embedding: fixtureVector(SCORE_FIXTURE_TOPICS[2].axis, item),
    });
    await store.intake.saveWindow(docId, { window: 0, version, claims: [draft('one', 710), draft('two', 711), draft('three', 712)], questions: [] });
    const claims = await store.intake.listClaims({ docId });
    const [a, b, c] = ['one', 'two', 'three'].map((s) => claims.find((x) => x.statement === s)!);
    await store.intake.decideClaim(a.id, { status: 'accepted' }, { by: 'you' });
    await store.intake.decideClaim(b.id, { status: 'rejected' }, { by: 'operator:bot' });
    const near = (await store.verdicts.neighbours({ kind: 'claim', ids: [c.id], k: 5, minCosine: 0.5 }))[c.id];
    expect(near).toEqual([expect.objectContaining({ id: a.id, approved: true, sameProject: true })]);
  });

  test('inboxToEmbed: Inbox items without an embedding, until they get one', async () => {
    const id = await pending('flagged while the embedder was down');
    expect((await store.verdicts.inboxToEmbed(100)).map((r) => r.id)).toContain(id);
    expect((await store.verdicts.inboxToEmbed(100)).find((r) => r.id === id)!.text).toBe('flagged while the embedder was down');
    await store.verdicts.setInboxEmbeddings([{ id, embedding: fixtureVector(SCORE_FIXTURE_TOPICS[0].axis, 720) }]);
    expect((await store.verdicts.inboxToEmbed(100)).map((r) => r.id)).not.toContain(id);
    expect((await store.verdicts.neighbours({ kind: 'candidate', ids: [id], k: 1, minCosine: 0.4 }))[id]).toHaveLength(1);
  });
});
