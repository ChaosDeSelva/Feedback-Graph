import { expect, test } from 'vitest';
import type { Lesson } from '@fb/core';
import { checkBeforeDone } from './context.ts';

const lesson: Lesson = { id: 'l1', projectKey: 'demo', origin: 'demo', title: 'Document new tools', rule: 'Add an entry to docs/tools.md for every new tool', appliesWhen: 'adding an MCP tool', scope: 'project', paths: ['packages/api/src/mcp.ts'], status: 'approved', source: 'postmortem', cause: null, missId: null, createdAt: 't', decidedAt: 't' };
const diff = 'diff --git a/packages/api/src/mcp.ts b/packages/api/src/mcp.ts\n--- a/packages/api/src/mcp.ts\n+++ b/packages/api/src/mcp.ts\n@@ -10,3 +10,4 @@\n ctx\n+  server.registerTool(\'new_tool\', {});\n';

test('a missing file the lesson names with its folder is asked of the repo as written, not beside each changed file', async () => {
  const asked: string[][] = [];
  const r = await checkBeforeDone({ project: 'demo', task: 'add a new MCP tool to the MCP server', summary: 'added new_tool', diff, filesChanged: ['packages/api/src/mcp.ts'] }, {
    roots: [{ host: '/projects', container: '/projects' }], exists: () => true, embed: async () => [[1]],
    k: { searchLessons: async () => [{ lesson, score: .9 }], relatedMisses: async () => [], missesNaming: async () => [], createManualFeedback: async () => 'f', recordPreDoneCheck: async () => {} },
    judge: async () => [{ lessonId: 'l1', status: 'not_addressed', applies: true, why: 'docs/tools.md has no entry for new_tool' }],
    repoDiff: async (_repo, files) => { asked.push(files); return { text: '', files }; },
  });
  expect(asked).toEqual([['docs/tools.md']]);
  expect(r.gaps).toMatchObject([{ lessonId: 'l1', missing: ['docs/tools.md'] }]);
});
