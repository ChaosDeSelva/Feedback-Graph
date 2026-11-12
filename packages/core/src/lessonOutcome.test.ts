import { describe, expect, test } from 'vitest';
import { LOOP_ACTOR, LOOP_BREAKER_ACTOR } from './loop/state.ts';
import { draftOf, lessonOutcome, lessonQuality, lessonQualityReport, editedDraft, ownerDecided } from './lessonOutcome.ts';
import type { Lesson } from './types.ts';

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  id: 'lesson:a', projectKey: 'acme', origin: 'acme', title: 'Server-side search', rule: 'Filter in api/search.ts on the server',
  appliesWhen: 'search features', scope: 'project', paths: ['api/search.ts'], status: 'approved', source: 'postmortem',
  cause: null, missId: null, createdAt: '2026-10-01T00:00:00.000Z', decidedAt: '2026-10-20T00:00:00.000Z', ...over,
});

describe('lessonOutcome', () => {
  test('approved with no recorded draft: as written', () => {
    expect(lessonOutcome(lesson())).toBe('as_written');
    expect(lessonOutcome(lesson({ proposedAs: null }))).toBe('as_written');
  });
  test('approved after the owner changed it: edited', () => {
    expect(lessonOutcome(lesson({ proposedAs: { ...draftOf(lesson()), rule: 'Always verify search' } }))).toBe('edited');
    expect(lessonOutcome(lesson({ proposedAs: { ...draftOf(lesson()), paths: [] } }))).toBe('edited');
    expect(lessonOutcome(lesson({ proposedAs: { ...draftOf(lesson()), scope: 'global' } }))).toBe('edited');
  });
  test('edited and changed back (or only whitespace): as written', () => {
    expect(lessonOutcome(lesson({ proposedAs: { ...draftOf(lesson()), rule: ' Filter in api/search.ts on the server ' } }))).toBe('as_written');
  });
  test('rejected; never decided, proposed or superseded: none', () => {
    expect(lessonOutcome(lesson({ status: 'rejected' }))).toBe('rejected');
    expect(lessonOutcome(lesson({ status: 'proposed' }))).toBeNull();
    expect(lessonOutcome(lesson({ status: 'superseded' }))).toBeNull();
    // Withdrawn because its feedback was rejected: not a decision on the lesson.
    expect(lessonOutcome(lesson({ status: 'rejected', decidedAt: null }))).toBeNull();
  });
  test('only post-mortem lessons count, never a sandbox run or the demo corpus', () => {
    expect(lessonOutcome(lesson({ source: 'memory' }))).toBeNull();
    expect(lessonOutcome(lesson({ source: 'demo' }))).toBeNull();
    expect(lessonOutcome(lesson({ sandbox: true }))).toBeNull();
  });
  test("only the owner's decisions count: a machine rejection (no miss, a detector, the session re-match) is none", () => {
    expect(lessonOutcome(lesson({ status: 'rejected', decidedBy: 'postmortem' }))).toBeNull();
    expect(lessonOutcome(lesson({ status: 'rejected', decidedBy: 'session-match' }))).toBeNull();
    expect(lessonOutcome(lesson({ status: 'rejected', decidedBy: 'you' }))).toBe('rejected');
    // Recorded before decidedBy was: the owner (only the UI decided then).
    expect(lessonOutcome(lesson({ status: 'rejected', decidedBy: null }))).toBe('rejected');
    // An operator acts on the owner's authority, but its decision is not the owner's judgement: none (counted apart).
    expect(lessonOutcome(lesson({ status: 'rejected', decidedBy: 'operator:codex' }))).toBeNull();
    expect(lessonOutcome(lesson({ status: 'approved', decidedBy: 'operator' }))).toBeNull();
  });
});

describe('ownerDecided', () => {
  test("you, an operator (named or not), or not recorded: the owner's; anything else: a machine", () => {
    for (const by of ['you', 'operator', 'operator:codex', null, undefined]) expect(ownerDecided(by)).toBe(true);
    for (const by of ['postmortem', 'session-match', 'detector', 'demo', 'operatorx']) expect(ownerDecided(by)).toBe(false);
  });
  test('the learning loop is never the owner: its decisions do not mark a lesson as yours nor teach the writer', () => {
    for (const by of [LOOP_ACTOR, LOOP_BREAKER_ACTOR, 'loop:2']) expect(ownerDecided(by)).toBe(false);
  });
});

describe('editedDraft', () => {
  const before = lesson({ status: 'proposed' });
  test('the writer\'s version, when a proposed lesson\'s words, paths or scope change', () => {
    expect(editedDraft(before, { rule: 'Run the search on the server in api/search.ts' })).toEqual(draftOf(before));
    expect(editedDraft(before, { paths: ['api/**'] })).toEqual(draftOf(before));
  });
  test('nothing when nothing changes, when only the status does, or when the lesson is no longer proposed', () => {
    expect(editedDraft(before, { rule: before.rule })).toBeNull();
    expect(editedDraft(before, { status: 'approved' })).toBeNull();
    expect(editedDraft(lesson({ status: 'approved' }), { rule: 'x' })).toBeNull();
  });
  test('the first draft is kept: a second edit does not replace it', () => {
    const first = { ...draftOf(before), rule: 'the writer said this' };
    expect(editedDraft({ ...before, proposedAs: first }, { rule: 'again' })).toBeNull();
  });
});

describe('lessonQuality', () => {
  const now = new Date('2026-10-25T00:00:00.000Z');
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  test('counts each outcome per window, decided inside it', () => {
    const ls = [
      lesson({ decidedAt: ago(1) }),
      lesson({ decidedAt: ago(2), proposedAs: { ...draftOf(lesson()), title: 'Old' } }),
      lesson({ decidedAt: ago(40), status: 'rejected' }),
      lesson({ decidedAt: ago(100), status: 'rejected' }),
      lesson({ decidedAt: ago(3), status: 'proposed' }),
      lesson({ decidedAt: ago(4), status: 'rejected', decidedBy: 'postmortem' }),
      lesson({ decidedAt: ago(5), status: 'rejected', decidedBy: 'operator:codex' }),
    ];
    // The operator's decision is counted apart, never in decided.
    expect(lessonQuality(ls, 30, now)).toEqual({ days: 30, asWritten: 1, edited: 1, rejected: 0, decided: 2, byOperator: 1 });
    expect(lessonQuality(ls, 90, now)).toEqual({ days: 90, asWritten: 1, edited: 1, rejected: 1, decided: 3, byOperator: 1 });
  });
});

describe('lessonQualityReport', () => {
  const now = new Date('2026-11-01T00:00:00.000Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  test('counts the 30- and 90-day windows overall and per project (origin when there is no project), skipping non-decisions', () => {
    const report = lessonQualityReport([
      lesson({ id: 'lesson:1', decidedAt: daysAgo(5) }),
      lesson({ id: 'lesson:2', status: 'rejected', decidedAt: daysAgo(60), decidedBy: 'operator:ci' }),
      lesson({ id: 'lesson:3', projectKey: null, origin: 'github.com/acme/web', decidedAt: daysAgo(10), proposedAs: { ...draftOf(lesson()), rule: 'other' } }),
      // not an owner decision: in neither the windows nor the projects
      lesson({ id: 'lesson:4', projectKey: 'other', status: 'rejected', decidedBy: 'postmortem', decidedAt: daysAgo(1) }),
    ], { now });
    const w = (days: number, asWritten: number, edited: number, rejected: number, byOperator = 0) =>
      ({ days, asWritten, edited, rejected, decided: asWritten + edited + rejected, byOperator });
    // lesson:2, the operator's rejection, is counted apart: not in rejected or decided.
    expect(report).toEqual({
      windows: [w(30, 1, 1, 0), w(90, 1, 1, 0, 1)],
      projects: { acme: [w(30, 1, 0, 0), w(90, 1, 0, 0, 1)], 'github.com/acme/web': [w(30, 0, 1, 0), w(90, 0, 1, 0)] },
    });
    expect(lessonQualityReport([], { now, capped: true })).toEqual({ windows: [w(30, 0, 0, 0), w(90, 0, 0, 0)], projects: {}, capped: true });
  });
});
