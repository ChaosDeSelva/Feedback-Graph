import { expect, test } from 'vitest';
import type { Lesson, LessonSignals } from '@fb/core';
import { applyTimeVeto, claimNeverTarget, lessonNeverTarget, missNeverTarget, ownerTouchedRecently } from './guards.ts';
import { loopMiss } from '../testing/context.ts';

const lesson = (o: Partial<Lesson> = {}): Lesson => ({
  id: 'lesson:1', projectKey: 'demo', title: 't', rule: 'r', appliesWhen: 'a', scope: 'project', paths: [], status: 'approved',
  source: 'postmortem', cause: null, missId: null, createdAt: '2026-10-01T00:00:00.000Z', decidedAt: null, ...o,
});

test('lessons the loop never targets', () => {
  expect(lessonNeverTarget(lesson())).toBeNull();
  expect(lessonNeverTarget(lesson({ source: 'memory', checks: [{ name: 'generic', why: 'w' }] }))).toBeNull();
  expect(lessonNeverTarget(lesson({ source: 'manual' }))).toBe('written by you');
  expect(lessonNeverTarget(lesson({ source: 'demo' }))).toBe('demo');
  expect(lessonNeverTarget(lesson({ sandbox: true }))).toBe('made in a run');
  expect(lessonNeverTarget(lesson({ run: 'r1' }))).toBe('made in a run');
  expect(lessonNeverTarget(lesson({ checks: [{ name: 'may-hold-secret', why: 'w' }] }))).toBe('may hold a secret');
  expect(lessonNeverTarget(lesson({ checks: [{ name: 'risky-command', why: 'w' }] }))).toBe('tells agents to run a risky command');
});

test('misses the loop never targets', () => {
  expect(missNeverTarget(loopMiss('miss:a'))).toBeNull();
  expect(missNeverTarget(loopMiss('miss:demo:demo:x'))).toBe('demo');
  expect(missNeverTarget(loopMiss('miss:a', { sandbox: true }))).toBe('made in a run');
  expect(missNeverTarget(loopMiss('miss:a', { run: 'r' }))).toBe('made in a run');
});

test('owner touched within 14 days', () => {
  const now = Date.parse('2026-11-15T00:00:00Z');
  const s = (lastOwnerTouch: string | null) => ({ lastOwnerTouch } as LessonSignals);
  expect(ownerTouchedRecently(null, now)).toBe(false);
  expect(ownerTouchedRecently(s(null), now)).toBe(false);
  expect(ownerTouchedRecently(s('2026-11-02T00:00:00Z'), now)).toBe(true);
  expect(ownerTouchedRecently(s('2026-11-01T00:00:00Z'), now)).toBe(false);
});

test('claims the loop never changes: a run\'s, your answer, an agent\'s notes, a loose quote, a statement that adds to its quote', async () => {
  const c = { run: null, sandbox: false, docId: 'doc:shop:intake:call', flags: [] as ('quote-fuzzy' | 'statement-adds')[] };
  expect(claimNeverTarget(c, { origin: 'weekly sync' })).toBeNull();
  expect(claimNeverTarget(c, null)).toBeNull();
  expect(claimNeverTarget({ ...c, run: 'r1' }, null)).toBe('made in a run');
  expect(claimNeverTarget({ ...c, docId: 'answer:question:1' }, null)).toBe('your answer to a question');
  expect(claimNeverTarget(c, { origin: 'agent:codex' })).toBe('from notes an agent submitted');
  expect(claimNeverTarget({ ...c, flags: ['quote-fuzzy'] }, null)).toBe('its quote matched the source only loosely');
  expect(claimNeverTarget({ ...c, flags: ['statement-adds'] }, null)).toBe('its statement adds to what was said');
  // At apply time too: a claim from an agent's notes is vetoed, so the call is only proposed.
  const store = { intake: { claim: async () => ({ ...c, id: 'claim:1' }), metas: async () => [{ origin: 'agent:codex' }] } } as never;
  expect(await applyTimeVeto(store, [{ kind: 'claim', id: 'claim:1', role: 'primary' }], 0)).toBe('claim:1: from notes an agent submitted');
});
