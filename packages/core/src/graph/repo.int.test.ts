import { beforeAll, describe, expect, test } from 'vitest';
import type { GraphStore, KnowledgeStore } from '../store.ts';
import { describeStores, type StoreProbe } from '../testing/index.ts';
import type { Classification, ParsedSession, Project } from '../types.ts';

const project: Project = { key: 'demo', name: 'demo', repoPath: '/vibe/demo' };

function session(turnCount: number): ParsedSession {
  const turns = Array.from({ length: turnCount }, (_, i) => ({
    uuid: `t${i}`,
    sessionId: 's1',
    ts: `2026-10-01T10:0${i}:00Z`,
    index: i,
    text: `turn ${i}`,
    precedingAssistantText: i ? `assistant before ${i}` : '',
    precedingToolCalls: i ? [{ name: 'Edit', ts: `2026-10-01T10:0${i}:00Z`, filePath: '/a.ts' }] : [],
  }));
  return {
    sessionId: 's1',
    sourceFile: '/transcripts/x/s1.jsonl',
    cwd: '/Users/j/Vibe/demo',
    gitBranch: 'main',
    startedAt: '2026-10-01T10:00:00Z',
    endedAt: '2026-10-01T10:09:00Z',
    turns,
    toolCalls: [],
  };
}

const pushback: Classification = { label: 'pushback', confidence: 0.9, summary: 'wants server-side', signals: ['not good enough'] };
const commits = [{ sha: 'a'.repeat(40), ts: '2026-10-01T10:03:00Z', subject: 'fix search' }];

describeStores('GraphStore', (h) => {
  let repo: GraphStore;
  let k: KnowledgeStore;
  let probe: StoreProbe;
  beforeAll(() => {
    repo = h.store.graph;
    k = h.store.knowledge;
    probe = h.probe;
  });

  describe('GraphRepo', () => {
    test('upserting the same session twice does not duplicate turns', async () => {
      await repo.upsertSession(project, session(3), commits);
      await repo.upsertSession(project, session(3), commits);
      expect(await probe.count('Turn')).toBe(3);
      expect(await probe.count('Commit')).toBe(1);
    });

    test('unclassifiedTurns skips index 0 and labelled turns', async () => {
      await repo.upsertSession(project, session(3), []);
      await repo.saveClassification('t1', pushback, false);
      const turns = await repo.unclassifiedTurns(10);
      expect(turns.map((t) => t.uuid)).toEqual(['t2']);
      expect(turns[0].projectKey).toBe('demo');
      expect(turns[0].precedingToolCalls[0].filePath).toBe('/a.ts');
    });

    test('callsAfter: the tool calls of later turns, then those after the last turn, and when the session ended', async () => {
      const s = session(3);
      const push = { name: 'Bash', ts: '2026-10-01T10:08:00Z', command: 'git push -u origin fix/x' };
      // The calls after the last turn are kept on the session (trailingToolCalls); earlier ones are the turns' own.
      await repo.upsertSession(project, { ...s, toolCalls: [...s.turns.flatMap((t) => t.precedingToolCalls), push] }, []);
      expect(await repo.callsAfter('t1')).toEqual({
        calls: [{ name: 'Edit', ts: '2026-10-01T10:02:00Z', filePath: '/a.ts' }, push],
        laterTurns: 1,
        endedAt: '2026-10-01T10:09:00.000Z',
      });
      expect(await repo.callsAfter('t2')).toMatchObject({ calls: [push], laterTurns: 0 });
      expect(await repo.callsAfter('nope')).toBeNull();
    });

    test('sessionInstructionFiles: what the transcript showed the agent had, null when not recorded', async () => {
      await repo.upsertSession(project, { ...session(2), instructionFiles: ['/Users/you/Vibe/demo/CLAUDE.md', '/Users/you/Vibe/demo/AGENTS.md'] }, []);
      expect(await repo.sessionInstructionFiles('s1')).toEqual(['/Users/you/Vibe/demo/CLAUDE.md', '/Users/you/Vibe/demo/AGENTS.md']);
      await repo.upsertSession(project, { ...session(2), instructionFiles: [] }, []);
      expect(await repo.sessionInstructionFiles('s1')).toEqual([]);
      await repo.upsertSession(project, session(2), []);
      expect(await repo.sessionInstructionFiles('s1')).toBeNull();
      expect(await repo.sessionInstructionFiles('nope')).toBeNull();
    });

    test('pendingSessionItems: pending detector items from sessions with their calls; decided ones and agent reports are not', async () => {
      await repo.upsertSession(project, session(4), []);
      for (const t of ['t1', 't2', 't3']) await repo.saveClassification(t, pushback, true);
      await repo.decide('t2', 'rejected', null);
      await k.createManualFeedback({ project, cwd: '/Users/j/Vibe/demo', text: 'you missed auth', whatWasDone: 'x' });
      const items = await repo.pendingSessionItems({ limit: 10 });
      expect(items).toEqual([
        { id: 't1', turnUuid: 't1', projectKey: 'demo', text: 'turn 1', precedingToolCalls: [{ name: 'Edit', ts: '2026-10-01T10:01:00Z', filePath: '/a.ts' }] },
        expect.objectContaining({ id: 't3' }),
      ]);
      expect((await repo.pendingSessionItems({ limit: 10, afterId: 't1' })).map((i) => i.id)).toEqual(['t3']);
      // Skipped by a rule: no longer pending.
      expect(await repo.skipPendingItem('t1', { rule: 'instruction', note: 'n', by: 'detect-rules' })).toBe(true);
      expect((await repo.pendingSessionItems({ limit: 10 })).map((i) => i.id)).toEqual(['t3']);
    });

    test('ruleSkippedItems and reopenRuleSkippedItem: what a rule rejected goes back to pending; your decisions stay', async () => {
      await repo.upsertSession(project, session(4), []);
      for (const t of ['t1', 't2', 't3']) await repo.saveClassification(t, pushback, true);
      await repo.skipPendingItem('t1', { rule: 'instruction', note: 'n', by: 'detect-rules' });
      await repo.skipPendingItem('t2', { rule: 'instruction', note: 'n', by: 'detect-rules' });
      // You decided t2 since: it is no longer the rule's.
      await repo.decide('t2', 'rejected', 'not useful', 'you');
      await repo.decide('t3', 'rejected', null, 'you');
      const skipped = await repo.ruleSkippedItems({ rule: 'instruction', by: 'detect-rules', limit: 10 });
      expect(skipped).toEqual([expect.objectContaining({ id: 't1', turnUuid: 't1', projectKey: 'demo', text: 'turn 1' })]);
      expect(await repo.ruleSkippedItems({ rule: 'instruction', by: 'detect-rules', limit: 10, afterId: 't1' })).toEqual([]);
      expect(await repo.reopenRuleSkippedItem('t2', { rule: 'instruction', by: 'detect-rules' })).toBe(false);
      expect(await repo.reopenRuleSkippedItem('t1', { rule: 'instruction', by: 'detect-rules' })).toBe(true);
      expect((await repo.pendingSessionItems({ limit: 10 })).map((i) => i.id)).toEqual(['t1']);
      const [c] = await repo.listCandidates({ status: 'pending' });
      expect(c).toMatchObject({ id: 't1', status: 'pending', note: null, decidedAt: null });
      expect(c.classification.signals).not.toContain('skip:instruction');
      expect(await repo.reopenRuleSkippedItem('t1', { rule: 'instruction', by: 'detect-rules' })).toBe(false);
    });

    test('unclassifiedTurns returns newest first and can be limited to some projects', async () => {
      await repo.upsertSession(project, session(4), []);
      const other = { key: 'other', name: 'other', repoPath: '/vibe/other' };
      const s2 = session(2);
      await repo.upsertSession(other, { ...s2, sessionId: 's2', turns: s2.turns.map((t) => ({ ...t, uuid: `o${t.index}`, sessionId: 's2', ts: `2026-10-02T10:0${t.index}:00Z` })) }, []);
      expect((await repo.unclassifiedTurns(10)).map((t) => t.uuid)).toEqual(['o1', 't3', 't2', 't1']);
      expect((await repo.unclassifiedTurns(10, ['demo'])).map((t) => t.uuid)).toEqual(['t3', 't2', 't1']);
      expect((await repo.unclassifiedTurns(10, undefined, ['demo'])).map((t) => t.uuid)).toEqual(['o1']);
    });

    test('re-upserting does not clear an existing label', async () => {
      await repo.upsertSession(project, session(3), []);
      await repo.saveClassification('t1', pushback, true);
      await repo.upsertSession(project, session(3), []);
      expect((await repo.unclassifiedTurns(10)).map((t) => t.uuid)).toEqual(['t2']);
    });

    test('a decided candidate keeps its status when re-flagged', async () => {
      await repo.upsertSession(project, session(3), []);
      await repo.saveClassification('t1', pushback, true);
      await repo.decide('t1', 'rejected', null);
      await repo.saveClassification('t1', pushback, true);
      const [c] = await repo.listCandidates({ status: 'rejected' });
      expect(c.id).toBe('t1');
      expect(await repo.listCandidates({ status: 'pending' })).toEqual([]);
    });

    test('confirming creates exactly one open Feedback', async () => {
      await repo.upsertSession(project, session(3), []);
      await repo.saveClassification('t1', pushback, true);
      await repo.decide('t1', 'confirmed', 'real miss');
      await repo.decide('t1', 'confirmed', 'real miss');
      expect(await probe.count('Feedback')).toBe(1);
      const [c] = await repo.listCandidates({ status: 'confirmed' });
      expect(c.note).toBe('real miss');
      expect(c.decidedAt).not.toBeNull();
      expect(c.classification).toEqual(pushback);
      // Who decided: you by default, or the agent that used the operator token.
      expect(c.decidedBy).toBe('you');
      await repo.decide('t1', 'rejected', 'bot comment', 'operator:codex');
      expect((await repo.listCandidates({ status: 'rejected' }))[0].decidedBy).toBe('operator:codex');
      expect((await repo.candidateDetail('t1'))!.candidate.decidedBy).toBe('operator:codex');
    });

    test('listCandidates filters by project', async () => {
      await repo.upsertSession(project, session(3), []);
      await repo.saveClassification('t1', pushback, true);
      expect(await repo.listCandidates({ projectKey: 'other' })).toEqual([]);
      expect(await repo.listCandidates({ projectKey: 'demo' })).toHaveLength(1);
    });

    test('listCandidates filters by source (a Claude Code session is claude)', async () => {
      await repo.upsertSession(project, session(3), []);
      await repo.saveClassification('t1', pushback, true);
      expect((await repo.listCandidates({ source: 'claude' })).map((c) => c.id)).toEqual(['t1']);
      expect(await repo.listCandidates({ source: 'codex' })).toEqual([]);
      expect(await repo.listCandidates({ source: 'github', projectKey: 'demo' })).toEqual([]);
    });

    test('candidateDetail returns neighbouring turns in order and session commits', async () => {
      await repo.upsertSession(project, session(6), commits);
      await repo.saveClassification('t3', pushback, true);
      const d = await repo.candidateDetail('t3');
      expect(d?.turn.uuid).toBe('t3');
      expect(d?.before.map((t) => t.uuid)).toEqual(['t1', 't2']);
      expect(d?.after.map((t) => t.uuid)).toEqual(['t4', 't5']);
      expect(d?.commits).toEqual(commits);
      expect(await repo.candidateDetail('nope')).toBeNull();
    });

    test('stats counts human turns and pushback per project and ISO week', async () => {
      await repo.upsertSession(project, session(3), []);
      await repo.saveClassification('t1', pushback, true);
      await repo.saveClassification('t2', { ...pushback, label: 'neutral' }, false);
      // t0 opens the session, so it can never be pushback and is not in the denominator.
      expect(await repo.stats()).toEqual([{ projectKey: 'demo', week: '2026-W40', humanTurns: 2, pushback: 1 }]);
    });

    test('a turn that failed classification 3 times is no longer offered', async () => {
      await repo.upsertSession(project, session(3), []);
      for (let i = 0; i < 3; i++) await repo.recordClassifyFailure('t1');
      await repo.recordClassifyFailure('t2');
      expect((await repo.unclassifiedTurns(10)).map((t) => t.uuid)).toEqual(['t2']);
    });

    test('turns given up on are counted, and re-queueing them makes them classifiable again', async () => {
      await repo.upsertSession(project, session(4), []);
      for (let i = 0; i < 3; i++) await repo.recordClassifyFailure('t1');
      for (let i = 0; i < 3; i++) await repo.recordClassifyFailure('t2');
      await repo.saveClassification('t2', pushback, true); // labelled later anyway: not given up
      await repo.recordClassifyFailure('t3');
      expect(await repo.givenUpTurns()).toBe(1);
      expect((await repo.unclassifiedTurns(10)).map((t) => t.uuid)).toEqual(['t3']);
      expect(await repo.requeueGivenUpTurns()).toBe(1);
      expect(await repo.givenUpTurns()).toBe(0);
      expect((await repo.unclassifiedTurns(10)).map((t) => t.uuid)).toEqual(['t3', 't1']);
      // t3 keeps its one attempt: only given-up turns start over.
      await repo.recordClassifyFailure('t3');
      await repo.recordClassifyFailure('t3');
      expect(await repo.givenUpTurns()).toBe(1);
      expect(await repo.requeueGivenUpTurns()).toBe(1);
      expect(await repo.requeueGivenUpTurns()).toBe(0);
    });

    test('rejecting a confirmed candidate rejects its Feedback, and confirming again reopens it', async () => {
      await repo.upsertSession(project, session(3), []);
      await repo.saveClassification('t1', pushback, true);
      await repo.decide('t1', 'confirmed', null);
      await repo.decide('t1', 'rejected', 'not a miss after all');
      const status = () => probe.feedbackStatus('t1');
      expect(await status()).toBe('rejected');
      await repo.decide('t1', 'confirmed', null);
      expect(await status()).toBe('open');
    });

    test('the worker heartbeat round-trips, and ping reports the graph is up', async () => {
      expect(await repo.workerStatus()).toBeNull();
      const st = { version: '0.2.0', startedAt: 'a', lastBeat: 'b', lastCycleAt: null, lastCycle: { turnsClassified: 3, scanned: false }, lastError: null, providers: { classify: 'x', postmortem: null } };
      await repo.heartbeat(st);
      expect(await repo.workerStatus()).toEqual(st);
      expect(await h.store.ping()).toBe(true);
    });

    test('retention removes the text of old turns nobody flagged, and keeps whole sessions behind candidates', async () => {
      await repo.upsertSession(project, session(3), []);
      const s2 = session(3);
      await repo.upsertSession(project, { ...s2, sessionId: 's2', turns: s2.turns.map((t) => ({ ...t, uuid: `q${t.index}`, sessionId: 's2' })) }, []);
      // s1 holds a candidate: a post-mortem reads all of its turns, so none are touched.
      await repo.saveClassification('t1', { ...pushback, label: 'neutral' }, false);
      await repo.saveClassification('t2', pushback, true);
      // In s2, q1 is classified and unflagged; q2 is still waiting for the classifier and keeps its text.
      await repo.saveClassification('q1', { ...pushback, label: 'neutral' }, false);
      expect(await repo.pruneTurnText(new Date('2026-10-02T00:00:00Z'))).toBe(2); // q0 (the opener, never classified) and q1
      expect(await probe.turn('q1')).toEqual({ text: null, precedingAssistantText: null });
      expect((await probe.turn('q2'))?.text).toBe('turn 2');
      expect((await probe.turn('t1'))?.text).toBe('turn 1');
      expect(await repo.pruneTurnText(new Date('2026-10-02T00:00:00Z'))).toBe(0);
    });

    test('candidate detail says where its post-mortem stands', async () => {
      await repo.upsertSession(project, session(3), []);
      await repo.saveClassification('t1', pushback, true);
      expect((await repo.candidateDetail('t1'))?.postmortem).toBeNull();
      await repo.decide('t1', 'confirmed', null);
      expect((await repo.candidateDetail('t1'))?.postmortem).toEqual({ done: false, attempts: 0, lastError: null, retryAt: null, gaveUp: false });
      for (let i = 0; i < 5; i++) await k.recordPostmortemFailure('t1', 'ollama timed out');
      expect((await repo.candidateDetail('t1'))?.postmortem).toEqual({ done: false, attempts: 5, lastError: 'ollama timed out', retryAt: null, gaveUp: true });
    });
  });

  describe('session source (Claude Code or Codex)', () => {
    test('sessions record their source; candidates from them carry it to the inbox', async () => {
      await repo.upsertSession(project, { ...session(3), source: 'codex' }, []);
      await repo.saveClassification('t2', pushback, true);
      const [c] = await repo.listCandidates();
      expect(c.source).toBe('codex');
      expect((await repo.candidateDetail('t2'))?.candidate.source).toBe('codex');
      expect(await probe.sessionSource('s1')).toBe('codex');
    });

    test('a session without a source is a Claude Code session', async () => {
      await repo.upsertSession(project, session(3), []);
      await repo.saveClassification('t2', pushback, true);
      expect((await repo.listCandidates())[0].source).toBe('claude');
    });
  });

  test('unclassifiedTurns with an empty project list returns nothing (nothing selected), not everything', async () => {
    await repo.upsertSession(project, session(3), []);
    expect(await repo.unclassifiedTurns(10, [])).toEqual([]);
  });

  describe('project remotes and aliases', () => {
    const clone = (key: string, remote: string | null): Project & { remote: string | null } => ({ key, name: key, repoPath: `/vibe/${key}`, remote });
    const props = (key: string) => probe.project(key);

    test('upsertSession stores the remote, and a later null does not erase it', async () => {
      await repo.upsertSession(clone('demo', 'github.com/org/demo'), session(2), []);
      expect((await props('demo'))?.remote).toBe('github.com/org/demo');
      await repo.upsertSession(project, session(2), []);
      expect((await props('demo'))?.remote).toBe('github.com/org/demo');
    });

    test('a new folder with a known remote resolves to the existing project and is recorded as its alias', async () => {
      await repo.upsertSession(clone('demo', 'github.com/org/demo'), session(2), []);
      const r = await repo.canonicalProject(clone('demo-2', 'github.com/org/demo'));
      expect(r).toEqual({ project: { key: 'demo', name: 'demo', repoPath: '/vibe/demo', remote: 'github.com/org/demo' }, aliasedNow: true });
      expect((await props('demo'))?.aliases).toEqual(['demo-2']);
      // Second meeting: same answer, not a new alias.
      expect(await repo.canonicalProject(clone('demo-2', 'github.com/org/demo'))).toMatchObject({ project: { key: 'demo' }, aliasedNow: false });
      expect((await props('demo'))?.aliases).toEqual(['demo-2']);
      expect(await props('demo-2')).toBeNull();
      expect(await repo.projectByAlias('demo-2')).toMatchObject({ key: 'demo' });
      expect(await repo.projectByAlias('demo')).toBeNull();
    });

    test('a dry run names the project a folder would follow without recording the alias', async () => {
      await repo.upsertSession(clone('demo', 'github.com/org/demo'), session(2), []);
      expect(await repo.canonicalProject(clone('demo-2', 'github.com/org/demo'), { dryRun: true })).toMatchObject({ project: { key: 'demo' }, aliasedNow: false });
      expect((await props('demo'))?.aliases).toEqual([]);
      expect(await repo.projectByAlias('demo-2')).toBeNull();
      expect(await repo.canonicalProject(clone('fresh', 'github.com/org/fresh'), { dryRun: true })).toMatchObject({ project: { key: 'fresh' }, aliasedNow: false });
    });

    test('a folder that already is a project, or has no remote, stays itself', async () => {
      await repo.upsertSession(clone('demo', 'github.com/org/demo'), session(2), []);
      await repo.upsertSession(clone('other', null), { ...session(1), sessionId: 's2' }, []);
      expect(await repo.canonicalProject(clone('other', 'github.com/org/demo'))).toMatchObject({ project: { key: 'other' }, aliasedNow: false });
      expect(await repo.canonicalProject(clone('fresh', null))).toMatchObject({ project: { key: 'fresh' }, aliasedNow: false });
      expect(await repo.canonicalProject(clone('demo', 'github.com/org/demo'))).toMatchObject({ project: { key: 'demo' }, aliasedNow: false });
      expect((await props('demo'))?.aliases).toEqual([]);
    });

    test('backfill lists projects without a remote and fills one in place', async () => {
      await repo.upsertSession(project, session(2), []);
      await repo.upsertSession(clone('known', 'local/known'), { ...session(1), sessionId: 's2' }, []);
      expect((await repo.projectsMissingRemote()).map((p) => p.key)).toEqual(['demo']);
      const turns = await probe.count('Turn');
      await repo.setProjectRemote('demo', 'github.com/org/demo');
      expect((await props('demo'))?.remote).toBe('github.com/org/demo');
      expect(await repo.projectsMissingRemote()).toEqual([]);
      expect(await probe.count('Turn')).toBe(turns);
    });

    test('a record made with no folder (a code map) is listed and gets its path and remote, never overwriting one', async () => {
      await h.store.codegraph.replaceCodeMap('mapped', { files: [], symbols: [], imports: [], tests: [], churn: {}, fingerprint: null });
      await repo.upsertSession(clone('known', 'local/known'), session(2), []);
      expect((await repo.projectsMissingFolder()).map((p) => p.key)).toEqual(['mapped']);
      await repo.fillProjectFolder('mapped', { repoPath: '/vibe/mapped', remote: 'github.com/org/mapped' });
      await repo.fillProjectFolder('known', { repoPath: '/elsewhere', remote: 'github.com/org/other' });
      expect(await repo.projectsMissingFolder()).toEqual([]);
      expect(await props('mapped')).toMatchObject({ repoPath: '/vibe/mapped', remote: 'github.com/org/mapped' });
      expect(await props('known')).toMatchObject({ repoPath: '/vibe/known', remote: 'local/known' });
    });
  });
});
