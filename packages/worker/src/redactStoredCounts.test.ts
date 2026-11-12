import { expect, test } from 'vitest';
import type { Activity, ActivityInput } from '@fb/core';
import { REDACTION_CURSOR, redactStoredOnRuleChange, type RedactStoredDeps } from './redactStored.ts';

/** A store where only facts change (as given; null: none), with the Activity log's history. */
function deps(facts: { redacted: number; closed: number; owner: number; instructions: number } | null, history: Activity[] = [], last: string | null = null) {
  const m = new Map<string, string>(last ? [[REDACTION_CURSOR, last]] : []);
  const recorded: ActivityInput[] = [];
  const d: RedactStoredDeps = {
    cursors: { getCursor: async (k) => m.get(k) ?? null, setCursor: async (k, v) => void m.set(k, v) },
    facts: { redactStoredFacts: async () => facts ?? { redacted: 0, closed: 0, owner: 0, instructions: 0 }, reopenInstructionFacts: async () => 0 },
    docs: { redactStoredDocs: async () => 0 },
    knowledge: { redactStoredLessons: async () => ({ redacted: 0, flagged: 0 }), redactStoredMisses: async () => 0 },
    activity: { record: async (a) => void recorded.push(a), list: async () => history, redactStoredActivity: async () => 0 },
    log: () => {},
  };
  return { d, recorded };
}

const v2Entry = (details: Record<string, unknown>): Activity => ({
  id: 'act:1', ts: '2026-10-24T10:00:00.000Z', kind: 'secrets_redacted', actor: 'deterministic', projectKey: null, subject: 's', why: 'w', targets: [],
  details: { version: 2, ...details },
});

test('a store where no fact or document text changes counts nothing changed for them', async () => {
  const t = deps(null);
  expect(await redactStoredOnRuleChange(t.d)).toMatchObject({ facts: 0, closed: 0, ownerFacts: 0, instructionFacts: 0, chunks: 0 });
  expect(t.recorded).toEqual([]);
});

test('one fact of each kind is told in the singular', async () => {
  const t = deps({ redacted: 1, closed: 1, owner: 1, instructions: 1 });
  await redactStoredOnRuleChange(t.d);
  expect(t.recorded[0].why).toMatch(/1 fact that was a credential is no longer served/);
  expect(t.recorded[0].why).toMatch(/1 fact you wrote kept, with only a known token shape redacted in it/);
  expect(t.recorded[0].why).toMatch(/1 fact from an upload that was an instruction to the agent is no longer served/);
});

test('several facts of each kind are told in the plural', async () => {
  const t = deps({ redacted: 4, closed: 2, owner: 2, instructions: 2 });
  await redactStoredOnRuleChange(t.d);
  expect(t.recorded[0].why).toMatch(/2 facts that were credentials are no longer served/);
  expect(t.recorded[0].why).toMatch(/2 facts you wrote kept, with only a known token shape redacted in them/);
  expect(t.recorded[0].why).toMatch(/2 facts from an upload that were instructions to the agent are no longer served/);
});

test('after v2, what its own entry says it changed is told again, counting a damaged count as none', async () => {
  const docsOnly = deps(null, [v2Entry({ facts: 'many', factsClosed: null, chunks: 2 })], 'v2');
  await redactStoredOnRuleChange(docsOnly.d);
  expect(docsOnly.recorded[0].why).toMatch(/v2 had rewritten 0 facts \(0 of them closed as credentials\), 2 document texts and 0 lessons/);

  const lessonsOnly = deps(null, [v2Entry({ lessons: 3 })], 'v2');
  await redactStoredOnRuleChange(lessonsOnly.d);
  expect(lessonsOnly.recorded[0].details).toMatchObject({ v2: { facts: 0, factsClosed: 0, chunks: 0, lessons: 3 } });
});

test('after v2 with no entry of what it did, or one that changed nothing, there is nothing to tell', async () => {
  for (const history of [[], [v2Entry({ facts: 0, chunks: 0, lessons: 0 })]]) {
    const t = deps(null, history, 'v2');
    await redactStoredOnRuleChange(t.d);
    expect(t.recorded).toEqual([]);
  }
});
