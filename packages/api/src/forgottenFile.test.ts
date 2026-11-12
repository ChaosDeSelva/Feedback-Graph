import { describe, expect, test } from 'vitest';
import type { Lesson } from '@fb/core';
import { checkBeforeDone, type ContextDeps, type Verdict } from './context.ts';

// "You forgot X" lessons: an omission has no diff line to cite, so a gap rests on the file the lesson requires that the
// change leaves out. Each negative case is one way a missing file could be guessed at instead of shown.
const lesson = (rule: string, paths: string[] = ['packages/api/src/mcp.ts']): Lesson => ({ id: 'l1', projectKey: 'demo', origin: 'demo', title: 'Test new MCP tools', rule, appliesWhen: 'adding an MCP tool', scope: 'project', paths, status: 'approved', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't' });
const RULE = 'When adding a new MCP tool in mcp.ts, write a corresponding test in mcp.test.ts';
const file = (path: string, line = '+  server.registerTool(\'new_tool\', {});') => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -10,3 +10,4 @@\n ctx\n${line}\n`;
const MCP_ONLY = file('packages/api/src/mcp.ts');
const WHY = 'The diff modifies mcp.ts but does not show any corresponding changes in mcp.test.ts.';

const TASK = 'add a new MCP tool to the MCP server';
/** The check, after asserting the lesson reached the judge, so a negative case can never pass by not being judged. */
const check = async (o: { rule?: string; paths?: string[]; diff?: string; why?: string; status?: Verdict['status']; filesChanged?: string[]; repoDiff?: ContextDeps['repoDiff'] } = {}) => {
  let judged = 0;
  const r = await checkBeforeDone(
    { project: 'demo', task: TASK, summary: 'added new_tool', diff: o.diff ?? MCP_ONLY, filesChanged: o.filesChanged ?? ['packages/api/src/mcp.ts'] },
    {
      roots: [{ host: '/projects', container: '/projects' }], exists: () => true, embed: async () => [[1]],
      k: { searchLessons: async () => [{ lesson: lesson(o.rule ?? RULE, o.paths), score: .9 }], relatedMisses: async () => [], missesNaming: async () => [], createManualFeedback: async () => 'f', recordPreDoneCheck: async () => {} },
      judge: async () => { judged++; return [{ lessonId: 'l1', status: o.status ?? 'not_addressed', applies: true, why: o.why ?? WHY }]; },
      ...(o.repoDiff && { repoDiff: o.repoDiff }),
    },
  );
  expect(judged).toBe(1);
  return r;
};

test('a lesson requiring a change to a file the diff leaves out is a gap that cites the missing file', async () => {
  const r = await check();
  expect(r.gaps).toMatchObject([{ lessonId: 'l1', missing: ['mcp.test.ts'] }]);
  expect(r.gaps[0].evidence).toBeUndefined();
  expect(r.cannotTell).toEqual([]);
  expect(r.markdown).toContain('not in the diff: `mcp.test.ts`, which the lesson says to change');
});

test('the lesson\'s paths say what it governs, and a named path must be absent as written', async () => {
  const rule = 'Add an entry to docs/tools.md for every new tool';
  const why = 'docs/tools.md has no entry for new_tool';
  expect((await check({ rule, why })).gaps).toMatchObject([{ missing: ['docs/tools.md'] }]);
  // Another tools.md is not the one the lesson names.
  expect((await check({ rule, why, diff: MCP_ONLY + file('site/tools.md', '+new_tool') })).gaps).toMatchObject([{ missing: ['docs/tools.md'] }]);
  expect((await check({ rule, why, diff: MCP_ONLY + file('docs/tools.md', '+new_tool') })).gaps).toEqual([]);
});

test('the repo is asked when it can be: a new file the agent never git add -N\'ed is no gap', async () => {
  const asked: string[][] = [];
  const changed = await check({ repoDiff: async (_repo, files) => { asked.push(files); return { text: file('packages/api/src/mcp.test.ts', '+test()'), files }; } });
  expect(asked).toEqual([['packages/api/src/mcp.test.ts']]);
  expect(changed.gaps).toEqual([]);
  expect(changed.cannotTell?.map((c) => c.lessonId)).toEqual(['l1']);
  expect((await check({ repoDiff: async () => null })).gaps).toMatchObject([{ missing: ['mcp.test.ts'] }]);
  expect((await check({ repoDiff: async () => { throw new Error('git failed'); } })).gaps).toEqual([]);
});

describe('never a guessed gap: each stays cannot_tell', () => {
  test.each([
    ['the lesson names no file, only "a test"', { rule: 'When adding a new MCP tool in mcp.ts, write a corresponding test' }],
    ['the file is named but no change to it is required', { rule: 'mcp.ts and mcp.test.ts describe each tool; keep tools small' }],
    ['the lesson forbids changing the file', { rule: 'When adding a tool in mcp.ts, do not update snapshot.json by hand', why: 'snapshot.json was not regenerated' }],
    ['the file is only in the lesson\'s condition ("When adding a tool in X")', { rule: 'When adding a new MCP tool in registry.ts, keep its name short', why: 'registry.ts is not in the diff' }],
    ['the diff does not touch the code the lesson governs', { diff: file('packages/api/src/app.ts') }],
    ['the required file is in the diff', { diff: MCP_ONLY + file('packages/api/src/mcp.test.ts', '+test()') }],
    ['the required file is in files_changed (left out of the diff the judge read)', { filesChanged: ['packages/api/src/mcp.ts', 'packages/api/src/mcp.test.ts'] }],
    ['the judge\'s reason does not name the file', { why: 'no tests were added for the new tool' }],
    ['the verdict is not "not followed"', { status: 'addressed' as const }],
    ['a prose ending is not a file (Node.js, e.g.)', { rule: 'When adding a tool in mcp.ts, also update Node.js usage, e.g. streams', why: 'Node.js streams unchanged' }],
  ])('%s', async (_name, o) => {
    const r = await check(o);
    expect(r.gaps).toEqual([]);
  });

  test('a diff read from the repo for files_changed is not the whole change', async () => {
    const r = await checkBeforeDone(
      { project: 'demo', task: TASK, summary: 'added new_tool', filesChanged: ['packages/api/src/mcp.ts'] },
      {
        roots: [{ host: '/projects', container: '/projects' }], exists: () => true, embed: async () => [[1]],
        k: { searchLessons: async () => [{ lesson: lesson(RULE), score: .9 }], relatedMisses: async () => [], missesNaming: async () => [], createManualFeedback: async () => 'f', recordPreDoneCheck: async () => {} },
        judge: async () => [{ lessonId: 'l1', status: 'not_addressed', applies: true, why: WHY }],
        repoDiff: async (_repo, files) => ({ text: MCP_ONLY, files }),
      },
    );
    expect(r.gaps).toEqual([]);
    expect(r.cannotTell?.map((c) => c.lessonId)).toEqual(['l1']);
  });
});

test('a secret file the lesson requires is never a missing-file gap: it is left out of every diff (sweep 4 NEW-5)', async () => {
  const rule = 'When adding a new MCP tool in mcp.ts, also add it to config/secrets.json';
  const why = 'config/secrets.json has no entry for new_tool';
  const secretFile = file('config/secrets.json', '+  "new_tool": {}');
  for (const diff of [MCP_ONLY, MCP_ONLY + secretFile]) {
    const r = await check({ rule, why, diff, filesChanged: ['packages/api/src/mcp.ts', 'config/secrets.json'] });
    expect(r.gaps.flatMap((g) => g.missing ?? [])).toEqual([]);
    expect(r.markdown).not.toContain('not in the diff');
  }
});
