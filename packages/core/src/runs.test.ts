import { expect, test } from 'vitest';
import { runItems, runRemoval, runWriteOwner } from './runs.ts';
import { docIdOf } from './graph/docs.ts';
import { linkEnds, linkIdOf } from './graph/links.ts';
import { NotTheRunsError } from './types.ts';

const row = (kind: string, id: string, o: { merged?: boolean; sandbox?: boolean } = {}) =>
  ({ kind, id, projectKey: 'shop', sandbox: !!o.sandbox, merged: !!o.merged }) as Parameters<typeof runItems>[0][number];

test("runItems: a lesson and a miss name their report as group, take its merged flag, and sort by kind then id", () => {
  const items = runItems([
    row('chat', 'chat:1'), row('lesson', 'lesson:manual:b'), row('miss', 'miss:manual:b'), row('feedback', 'manual:b', { merged: true }),
    row('feedback', 'manual:a'), row('lesson', 'lesson:manual:a'),
  ]);
  expect(items.map((i) => [i.kind, i.id, i.group, i.merged])).toEqual([
    ['feedback', 'manual:a', null, false], ['feedback', 'manual:b', null, true],
    ['lesson', 'lesson:manual:a', 'manual:a', false], ['lesson', 'lesson:manual:b', 'manual:b', true],
    ['miss', 'miss:manual:b', 'manual:b', true],
    ['chat', 'chat:1', null, false],
  ]);
});

test('runRemoval: a kept report keeps its lesson and miss (whichever id was kept), a merged one is never removed, the rest goes', () => {
  const items = runItems([
    row('feedback', 'manual:a'), row('lesson', 'lesson:manual:a'), row('miss', 'miss:manual:a'),
    row('feedback', 'manual:b'), row('lesson', 'lesson:manual:b'), row('miss', 'miss:manual:b'),
    row('feedback', 'manual:c', { merged: true }), row('lesson', 'lesson:manual:c'),
    row('doc', 'doc:shop:upload:a.md'), row('doc', 'doc:shop:upload:b.md'), row('link', 'link:shop|web'),
  ]);
  expect(runRemoval(items, ['lesson:manual:b', 'doc:shop:upload:b.md'])).toEqual({
    feedback: ['manual:a'], lesson: ['lesson:manual:a'], miss: ['miss:manual:a'],
    predone_check: [], fact: [], doc: ['doc:shop:upload:a.md'], link: ['link:shop|web'], chat: [],
  });
  expect(runRemoval([], [])).toEqual({ feedback: [], lesson: [], miss: [], predone_check: [], fact: [], doc: [], link: [], chat: [] });
});

test("a run's write owns a new record or its own; over the owner's or another run's it throws, unless the owner opened a non-sandbox run (then it is the owner's)", () => {
  const run = { id: 'run-1', sandbox: false };
  const sbx = { id: 'sbx-1', sandbox: true };
  expect(runWriteOwner('x', undefined, run)).toBe(run);
  expect(runWriteOwner('x', 'run-1', run)).toBe(run);
  expect(() => runWriteOwner('x', null, run)).toThrow(NotTheRunsError);
  expect(() => runWriteOwner('x', 'run-2', run)).toThrow(/not run run-1's/);
  expect(runWriteOwner('x', null, run, true)).toBeNull();
  expect(() => runWriteOwner('x', null, sbx, true)).toThrow(NotTheRunsError);
  // No run: the owner's write, which makes any record the owner's.
  expect(runWriteOwner('x', 'run-1', null)).toBeNull();
});

test("a sandbox run's document and link ids are its own, and still name the project and both ends", () => {
  const d = { projectKey: 'shop', source: 'upload' as const, ref: 'notes:v2.md' };
  expect(docIdOf(d)).toBe('doc:shop:upload:notes:v2.md');
  expect(docIdOf(d, { id: 'run-1', sandbox: false })).toBe('doc:shop:upload:notes:v2.md');
  const own = docIdOf(d, { id: 'sbx-1', sandbox: true });
  expect(own).toBe('doc@sbx-1:shop:upload:notes:v2.md');
  expect(own.split(':')[1]).toBe('shop');
  expect(own.split(':').slice(3).join(':')).toBe('notes:v2.md');
  expect(linkIdOf('web', 'shop', { id: 'sbx-1', sandbox: true })).toBe('link@sbx-1:shop|web');
  expect(linkEnds('link@sbx-1:shop|web')).toEqual(['shop', 'web']);
  expect(linkEnds(linkIdOf('web', 'shop'))).toEqual(['shop', 'web']);
  expect(linkEnds('doc:shop')).toBeNull();
});
