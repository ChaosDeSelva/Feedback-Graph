import { expect, test } from 'vitest';
import type { Lesson, LessonSignals } from '@fb/core';
import { lessonNeverTarget, missNeverTarget, ownerTouchedRecently } from './guards.ts';
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
