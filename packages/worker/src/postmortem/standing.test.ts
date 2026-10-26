import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HumanTurn, PostMortemInput } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { loadStandingContext, markAvailability, runPostMortem, type StandingDoc } from './postmortem.ts';
import { claimsNotLoaded, correctStandingClaims, sessionEvidence } from './standing.ts';

const turn = (i: number, text: string, extra: Partial<HumanTurn> = {}): HumanTurn => ({
  uuid: `t${i}`, sessionId: 's1', ts: `2026-10-01T10:0${i}:00Z`, index: i, text, precedingAssistantText: '', precedingToolCalls: [], ...extra,
});
const input: PostMortemInput = {
  feedbackId: 't1', projectKey: 'demo', repoPath: '/vibe/demo', cwd: '/Users/you/Vibe/demo', sessionId: 's1', note: null,
  feedback: turn(1, 'you used npm, this repo uses pnpm'), turns: [turn(0, 'add the members list'), turn(1, 'you used npm, this repo uses pnpm')],
};

function tree() {
  const root = mkdtempSync(join(tmpdir(), 'fbstand-'));
  const repo = join(root, 'demo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'AGENTS.md'), 'Use pnpm, never npm.');
  writeFileSync(join(repo, 'CLAUDE.md'), 'See the shared rules.\n\n@AGENTS.md\n');
  return { root, repo, mem: join(root, 'mem') };
}

describe('what standing context the agent had: from the session, not only from which agent it was', () => {
  test('an AGENTS.md the Claude Code transcript attached is loaded', async () => {
    const { root, repo, mem } = tree();
    writeFileSync(join(repo, 'CLAUDE.md'), 'project rules');
    const plain = await loadStandingContext({ repoPath: repo, stopAt: root, memoryDir: mem, source: 'claude' });
    expect(plain.find((d) => d.kind === 'agents_md')?.loaded).toBe(false);
    const items = await loadStandingContext({ repoPath: repo, stopAt: root, memoryDir: mem, source: 'claude', evidence: ['/Users/you/Vibe/demo/AGENTS.md'] });
    expect(items.map((d) => [d.kind, d.loaded])).toEqual([['claude_md', true], ['agents_md', true]]);
  });

  test('an AGENTS.md that a loaded CLAUDE.md imports (@AGENTS.md) is loaded, with no transcript evidence', async () => {
    const { root, repo, mem } = tree();
    const items = await loadStandingContext({ repoPath: repo, stopAt: root, memoryDir: mem, source: 'claude' });
    expect(items.map((d) => [d.kind, d.loaded])).toEqual([['claude_md', true], ['agents_md', true]]);
  });

  test('evidence of another folder\'s AGENTS.md does not make this one loaded', async () => {
    const { root, repo, mem } = tree();
    writeFileSync(join(repo, 'CLAUDE.md'), 'project rules');
    const items = await loadStandingContext({ repoPath: repo, stopAt: root, memoryDir: mem, source: 'claude', evidence: ['/Users/you/Vibe/other/AGENTS.md'] });
    expect(items.find((d) => d.kind === 'agents_md')?.loaded).toBe(false);
  });

  test('sessionEvidence: the instruction files the transcript showed, and those the agent read before the feedback', () => {
    const read = { ...input, turns: [turn(0, 'go'), turn(1, 'x', { precedingToolCalls: [{ name: 'Read', ts: 't', filePath: '/Users/you/Vibe/demo/CLAUDE.md' }] })] };
    expect(sessionEvidence({ ...read, feedback: read.turns[1] }, ['/Users/you/Vibe/demo/AGENTS.md'])).toEqual(['/Users/you/Vibe/demo/AGENTS.md', '/Users/you/Vibe/demo/CLAUDE.md']);
    expect(sessionEvidence(input, null)).toEqual([]);
  });

  test('markAvailability counts an instruction file as available when the standing context says it was loaded', () => {
    const standing: StandingDoc[] = [{ kind: 'agents_md', ref: '/vibe/demo/AGENTS.md', text: 'Use pnpm', loaded: true }];
    const items = markAvailability([{ kind: 'code', ref: 'AGENTS.md:1', excerpt: 'Use pnpm', why: 'says pnpm' }], input, standing);
    expect(items.map((i) => [i.kind, i.wasAvailable])).toEqual([['agents_md', true]]);
    // Without that evidence, a Claude Code agent's AGENTS.md is not.
    expect(markAvailability([{ kind: 'code', ref: 'AGENTS.md', excerpt: '', why: '' }], input).map((i) => i.wasAvailable)).toEqual([false]);
  });
});

describe('a cause that contradicts the evidence is refused', () => {
  test('claimsNotLoaded finds "did not load X" in its many wordings, and nothing in a sentence that does not say it', () => {
    expect(claimsNotLoaded('Claude Code does not load AGENTS.md, so the pnpm rule was never seen.')).toEqual(['agents_md']);
    expect(claimsNotLoaded("The agent didn't read the AGENTS.md rules.")).toEqual(['agents_md']);
    expect(claimsNotLoaded('AGENTS.md was not loaded by this agent.')).toEqual(['agents_md']);
    expect(claimsNotLoaded('The rule is only in AGENTS.md, which this agent never loads.')).toEqual(['agents_md']);
    expect(claimsNotLoaded('CLAUDE.md is not in its context')).toEqual(['claude_md']);
    expect(claimsNotLoaded('AGENTS.md says to use pnpm and the agent used npm.')).toEqual([]);
    expect(claimsNotLoaded('The agent did not run the tests; CLAUDE.md asks for them.')).toEqual([]);
  });

  test('a context_missing blamed on an AGENTS.md that was loaded becomes context_available_ignored, the false sentence dropped and flagged', () => {
    const standing: StandingDoc[] = [{ kind: 'agents_md', ref: '/vibe/demo/AGENTS.md', text: 'Use pnpm', loaded: true }];
    const r = correctStandingClaims({ cause: 'context_missing', missed: 'used npm instead of pnpm', causeExplanation: 'The agent does not load AGENTS.md, which says to use pnpm. It ran npm install.' }, standing);
    expect(r.cause).toBe('context_available_ignored');
    expect(r.causeExplanation).toBe('AGENTS.md was in the agent\'s context in this session (/vibe/demo/AGENTS.md), so it was available and not followed. It ran npm install.');
    expect(r.flag).toEqual({ name: 'contradicts-evidence', why: expect.stringContaining('said AGENTS.md was not loaded, but the session had it (/vibe/demo/AGENTS.md); cause context_missing changed to context_available_ignored') });
  });

  test('the same claim about a file that really was not loaded stands', () => {
    const standing: StandingDoc[] = [{ kind: 'agents_md', ref: '/vibe/demo/AGENTS.md', text: 'Use pnpm', loaded: false }];
    const before = { cause: 'context_missing' as const, missed: 'm', causeExplanation: 'The agent does not load AGENTS.md.' };
    expect(correctStandingClaims(before, standing)).toEqual({ ...before, flag: null });
  });

  test('runPostMortem applies it, and the prompt tells the model a loaded file was seen', async () => {
    let prompt = '';
    const r = await runPostMortem(input, {
      standing: async () => [{ kind: 'agents_md', ref: '/vibe/demo/AGENTS.md', text: 'Use pnpm', loaded: true }],
      facts: async () => [],
      llm: { id: 'fake', agentic: false, json: async (o: { user: string }) => {
        prompt = o.user;
        return {
          taskTitle: 'Members list', missed: 'used npm instead of pnpm', cause: 'context_missing', causeExplanation: 'Claude Code does not load AGENTS.md.', outcome: 'addressed',
          lesson: { title: 'Use pnpm here', rule: 'Run pnpm, not npm, in package.json scripts', appliesWhen: 'installing packages', scope: 'project', paths: ['package.json'] },
          contextItems: [{ kind: 'agents_md', ref: 'AGENTS.md', excerpt: 'Use pnpm', why: 'says pnpm' }],
        };
      } } as never,
    });
    expect(prompt).toMatch(/never give as the cause that the agent did not load or could not see a file marked loaded/i);
    expect(r.cause).toBe('context_available_ignored');
    expect(r.contextItems[0].wasAvailable).toBe(true);
    expect(r.lessonChecks?.map((c) => c.name)).toContain('contradicts-evidence');
  });
});
