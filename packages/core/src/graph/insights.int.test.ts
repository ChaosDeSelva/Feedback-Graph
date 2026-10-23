import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { GraphStore, InsightsStore, KnowledgeStore } from '../store.ts';
import { describeStores } from '../testing/index.ts';
import type { Classification, ParsedSession, PostMortem, Project } from '../types.ts';

const pushback: Classification = { label: 'pushback', confidence: 0.9, summary: 's', signals: [] };
const vec = (axis: number, noise = 0) => {
  const v = Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : noise));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

function session(id: string, day: number): ParsedSession {
  const ts = (i: number) => `2026-10-${String(day).padStart(2, '0')}T10:0${i}:00Z`;
  const turns = [0, 1, 2].map((i) => ({ uuid: `${id}-t${i}`, sessionId: id, ts: ts(i), index: i, text: `turn ${i}`, precedingAssistantText: 'r', precedingToolCalls: [] }));
  return { sessionId: id, sourceFile: 'f', cwd: '/vibe/x', gitBranch: 'main', startedAt: ts(0), endedAt: ts(2), turns, toolCalls: [] };
}

const pm = (missed: string, cause: PostMortem['cause']): PostMortem => ({
  taskTitle: `task for ${missed}`, missed, cause, causeExplanation: 'why', outcome: 'approved',
  lesson: { title: `lesson: ${missed}`, rule: 'rule', appliesWhen: 'when', scope: 'project', paths: [] },
  contextItems: [{ kind: 'claude_md', ref: 'CLAUDE.md', excerpt: 'rule text', why: 'stated', wasAvailable: true }],
});

describeStores('InsightsStore', (h) => {
  let repo: GraphStore;
  let k: KnowledgeStore;
  let ins: InsightsStore;

  /** A confirmed feedback with a saved post-mortem whose miss embedding points along `axis`. */
  async function miss(project: Project, sessionId: string, day: number, missed: string, cause: PostMortem['cause'], axis: number) {
    await repo.upsertSession(project, session(sessionId, day), [{ sha: `${sessionId}c`, ts: `2026-10-${String(day).padStart(2, '0')}T10:05:00Z`, subject: 'fix it' }]);
    await repo.saveClassification(`${sessionId}-t1`, pushback, true);
    await repo.decide(`${sessionId}-t1`, 'confirmed', 'not good enough');
    await k.savePostmortem(`${sessionId}-t1`, pm(missed, cause), { miss: vec(axis, 0.01), lesson: vec(axis) });
  }

  const shop: Project = { key: 'shop', name: 'shop', repoPath: '/vibe/shop' };
  const blog: Project = { key: 'blog', name: 'blog', repoPath: '/vibe/blog' };

  beforeAll(() => {
    repo = h.store.graph;
    k = h.store.knowledge;
    ins = h.store.insights;
  });
  beforeEach(async () => {
    await miss(shop, 's1', 1, 'no tenant scoping on list', 'context_available_ignored', 1);
    await miss(shop, 's2', 9, 'tenant scoping missed again', 'context_available_ignored', 1);
    await miss(blog, 's3', 10, 'no pagination cap', 'requirement_unstated', 2);
    await miss(shop, 's4', 12, 'forgot tests', 'verification_gap', 3);
  });

  describe('InsightsRepo.projectGraph', () => {
    test('returns the evidence chain nodes and links for one project only', async () => {
      const g = await ins.projectGraph('shop');
      const kinds = new Set(g.nodes.map((n) => n.kind));
      for (const kind of ['feedback', 'miss', 'cause', 'lesson', 'context', 'commit', 'task']) expect(kinds).toContain(kind);
      expect(g.nodes.some((n) => n.label.includes('pagination'))).toBe(false);
      const ids = new Set(g.nodes.map((n) => n.id));
      for (const l of g.links) {
        expect(ids.has(l.source)).toBe(true);
        expect(ids.has(l.target)).toBe(true);
      }
      expect(g.links.map((l) => l.type)).toEqual(expect.arrayContaining(['EXPLAINS', 'CAUSED_BY', 'DERIVED_FROM', 'WOULD_HAVE_PREVENTED', 'ADDRESSES', 'CRITICIZES']));
      // Cause nodes are shared across misses: one node per cause, not per miss.
      expect(g.nodes.filter((n) => n.kind === 'cause' && n.label === 'context_available_ignored')).toHaveLength(1);
    });
  });

  describe('InsightsRepo.patterns', () => {
    test('counts misses by cause, across all projects or one', async () => {
      const all = await ins.patterns({});
      expect(all.causes).toEqual([
        { cause: 'context_available_ignored', count: 2 },
        { cause: 'requirement_unstated', count: 1 },
        { cause: 'verification_gap', count: 1 },
      ]);
      const shopOnly = await ins.patterns({ projectKey: 'shop' });
      expect(shopOnly.causes.reduce((n, c) => n + c.count, 0)).toBe(3);
    });

    test('a miss similar to an earlier miss is a repeat, grouped with it', async () => {
      const r = await ins.patterns({});
      expect(r.repeatGroups).toHaveLength(1);
      expect(r.repeatGroups[0]).toMatchObject({ count: 2, projects: ['shop'], cause: 'context_available_ignored' });
      expect(r.repeatGroups[0].examples).toEqual(['no tenant scoping on list', 'tenant scoping missed again']);
    });

    test('weekly series counts feedback and repeats by the week the feedback was given', async () => {
      const r = await ins.patterns({});
      const total = r.weekly.reduce((n, w) => n + w.feedback, 0);
      expect(total).toBe(4);
      expect(r.weekly.reduce((n, w) => n + w.repeats, 0)).toBe(1);
      const repeatWeek = r.weekly.find((w) => w.repeats === 1)!;
      expect(repeatWeek.week).toBe('2026-W41'); // Oct 9, the second tenant-scoping miss
    });

    test('pre-done catch rate comes from recorded checks', async () => {
      await k.recordPreDoneCheck({ projectKey: 'shop', task: 'a', checkedLessonIds: ['lesson:s1-t1'], gapLessonIds: ['lesson:s1-t1'] });
      await k.recordPreDoneCheck({ projectKey: 'shop', task: 'b', checkedLessonIds: ['lesson:s1-t1'], gapLessonIds: [] });
      await k.recordPreDoneCheck({ projectKey: 'blog', task: 'c', checkedLessonIds: [], gapLessonIds: [] });
      expect((await ins.patterns({})).preDone).toEqual({ checks: 3, withGaps: 1, gapsFound: 1 });
      expect((await ins.patterns({ projectKey: 'shop' })).preDone).toEqual({ checks: 2, withGaps: 1, gapsFound: 1 });
    });
  });
});
