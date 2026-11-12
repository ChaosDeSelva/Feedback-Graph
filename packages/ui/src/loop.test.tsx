import { expect, test } from 'vitest';
import { confidenceLine, decisionsCsv, decisionTitle, decisionTone, eventLabel, eventTone, fieldDiff, modeHint, modeShort, rate, reasonLabel, showValue, tierLabel, trackLabel, trackTone, typeLabel } from './loop.ts';
import { decision } from './testing/loop.ts';

test('every lookup names a known value and reads an unknown one as itself, never as an Object.prototype member', () => {
  expect([typeLabel('merge_duplicates'), typeLabel('dream_up'), typeLabel('constructor')]).toEqual(['merge duplicates', 'dream up', 'constructor']);
  expect([decisionTone('applied'), decisionTone('overridden'), decisionTone('pondering'), decisionTone('toString')]).toEqual(['ok', 'accent', 'neutral', 'neutral']);
  expect([modeHint('observe'), modeHint('turbo')]).toEqual(['records what it would do, changes nothing', 'a mode this page does not know']);
  expect([modeShort('auto'), modeShort('turbo')]).toEqual(['applies what it has earned', 'unknown mode']);
  expect([tierLabel('A'), tierLabel('Z')]).toEqual(['agent-facing', 'Z']);
  expect([eventLabel('decision_rolled_back'), eventLabel('loop_dreamed')]).toEqual(['rolled back', 'loop dreamed']);
  expect([eventTone('decision_applied'), eventTone('decision_noted'), eventTone('loop_dreamed')]).toEqual(['ok', 'neutral', 'neutral']);
  expect([reasonLabel('too_broad'), reasonLabel('bored_now')]).toEqual(['too broad', 'bored now']);
  expect([trackLabel('gap_fixed'), trackLabel('owner'), trackLabel('rumour_heard')]).toEqual(['gap fixed', 'you', 'rumour heard']);
  expect([trackTone('repeat'), trackTone('served'), trackTone('rumour')]).toEqual(['bad', 'neutral', 'neutral']);
});

test('rates and confidence read as sentences', () => {
  expect(rate(1, 8)).toBe('1 of 8 (13%)');
  expect(rate(0, 0)).toBe('none yet');
  expect(confidenceLine({ p: 0.934, lower: 0.9, n: 1 })).toBe('p 0.93 (lower 0.90), earned from 1 of your review');
  expect(confidenceLine({ p: 0.5, lower: 0.2, n: 0 })).toBe('p 0.50 (lower 0.20), earned from 0 of your reviews');
});

test('a decision is named by its primary target, else its first, else its type', () => {
  expect(decisionTitle({ type: 'merge_duplicates', targets: [{ kind: 'lesson', id: 'a', role: 'merged' }, { kind: 'lesson', id: 'b', role: 'keeper' }] })).toBe('merge duplicates · a');
  expect(decisionTitle({ type: 'tune_threshold', targets: [] })).toBe('tune threshold');
});

test('the diff lists fields changed by the decision and fields changed since, per target', () => {
  const s = (id: string, fields: Record<string, unknown>) => ({ kind: 'lesson' as const, id, fields, fingerprint: id });
  const rows = fieldDiff(
    [s('a', { status: 'approved', title: 'T', weight: 1 })],
    [s('a', { status: 'revoked', title: 'T', weight: 1 }), s('new', { rule: 'R' })],
    [s('a', { status: 'revoked', title: 'T2', weight: 1 })],
  );
  expect(rows).toEqual([
    { target: 'a', field: 'status', before: 'approved', after: 'revoked', now: 'revoked', nowKnown: true },
    { target: 'a', field: 'title', before: 'T', after: 'T', now: 'T2', nowKnown: true },
    { target: 'new', field: 'rule', before: undefined, after: 'R', now: undefined, nowKnown: false },
  ]);
  expect(fieldDiff([s('gone', { x: 1 })], [], [])).toEqual([{ target: 'gone', field: 'x', before: 1, after: undefined, now: undefined, nowKnown: false }]);
});

test('values show as text, absent ones as a dash', () => {
  expect([showValue(undefined), showValue(null), showValue('x'), showValue(0.5), showValue(['a', 'b']), showValue([]), showValue([1]), showValue({ a: 1 })]).toEqual(['–', '–', 'x', '0.5', 'a, b', '(none)', '[1]', '{"a":1}']);
});

test('the CSV export quotes what needs quoting and leaves the rest bare', () => {
  const csv = decisionsCsv([decision('dec:1', { rationale: 'said "no", then\nyes', decidedBy: undefined })]).split('\r\n');
  expect(csv[0]).toBe('id,type,status,projectKey,mode,tier,p,lower,n,band,targets,createdAt,appliedAt,decidedAt,decidedBy,model,policyVersion,rationale');
  expect(csv[1]).toBe('dec:1,retire_lesson,applied,demo-shop,auto,H,0.93,0.9,34,4,primary:lesson:lesson:demo-shop:1,2026-11-09T12:00:00Z,2026-11-09T12:00:01Z,2026-11-09T12:00:01Z,,,1,"said ""no"", then\nyes"');
});
