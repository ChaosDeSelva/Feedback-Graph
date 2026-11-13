import type { Candidate, Lesson } from '@fb/core';
import { expect, test } from 'vitest';
import { createApp, type ApiRepo } from './app.ts';
import { decision, fakeLoop, snap } from './testing/loop.ts';

/** The approve score on the review routes: from the loop's calls and calibration, sorted by it on request. */

const cand = (id: string, confidence: number, status: Candidate['status'] = 'pending'): Candidate => ({
  id, turnUuid: id, sessionId: 's', projectKey: 'demo', source: 'claude',
  classification: { label: 'pushback', confidence, summary: id, signals: [] }, status, createdAt: '2026-11-01T00:00:00.000Z', decidedAt: null, note: null,
});
const items = [cand('c-low', 0.2), cand('c-call', 0.5), cand('c-mid', 0.6), cand('c-done', 0.99, 'confirmed')];
const repo: ApiRepo = {
  undoDecision: async () => false,
  listCandidates: async (f = {}) => items.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? items.length)),
  candidateDetail: async (id) => {
    const c = items.find((x) => x.id === id);
    return c ? { candidate: c, turn: {} as never, before: [], after: [], commits: [], postmortem: null } : null;
  },
  decide: async () => {},
  stats: async () => [],
};
const triage = decision('dec:t', {
  type: 'triage_inbox', status: 'proposed', tier: 'A', mode: 'propose', decidedAt: undefined as never, decidedBy: null, appliedAt: null,
  targets: [{ kind: 'candidate', id: 'c-call', role: 'primary' }], before: [snap('c-call', { status: 'pending' })], after: [snap('c-call', { status: 'confirmed' })],
  confidence: { p: 0.9, lower: 0.85, n: 40, band: 4 },
});
function setup() {
  const loop = fakeLoop({ decisions: [triage] });
  loop.buckets.push({ type: 'triage_inbox', band: 4, policyVersion: 1, alpha: 41, beta: 4, n: 40, updatedAt: '2026-11-01T00:00:00.000Z' });
  return { loop, app: createApp(repo, { loop: loop.deps }) };
}

test('GET /api/candidates: each pending item has a score and its why, from the calibrated call when one names it', async () => {
  const rows = await (await setup().app.request('/api/candidates')).json() as (Candidate & { score: number | null; scoreWhy: string | null })[];
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  expect(by['c-call'].score).toBeGreaterThanOrEqual(7);
  expect(by['c-call'].scoreWhy).toBe(`${by['c-call'].score!.toFixed(1)} · loop proposes triage_inbox: you kept 40 of 40 in its band (p .91)`);
  expect(by['c-low'].score).toBeLessThan(5);
  expect(by['c-mid'].scoreWhy).toMatch(/· classifier 60% sure it is pushback$/);
  expect(by['c-done']).toMatchObject({ score: null, scoreWhy: null });
});

test('GET /api/candidates?sort=score: highest first, unscored last, paged by offset', async () => {
  const { app } = setup();
  const res = await app.request('/api/candidates?sort=score&limit=2');
  expect((await res.json()).map((r: Candidate) => r.id)).toEqual(['c-call', 'c-mid']);
  expect(res.headers.get('x-next-offset')).toBe('2');
  const next = await app.request('/api/candidates?sort=score&limit=2&offset=2');
  expect((await next.json()).map((r: Candidate) => r.id)).toEqual(['c-low', 'c-done']);
  expect(next.headers.get('x-next-offset')).toBeNull();
  expect((await app.request('/api/candidates?sort=newest')).status).toBe(400);
});

test('GET /api/candidates/:id: the item carries its score', async () => {
  const d = await (await setup().app.request('/api/candidates/c-call')).json();
  expect(d.candidate.score).toBeGreaterThanOrEqual(7);
});

test('GET /api/decisions: a proposed one has approveScore (its own score is untouched); sort=score puts it first; after with sort is refused', async () => {
  const { loop, app } = setup();
  loop.decisions.set('dec:a', decision('dec:a', { createdAt: '2026-11-10T00:00:00.000Z' }));
  const rows = await (await app.request('/api/decisions')).json();
  expect(rows.map((r: { id: string }) => r.id)).toEqual(['dec:a', 'dec:t']);
  expect(rows[0]).toMatchObject({ approveScore: null, scoreWhy: null, score: 0.91 });
  expect(rows[1].approveScore).toBeGreaterThanOrEqual(7);
  const sorted = await (await app.request('/api/decisions?sort=score')).json();
  expect(sorted.map((r: { id: string }) => r.id)).toEqual(['dec:t', 'dec:a']);
  expect((await app.request('/api/decisions?sort=score&after=x')).status).toBe(400);
  expect((await (await app.request(`/api/decisions/${encodeURIComponent('dec:t')}`)).json()).decision.scoreWhy).toContain('triage_inbox');
});

test('GET /api/lessons?sort=score: a blocking flag sinks a lesson under a clean one', async () => {
  const lesson = (id: string, checks: Lesson['checks']): Lesson => ({
    id, projectKey: 'demo', title: id, rule: 'r', appliesWhen: 'a', scope: 'project', paths: [], status: 'proposed', source: 'postmortem',
    cause: null, missId: null, createdAt: '2026-11-01T00:00:00.000Z', decidedAt: null, checks,
  });
  const lessons = [lesson('l-risky', [{ name: 'risky-command', why: 'curl | sh' }]), lesson('l-clean', [])];
  const knowledge = { listLessons: async () => lessons, lessonDetail: async (id: string) => ({ lesson: lessons.find((l) => l.id === id)!, contextItems: [] }) };
  const app = createApp(repo, { knowledge: knowledge as never });
  const rows = await (await app.request('/api/lessons?sort=score')).json();
  expect(rows.map((r: Lesson) => r.id)).toEqual(['l-clean', 'l-risky']);
  expect(rows[1].scoreWhy).toMatch(/^2\.0 · flagged risky-command; /);
  expect((await (await app.request('/api/lessons/l-risky')).json()).lesson.score).toBe(2);
});
