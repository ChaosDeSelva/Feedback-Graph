import { describe, expect, test } from 'vitest';
import { draftOf, lessonOutcome, lessonQuality, editedDraft, ownerDecided } from './lessonOutcome.ts';
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
    // An operator acts on the owner's authority (the owner gave it the token): counted, and labelled in lessonQuality.
    expect(lessonOutcome(lesson({ status: 'rejected', decidedBy: 'operator:codex' }))).toBe('rejected');
  });
});

describe('ownerDecided', () => {
  test("you, an operator (named or not), or not recorded: the owner's; anything else: a machine", () => {
    for (const by of ['you', 'operator', 'operator:codex', null, undefined]) expect(ownerDecided(by)).toBe(true);
    for (const by of ['postmortem', 'session-match', 'detector', 'demo', 'operatorx']) expect(ownerDecided(by)).toBe(false);
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
    expect(lessonQuality(ls, 30, now)).toEqual({ days: 30, asWritten: 1, edited: 1, rejected: 1, decided: 3, byOperator: 1 });
    expect(lessonQuality(ls, 90, now)).toEqual({ days: 90, asWritten: 1, edited: 1, rejected: 2, decided: 4, byOperator: 1 });
  });
});
