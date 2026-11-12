import { beforeEach, expect, test } from 'vitest';
import {
  LOOP_POLICY_VERSION, LOOP_TYPE_INFO, loopExecutor, needsYouReason, seedLoopSettings, writeLoopSettings, type Classification, type ParsedSession, type Project, type Store,
} from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { runLoopRound, type LoopEngineDeps } from '../engine.ts';
import { triageInbox } from './triage_inbox.ts';

const demo: Project = { key: 'demo', name: 'demo', repoPath: '/projects/demo' };
/** The classifier unsure it is pushback: triage would reject it. */
const unsure: Classification = { label: 'pushback', confidence: 0.2, summary: 'not really pushback', signals: [] };
const sure: Classification = { label: 'pushback', confidence: 0.95, summary: 'the totals are wrong', signals: [] };
const session = (id: string, text: string): ParsedSession => {
  const turns = [0, 1, 2].map((i) => ({ uuid: `${id}-t${i}`, sessionId: id, ts: `2026-11-10T10:0${i}:00Z`, index: i, text: i === 1 ? text : `turn ${i}`, precedingAssistantText: 'r', precedingToolCalls: [] }));
  return { sessionId: id, sourceFile: 'f', cwd: '/Users/me/Vibe/demo', gitBranch: 'main', startedAt: turns[0].ts, endedAt: turns[2].ts, turns, toolCalls: [] };
};

/**
 * triage_inbox as tier A (0.9.1) through a real round on each backend: applied on its own only once its band has earned
 * it (30 of your labels, the lower bound at τ 0.9), and a confirm of your own session's item stays a proposal with why.
 */
describeStores('triage_inbox applies once earned', (h) => {
  let store: Store;
  beforeEach(() => {
    store = h.store;
  });
  const deps = (): LoopEngineDeps => ({
    store, cursors: store.docs, tokenless: false, inScope: () => true, executor: loopExecutor(store), llm: null, now: () => Date.now() + 60_000, log: () => {},
    config: { mode: null, disabled: false, llm: null, llmCallsPerDay: 40, autoPerDay: 5, autoPerProject: 5, syncHoldDays: 7, holdout: 0, types: null },
    types: [triageInbox],
  });
  /** Your earlier reviews of triage proposals in every band, as the calibration fold left them. */
  const labels = async (n: number, kept: number) => {
    for (let band = 0; band < 5; band++) {
      await store.decisions.bumpCalibration({ type: 'triage_inbox', band, policyVersion: LOOP_POLICY_VERSION, prior: LOOP_TYPE_INFO.triage_inbox.prior, alpha: kept, beta: n - kept, n });
    }
  };
  const item = async (id: string, text: string, c: Classification) => {
    await store.graph.upsertSession(demo, session(id, text), []);
    await store.graph.saveClassification(`${id}-t1`, c, true);
  };

  test('earned: a reject applies on its own; a confirm of your own session stays a proposal, with why it needs you', async () => {
    await writeLoopSettings(store.docs, seedLoopSettings({ mode: 'auto' }));
    await labels(150, 148);
    await item('r1', 'hmm ok', unsure);
    await item('c1', 'the totals are wrong again', sure);
    const { round } = await runLoopRound(deps());
    expect(round).toMatchObject({ decisions: { applied: 1, proposed: 1 } });
    expect((await store.graph.candidateDetail('r1-t1'))!.candidate).toMatchObject({ status: 'rejected', decidedBy: 'loop:1' });
    const [proposed] = await store.decisions.list({ type: 'triage_inbox', status: ['proposed'] });
    expect(proposed.tier).toBe('A');
    expect(needsYouReason(proposed)).toBe('it is from your own session: you confirm those');
    expect((await store.graph.candidateDetail('c1-t1'))!.candidate.status).toBe('pending');
  });

  test('not yet earned: under 30 of your labels in the band, every call is a proposal', async () => {
    await writeLoopSettings(store.docs, seedLoopSettings({ mode: 'auto' }));
    await labels(29, 29);
    await item('r2', 'hmm ok', unsure);
    const { round } = await runLoopRound(deps());
    expect(round).toMatchObject({ decisions: { applied: 0, proposed: 1 } });
    const [d] = await store.decisions.list({ type: 'triage_inbox' });
    expect(needsYouReason(d)).toMatch(/^not earned yet: 29 of the 30 reviews/);
  });
});
