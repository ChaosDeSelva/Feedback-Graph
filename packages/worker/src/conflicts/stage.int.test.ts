import { conflictFingerprint, type ClaimDraft, type ConflictSnapshotFields, type JsonTask, type LlmProvider, type Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { expect, test } from 'vitest';
import { CONFLICT_TRIGGER_CURSOR, conflictSweepRound, conflictTriggerRound, type ConflictStageDeps } from './stage.ts';

const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
/** Near axis `a` (cosine about 0.99), off it a little toward `b`. */
const near = (a: number, b: number) => Array.from({ length: 768 }, (_, i) => (i === a ? 0.9 : i === b ? 0.1 : 0));
/** The embedder: import timeouts on one axis, ledger retries on another, anything else far from both. */
const embed = async (texts: string[]) => texts.map((t) => (/import/i.test(t) ? near(1, 5) : /ledger/i.test(t) ? near(2, 6) : vec(9)));

/** A judge that calls every pair a contradiction, citing the first line of each fenced statement. */
function judge(): LlmProvider & { calls: number } {
  const m = {
    id: 'fake:judge', agentic: false, vision: false, calls: 0,
    json: async (t: JsonTask) => {
      m.calls++;
      const [a, b] = [...t.user.matchAll(/--- begin untrusted document [^\n]*---\n([^\n]*)/g)].map((x) => x[1]);
      return { explanation: 'they differ', relation: 'contradicts', aQuote: a, bQuote: b, confidence: 0.9 };
    },
  };
  return m;
}

const draft = (statement: string, over: Partial<ClaimDraft> = {}): ClaimDraft => ({
  type: 'fact', statement, quote: statement, speakerId: null, span: { utt: 0, start: 0, end: statement.length }, assertedAt: '2026-11-10T10:00:00.000Z',
  confidence: 0.9, scope: { area: null, files: [] }, about: '', due: null, flags: [], embedding: null, ...over,
});

describeStores('contradiction detection on the store', (h) => {
  const deps = (llm: LlmProvider | null): ConflictStageDeps => ({ store: h.store, embed, llm, projects: async () => ['shop'] });

  /** Known: a code fact and an approved lesson. Said: a source with two claims that contradict them. */
  async function seed(s: Store) {
    const fact = await s.facts.addOwnerFact('shop', { kind: 'config', statement: 'Import jobs time out after 120 seconds.', path: 'src/import/config.ts', lines: null, confidence: 1, why: 'w', embedding: (await embed(['import']))[0] }, 'you');
    await s.knowledge.upsertLesson({
      id: 'manual:ledger-retries', projectKey: 'shop', title: 'Cap ledger client retries', rule: 'Retry the ledger client at most 3 times before failing the job.', appliesWhen: 'a',
      scope: 'project', paths: ['src/ledger/client.ts'], status: 'approved', source: 'memory', embedding: (await embed(['ledger']))[0],
    });
    const docId = await s.docs.upsertDoc({ projectKey: 'shop', source: 'intake', ref: 'sync.txt', title: 'sync', url: null }, [{ text: 'Oskar: import jobs time out after five minutes', embedding: vec(9) }], { read: true });
    await s.intake.upsertMeta({ docId, kind: 'transcript', format: 'txt', occurredAt: '2026-11-10', origin: null, private: true, participants: [] });
    const { version } = (await s.intake.nextWindow(docId))!;
    await s.intake.saveWindow(docId, {
      window: 0, version, total: 2, questions: [],
      claims: [
        draft('Import jobs time out after five minutes.', { about: 'import job timeout', embedding: (await embed(['import']))[0] }),
        draft('The ledger client retries 5 times.', { about: 'ledger retries', embedding: (await embed(['ledger']))[0] }),
      ],
    });
    const claims = await s.intake.listClaims({ docId });
    return { fact, docId, claims };
  }

  test('a source read: its claims are checked against current facts and approved lessons, and the conflicts stored once', async () => {
    const s = h.store;
    const { fact, docId, claims } = await seed(s);
    const llm = judge();
    // The first round starts at the end of the log: what came before is the sweep's.
    expect((await conflictTriggerRound(deps(llm))).sides).toBe(0);
    expect(await s.docs.getCursor(CONFLICT_TRIGGER_CURSOR)).not.toBeNull();
    await s.activity.record({ kind: 'source_read', actor: 'fake:intake', projectKey: 'shop', subject: 'read', why: 'w', targets: [docId] });
    const t = await conflictTriggerRound(deps(llm));
    expect(t).toMatchObject({ sides: 2, conflicts: 2, uncited: 0 });
    const open = await s.intake.listConflicts({ status: ['open'] });
    const pairs = open.map((c) => [c.a.kind, c.b.kind].sort().join('+')).sort();
    expect(pairs).toEqual(['claim+fact', 'claim+lesson']);
    const withFact = open.find((c) => c.a.id === fact.id || c.b.id === fact.id)!;
    expect(withFact).toMatchObject({ kind: 'disagreement', projectKey: 'shop', judge: expect.objectContaining({ relation: 'contradicts', model: 'fake:judge' }) });
    expect(withFact.signals.map((x) => x.family)).toContain('number');
    expect([withFact.a.id, withFact.b.id]).toContain(claims.find((c) => c.statement.startsWith('Import'))!.id);
    expect(await s.activity.list({ kind: 'conflict_found', limit: 10 })).toHaveLength(2);

    // Nothing new since: no round, no call. The sweep over the same knowledge: the pairs are memoised.
    const calls = llm.calls;
    expect((await conflictTriggerRound(deps(llm))).sides).toBe(0);
    const swept = await conflictSweepRound(deps(llm));
    expect(swept).toMatchObject({ wrapped: true, conflicts: 0 });
    expect(llm.calls).toBe(calls);
  });

  test('a dismissed pair stays dismissed when the sweep finds it again', async () => {
    const s = h.store;
    const { fact } = await seed(s);
    const llm = judge();
    // Accepting a claim (its Activity entry) checks it; the sweep checks the fact and the lesson against accepted claims.
    const [importClaim] = (await s.intake.listClaims({})).filter((c) => c.statement.startsWith('Import'));
    await s.intake.decideClaim(importClaim.id, { status: 'accepted' }, { by: 'you' });
    const swept = await conflictSweepRound(deps(llm));
    expect(swept.conflicts).toBe(1);
    const [conflict] = await s.intake.conflictsFor([fact.id]);
    const dismiss: ConflictSnapshotFields = { status: 'dismissed', resolution: { choice: 'none', note: null, reason: 'scope', createdFactId: null }, resolvedBy: 'you', resolvedAt: '2026-11-11T00:00:00.000Z', decisionId: 'dec:1' };
    await s.intake.writeSnapshots([{ kind: 'conflict', id: conflict.id, fields: dismiss, expect: conflictFingerprint(conflict) }]);
    // Judged again (the memo forgotten): openConflict finds the dismissed pair unchanged and leaves it so.
    const forgetful = { getCursor: async (k: string) => (k.startsWith('conflict-pair:') ? null : s.docs.getCursor(k)), setCursor: (k: string, v: string) => s.docs.setCursor(k, v) };
    const again = await conflictSweepRound({ ...deps(llm), store: { intake: s.intake, facts: s.facts, knowledge: s.knowledge, links: s.links, activity: s.activity, docs: forgetful } });
    expect(again.conflicts).toBe(0);
    expect((await s.intake.conflictsFor([fact.id], { status: ['dismissed'] })).map((c) => c.id)).toEqual([conflict.id]);
    expect(await s.intake.conflictsFor([fact.id])).toEqual([]);
  });
});
