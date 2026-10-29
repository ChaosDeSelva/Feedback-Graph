import { expect, test } from 'vitest';
import type { Lesson } from '@fb/core';
import { buildChatContext } from './chat.ts';
import { checkBeforeDone, getTaskContext, makeJudge, type ContextDeps } from './context.ts';
import { quotedCode, citeDiff, splitDiff } from './diff.ts';

const lesson: Lesson = { id: 'prefix', projectKey: 'demo', title: 'Key prefix', rule: 'Do not use KeyPrefix 005.', appliesWhen: 'editing the schema', paths: ['src/schema.ts'], status: 'approved', scope: 'project', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't' };
const deps = (over: Partial<ContextDeps> = {}): ContextDeps => ({ roots: [{ host: '/projects', container: '/projects' }], exists: () => true, embed: async () => [[1]], k: { searchLessons: async () => [{ lesson, score: 1 }], relatedMisses: async () => [], recordPreDoneCheck: async () => {}, createManualFeedback: async () => 'f' }, judge: async () => [], ...over });
const diff = (old: string, next: string) => `--- a/src/schema.ts\n+++ b/src/schema.ts\n@@ -1 +1 @@\n-KeyPrefix = "${old}";\n+KeyPrefix = "${next}";\n`;

test('single-quoted short literals in model reasons validate violations and clean changes, never the wrong side', async () => {
  expect(quotedCode("The user's prefix is '005'.")).toEqual(['005']);
  for (const [old, next, status, literal, gap] of [['004', '005', 'not_addressed', '005', true], ['005', '006', 'addressed', '006', false], ['005', '006', 'not_addressed', '005', false]] as const) {
    const judge = makeJudge({ id: 'fake', agentic: false, json: async () => ({ verdicts: [{ lessonId: 'L1', applies: true, status, why: `KeyPrefix is '${literal}'.` }] }) });
    const result = await checkBeforeDone({ project: 'demo', task: 'edit src/schema.ts', summary: 'done', diff: diff(old, next) }, deps({ judge }));
    expect(result.gaps.length > 0).toBe(gap);
    if (gap) expect(result.gaps[0].evidence?.[0].line).toBe('+KeyPrefix = "005";');
    if (status === 'addressed') expect(result.cannotTell).toEqual([]);
  }
  expect(citeDiff(splitDiff(diff('005', '006')), '+005')).toBe(null);
});

test('context applies weighted fact rank .80 and returns bounded explicit ranks on every scored kind', async () => {
  const fact = (id: string, score: number, relevance: number) => ({ fact: { id, path: '.', statement: id, kind: 'convention', relevance, origin: 'model' } as never, score });
  const context = await getTaskContext({ project: 'demo', task: 'edit schema' }, deps({
    facts: { searchFacts: async () => [fact('weak', .99, .5), fact('boundary', .8, 1), fact('rounding', 1.01, 1)] },
    k: { ...deps().k, relatedMisses: async () => [{ missId: 'm', missed: 'Omitted a check', feedbackText: '', sessionId: 's', ts: 't', cause: 'requirement_unstated', score: 1.2 }] },
    docs: { searchDocs: async () => [{ docId: 'd', source: 'upload', ref: 'd', title: 'Guide', text: 'text', url: null, score: 1.2 }] },
  }));
  expect(context.facts.map(h => h.fact.id)).toEqual(['rounding', 'boundary']);
  expect(context.facts.every(h => h.score <= 1 && h.rankingScore! <= 1 && h.rankingScore! >= .8)).toBe(true);
  expect(context.misses[0]).toMatchObject({ score: 1, rankingScore: 1 });
  expect(context.docs[0]).toMatchObject({ score: 1, rankingScore: 1 });
  expect(context.facts.every(h => Number.isFinite(h.rankingScore))).toBe(true);
  expect(context.markdown).toContain('rank≥0.80');
  expect(context.markdown).not.toContain('1.20');
});

test('the calibrated lexical scale remains usable rather than inheriting a cosine-only .80 cutoff', async () => {
  const context = await getTaskContext({ project: 'demo', task: 'schema' }, deps({ similarityFloor: .05,
    facts: { searchFacts: async () => [{ fact: { id: 'lexical', path: '.', relevance: .8, statement: 'schema', kind: 'convention' } as never, score: .2 }] },
  }));
  expect(context.facts[0].fact.id).toBe('lexical');
});

test('own-PR exclusion filters vector and file misses and tells the agent the excluded PR', async () => {
  const own = { missId: 'm-own', missed: 'Own review', feedbackText: '', sessionId: 'github:acme/demo#42', ts: 't', cause: 'requirement_unstated' as const, score: .99 };
  const keep = { ...own, missId: 'm-other', missed: 'Other review', sessionId: 'github:acme/demo#43' };
  const context = deps({ k: { ...deps().k, searchLessons: async () => [], relatedMisses: async () => [own, keep] }, codegraph: { lessonsForPaths: async () => [], moduleContext: async () => ({ file: { path: 'src/schema.ts' }, symbols: [], imports: [], importers: [], tests: [], facts: [], lessons: [], misses: [{ ...own, feedbackId: 'f', paths: ['src/schema.ts'], fixedHere: false, lessonId: null }] }) } as never });
  const full = await getTaskContext({ project: 'demo', task: 'review PR #42 in src/schema.ts' }, context);
  expect(full.misses.map(m => m.missId)).toEqual(['m-other']); expect(full.fileMisses).toEqual([]);
  expect(full.markdown).toContain('Own-PR exclusion: #42');
  const brief = await getTaskContext({ project: 'demo', task: 'review PR #42 in src/schema.ts', brief: true }, context);
  expect(brief.fileMisses).toEqual([]); expect(brief.markdown).toContain('Own-PR exclusion: #42');
  let judged: string[] = [];
  const checked = await checkBeforeDone({ project: 'demo', task: 'review PR #42 in src/schema.ts', summary: 'done' }, { ...context, judge: async (_work, lessons) => { judged = lessons.map(h => h.lesson.id); return []; } });
  expect(judged).toEqual(['m-other']); expect(checked.markdown).toContain('Own-PR exclusion: #42');
});

test('Ask includes the exact named file symbols even when their names do not match the question tokens', async () => {
  const path = 'src/workos-invite-dialog.tsx';
  const map = { files: [{ path, lang: 'tsx', isTest: false }], symbols: ['InviteDialog', 'sendInvite', 'validateAddress', 'resetForm'].map(name => ({ path, name, kind: 'function', lines: '1-3', exported: true })), imports: [], outside: [] };
  const result = await buildChatContext('demo', 'What went wrong in workos-invite-dialog.tsx?', [], { context: deps(), codeMap: async () => map as never });
  for (const symbol of map.symbols) expect(result.context).toContain(symbol.name);
  expect(result.context).not.toContain('No code-map entry');
  expect(result.sources.filter(s => s.kind === 'code')).toHaveLength(4);
});
