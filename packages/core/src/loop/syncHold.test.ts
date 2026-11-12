import { expect, test } from 'vitest';
import { ABSENT } from '../decisions/record.ts';
import type { Lesson, TargetSnapshot } from '../types.ts';
import { heldIds, heldTargets, holdFacts, holdLessons } from './syncHold.ts';

const lesson = (id: string, o: Partial<Lesson> = {}): Lesson => ({
  id, projectKey: 'demo', title: 't', rule: 'now', appliesWhen: 'a', scope: 'project', paths: ['a.ts'], status: 'approved',
  source: 'postmortem', cause: null, missId: null, createdAt: '2026-10-01T00:00:00.000Z', decidedAt: '2026-11-10T00:00:00.000Z', ...o,
});
const ALL = { key: null, keys: null };
const NO_ORIGIN = new Map<string, string | null>();
const snap = (kind: TargetSnapshot['kind'], id: string, fields: Record<string, unknown>, fingerprint = 'f'): TargetSnapshot => ({ kind, id, fields, fingerprint });

test('each held target is exported from the before of its earliest held decision', () => {
  const held = heldTargets([
    { appliedAt: '2026-11-10T00:00:00.000Z', before: [snap('lesson', 'lesson:a', { rule: 'second' })], after: [snap('lesson', 'lesson:a', { rule: 'third' })] },
    { appliedAt: '2026-11-01T00:00:00.000Z', before: [snap('lesson', 'lesson:a', { rule: 'first' }), snap('fact', 'fact:x', {})], after: [snap('lesson', 'lesson:a', { rule: 'second' })] },
    { appliedAt: '2026-11-01T00:00:00.000Z', before: [snap('lesson', 'lesson:b', {})], after: [] },
  ]);
  expect(held.get('lesson:lesson:a')).toEqual({ before: snap('lesson', 'lesson:a', { rule: 'first' }), after: snap('lesson', 'lesson:a', { rule: 'third' }) });
  expect(heldIds(held, 'lesson')).toEqual(['lesson:a', 'lesson:b']);
  expect(heldIds(held, 'fact')).toEqual(['fact:x']);
});

test('lessons: held ones as they were (only the fields an export carries), a lesson the loop created left out; approvedOnly on the held status', () => {
  const held = heldTargets([{
    appliedAt: '2026-11-01T00:00:00.000Z',
    before: [
      snap('lesson', 'lesson:retired', { status: 'approved', rule: 'before', decidedBy: 'you', decidedAt: '2026-10-02T00:00:00.000Z' }),
      snap('lesson', 'lesson:approved', { status: 'proposed', decidedAt: null }),
      snap('lesson', 'lesson:split', {}, ABSENT),
    ],
    after: [
      snap('lesson', 'lesson:retired', { status: 'revoked', rule: 'now', decidedBy: 'loop:1' }),
      snap('lesson', 'lesson:approved', { status: 'approved', decidedAt: '2026-11-10T00:00:00.000Z' }),
      snap('lesson', 'lesson:split', { rule: 'now' }),
    ],
  }]);
  const lessons = [lesson('lesson:retired', { status: 'revoked' }), lesson('lesson:approved'), lesson('lesson:split'), lesson('lesson:other')];
  const shown = holdLessons(lessons, held, false, ALL, NO_ORIGIN);
  expect(shown.map((l) => [l.id, l.status, l.rule, l.decidedAt])).toEqual([
    ['lesson:retired', 'approved', 'before', '2026-10-02T00:00:00.000Z'],
    ['lesson:approved', 'proposed', 'now', null],
    ['lesson:other', 'approved', 'now', '2026-11-10T00:00:00.000Z'],
  ]);
  expect(shown[0]).not.toHaveProperty('decidedBy');
  expect(holdLessons(lessons, held, true, ALL, NO_ORIGIN).map((l) => l.id)).toEqual(['lesson:retired', 'lesson:other']);
  expect(holdLessons(lessons, new Map(), false, ALL, NO_ORIGIN)).toEqual(lessons);
});

test('facts: one the loop created (absent, or not current, before) is left out; one it changed is shown as it was', () => {
  const held = heldTargets([{
    appliedAt: '2026-11-01T00:00:00.000Z',
    before: [snap('fact', 'fact:new', {}, ABSENT), snap('fact', 'fact:closed', { current: false }), snap('fact', 'fact:changed', { statement: 'before', current: true })],
    after: [snap('fact', 'fact:new', { statement: 'now' }), snap('fact', 'fact:closed', { statement: 'now' }), snap('fact', 'fact:changed', { statement: 'now', current: true })],
  }]);
  const fact = (id: string) => ({ id, statement: 'now', path: 'a.ts' });
  expect(holdFacts(['fact:new', 'fact:closed', 'fact:changed', 'fact:other'].map(fact), held)).toEqual([
    { id: 'fact:changed', statement: 'before', path: 'a.ts' },
    { id: 'fact:other', statement: 'now', path: 'a.ts' },
  ]);
});

test('a held target changed since the loop left it (the owner revoked, rejected or edited it) is exported as it is now', () => {
  const held = heldTargets([{
    appliedAt: '2026-11-01T00:00:00.000Z',
    before: [snap('lesson', 'lesson:w', { status: 'approved', rule: 'now', servingWeight: null }), snap('fact', 'fact:f', { statement: 'before', current: true })],
    after: [snap('lesson', 'lesson:w', { status: 'approved', rule: 'now', servingWeight: 0.9 }), snap('fact', 'fact:f', { statement: 'loop', current: true })],
  }]);
  // The weight is not exported: a lesson the loop only re-weighted is as it left it until the owner changes it.
  expect(holdLessons([lesson('lesson:w')], held, true, ALL, NO_ORIGIN).map((l) => l.status)).toEqual(['approved']);
  expect(holdLessons([lesson('lesson:w', { status: 'revoked' })], held, true, ALL, NO_ORIGIN)).toEqual([]);
  expect(holdLessons([lesson('lesson:w', { rule: 'the owner\'s words' })], held, false, ALL, NO_ORIGIN).map((l) => l.rule)).toEqual(['the owner\'s words']);
  expect(holdFacts([{ id: 'fact:f', statement: 'loop' }], held)).toEqual([{ id: 'fact:f', statement: 'before' }]);
  expect(holdFacts([{ id: 'fact:f', statement: 'yours' }], held)).toEqual([{ id: 'fact:f', statement: 'yours' }]);
});

test('a held lesson is exported with its project as it was: one the loop moved to another project stays in its own export', () => {
  const was = snap('lesson', 'lesson:g', { projectKey: null, scope: 'global', status: 'approved', rule: 'now' });
  const held = heldTargets([{ appliedAt: '2026-11-01T00:00:00.000Z', before: [was], after: [snap('lesson', 'lesson:g', { projectKey: 'b', scope: 'project', status: 'approved', rule: 'now' })] }]);
  const moved = [lesson('lesson:g', { projectKey: 'b', scope: 'project' })];
  const origins = new Map([['lesson:g', 'a']]);
  expect(holdLessons(moved, held, true, { key: 'a', keys: null }, origins).map((l) => [l.id, l.projectKey, l.scope])).toEqual([['lesson:g', null, 'global']]);
  expect(holdLessons(moved, held, true, { key: 'b', keys: null }, origins)).toEqual([]);
  expect(holdLessons(moved, held, true, { key: null, keys: ['a'] }, origins).map((l) => l.id)).toEqual(['lesson:g']);
  expect(holdLessons(moved, held, true, { key: null, keys: ['b'] }, origins)).toEqual([]);
  expect(holdLessons(moved, new Map(), true, { key: 'b', keys: null }, origins).map((l) => l.projectKey)).toEqual(['b']);
});
