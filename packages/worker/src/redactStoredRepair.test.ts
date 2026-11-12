import { REDACTION_VERSION } from '@fb/core';
import { expect, test } from 'vitest';
import { REDACTION_CURSOR, redactStoredOnRuleChange, type RedactStoredDeps } from './redactStored.ts';

const NEEDED = 'redaction-v6-repair-needed';

/** Stores that change nothing, a repair whose candidate pages come from `pages`, and the cursors kept in `m`. */
function deps(m: Map<string, string>, pages: () => Promise<{ id: string; projectKey: string; path: string | null; docId: string | null }[]>) {
  const cursors = { getCursor: async (k: string) => m.get(k) ?? null, setCursor: async (k: string, v: string) => void m.set(k, v) };
  let repairs = 0;
  const d: RedactStoredDeps = {
    cursors,
    facts: { redactStoredFacts: async () => ({ redacted: 0, closed: 0, owner: 0, instructions: 0 }), reopenInstructionFacts: async () => 0 },
    docs: { redactStoredDocs: async () => 0 },
    knowledge: { redactStoredLessons: async () => ({ redacted: 0, flagged: 0 }), redactStoredMisses: async () => 0 },
    graph: { redactStoredCandidates: async () => 0 },
    activity: { record: async () => {}, list: async () => [], redactStoredActivity: async () => 0 },
    log: () => {},
    repair: {
      facts: { redactionRepairCandidates: async () => { repairs++; return pages(); }, requestFilesScan: async () => 0, requestScan: async () => 0 },
      docs: { ...cursors, queueRedactionRepair: async () => 0 },
      knowledge: { listLessons: async () => [], updateLesson: async () => ({ unscoped: false }), setLessonChecks: async () => true },
      projects: async () => [],
    },
  } as unknown as RedactStoredDeps;
  return { d, repairs: () => repairs };
}

test('an upgrade from an older rule set repairs v6 sources first; a repair cut short runs again at the next start', async () => {
  const m = new Map([[REDACTION_CURSOR, 'v6']]);
  let fail = true;
  const t = deps(m, async () => { if (fail) throw new Error('store went away'); return []; });
  await expect(redactStoredOnRuleChange(t.d)).rejects.toThrow('store went away');
  expect(m.get(NEEDED)).toBe('yes');
  expect(m.get(REDACTION_CURSOR)).toBe('v6');

  fail = false;
  await redactStoredOnRuleChange(t.d);
  expect(m.get(NEEDED)).toBe('done');
  expect(m.get(REDACTION_CURSOR)).toBe(`v${REDACTION_VERSION}`);

  // Current and repaired: neither runs again.
  const before = t.repairs();
  expect(await redactStoredOnRuleChange(t.d)).toBeNull();
  expect(t.repairs()).toBe(before);
});

test('a repair still marked needed runs even when the rules are already current', async () => {
  const m = new Map([[REDACTION_CURSOR, `v${REDACTION_VERSION}`], [NEEDED, 'yes']]);
  const t = deps(m, async () => []);
  expect(await redactStoredOnRuleChange(t.d)).toBeNull();
  expect(t.repairs()).toBe(1);
  expect(m.get(NEEDED)).toBe('done');
});

test('a new install (no rules run yet) has nothing to repair', async () => {
  const m = new Map<string, string>();
  const t = deps(m, async () => []);
  await redactStoredOnRuleChange(t.d);
  expect(t.repairs()).toBe(0);
  expect(m.has(NEEDED)).toBe(false);
});
