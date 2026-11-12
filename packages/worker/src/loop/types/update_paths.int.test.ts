import { beforeEach, expect, test } from 'vitest';
import { decisionExecutor, LOOP_ACTOR, LOOP_POLICY_VERSION, writeRenames, type DecisionExecutor, type Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import type { LoopTypeContext } from '../plugin.ts';
import { updatePaths } from './update_paths.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const file = (path: string) => ({ path, lang: 'typescript', hash: 'h', loc: 10, isTest: false });

/** update_paths on each backend: a renamed file's lesson paths and trigger paths move to the new name, and back on rollback. */
describeStores('update_paths finds, applies and rolls back', (h) => {
  let s: Store;
  let x: DecisionExecutor;
  beforeEach(() => {
    s = h.store;
    x = decisionExecutor(s);
  });
  const ctx = async (): Promise<LoopTypeContext> => {
    const lessons = await s.knowledge.listLessons({ limit: 100 });
    return { now: Date.parse('2026-11-12T12:00:00Z'), store: s, entries: [], mode: 'auto', lessons: async () => lessons, signals: async () => null, inScope: () => true, holdout: 0, recall: async () => null, llm: null, log: () => {} };
  };

  test('the old name gone from the map and the new one in it: paths and trigger paths renamed; a rollback restores both; a glob is left alone', async () => {
    await s.knowledge.upsertLesson({
      id: 'lesson:r', projectKey: 'demo', title: 'Totals in cents', rule: 'Keep totals in cents', appliesWhen: 'billing', scope: 'project',
      paths: ['src/money.ts', 'src/**/*.sql'], status: 'approved', source: 'memory', embedding: vec(1),
      triggers: { paths: ['src/money.ts'], patterns: [], symbols: ['toCents'] },
    });
    await s.codegraph.replaceCodeMap('demo', { files: [file('src/billing/money.ts'), file('src/cart.ts')], symbols: [], imports: [], tests: [], churn: {}, fingerprint: 'f1' });
    await writeRenames(s.docs, 'demo', { 'src/money.ts': 'src/billing/money.ts', 'src/cart.ts': 'src/basket.ts' });
    const r = await updatePaths.candidates(await ctx());
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    const d = (await s.decisions.propose({
      type: 'update_paths', projectKey: 'demo', targets: c.targets, before: c.before, after: c.after, evidence: c.evidence, features: c.features, score: 0.95,
      confidence: { p: 0.95, lower: 0.9, n: 5, band: 4 }, tier: 'H', mode: 'auto', rationale: c.rationale, model: 'deterministic', policyVersion: LOOP_POLICY_VERSION, status: 'proposed',
    })).decision;
    const applied = await x.apply(d, { by: LOOP_ACTOR });
    expect(applied.status).toBe('applied');
    const now = (await s.knowledge.lessonDetail('lesson:r'))!.lesson;
    expect(now.paths).toEqual(['src/billing/money.ts', 'src/**/*.sql']);
    expect(now.triggers).toEqual({ paths: ['src/billing/money.ts'], patterns: [], symbols: ['toCents'] });
    expect((await updatePaths.candidates(await ctx())).candidates).toEqual([]);

    await x.rollback(applied, { by: 'you', cascade: 'apply' });
    const back = (await s.knowledge.lessonDetail('lesson:r'))!.lesson;
    expect(back.paths).toEqual(['src/money.ts', 'src/**/*.sql']);
    expect(back.triggers).toEqual({ paths: ['src/money.ts'], patterns: [], symbols: ['toCents'] });
  });

  test('nothing when the old name is still in the map, the new one is not, or no rename was seen', async () => {
    await s.knowledge.upsertLesson({ id: 'lesson:s', projectKey: 'demo', title: 't', rule: 'r', appliesWhen: 'a', scope: 'project', paths: ['src/a.ts', 'src/b.ts'], status: 'approved', source: 'memory', embedding: vec(1) });
    await s.codegraph.replaceCodeMap('demo', { files: [file('src/a.ts'), file('src/c.ts')], symbols: [], imports: [], tests: [], churn: {}, fingerprint: 'f2' });
    expect((await updatePaths.candidates(await ctx())).candidates).toEqual([]);
    await writeRenames(s.docs, 'demo', { 'src/a.ts': 'src/a2.ts', 'src/b.ts': 'src/missing.ts' });
    expect((await updatePaths.candidates(await ctx())).candidates).toEqual([]);
  });
});
