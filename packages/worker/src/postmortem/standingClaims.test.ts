import type { HumanTurn, PostMortemInput } from '@fb/core';
import { expect, test } from 'vitest';
import type { StandingDoc } from './postmortem.ts';
import { correctStandingClaims, sessionEvidence } from './standing.ts';

const turn = (i: number, extra: Partial<HumanTurn> = {}): HumanTurn => ({ uuid: `t${i}`, sessionId: 's1', ts: 't', index: i, text: 'x', precedingAssistantText: '', precedingToolCalls: [], ...extra });
const standing: StandingDoc[] = [{ kind: 'claude_md', ref: '/vibe/demo/CLAUDE.md', text: 'Run the tests', loaded: true }];

test('a claim that a loaded file was not loaded is dropped under any other cause, which stands; a miss that is only the claim is kept', () => {
  const r = correctStandingClaims({ cause: 'implementation_error', missed: 'The agent never read CLAUDE.md.', causeExplanation: 'CLAUDE.md is not in its context. It skipped the tests.' }, standing);
  expect(r.cause).toBe('implementation_error');
  expect(r.missed).toBe('The agent never read CLAUDE.md.');
  expect(r.causeExplanation).toBe("CLAUDE.md was in the agent's context in this session (/vibe/demo/CLAUDE.md). It skipped the tests.");
  expect(r.flag?.why).toMatch(/; the claim was dropped$/);
});

test("a review comment's evidence is the session that did its work, none when no session was matched", () => {
  const read = turn(0, { precedingToolCalls: [{ name: 'Read', ts: 't', filePath: '/w/demo/AGENTS.md' }] });
  const comment = turn(1, { external: { source: 'github' } as HumanTurn['external'] });
  const base = { feedbackId: 'c', projectKey: 'demo', repoPath: '/vibe/demo', cwd: '/w/demo', sessionId: 's1', note: null, feedback: comment, turns: [] } as PostMortemInput;
  expect(sessionEvidence({ ...base, work: { sessionId: 'w', source: 'claude', cwd: '/w/demo', turns: [read], matchedBy: 'branch' } }, null)).toEqual(['/w/demo/AGENTS.md']);
  expect(sessionEvidence(base, null)).toEqual([]);
});
