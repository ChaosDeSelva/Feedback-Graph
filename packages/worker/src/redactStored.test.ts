import { describe, expect, test } from 'vitest';
import { REDACTION_VERSION, type Activity, type ActivityInput } from '@fb/core';
import { REDACTION_CURSOR, redactStoredOnRuleChange, type RedactStoredDeps } from './redactStored.ts';

function kv() {
  const m = new Map<string, string>();
  return { m, getCursor: async (k: string) => m.get(k) ?? null, setCursor: async (k: string, v: string) => void m.set(k, v) };
}

const logged = (over: Partial<Activity>): Activity => ({
  id: 'act:1', ts: '2026-10-24T10:00:00.000Z', kind: 'secrets_redacted', actor: 'deterministic', projectKey: null,
  subject: 's', why: 'w', details: {}, targets: [], ...over,
});

function deps(over: Partial<RedactStoredDeps> = {}, history: Activity[] = []) {
  const cursors = kv();
  const activity: ActivityInput[] = [];
  const calls: string[] = [];
  const logs: [string, object | undefined][] = [];
  const d: RedactStoredDeps = {
    cursors,
    facts: { redactStoredFacts: async () => { calls.push('facts'); return { redacted: 3, closed: 2, owner: 1 }; } },
    docs: { redactStoredDocs: async () => { calls.push('docs'); return 4; } },
    knowledge: {
      redactStoredLessons: async () => { calls.push('lessons'); return 1; },
      redactStoredMisses: async () => { calls.push('misses'); return 2; },
    },
    graph: { redactStoredCandidates: async () => { calls.push('candidates'); return 5; } },
    sessions: { redactStoredSummaries: async () => { calls.push('sessions'); return 1; } },
    activity: {
      record: async (a) => { activity.push(a); },
      list: async (q) => { calls.push(`list:${q.kind}`); return history; },
      redactStoredActivity: async () => { calls.push('activity'); return 6; },
    },
    log: (msg, extra) => { logs.push([msg, extra]); },
    ...over,
  };
  return { d, cursors, activity, calls, logs };
}

const ALL = { facts: 3, closed: 2, ownerFacts: 1, chunks: 4, lessons: 1, misses: 2, candidates: 5, sessions: 1, activity: 6 };

describe('redactStoredOnRuleChange', () => {
  test('runs the current rules once over every kind of stored text and says, per kind, what changed', async () => {
    const t = deps();
    expect(await redactStoredOnRuleChange(t.d)).toEqual(ALL);
    // The Activity log is redacted before the entry about it is written.
    expect(t.calls).toEqual(['facts', 'docs', 'lessons', 'misses', 'candidates', 'sessions', 'activity']);
    expect(t.cursors.m.get(REDACTION_CURSOR)).toBe(`v${REDACTION_VERSION}`);
    expect(t.activity).toHaveLength(1);
    expect(t.activity[0]).toMatchObject({ kind: 'secrets_redacted', actor: 'deterministic', projectKey: null });
    expect(t.activity[0].subject).toBe(`redaction rules v${REDACTION_VERSION} applied to stored data: 3 facts, 4 document texts, 1 lesson, 2 misses, 5 Inbox items, 1 session summary, 6 Activity entries changed`);
    expect(t.activity[0].why).toMatch(/2 facts that were credentials are no longer served/);
    expect(t.activity[0].why).toMatch(/1 fact you wrote kept, with only a known token shape redacted in it/);
    expect(t.activity[0].details).toEqual({ version: REDACTION_VERSION, previous: null, facts: 3, factsClosed: 2, ownerFacts: 1, chunks: 4, lessons: 1, misses: 2, candidates: 5, sessions: 1, activity: 6 });
    expect(t.logs).toEqual([['redaction rules applied to stored data', { version: REDACTION_VERSION, previous: null, ...ALL }]]);
    // The next start: nothing to do.
    expect(await redactStoredOnRuleChange(t.d)).toBeNull();
    expect(t.calls).toHaveLength(7);
  });

  test('nothing changed is recorded as done without an Activity entry', async () => {
    const t = deps({
      facts: { redactStoredFacts: async () => ({ redacted: 0, closed: 0, owner: 0 }) },
      docs: { redactStoredDocs: async () => 0 },
      knowledge: {},
      graph: {},
      sessions: {},
      activity: { record: async () => { throw new Error('not expected'); } },
    });
    expect(await redactStoredOnRuleChange(t.d)).toEqual({ facts: 0, closed: 0, ownerFacts: 0, chunks: 0, lessons: 0, misses: 0, candidates: 0, sessions: 0, activity: 0 });
    expect(t.cursors.m.get(REDACTION_CURSOR)).toBe(`v${REDACTION_VERSION}`);
  });

  test('a store that cannot re-redact counts as nothing changed there; a failure leaves the version unrecorded', async () => {
    const partial = deps({ knowledge: {}, graph: {}, sessions: {} });
    expect(await redactStoredOnRuleChange(partial.d)).toMatchObject({ lessons: 0, misses: 0, candidates: 0, sessions: 0 });
    const failing = deps({ docs: { redactStoredDocs: async () => { throw new Error('db down'); } } });
    await expect(redactStoredOnRuleChange(failing.d)).rejects.toThrow('db down');
    expect(failing.cursors.m.has(REDACTION_CURSOR)).toBe(false);
  });

  test('after v2, what v2 changed and closed is said again, because v2 kept no original text to restore', async () => {
    const v2 = logged({ details: { version: 2, previous: null, facts: 40, factsClosed: 12, chunks: 7, lessons: 3 } });
    const t = deps({}, [v2]);
    t.cursors.m.set(REDACTION_CURSOR, 'v2');
    await redactStoredOnRuleChange(t.d);
    expect(t.calls).toContain('list:secrets_redacted');
    expect(t.activity[0].why).toMatch(/redaction rules v2 had rewritten 40 facts \(12 of them closed as credentials\), 7 document texts and 3 lessons in place/);
    expect(t.activity[0].why).toMatch(/v2 kept no copy of the original text, so it cannot be restored/);
    expect(t.activity[0].details).toMatchObject({ previous: 'v2', v2: { facts: 40, factsClosed: 12, chunks: 7, lessons: 3 } });
  });

  test('after v2 with nothing to change now, the entry is still written so the owner sees what v2 did', async () => {
    const v2 = logged({ details: { version: 2, previous: null, facts: 5, factsClosed: 5, chunks: 0, lessons: 0 } });
    const t = deps({
      facts: { redactStoredFacts: async () => ({ redacted: 0, closed: 0, owner: 0 }) },
      docs: { redactStoredDocs: async () => 0 },
      knowledge: {}, graph: {}, sessions: {},
    }, [v2]);
    t.d.activity!.redactStoredActivity = async () => 0;
    t.cursors.m.set(REDACTION_CURSOR, 'v2');
    await redactStoredOnRuleChange(t.d);
    expect(t.activity).toHaveLength(1);
    expect(t.activity[0].subject).toBe(`redaction rules v${REDACTION_VERSION} applied to stored data: nothing changed`);
    expect(t.activity[0].why).toMatch(/5 facts \(5 of them closed as credentials\)/);
  });

  test('a v2 that changed nothing, or an install that never ran v2, adds no v2 note', async () => {
    const t = deps({}, [logged({ details: { version: 1 } })]);
    t.cursors.m.set(REDACTION_CURSOR, 'v1');
    await redactStoredOnRuleChange(t.d);
    expect(t.calls).not.toContain('list:secrets_redacted');
    expect(t.activity[0].why).not.toMatch(/v2/);
  });
});
