import { ProviderUnavailableError, type IntakeMeta, type JsonTask, type LlmProvider, type WindowSave } from '@fb/core';
import { expect, test } from 'vitest';
import { budgetedLlm, IntakeBudget, IntakeBudgetSpent, parseIntakeSpend } from './budget.ts';
import { assertedAt, extractIntakeOne, extractSource, type ExtractDeps } from './extract.ts';
import { intakeModelSpec } from './model.ts';

const TEXT = 'Ana: The retry timeout is 30 seconds.\nBo: I will write the runbook by Friday.';
const fake = (answer: (t: JsonTask) => unknown): LlmProvider & { asked: JsonTask[] } => {
  const asked: JsonTask[] = [];
  return { id: 'fake:intake', agentic: false, vision: false, asked, json: async (t) => { asked.push(t); return answer(t); } };
};
const windowAnswer = {
  claims: [
    { type: 'fact', speaker: 'S1', quote: 'The retry timeout is 30 seconds', statement: 'The retry timeout is 30 seconds.', about: 'retries', area: 'none', files: [], due: 'none', confidence: 0.9 },
    { type: 'commitment', speaker: 'S2', quote: 'I will write the runbook by Friday', statement: 'Bo writes the runbook by Friday.', about: 'runbook', area: '', files: [], due: 'Friday', confidence: 0.8 },
    { type: 'decision', speaker: 'S1', quote: 'We agreed to skip review', statement: 'Review is skipped.', about: 'review', area: '', files: [], due: '', confidence: 0.9 },
    { nonsense: true },
  ],
  questions: [],
};
const answer = (t: JsonTask) => (t.system.includes('claims drawn from one source') ? { questions: [{ text: 'Who owns the rollback?', kind: 'needs_owner', claims: ['c2'] }] } : windowAnswer);

test('a source in memory: windows then the questions pass, pseudonymised, quotes checked, drops counted', async () => {
  const llm = fake(answer);
  const r = await extractSource({ title: 'sync', kind: 'transcript', format: 'txt', occurredAt: '2026-11-10', text: TEXT }, llm);
  expect(llm.asked).toHaveLength(2);
  expect(llm.asked[0].user).not.toMatch(/Ana|Bo:/);
  expect(llm.asked[0].user).toContain('--- begin untrusted document');
  expect(r.claims.map((c) => [c.type, c.speaker, TEXT.slice(c.span.start, c.span.end), c.due])).toEqual([
    ['fact', 'Ana', 'The retry timeout is 30 seconds', null], ['commitment', 'Bo', 'I will write the runbook by Friday', 'Friday'],
  ]);
  expect(r.questions).toEqual([expect.objectContaining({ kind: 'needs_owner', quote: 'I will write the runbook by Friday', askedBy: null })]);
  expect(r.dropped).toEqual({ unquoted: 1, malformed: 1 });
});

test('assertedAt is the source date plus the time into the call', () => {
  expect(assertedAt('2026-11-10T09:00:00Z', 90_000)).toBe('2026-11-10T09:01:30.000Z');
  expect(assertedAt('2026-11-10', null)).toBe('2026-11-10T00:00:00.000Z');
  expect(assertedAt(null, 5)).toBeNull();
});

function world(o: { llm?: LlmProvider; spent?: boolean } = {}) {
  const job = { id: 'doc:shop:intake:sync', projectKey: 'shop', ref: 'sync', title: 'sync', kind: 'text' as const, text: TEXT, image: null, attempts: 0, version: 'v1' };
  const meta: IntakeMeta = { docId: job.id, kind: 'transcript', format: 'txt', occurredAt: '2026-11-10', origin: null, private: true, participants: [], windowsDone: 0, windowsTotal: null };
  const saves: WindowSave[] = [];
  const progress: boolean[] = [];
  const failures: string[] = [];
  let done = 0;
  const d: ExtractDeps = {
    docs: {
      nextDocToRead: async (_now, q) => (q?.intake && done < 2 ? job : null),
      recordDocFailure: async (_id, error) => { failures.push(error); return null; },
      recordDocProgress: async (_id, _v, p) => { progress.push(p.done); return true; },
    },
    intake: {
      metas: async () => [meta],
      nextWindow: async () => ({ window: done, version: 'v1' }),
      saveWindow: async (_id, w) => { saves.push(w); done = w.window + 1; return true; },
      resolveAlias: async (name) => ({ person: { id: `person:${name}`, displayName: name, isOwner: false, status: 'proposed', aliases: [], claims: 0, createdAt: '' }, created: true }),
      listClaims: async () => [],
    },
    llm: o.llm ?? fake(answer), budgetSpent: async () => !!o.spent, perDay: 200,
    embed: async (texts) => texts.map(() => [1]), inScope: async () => true, knownFiles: async () => null,
  };
  return { d, saves, progress, failures };
}

test('the stage reads one pass a round, saves it as a window with Person ids, and is done after the questions pass', async () => {
  const w = world();
  expect(await extractIntakeOne(w.d)).toEqual({ read: true });
  expect(w.saves[0]).toMatchObject({ window: 0, version: 'v1', total: 2 });
  expect(w.saves[0].claims.map((c) => [c.speakerId, c.span, c.embedding])).toEqual([
    ['person:Ana', { utt: 0, start: 5, end: 36 }, [1]], ['person:Bo', { utt: 1, start: 42, end: 76 }, [1]],
  ]);
  expect(w.progress).toEqual([false]);
  // Resumed (nextWindow says 1): the questions pass, over the stored claims (none here: no call), and done.
  expect(await extractIntakeOne(w.d)).toEqual({ read: true });
  expect(w.saves[1]).toMatchObject({ window: 1, claims: [], questions: [] });
  expect(w.progress).toEqual([false, true]);
  expect(await extractIntakeOne(w.d)).toBeNull();
});

test('a spent budget or a model that is down pauses the source, uncounted, and ends the round', async () => {
  const spent = world({ spent: true });
  expect(await extractIntakeOne(spent.d)).toEqual({ read: false, unavailable: expect.stringContaining('INTAKE_LLM_CALLS_PER_DAY') });
  expect(spent.saves).toEqual([]);
  const down = world({ llm: fake(() => { throw new ProviderUnavailableError('connection refused'); }) });
  expect(await extractIntakeOne(down.d)).toMatchObject({ read: false, unavailable: expect.any(String) });
  expect(down.failures[0]).toMatch(/model unavailable/);
});

test('the budget is kept per UTC day in a cursor, and refuses the call past it', async () => {
  const cursors = new Map<string, string>();
  const b = new IntakeBudget({ cursors: { getCursor: async (k) => cursors.get(k) ?? null, setCursor: async (k, v) => { cursors.set(k, v); } }, perDay: 2, now: () => Date.parse('2026-11-12T10:00:00Z') });
  const llm = budgetedLlm(fake(() => ({})), b);
  await llm.json({ system: '', user: '', schema: {} });
  await llm.json({ system: '', user: '', schema: {} });
  await expect(llm.json({ system: '', user: '', schema: {} })).rejects.toBeInstanceOf(IntakeBudgetSpent);
  expect(await b.spent()).toBe(true);
  expect(parseIntakeSpend(cursors.get('intake-budget')!, Date.parse('2026-11-13T00:00:01Z'))).toEqual({ day: '2026-11-13', llmCalls: 0 });
});

test('intake\'s model: INTAKE_LLM, then DOCS_LLM, SCAN_LLM, the local model, skipping what the allow list refuses', () => {
  const cfg = (intake: string | null, docs: string | null, allow = ['ollama', 'claude-cli']) => ({ intake: { enabled: true, llm: intake, providerAllow: allow, llmCallsPerDay: 200 }, llm: { classify: null, postmortem: null, scan: null, check: null, docs, chat: null } });
  expect(intakeModelSpec(cfg('claude-cli', null), 'ollama:gemma4')).toEqual({ spec: 'claude-cli', skipped: [] });
  expect(intakeModelSpec(cfg(null, 'openai:gpt-5.1'), 'ollama:gemma4')).toEqual({ spec: 'ollama:gemma4', skipped: ['openai:gpt-5.1'] });
  expect(intakeModelSpec(cfg(null, 'openai:gpt-5.1', ['ollama', 'openai']), 'ollama:gemma4').spec).toBe('openai:gpt-5.1');
  expect(intakeModelSpec(cfg(null, null, ['claude-cli']), 'ollama:gemma4')).toEqual({ spec: null, skipped: ['ollama:gemma4'] });
});
