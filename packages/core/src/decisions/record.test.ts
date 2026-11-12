import { afterEach, expect, test } from 'vitest';
import { setRedactionArchive, type RedactionOriginal } from '../redactionArchive.ts';
import type { Decision, DecisionInput, Lesson } from '../types.ts';
import { canonicalJson, decisionId, factFingerprint, lessonFingerprint, prepareDecision, prepareNote, prepareRollback, prepareSnapshots, redactStoredDecision, TargetChangedError } from './record.ts';

const SECRET = `ghp_${'A1b2'.repeat(9)}`;
afterEach(() => setRedactionArchive(undefined));

const input: DecisionInput = {
  type: 'merge_duplicates', projectKey: 'demo',
  targets: [{ kind: 'lesson', id: 'lesson:keep', role: 'keeper' }, { kind: 'lesson', id: 'lesson:dup', role: 'merged' }],
  before: [], after: [], evidence: [{ kind: 'check', id: 'lesson:dup', role: 'duplicate-of cos .95', weight: 1, observedAt: '2026-11-01T00:00:00.000Z' }],
  features: { cosine: 0.95 }, score: 0.9, confidence: { p: 0.9, lower: 0.85, n: 20, band: 4 }, tier: 'H', mode: 'auto',
  rationale: 'same rule twice', model: 'deterministic', policyVersion: 1, status: 'proposed',
};

const lesson: Lesson = {
  id: 'lesson:1', projectKey: 'demo', title: 't', rule: 'r', appliesWhen: 'a', scope: 'project', paths: ['src/a.ts'],
  status: 'proposed', source: 'postmortem', cause: null, missId: null, createdAt: '2026-11-01T00:00:00.000Z', decidedAt: null,
};

test('canonicalJson sorts keys at every depth and writes undefined as null', () => {
  expect(canonicalJson({ b: [{ y: 1, x: undefined }], a: 'z' })).toBe('{"a":"z","b":[{"x":null,"y":1}]}');
  expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
});

test('decisionId depends on the type, targets as they were, what the evidence points at and the policy version, not on weights or order', () => {
  const was = (id: string, fingerprint: string) => ({ kind: 'lesson' as const, id, fields: { rule: fingerprint }, fingerprint });
  const at = { ...input, before: [was('lesson:keep', 'k1'), was('lesson:dup', 'd1')] };
  const id = decisionId(at);
  expect(id).toMatch(/^dec:[0-9a-f]{64}$/);
  const reordered: DecisionInput = { ...at, targets: [...at.targets].reverse(), before: [...at.before].reverse(), evidence: [{ ...at.evidence[0], weight: 0.2, observedAt: 'later' }], after: [was('lesson:keep', 'k9')] };
  expect(decisionId(reordered)).toBe(id);
  for (const other of [{ type: 'link_misses' as const }, { policyVersion: 2 }, { evidence: [] }, { targets: at.targets.slice(0, 1) }, { before: [was('lesson:keep', 'k2'), was('lesson:dup', 'd1')] }]) {
    expect(decisionId({ ...at, ...other })).not.toBe(id);
  }
  // The decisions it builds on count, in any order; none (or an empty list) is the id it had before dependsOn.
  expect(decisionId({ ...at, dependsOn: [] })).toBe(id);
  expect(decisionId({ ...at, dependsOn: ['dec:a', 'dec:b'] })).toBe(decisionId({ ...at, dependsOn: ['dec:b', 'dec:a'] }));
  expect(decisionId({ ...at, dependsOn: ['dec:a'] })).not.toBe(id);
  expect(decisionId({ ...at, dependsOn: ['dec:a'] })).not.toBe(decisionId({ ...at, dependsOn: ['dec:c'] }));
});

test('a fingerprint changes with a field a decision changes or restores, and not with anything else', () => {
  const fp = lessonFingerprint(lesson);
  expect(lessonFingerprint({ ...lesson, checks: [], checksVersion: 6, from: 'session' })).toBe(fp);
  expect(lessonFingerprint({ ...lesson, decidedBy: undefined })).toBe(fp); // unset reads as null
  for (const change of [{ status: 'approved' as const }, { rule: 'r2' }, { paths: [] }, { decisionNote: 'n' }, { id: 'lesson:2' }]) {
    expect(lessonFingerprint({ ...lesson, ...change })).not.toBe(fp);
  }
  const fact = { id: 'fact:1', kind: 'convention' as const, statement: 's', path: 'p', lines: null, relevance: 0.5, relevanceBy: 'model' as const, current: true };
  expect(factFingerprint({ ...fact })).toBe(factFingerprint(fact));
  expect(factFingerprint({ ...fact, current: false })).not.toBe(factFingerprint(fact));
  expect(factFingerprint({ ...fact, relevanceBy: 'you' })).not.toBe(factFingerprint(fact));
});

test('TargetChangedError says which target, what was expected and what it is now', () => {
  const e = new TargetChangedError('lesson:1', 'a', null);
  expect(e).toBeInstanceOf(Error);
  expect(e).toMatchObject({ name: 'TargetChangedError', targetId: 'lesson:1', expected: 'a', actual: null, message: 'lesson:1 changed since the decision\'s snapshot' });
});

test('prepareDecision redacts every text, keeps ids, fingerprints and numbers, dedupes dependsOn, and archives the original', async () => {
  const originals: RedactionOriginal[] = [];
  setRedactionArchive(async (r) => { originals.push(r); });
  const snap = { kind: 'lesson' as const, id: 'lesson:keep', fields: { rule: `token=${SECRET}`, paths: ['a'] }, fingerprint: 'c'.repeat(64) };
  const raw: DecisionInput = { ...input, before: [snap], after: [snap], rationale: `saw ${SECRET}`, model: `x:${SECRET}`, evidence: [{ ...input.evidence[0], role: SECRET }], dependsOn: ['dec:a', 'dec:a', 'dec:b'] };
  const out = await prepareDecision(raw);
  expect(out.id).toBe(decisionId(raw)); // the id is the caller's input's, so a later redaction rule never changes it
  expect(JSON.stringify(out)).not.toContain(SECRET);
  expect(out.before[0]).toEqual({ ...snap, fields: { rule: 'token=[REDACTED]', paths: ['a'] } });
  expect(out).toMatchObject({ rationale: 'saw [REDACTED]', model: 'x:[REDACTED]', dependsOn: ['dec:a', 'dec:b'], features: { cosine: 0.95 } });
  expect(originals).toHaveLength(1);
  expect(originals[0]).toMatchObject({ kind: 'decision-incoming' });

  const clean = await prepareDecision({ ...input, model: null });
  expect(clean).toMatchObject({ model: null, dependsOn: [] });
  expect(originals).toHaveLength(1); // nothing redacted: nothing archived
});

test('snapshots, rollbacks and notes written later are redacted the same way', async () => {
  const snap = { kind: 'fact' as const, id: 'fact:1', fields: { statement: `key ${SECRET}` }, fingerprint: 'd'.repeat(64) };
  expect((await prepareSnapshots('dec:1', [snap]))[0].fields).toEqual({ statement: 'key [REDACTED]' });
  const rollback = { at: 'now', by: 'you', reason: null, note: `oops ${SECRET}`, cascade: [] };
  expect(await prepareRollback('dec:1', rollback)).toEqual({ ...rollback, note: 'oops [REDACTED]' });
  expect(await prepareRollback('dec:1', { ...rollback, note: null })).toEqual({ ...rollback, note: null });
  const note = await prepareNote('dec:1', { by: 'you', text: `see ${SECRET}`, verdict: 'agree', reason: 'other' });
  expect(note).toEqual({ id: expect.stringMatching(/^dnote:/), decisionId: 'dec:1', ts: expect.any(String), by: 'you', text: 'see [REDACTED]', verdict: 'agree', reason: 'other' });
  expect(await prepareNote('dec:1', { by: 'you', text: 'ok' })).toMatchObject({ verdict: null, reason: null });
});

test('redactStoredDecision returns the decision with its texts redacted, or null when nothing changes', () => {
  const stored = { ...input, id: 'dec:1', rollback: null } as unknown as Decision;
  expect(redactStoredDecision(stored)).toBeNull();
  expect(redactStoredDecision({ ...stored, model: null })).toBeNull();
  const rolled = { ...stored, rollback: { at: 'now', by: 'you', reason: null, note: `has ${SECRET}`, cascade: [] } };
  expect(redactStoredDecision(rolled)).toEqual({ ...rolled, rollback: { ...rolled.rollback, note: 'has [REDACTED]' } });
  expect(redactStoredDecision({ ...rolled, rollback: { ...rolled.rollback, note: null } })).toBeNull();
});
