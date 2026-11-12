import { describe, expect, test } from 'vitest';
import { candidateSnapshot, type Candidate, type ExternalRef } from '@fb/core';
import { fakeContext } from '../testing/context.ts';
import { score } from '../policy.ts';
import { candidateNeverTarget, CONFIRM_FROM, REJECT_BELOW, triageInbox } from './triage_inbox.ts';

const item = (id: string, o: Partial<Candidate> = {}, c: Partial<Candidate['classification']> = {}): Candidate => ({
  id, turnUuid: id, sessionId: 's', projectKey: 'demo', source: 'claude', status: 'pending', createdAt: '2026-11-01T00:00:00.000Z', decidedAt: null, note: null,
  classification: { label: 'pushback', confidence: 0.9, summary: 'the user says the migration is missing', signals: [], ...c }, origins: ['detector'], ...o,
} as Candidate);
const ext = (o: Partial<ExternalRef> = {}): ExternalRef => ({
  source: 'github', kind: 'review_comment', author: 'reviewer', url: 'u', thread: 't', title: 'PR', threadUrl: 'u', path: null, line: null, diffHunk: null,
  branch: null, createdAt: '2026-11-01T00:00:00Z', linkedSessionIds: [], authorKind: 'human', threadAuthor: 'author', ...o,
} as ExternalRef);

function ctxOf(items: Candidate[], o: { texts?: Record<string, string>; inScope?: (k: string | null) => boolean } = {}) {
  const asked: unknown[] = [];
  const ctx = fakeContext({
    inScope: o.inScope,
    store: {
      graph: {
        listCandidates: async (f: unknown) => { asked.push(f); return items; },
        candidateDetail: async (id: string) => (o.texts?.[id] === undefined ? null : { turn: { text: o.texts[id] } } as never),
      },
    },
  });
  return { ctx, asked };
}

describe('triageInbox', () => {
  test(`pushback at ${CONFIRM_FROM} or more: confirm, decided by whoever approves it; only pending items are read`, async () => {
    const c = item('k1');
    const { ctx, asked } = ctxOf([c]);
    const r = await triageInbox.candidates(ctx);
    expect(asked).toEqual([{ status: 'pending', limit: 200 }]);
    expect(r).toMatchObject({ scanned: 1, skipped: {} });
    const [d] = r.candidates;
    expect(d.targets).toEqual([{ kind: 'candidate', id: 'k1', role: 'primary' }]);
    expect(d.before).toEqual([candidateSnapshot(c)]);
    expect(d.after).toEqual([candidateSnapshot({ id: 'k1', status: 'confirmed', note: 'triage: the classifier is 90% sure it is pushback', decidedBy: null })]);
    expect(d.features).toEqual({ confidence: 0.9, agentReported: 0, skipRule: 0, external: 0 });
    expect(d.evidence.map((e) => e.role)).toEqual(['classified pushback']);
    expect(d.subject).toBe('confirm Inbox item "the user says the migration is missing"');
    expect(d.rationale).toContain('starts its post-mortem');
  });

  test('the agent reported the miss too: said, and it scores higher', async () => {
    const both = item('k2', { origins: ['detector', 'agent'], agentReport: { text: 't', whatWasDone: 'w', reportedAt: '2026-11-02T00:00:00Z', sessionId: null } });
    const [d] = (await triageInbox.candidates(ctxOf([both]).ctx)).candidates;
    expect(d.features.agentReported).toBe(1);
    expect(d.evidence.map((e) => [e.role, e.observedAt])).toContainEqual(['agent reported', '2026-11-02T00:00:00Z']);
    expect(d.rationale).toContain('the agent reported the miss itself');
    const alone = (await triageInbox.candidates(ctxOf([item('k1')]).ctx)).candidates[0];
    expect(score(triageInbox, d.features)).toBeGreaterThan(score(triageInbox, alone.features));
    const noReport = (await triageInbox.candidates(ctxOf([item('k3', { origins: ['agent'] }, { summary: '' })]).ctx)).candidates[0];
    expect(noReport.evidence.at(-1)!.observedAt).toBe('2026-11-01T00:00:00.000Z');
    expect(noReport.subject).toBe('confirm Inbox item "k3"');
  });

  test(`a classifier under ${REJECT_BELOW} with no agent report: reject; in between, or an agent report: no call`, async () => {
    const r = await triageInbox.candidates(ctxOf([item('lo', {}, { confidence: 0.2 }), item('mid', {}, { confidence: 0.6 }), item('lo-agent', { origins: ['agent'] }, { confidence: 0.2 })]).ctx);
    expect(r.candidates.map((d) => [d.targets[0].id, d.after[0].fields.status])).toEqual([['lo', 'rejected']]);
    expect(r.candidates[0].features.confidence).toBe(0.8);
    expect(r.candidates[0].after[0].fields.note).toBe('triage: the classifier is only 20% sure it is pushback, and no agent reported a miss');
    expect(r.skipped).toEqual({ below_floor: 2 });
    // A correction is confirmed like pushback; any other label never is.
    const labels = await triageInbox.candidates(ctxOf([item('c', {}, { label: 'correction' }), item('a', {}, { label: 'approval' })]).ctx);
    expect(labels.candidates.map((d) => d.targets[0].id)).toEqual(['c']);
    expect(labels.skipped).toEqual({ below_floor: 1 });
  });

  test('a synced comment a skip rule matches now, or an agent reviewing its own PR: reject, whatever the classifier said', async () => {
    const bot = item('bot', { external: ext({ authorKind: 'bot' }) });
    const self = item('self', { external: ext({ authorKind: 'agent', author: 'author' }) });
    const signalled = item('sig', { external: ext() }, { signals: ['self-review'] });
    const fine = item('fine', { external: ext() });
    const gone = item('gone', { external: ext() });
    const r = await triageInbox.candidates(ctxOf([bot, self, signalled, fine, gone], { texts: { bot: 'nit', self: 'please add tests', sig: 'add tests', fine: 'the migration is missing' } }).ctx);
    const by = Object.fromEntries(r.candidates.map((d) => [d.targets[0].id, d]));
    expect(by.bot.after[0].fields).toMatchObject({ status: 'rejected', note: expect.stringContaining('a skip rule matches it now (bot-author') });
    expect(by.bot.features.skipRule).toBe(1);
    expect(by.bot.evidence.map((e) => e.role)).toContain('skip rule bot-author');
    expect(by.self.after[0].fields.note).toBe('triage: an agent reviewing its own pull request');
    expect(by.sig.after[0].fields.status).toBe('rejected');
    expect(by.fine.after[0].fields.status).toBe('confirmed');
    expect(by.fine.features.external).toBe(1);
    // An item whose turn is gone is judged on its classification.
    expect(by.gone.after[0].fields.status).toBe('confirmed');
    expect(by.bot.rationale).not.toContain('post-mortem');
  });

  test('never: the demo, a run or sandbox item; nor out of scope', async () => {
    const r = await triageInbox.candidates(ctxOf([item('demo:shop:1'), item('r', { run: 'r1' }), item('sb', { sandbox: true }), item('o', { projectKey: 'other' })], { inScope: (k) => k !== 'other' }).ctx);
    expect(r).toEqual({ candidates: [], scanned: 4, skipped: { never_target: 3, out_of_scope: 1 } });
    expect(candidateNeverTarget(item('x'))).toBeNull();
  });
});
