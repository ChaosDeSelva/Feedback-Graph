import { expect, test } from 'vitest';
import { INTAKE_REDACTION_VERSION, REDACTION_VERSION, type ActivityInput } from '@fb/core';
import { INTAKE_REDACTION_CURSOR, redactStoredIntakeOnRuleChange, type IntakeRedactedCounts, type RedactStoredIntakeDeps } from './redactStored.ts';

const STAMP = `v${REDACTION_VERSION}.i${INTAKE_REDACTION_VERSION}`;

function deps(counts: IntakeRedactedCounts, cursor: string | null = null) {
  const m = new Map<string, string>(cursor ? [[INTAKE_REDACTION_CURSOR, cursor]] : []);
  const recorded: ActivityInput[] = [];
  let runs = 0;
  const d: RedactStoredIntakeDeps = {
    cursors: { getCursor: async (k) => m.get(k) ?? null, setCursor: async (k, v) => void m.set(k, v) },
    intake: { redactStoredIntake: async () => { runs++; return counts; } },
    activity: { record: async (a) => { recorded.push(a); } },
  };
  return { d, m, recorded, runs: () => runs };
}

test('runs once per pair of rule versions and says what changed, never the text', async () => {
  const t = deps({ sources: 2, claims: 1, questions: 0 });
  expect(await redactStoredIntakeOnRuleChange(t.d)).toEqual({ sources: 2, claims: 1, questions: 0 });
  expect(t.m.get(INTAKE_REDACTION_CURSOR)).toBe(STAMP);
  expect(t.recorded).toHaveLength(1);
  expect(t.recorded[0]).toMatchObject({ kind: 'secrets_redacted', actor: 'deterministic', projectKey: null });
  expect(t.recorded[0].subject).toBe(`intake redaction rules ${STAMP} applied to stored intake: 2 intake sources, 1 claim changed`);
  expect(t.recorded[0].why).toMatch(/^intake stored before redaction rules/);
  expect(t.recorded[0].details).toEqual({ version: REDACTION_VERSION, intakeVersion: INTAKE_REDACTION_VERSION, previous: null, sources: 2, claims: 1, questions: 0 });
  // The next start: nothing to do.
  expect(await redactStoredIntakeOnRuleChange(t.d)).toBeNull();
  expect(t.runs()).toBe(1);
});

test('a change of either rule set runs it again; nothing changed records nothing', async () => {
  const t = deps({ sources: 0, claims: 0, questions: 0 }, `v${REDACTION_VERSION - 1}.i${INTAKE_REDACTION_VERSION}`);
  expect(await redactStoredIntakeOnRuleChange(t.d)).toEqual({ sources: 0, claims: 0, questions: 0 });
  expect(t.recorded).toEqual([]);
  expect(t.m.get(INTAKE_REDACTION_CURSOR)).toBe(STAMP);
});

test('an earlier stamp is named in why', async () => {
  const t = deps({ sources: 0, claims: 0, questions: 1 }, 'v1.i0');
  await redactStoredIntakeOnRuleChange(t.d);
  expect(t.recorded[0].why).toMatch(/^the redaction rules changed \(v1\.i0 to /);
  expect(t.recorded[0].subject).toMatch(/1 question changed$/);
});

test('a failure leaves the old stamp, so the next start runs it again', async () => {
  const t = deps({ sources: 0, claims: 0, questions: 0 }, 'v1.i0');
  t.d.intake.redactStoredIntake = async () => { throw new Error('store down'); };
  await expect(redactStoredIntakeOnRuleChange(t.d)).rejects.toThrow('store down');
  expect(t.m.get(INTAKE_REDACTION_CURSOR)).toBe('v1.i0');
});
