import { describe, expect, test } from 'vitest';
import type { LessonSignals, LoopMiss } from '@fb/core';
import { activity, axis, loopMiss, relatedOf } from './testing/context.ts';
import { admissible, isDemoId, pruneSessions, readSessions, SignalFold, type SessionMemory } from './signals.ts';

const memoryCursors = (v: Record<string, string> = {}) => ({ getCursor: async (k: string) => v[k] ?? null });

function fold(o: { stored?: Record<string, LessonSignals>; misses?: LoopMiss[]; sessions?: SessionMemory } = {}) {
  const misses = o.misses ?? [];
  return new SignalFold({
    decisions: {
      signals: async (id) => o.stored?.[id] ?? null,
      signalsOf: async (ids) => ids.flatMap((id) => o.stored?.[id] ?? []),
      loopMisses: async (ids) => misses.filter((m) => ids.includes(m.id)),
    },
    knowledge: { relatedMisses: async () => misses.map(relatedOf) },
    sessions: o.sessions ?? {},
  });
}
const counts = async (f: SignalFold, id: string) => (await f.get(id))?.counts;

describe('admissible', () => {
  const inScope = (k: string | null) => k === null || k === 'demo';
  test('runs, sandboxes, unselected folders, projects out of scope and the loop\'s own entries are left out', () => {
    expect(admissible(activity('context_served'), inScope)).toBe(true);
    expect(admissible(activity('context_served', { projectKey: null }), inScope)).toBe(true);
    expect(admissible(activity('context_served', { run: 'r' }), inScope)).toBe(false);
    expect(admissible(activity('context_served', { sandbox: true }), inScope)).toBe(false);
    expect(admissible(activity('context_served', { projectKey: null, details: { globalOnly: true } }), inScope)).toBe(false);
    expect(admissible(activity('context_served', { projectKey: 'other' }), inScope)).toBe(false);
    expect(admissible(activity('decision_made', { actor: 'loop:1' }), inScope)).toBe(false);
    expect(admissible(activity('decision_made', { actor: 'you' }), inScope)).toBe(true);
  });
  test('demo ids', () => {
    expect(['demo:p:x', 'lesson:demo:p:x', 'miss:demo:p:y', 'lesson:a'].map(isDemoId)).toEqual([true, true, true, false]);
  });
});

describe('SignalFold', () => {
  test('served: counts per lesson, sessions once each, the last time served; demo lessons are skipped', async () => {
    const f = fold({ stored: { 'lesson:a': { lessonId: 'lesson:a', counts: { served: 4 } as LessonSignals['counts'], lastServed: 'x', lastOwnerTouch: 'y', updatedAt: 'z' } } });
    const served = (ts: string, session?: string) => activity('context_served', {
      ts, details: { lessons: [{ id: 'lesson:a' }, { id: 'lesson:b' }, { id: 'demo:p:l' }], misses: [{ id: 'miss:m' }] },
      targets: ['lesson:a', 'lesson:b', 'demo:p:l', 'miss:m', ...(session ? [session] : [])],
    });
    await f.fold(served('2026-11-01T00:00:00.000Z', 's1'));
    await f.fold(served('2026-11-02T00:00:00.000Z', 's1'));
    await f.fold(served('2026-11-03T00:00:00.000Z'));
    expect(await counts(f, 'lesson:a')).toMatchObject({ served: 7, sessionsServed: 1, addressed: 0 });
    expect((await f.get('lesson:a'))?.lastServed).toBe('2026-11-03T00:00:00.000Z');
    expect((await f.get('lesson:a'))?.lastOwnerTouch).toBe('y');
    expect(await counts(f, 'lesson:b')).toMatchObject({ served: 3, sessionsServed: 1 });
    expect(f.rows().map((r) => r.lessonId).sort()).toEqual(['lesson:a', 'lesson:b']);
    expect(f.sessions.s1.served).toEqual(['lesson:a', 'lesson:b']);
    expect(await f.get('lesson:none')).toBeNull();
  });

  test('a fold of the unselected-folder shape (lesson ids as strings) reads them too', async () => {
    const f = fold();
    await f.fold(activity('context_served', { details: { lessons: ['lesson:g', 7] }, targets: ['lesson:g'] }));
    expect(await counts(f, 'lesson:g')).toMatchObject({ served: 1, sessionsServed: 0 });
  });

  test('verdicts, and a gap fixed later in the same session', async () => {
    const f = fold();
    const check = (verdicts: { lessonId: string; status: string }[], o: { session?: string; notJudged?: boolean } = {}) =>
      activity('predone_check', { details: { verdicts, ...(o.notJudged && { notJudged: true }) }, targets: [...verdicts.map((v) => v.lessonId), ...(o.session ? [o.session] : [])] });
    await f.fold(check([{ lessonId: 'lesson:a', status: 'not_addressed' }, { lessonId: 'lesson:b', status: 'not_applicable' }, { lessonId: 'miss:x', status: 'not_addressed' }], { session: 's1' }));
    await f.fold(check([{ lessonId: 'lesson:a', status: 'not_addressed' }], { session: 's1' }));
    await f.fold(check([{ lessonId: 'lesson:a', status: 'addressed' }, { lessonId: 'lesson:b', status: 'cannot_tell' }, { lessonId: 'demo:p:l', status: 'addressed' }], { session: 's1' }));
    await f.fold(check([{ lessonId: 'lesson:a', status: 'addressed' }], { session: 's1' }));
    await f.fold(check([{ lessonId: 'lesson:a', status: 'not_addressed' }]));
    await f.fold(check([{ lessonId: 'lesson:a', status: 'weird' }]));
    await f.fold(check([{ lessonId: 'lesson:a', status: 'addressed' }], { notJudged: true }));
    await f.fold(activity('predone_check', { details: { verdicts: 'x' } }));
    expect(await counts(f, 'lesson:a')).toMatchObject({ addressed: 2, notAddressed: 3, gapsFixed: 1 });
    expect(await counts(f, 'lesson:b')).toMatchObject({ notApplicable: 1, cannotTell: 1, agentNotApplicable: 2 });
    expect(await f.get('miss:x')).toBeNull();
    expect(f.sessions.s1.gaps).toEqual([]);
  });

  test('a verdict on a lesson judged only through its trigger on other files is not counted', async () => {
    const f = fold();
    await f.fold(activity('predone_check', { details: { verdicts: [{ lessonId: 'lesson:c', status: 'not_applicable', triggerOnly: true }, { lessonId: 'lesson:c', status: 'addressed' }] }, targets: ['lesson:c'] }));
    expect(await counts(f, 'lesson:c')).toMatchObject({ addressed: 1, notApplicable: 0, agentNotApplicable: 0 });
  });

  test('the owner\'s edits and rejects, and when the owner last touched it; others\' decisions do not count', async () => {
    const f = fold();
    await f.fold(activity('lesson_decided', { actor: 'you', ts: '2026-11-01T00:00:00.000Z', subject: 'edited lesson "x"', details: { changed: { rule: { from: 'a', to: 'b' } } }, targets: ['lesson:a'] }));
    await f.fold(activity('lesson_decided', { actor: 'you', ts: '2026-11-02T00:00:00.000Z', subject: 'rejected lesson "x"', details: { changed: {} }, targets: ['lesson:a'] }));
    await f.fold(activity('lesson_decided', { actor: 'postmortem', subject: 'rejected lesson "x"', targets: ['lesson:a'] }));
    await f.fold(activity('lesson_decided', { actor: 'you', subject: 'approved lesson', targets: ['demo:p:x'] }));
    expect(await counts(f, 'lesson:a')).toMatchObject({ ownerEdits: 1, ownerRejects: 1 });
    expect((await f.get('lesson:a'))?.lastOwnerTouch).toBe('2026-11-02T00:00:00.000Z');
    expect(await f.get('demo:p:x')).toBeNull();
  });

  test('repeats: served in the session (ineffective) or not (retrieval gap), and owner pushback on a served lesson', async () => {
    const misses = [
      loopMiss('miss:new', { sessionId: 's1', createdAt: '2026-11-05T00:00:00.000Z' }),
      loopMiss('miss:served', { createdAt: '2026-10-01T00:00:00.000Z' }),
      loopMiss('miss:unserved', { createdAt: '2026-10-01T00:00:00.000Z', embedding: axis(0, 0.1) }),
      loopMiss('miss:near', { createdAt: '2026-10-01T00:00:00.000Z', embedding: axis(0, 0.7) }),
      loopMiss('miss:later', { createdAt: '2026-11-06T00:00:00.000Z' }),
      loopMiss('miss:far', { createdAt: '2026-10-01T00:00:00.000Z', embedding: axis(4) }),
      loopMiss('miss:flat', { embedding: null }),
      loopMiss('miss:demo:p:z'),
    ];
    const f = fold({ misses, sessions: { s1: { ts: '2026-11-05T00:00:00.000Z', served: ['lesson:served', 'lesson:near'], gaps: [] } } });
    await f.fold(activity('postmortem_done', { targets: ['new', 'miss:new', 'lesson:new'] }));
    expect(await counts(f, 'lesson:served')).toMatchObject({ repeatServed: 1, ownerPushbackAfter: 1, repeatUnserved: 0 });
    expect(await counts(f, 'lesson:unserved')).toMatchObject({ repeatUnserved: 1, ownerPushbackAfter: 0 });
    // cos ≈ .82: pushback on a served lesson, but not a repeat.
    expect(await counts(f, 'lesson:near')).toMatchObject({ repeatServed: 0, ownerPushbackAfter: 1 });
    expect(await f.get('lesson:later')).toBeNull();
    expect(await f.get('lesson:far')).toBeNull();
    // No miss, a demo miss, a miss gone or without an embedding: nothing.
    await f.fold(activity('postmortem_done', { targets: ['x'] }));
    await f.fold(activity('postmortem_done', { targets: ['miss:demo:p:z'] }));
    await f.fold(activity('postmortem_done', { targets: ['miss:gone'] }));
    await f.fold(activity('postmortem_done', { targets: ['miss:flat'] }));
    await f.fold(activity('scan_started'));
    expect(f.rows().map((r) => r.lessonId).sort()).toEqual(['lesson:near', 'lesson:served', 'lesson:unserved']);
  });

  test('a miss with no session counts every repeat as unserved', async () => {
    const f = fold({ misses: [loopMiss('miss:new', { sessionId: null, createdAt: '2026-11-05T00:00:00.000Z' }), loopMiss('miss:old')] });
    await f.fold(activity('postmortem_done', { targets: ['miss:new'] }));
    expect(await counts(f, 'lesson:old')).toMatchObject({ repeatUnserved: 1 });
  });
});

test('sessions: read back, pruned to the last 14 days and the newest 2000', async () => {
  expect(await readSessions(memoryCursors())).toEqual({});
  expect(await readSessions(memoryCursors({ 'loop-sessions': '{' }))).toEqual({});
  expect(await readSessions(memoryCursors({ 'loop-sessions': '[]' }))).toEqual({});
  expect(await readSessions(memoryCursors({ 'loop-sessions': '{"s":{"ts":"t","served":[],"gaps":[]}}' }))).toEqual({ s: { ts: 't', served: [], gaps: [] } });
  const now = Date.parse('2026-11-30T00:00:00Z');
  const s: SessionMemory = { old: { ts: '2026-11-01T00:00:00.000Z', served: [], gaps: [] } };
  for (let i = 0; i < 2005; i++) s[`s${i}`] = { ts: new Date(now - i * 1000).toISOString(), served: [], gaps: [] };
  const kept = pruneSessions(s, now);
  expect(Object.keys(kept)).toHaveLength(2000);
  expect(kept.old).toBeUndefined();
  expect(kept.s0).toBeDefined();
  expect(kept.s2004).toBeUndefined();
});
