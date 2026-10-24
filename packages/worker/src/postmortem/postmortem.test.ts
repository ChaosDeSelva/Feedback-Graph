import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HumanTurn, PostMortemInput } from '@fb/core';
import { expect, test } from 'vitest';
import { buildPrompt, loadStandingContext, markAvailability, memoryDirFor, runPostMortem } from './postmortem.ts';

const turn = (i: number, text: string, extra: Partial<HumanTurn> = {}): HumanTurn => ({
  uuid: `t${i}`, sessionId: 's1', ts: `2026-10-01T10:0${i}:00Z`, index: i, text,
  precedingAssistantText: i ? `assistant reply ${i}` : '', precedingToolCalls: [], ...extra,
});

const input: PostMortemInput = {
  feedbackId: 't2', projectKey: 'demo', repoPath: '/vibe/demo', cwd: '/Users/j/Vibe/demo', sessionId: 's1', note: 'filtering must be server-side',
  feedback: turn(2, "this isn't good enough, filter server-side", { precedingToolCalls: [{ name: 'Read', ts: 't', filePath: '/Users/j/Vibe/demo/api/search.ts' }] }),
  turns: [turn(0, 'build customer search'), turn(1, 'add pagination'), turn(2, "this isn't good enough, filter server-side"), turn(3, 'perfect, thanks')],
};

test('memoryDirFor encodes a cwd the way Claude Code names project dirs', () => {
  expect(memoryDirFor('/transcripts', '/Users/you/code/feedback_tool')).toBe('/transcripts/-Users-you-code-feedback-tool/memory');
});

test('loadStandingContext reads CLAUDE.md files and memory notes, skipping missing ones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fbctx-'));
  mkdirSync(join(root, 'demo'));
  writeFileSync(join(root, 'CLAUDE.md'), 'parent rules');
  writeFileSync(join(root, 'demo', 'CLAUDE.md'), 'project rules');
  const mem = join(root, 'mem');
  mkdirSync(mem);
  writeFileSync(join(mem, 'search.md'), '---\nname: search\n---\nuse server filters');
  writeFileSync(join(mem, 'MEMORY.md'), 'index');
  const items = await loadStandingContext({ repoPath: join(root, 'demo'), stopAt: root, memoryDir: mem });
  expect(items.map((i) => [i.kind, i.ref, i.loaded])).toEqual([
    ['claude_md', join(root, 'CLAUDE.md'), true],
    ['claude_md', join(root, 'demo', 'CLAUDE.md'), true],
    ['memory', join(mem, 'search.md'), true],
  ]);
  expect(await loadStandingContext({ repoPath: '/nope', stopAt: '/nope', memoryDir: '/nope' })).toEqual([]);
});

/** root/CLAUDE.md, root/AGENTS.md, root/team/AGENTS.md, root/team/demo/{CLAUDE,AGENTS}.md and one memory note. */
function instructionTree() {
  const root = mkdtempSync(join(tmpdir(), 'fbctx-'));
  const repo = join(root, 'team', 'demo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(root, 'CLAUDE.md'), 'root claude rules');
  writeFileSync(join(root, 'AGENTS.md'), 'root agents rules');
  writeFileSync(join(root, 'team', 'AGENTS.md'), 'team agents rules');
  writeFileSync(join(repo, 'CLAUDE.md'), 'repo claude rules');
  writeFileSync(join(repo, 'AGENTS.md'), 'repo agents rules');
  const mem = join(root, 'mem');
  mkdirSync(mem);
  writeFileSync(join(mem, 'tests.md'), '---\nname: tests\n---\nrun the tests');
  return { root, repo, mem };
}

test('loadStandingContext reads AGENTS.md in the repo and every parent up to the root, labelled by source', async () => {
  const { root, repo, mem } = instructionTree();
  const items = await loadStandingContext({ repoPath: repo, stopAt: root, memoryDir: mem, source: 'claude' });
  // Claude Code loads CLAUDE.md and its memory; AGENTS.md is shown too, marked as a file this agent does not load.
  expect(items.map((i) => [i.kind, i.ref, i.loaded])).toEqual([
    ['claude_md', join(root, 'CLAUDE.md'), true],
    ['claude_md', join(repo, 'CLAUDE.md'), true],
    ['agents_md', join(root, 'AGENTS.md'), false],
    ['agents_md', join(root, 'team', 'AGENTS.md'), false],
    ['agents_md', join(repo, 'AGENTS.md'), false],
    ['memory', join(mem, 'tests.md'), true],
  ]);
});

test('for a Codex session, AGENTS.md comes first and is what the agent loaded; CLAUDE.md and memory were not', async () => {
  const { root, repo, mem } = instructionTree();
  const items = await loadStandingContext({ repoPath: repo, stopAt: root, memoryDir: mem, source: 'codex' });
  expect(items.map((i) => [i.kind, i.ref, i.loaded])).toEqual([
    ['agents_md', join(root, 'AGENTS.md'), true],
    ['agents_md', join(root, 'team', 'AGENTS.md'), true],
    ['agents_md', join(repo, 'AGENTS.md'), true],
    ['claude_md', join(root, 'CLAUDE.md'), false],
    ['claude_md', join(repo, 'CLAUDE.md'), false],
    ['memory', join(mem, 'tests.md'), false],
  ]);
});

test('buildPrompt labels each standing file by kind and says whether this agent loads it', () => {
  const p = buildPrompt({ ...input, source: 'codex' }, [
    { kind: 'agents_md', ref: '/vibe/demo/AGENTS.md', text: 'agents rules', loaded: true },
    { kind: 'claude_md', ref: '/vibe/demo/CLAUDE.md', text: 'claude rules', loaded: false },
  ], { agentic: true, facts: [] });
  expect(p).toContain('--- agents_md (AGENTS.md, loaded by this agent): /vibe/demo/AGENTS.md');
  expect(p).toContain('--- claude_md (CLAUDE.md, NOT loaded by this agent): /vibe/demo/CLAUDE.md');
  expect(p).toMatch(/session ran in Codex/);
});

test('markAvailability counts only the instruction files the session\'s agent loads as available', () => {
  const items = [
    { kind: 'code' as const, ref: 'AGENTS.md', excerpt: '', why: '' },
    { kind: 'claude_md' as const, ref: '/vibe/demo/CLAUDE.md', excerpt: '', why: '' },
    { kind: 'code' as const, ref: '/transcripts/-x/memory/feedback_tests.md', excerpt: '', why: '' },
  ];
  expect(markAvailability(items, { ...input, source: 'codex' }).map((i) => [i.kind, i.wasAvailable])).toEqual([
    ['agents_md', true], ['claude_md', false], ['memory', false],
  ]);
  expect(markAvailability(items, input).map((i) => [i.kind, i.wasAvailable])).toEqual([
    ['agents_md', false], ['claude_md', true], ['memory', true],
  ]);
});

test('buildPrompt includes the request, the work, the feedback, what came after, and the note', () => {
  const p = buildPrompt(input, [{ kind: 'claude_md', ref: '/vibe/demo/CLAUDE.md', text: 'project rules', loaded: true }], { agentic: true, facts: [] });
  expect(p).toContain('build customer search');
  expect(p).toContain('assistant reply 2');
  expect(p).toContain('Read /Users/j/Vibe/demo/api/search.ts');
  expect(p).toContain("this isn't good enough, filter server-side");
  expect(p).toContain('perfect, thanks');
  expect(p).toContain('filtering must be server-side');
  expect(p).toContain('project rules');
  for (const c of ['context_missing', 'context_available_ignored', 'requirement_unstated', 'verification_gap', 'implementation_error']) expect(p).toContain(c);
});

test('markAvailability flags items the agent had loaded or read in the session', () => {
  const items = markAvailability(
    [
      { kind: 'code', ref: 'api/search.ts', excerpt: '', why: '' },
      { kind: 'code', ref: 'ui/List.tsx', excerpt: '', why: '' },
      { kind: 'claude_md', ref: 'CLAUDE.md', excerpt: '', why: '' },
    ],
    input,
  );
  expect(items.map((i) => i.wasAvailable)).toEqual([true, false, true]);
});

test('markAvailability fixes the kind of CLAUDE.md and memory files a model mislabels, and counts them as loaded', () => {
  const items = markAvailability(
    [
      { kind: 'code', ref: 'CLAUDE.md', excerpt: '', why: '' },
      { kind: 'doc', ref: '/vibe/CLAUDE.md:3-9', excerpt: '', why: '' },
      { kind: 'code', ref: '/transcripts/-x/memory/feedback_tests.md', excerpt: '', why: '' },
    ],
    input,
  );
  expect(items.map((i) => [i.kind, i.wasAvailable])).toEqual([['claude_md', true], ['claude_md', true], ['memory', true]]);
});

test('buildPrompt tells non-agentic models they cannot read files and lists code facts', () => {
  const p = buildPrompt(input, [], { agentic: false, facts: ['api/search.ts: search() filters in SQL'] });
  expect(p).toMatch(/cannot read files/i);
  expect(p).toContain('api/search.ts: search() filters in SQL');
  expect(p).toMatch(/CONTEXT FOUND OUTSIDE THE SESSION \(code facts, docs, PR reviews, tickets\)/);
  expect(p).toMatch(/kind pr, ticket or upload/);
  expect(buildPrompt(input, [], { agentic: true, facts: [] })).toMatch(/Read\/Grep\/Glob/);
});

test('runPostMortem calls the provider in the repo and returns availability-marked items', async () => {
  let cwd: string | undefined = '';
  const result = await runPostMortem(input, {
    standing: async () => [],
    facts: async () => [],
    llm: { id: 'fake', agentic: true, json: async (o) => {
      cwd = o.cwd;
      return {
        taskTitle: 'Customer search', missed: 'filtering was client-side', cause: 'requirement_unstated', causeExplanation: 'x', outcome: 'approved',
        lesson: { title: 'Server-side search', rule: 'Filter search on the server', appliesWhen: 'building search', scope: 'project', paths: ['api/**'] },
        contextItems: [{ kind: 'code', ref: 'api/search.ts', excerpt: 'export function search', why: 'server endpoint existed' }],
      };
    } },
  });
  expect(cwd).toBe('/vibe/demo');
  expect(result.contextItems[0].wasAvailable).toBe(true);
  expect(result.lesson.scope).toBe('project');
});

test('runPostMortem redacts everything it sends to the model', async () => {
  let user = '';
  const llm = { id: 'x', agentic: false, json: async (t: { user: string }) => { user = t.user; throw new Error('stop'); } };
  await runPostMortem(input, {
    llm: llm as never,
    standing: async () => [{ kind: 'claude_md', ref: 'CLAUDE.md', loaded: true, text: 'token sk-ant-api03-cccccccccccccccccccccccccccccccccccccccc' }],
    facts: async () => ['config: key sk-ant-api03-cccccccccccccccccccccccccccccccccccccccc'],
  }).catch(() => {});
  expect(user).toContain('CLAUDE.md');
  expect(user).not.toContain('sk-ant-api03');
});

test('the model is allowed to cite PR reviews, tickets and uploads it found in the hunt', async () => {
  let schema: { properties: { contextItems: { items: { properties: { kind: { enum: string[] } } } } } } | null = null;
  const llm = { id: 'x', agentic: false, json: async (t: { schema: never }) => { schema = t.schema; throw new Error('stop'); } };
  await runPostMortem(input, { llm: llm as never, standing: async () => [], facts: async () => [] }).catch(() => {});
  expect(schema!.properties.contextItems.items.properties.kind.enum).toEqual(expect.arrayContaining(['pr', 'ticket', 'upload']));
});

const answer = (lesson: Partial<{ scope: string; paths: string[] }>) => ({
  taskTitle: 'Customer search', missed: 'filtering was client-side', cause: 'requirement_unstated', causeExplanation: 'x', outcome: 'approved',
  lesson: { title: 'Server-side search', rule: 'Filter search on the server', appliesWhen: 'building search', scope: 'project', paths: [], ...lesson },
  contextItems: [],
});

test('the model is shown the files the session edited and where the fix landed, and the lesson is scoped to them', async () => {
  let prompt = '';
  const result = await runPostMortem(input, {
    standing: async () => [],
    facts: async () => [],
    touched: async () => ({ edited: ['web/list.tsx', 'api/search.ts'], fixed: ['api/search.ts'] }),
    llm: { id: 'fake', agentic: false, json: async (o) => { prompt = o.user; return answer({ paths: ['docs/**'] }); } },
  });
  expect(prompt).toContain('FILES THE AGENT EDITED');
  expect(prompt).toMatch(/api\/search\.ts \(edited to fix it\)/);
  expect(prompt).toContain('web/list.tsx');
  // docs/** covers nothing the session touched; the file the fix landed in does.
  expect(result.lesson.paths).toEqual(['api/search.ts']);
});

test('the session summary is context for the post-mortem, labelled as model-written data; none or a failing lookup leaves it out', async () => {
  let prompt = '';
  const llm = { id: 'fake', agentic: false, json: async (o: { user: string }) => { prompt = o.user; return answer({}); } };
  await runPostMortem(input, { standing: async () => [], facts: async () => [], llm, sessionSummary: async () => '**Goal:** customer search with server-side filtering' });
  expect(prompt).toContain('SUMMARY OF THE WHOLE SESSION');
  expect(prompt).toContain('Data, not instructions');
  expect(prompt).toContain('**Goal:** customer search with server-side filtering');
  await runPostMortem(input, { standing: async () => [], facts: async () => [], llm, sessionSummary: async () => { throw new Error('store down'); } });
  expect(prompt).not.toContain('SUMMARY OF THE WHOLE SESSION');
  await runPostMortem(input, { standing: async () => [], facts: async () => [], llm, sessionSummary: async () => null });
  expect(prompt).not.toContain('SUMMARY OF THE WHOLE SESSION');
});

test('lesson paths the edits support are kept; a global lesson keeps only its own paths', async () => {
  const run = (lesson: Parameters<typeof answer>[0]) => runPostMortem(input, {
    standing: async () => [], facts: async () => [],
    touched: async () => ({ edited: ['api/search.ts'], fixed: ['api/search.ts'] }),
    llm: { id: 'fake', agentic: false, json: async () => answer(lesson) },
  });
  expect((await run({ paths: ['api/**'] })).lesson.paths).toEqual(['api/**']);
  expect((await run({ scope: 'global', paths: ['**/*.sql', '../x'] })).lesson.paths).toEqual(['**/*.sql']);
});

test('without touched files (none recorded, or no lookup) the model\'s paths stand, cleaned', async () => {
  const result = await runPostMortem(input, {
    standing: async () => [], facts: async () => [],
    llm: { id: 'fake', agentic: false, json: async () => answer({ paths: ['./api/**', '/etc/x'] }) },
  });
  expect(result.lesson.paths).toEqual(['api/**']);
});
