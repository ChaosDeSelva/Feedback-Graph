import { expect, test } from 'vitest';
import type { Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { PostMortem, Project, RunTag } from '../types.ts';
import type { GraphRepo } from './repo.ts';

const DIMS = 768;
/** A seeded generator (mulberry32): spread-out vectors like real embeddings, the same on every run. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const random = rng(11);
const vector = () => unit(Array.from({ length: DIMS }, random));
const query = vector();
/** The query plus noise of the given size: the bigger, the farther. */
const near = (noise: number) => {
  const n = vector();
  return unit(query.map((x, i) => x + noise * n[i]));
};
const project: Project = { key: 'demo', name: 'demo', repoPath: '/vibe/demo' };
const sandbox: RunTag = { id: 'sbx-1', sandbox: true };
const pm = (i: number): PostMortem => ({
  taskTitle: 't', missed: `missed ${i}`, cause: 'requirement_unstated', causeExplanation: 'c', outcome: 'approved',
  lesson: { title: `l ${i}`, rule: 'r', appliesWhen: 'w', scope: 'project', paths: [] }, contextItems: [],
});

/** demo: 4 of each kind a little off the query; other: 40 of each, all nearer (they fill the index's first hits). */
async function seed(s: Store) {
  for (const [key, count, noise, step] of [['other', 40, 0.4, 0], ['demo', 4, 1.5, 0.5]] as const) {
    for (let i = 0; i < count; i++) {
      const e = near(noise + i * step);
      await s.knowledge.upsertLesson({ id: `mem:${key}${i}`, projectKey: key, title: `${key} ${i}`, rule: 'r', appliesWhen: '', scope: 'project', paths: [], status: 'approved', source: 'memory', embedding: e });
      await s.facts.saveFileFacts(key, { path: `f${i}.ts`, hash: 'h', summary: '' }, [{ kind: 'convention', statement: `${key} ${i}`, path: `f${i}.ts`, lines: null, confidence: 1, why: '', embedding: e }], 'p');
      const id = await s.knowledge.createManualFeedback({ project: { ...project, key }, cwd: `/vibe/${key}`, text: `${key} ${i}`, whatWasDone: 'x' });
      await s.graph.decide(id, 'confirmed', null, 'operator:tester');
      await s.knowledge.savePostmortem(id, pm(i), { miss: e, lesson: e });
    }
    await s.docs.upsertDoc({ projectKey: key, source: 'upload', ref: `${key}.md`, title: key, url: null }, Array.from({ length: count }, (_, i) => ({ text: `${key} ${i}`, embedding: near(noise + i * step) })));
  }
}

const searches = (s: Store, run: string | null = null) => Promise.all([
  s.knowledge.searchLessons({ embedding: query, projectKey: 'demo', k: 3, run }).then((r) => r.map((h) => [h.lesson.title, h.score.toFixed(5)])),
  s.knowledge.relatedMisses({ embedding: query, projectKey: 'demo', k: 3, run }).then((r) => r.map((h) => [h.missed, h.score.toFixed(5)])),
  s.facts.searchFacts({ embedding: query, projectKey: 'demo', k: 3, run }).then((r) => r.map((h) => [h.fact.statement, h.score.toFixed(5)])),
  s.docs.searchDocs({ embedding: query, projectKey: 'demo', k: 3, run }).then((r) => r.map((h) => [h.text, h.score.toFixed(5)])),
]);

describeStores('Vector searches', (h) => {
  test("each search finds the project's k nearest even when another project's records are nearer, and a sandbox written after a search is hidden at once", async () => {
    await seed(h.store);
    const [lessons, misses, facts, docs] = await searches(h.store);
    expect(lessons.map((x) => x[0])).toEqual(['demo 0', 'demo 1', 'demo 2']);
    expect(misses.map((x) => x[0])).toEqual(['missed 0', 'missed 1', 'missed 2']);
    expect(facts.map((x) => x[0])).toEqual(['demo 0', 'demo 1', 'demo 2']);
    expect(docs.map((x) => x[0])).toEqual(['demo 0', 'demo 1', 'demo 2']);
    // A sandbox run writes nearer records after the searches above found none: no one else is served them, its run is.
    await h.store.facts.addOwnerFact('demo', { kind: 'convention', statement: 'sandbox fact', path: '.', lines: null, confidence: 1, why: 'w', embedding: near(0.1) }, 'operator:tester', sandbox);
    await h.store.docs.upsertDoc({ projectKey: 'demo', source: 'upload', ref: 'sbx.md', title: 'sbx', url: null }, [{ text: 'sandbox chunk', embedding: near(0.1) }], { run: sandbox });
    const after = await searches(h.store);
    expect(after[2].map((x) => x[0])).toEqual(['demo 0', 'demo 1', 'demo 2']);
    expect(after[3].map((x) => x[0])).toEqual(['demo 0', 'demo 1', 'demo 2']);
    const own = await searches(h.store, 'sbx-1');
    expect(own[2][0][0]).toBe('sandbox fact');
    expect(own[3][0][0]).toBe('sandbox chunk');
  }, 60_000);

  test('every sandbox write marks presence: a sandbox lesson or demo miss written right after a search that found none is never served to another caller', async () => {
    await seed(h.store);
    // A search that found no sandbox record: "none" is believed for a few seconds.
    expect((await searches(h.store))[0].map((x) => x[0])).toEqual(['demo 0', 'demo 1', 'demo 2']);
    await h.store.knowledge.upsertLesson({ id: 'mem:sbx', projectKey: 'demo', title: 'sandbox lesson', rule: 'r', appliesWhen: '', scope: 'project', paths: [], status: 'approved', source: 'memory', embedding: near(0.1), run: sandbox });
    await h.store.knowledge.saveDemoMiss!({
      project, id: 'demo:demo:sbx', ts: new Date().toISOString(), feedbackText: 'f', whatWasDone: 'w', missed: 'sandbox miss', cause: 'requirement_unstated', causeExplanation: 'c',
      embedding: near(0.1), run: sandbox,
    });
    const [lessons, misses] = await searches(h.store);
    expect(lessons.map((x) => x[0])).not.toContain('sandbox lesson');
    expect(misses.map((x) => x[0])).not.toContain('sandbox miss');
    const own = await searches(h.store, 'sbx-1');
    expect(own[0][0][0]).toBe('sandbox lesson');
    expect(own[1][0][0]).toBe('sandbox miss');
  }, 60_000);
});

describeStores('Neo4j vector indexes', (h) => {
  test('the Neo4j searches read the vector indexes, with the scores the exact scan gives', async () => {
    const g = h.store.graph as GraphRepo;
    await seed(h.store);
    await g.run('CALL db.awaitIndexes(60)');
    const reads = async () => {
      const rows = await g.run(`SHOW INDEXES YIELD name, type, readCount WHERE type = 'VECTOR' RETURN name, coalesce(readCount, 0) AS n`);
      return Object.fromEntries(rows.map((r) => [r.get('name'), Number(r.get('n'))]));
    };
    const before = await reads();
    // k = 1: the first index candidates (other project's) are filtered out, and the project's nearest is still found.
    const one = await Promise.all([
      h.store.knowledge.searchLessons({ embedding: query, projectKey: 'demo', k: 1 }),
      h.store.facts.searchFacts({ embedding: query, projectKey: 'demo', k: 1 }),
      h.store.knowledge.relatedMisses({ embedding: query, projectKey: 'demo', k: 1 }),
      h.store.docs.searchDocs({ embedding: query, projectKey: 'demo', k: 1 }),
    ]);
    expect(one.map((r) => r.length)).toEqual([1, 1, 1, 1]);
    // Neo4j counts index reads in the background: wait for the counts to catch up.
    const indexes = ['lesson_embedding', 'fact_embedding', 'miss_embedding', 'chunk_embedding'];
    let after = await reads();
    for (let i = 0; i < 60 && indexes.some((x) => !(after[x] > (before[x] ?? 0))); i++) {
      await new Promise((r) => setTimeout(r, 500));
      after = await reads();
    }
    for (const index of indexes) expect(after[index], index).toBeGreaterThan(before[index] ?? 0);
    // Same hits and scores as the exact cosine over every candidate.
    const [exact] = await g.run(
      `MATCH (node:Fact {projectKey: 'demo', current: true}) WITH node, vector.similarity.cosine(node.embedding, $q) AS score
       RETURN node.statement AS s, score ORDER BY score DESC LIMIT 1`,
      { q: query },
    );
    expect([one[1][0].fact.statement, one[1][0].score.toFixed(5)]).toEqual([exact.get('s'), (exact.get('score') as number).toFixed(5)]);
  }, 60_000);
}, { only: ['neo4j'] });
