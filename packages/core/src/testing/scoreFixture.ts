import type { Store } from '../store.ts';

/**
 * A synthetic history of your verdicts for the approve score (0.9.5): Inbox items and lessons on three topics, each
 * topic a direction in embedding space, decided by you in order (so decidedAt rises). Topic 0 you mostly approve,
 * topic 1 mostly reject, topic 2 is a coin flip; one project per kind and a second project holding a few of topic 0.
 * The same seed gives the same history. Used by the verdicts integration test and scripts/score-eval.ts --fixture.
 */
export const SCORE_FIXTURE_TOPICS = [{ axis: 10, approve: 0.9 }, { axis: 20, approve: 0.1 }, { axis: 30, approve: 0.5 }] as const;
const DIMS = 768;

/** Deterministic in [0, 1): mulberry32. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A unit vector at cosine `c` to the topic's axis, the rest along the item's own axis: two items of one topic meet at c². */
export function fixtureVector(topicAxis: number, itemAxis: number, c = 0.85): number[] {
  const v = new Array<number>(DIMS).fill(0);
  v[topicAxis] = c;
  v[itemAxis] = Math.sqrt(1 - c * c);
  return v;
}

export type ScoreFixtureItem = { id: string; topic: number; approved: boolean; projectKey: string };

export async function seedScoreFixture(store: Store, o: { items?: number; seed?: number; project?: string } = {}): Promise<{ candidates: ScoreFixtureItem[]; lessons: ScoreFixtureItem[] }> {
  const n = o.items ?? 60;
  const next = rng(o.seed ?? 95);
  const main = o.project ?? 'score-fixture';
  const other = `${main}-other`;
  const candidates: ScoreFixtureItem[] = [];
  const lessons: ScoreFixtureItem[] = [];
  for (let i = 0; i < n; i++) {
    const topic = i % SCORE_FIXTURE_TOPICS.length;
    const t = SCORE_FIXTURE_TOPICS[topic];
    const projectKey = topic === 0 && i % 4 === 0 ? other : main;
    const approved = next() < t.approve;
    const id = await store.knowledge.createManualFeedback({
      project: { key: projectKey, name: projectKey, repoPath: `/fixture/${projectKey}` }, cwd: `/fixture/${projectKey}`,
      text: `fixture miss ${i} on topic ${topic}`, whatWasDone: 'fixture', embedding: fixtureVector(t.axis, 100 + i),
    });
    await store.graph.decide(id, approved ? 'confirmed' : 'rejected', null, 'you');
    candidates.push({ id, topic, approved, projectKey });
    const lid = `lesson:score-fixture-${i}`;
    await store.knowledge.upsertLesson({
      id: lid, projectKey, title: `fixture lesson ${i}`, rule: `fixture rule on topic ${topic}`, appliesWhen: 'fixture', scope: 'project',
      paths: [], status: 'proposed', source: 'memory', embedding: fixtureVector(t.axis, 100 + n + i), checks: [],
    });
    await store.knowledge.updateLesson(lid, { status: approved ? 'approved' : 'rejected' }, { by: 'you' });
    lessons.push({ id: lid, topic, approved, projectKey });
  }
  return { candidates, lessons };
}
