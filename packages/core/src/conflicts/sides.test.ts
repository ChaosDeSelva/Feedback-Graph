import { expect, test } from 'vitest';
import { citedVerdict, conflictKindOf, conflictPairKey, sameSource, scopesOverlap, type ConflictSideInfo } from './sides.ts';

const side = (id: string, over: Partial<ConflictSideInfo> = {}): ConflictSideInfo => ({
  ref: { kind: 'claim', id }, projectKey: 'shop', text: 'The retry timeout is 30 seconds.', citable: ['retry timeout is 30 seconds', 'The retry timeout is 30 seconds.'],
  about: 'retry timeout', area: null, files: [], assertedAt: '2026-11-02T10:00:00Z', speaker: 'person:ana', owner: false, type: 'fact', due: null, docId: 'doc:a',
  fingerprint: 'fp', ...over,
});
const none = () => false;

test('scopes overlap: same or linked project, or a global side, and then a shared subject, area or service', () => {
  const b = side('b', { text: 'Retries wait 60 seconds before giving up.', about: 'retries' });
  expect(scopesOverlap(side('a'), b, none)).toBe(true);
  expect(scopesOverlap(side('a'), { ...b, projectKey: 'billing' }, none)).toBe(false);
  expect(scopesOverlap(side('a'), { ...b, projectKey: 'billing' }, (x, y) => x === 'shop' && y === 'billing')).toBe(true);
  expect(scopesOverlap(side('a', { projectKey: null }), { ...b, projectKey: 'billing' }, none)).toBe(true);
  // Nothing in common but the project: no pair.
  const unrelated = side('c', { text: 'The dashboard uses a dark theme.', about: 'dashboard theme' });
  expect(scopesOverlap(side('a'), unrelated, none)).toBe(false);
  expect(scopesOverlap(side('a', { area: 'Payments' }), { ...unrelated, area: 'payments' }, none)).toBe(true);
  expect(scopesOverlap(side('a', { files: ['src/ledger/client.ts'] }), { ...unrelated, files: ['src/ledger/retry.ts'] }, none)).toBe(true);
  // A side's subject named in the other's text, though their about phrases differ.
  expect(scopesOverlap(side('a', { about: 'ledger client' }), side('d', { text: 'The ledger client retries 5 times.', about: 'retry count' }), none)).toBe(true);
});

test('a verdict counts only when it cites both sides verbatim; swapped citations are put back in order', () => {
  const [a, b] = [side('a'), side('b', { citable: ['retries wait 60 seconds'] })];
  const v = { relation: 'contradicts' as const, aQuote: 'timeout is 30 seconds', bQuote: 'wait 60 seconds' };
  expect(citedVerdict(v, a, b)).toEqual(v);
  expect(citedVerdict({ ...v, aQuote: v.bQuote, bQuote: v.aQuote }, a, b)).toEqual(v);
  expect(citedVerdict({ ...v, bQuote: 'wait 90 seconds' }, a, b)).toBeNull();
  expect(citedVerdict({ ...v, aQuote: '' }, a, b)).toBeNull();
  expect(citedVerdict({ ...v, relation: 'unrelated', aQuote: '', bQuote: '' }, a, b)).not.toBeNull();
});

test('time rules: a later decision or plan by the same speaker or the owner supersedes; anything else disagrees', () => {
  const older = side('a', { type: 'decision' });
  const later = side('b', { type: 'decision', assertedAt: '2026-11-16T10:00:00Z' });
  expect(conflictKindOf(later, older)).toMatchObject({ kind: 'supersession', newer: later, older });
  expect(conflictKindOf(older, { ...later, speaker: 'person:bo' }).kind).toBe('disagreement');
  expect(conflictKindOf(older, { ...later, speaker: 'person:bo', owner: true }).kind).toBe('supersession');
  expect(conflictKindOf(older, { ...later, type: 'fact' }).kind).toBe('disagreement');
  expect(conflictKindOf(older, { ...later, assertedAt: null })).toEqual({ kind: 'disagreement', newer: null, older: null });
  // A plan whose date had passed by the later statement.
  const plan = side('p', { type: 'plan', due: '2026-11-10', speaker: 'person:cy' });
  expect(conflictKindOf(plan, { ...later, type: 'fact', speaker: 'person:bo' }).kind).toBe('supersession');
});

test('the pair key ignores order and changes when either side changes', () => {
  const [a, b] = [side('a'), side('b')];
  expect(conflictPairKey(a, b)).toBe(conflictPairKey(b, a));
  expect(conflictPairKey(a, { ...b, fingerprint: 'fp2' })).not.toBe(conflictPairKey(a, b));
  expect(conflictPairKey(a, b)).toMatch(/^conflict-pair:[0-9a-f]{40}$/);
});

test('two claims of one source are the same source; a claim and a fact never are', () => {
  expect(sameSource(side('a'), side('b'))).toBe(true);
  expect(sameSource(side('a'), side('b', { docId: 'doc:b' }))).toBe(false);
  expect(sameSource(side('a'), side('f', { ref: { kind: 'fact', id: 'f' } }))).toBe(false);
});
