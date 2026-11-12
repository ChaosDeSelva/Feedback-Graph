import { expect, test } from 'vitest';
import { checkUnanswered, compactContext, contextForPrompt, doneCheckPending, editedSince, mcpText, stopDecision, taskContextArgs } from './lib.mjs';

const line = (o) => JSON.stringify(o);
const use = (id, name, input = {}) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const answer = (id, content, isError = false) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } });
const CHECK = 'mcp__plugin_feedback-graph_fg__check_before_done';

test('an approved lesson longer than the whole budget is still shown once, whole, and not again', () => {
  const md = ['# Feedback Graph context for "t" in demo', '', '## Approved lessons (follow these)', `- **Huge rule**: ${'r'.repeat(2_000)}`, '  - applies when: x · lesson big · relevance 0.80'].join('\n');
  expect(compactContext(md)).toContain('Huge rule');
  const first = contextForPrompt(md, { asked: false, shown: [] });
  expect(first.text).toContain('lesson big');
  expect(first.state.shown).toEqual(['big']);
  expect(contextForPrompt(md, first.state).text).toBeNull();
});

test('an approved lesson with no lesson id is keyed by its first line, so it is shown once per session', () => {
  const md = ['## Approved lessons (follow these)', '- **Untitled**: always release the pool client'].join('\n');
  const first = contextForPrompt(md, { asked: false, shown: [] });
  // No "# " title line: the context starts at the section.
  expect(first.text).toMatch(/^## Approved lessons \(follow these\)\n- \*\*Untitled\*\*/);
  expect(first.state.shown).toEqual(['item:**Untitled**: always release the pool client']);
  expect(contextForPrompt(md, first.state).text).toBeNull();
});

test('taskContextArgs on a prompt event with no prompt asks with an empty task and no files', () => {
  expect(taskContextArgs({ cwd: '/r' })).toEqual({ cwd: '/r', task: '' });
});

test('transcript lines that are not tool calls or results (prompts, text blocks, results without an id) are skipped', () => {
  const lines = [
    line({ type: 'user', message: { content: 'please fix the pool' } }),
    line({ type: 'user', message: { content: [{ type: 'text', text: 'and the tests' }] } }),
    use('e1', 'Edit', { file_path: 'src/pool.ts' }),
    use('c1', CHECK),
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'stray' }] } }),
  ];
  // The check never got its own result: it is unanswered and the edit is still pending.
  expect(doneCheckPending(lines, '/r')).toBe(true);
  expect(checkUnanswered(lines, '/r')).toBe(true);
});

test('a check answered with non-text blocks, or with no content, still counts as answered', () => {
  const edit = use('e1', 'Edit', { file_path: 'a.ts' });
  expect(doneCheckPending([edit, use('c1', CHECK), answer('c1', [{ type: 'image', source: {} }])], '/r')).toBe(false);
  expect(doneCheckPending([edit, use('c2', CHECK), answer('c2', undefined)], '/r')).toBe(false);
  // An error result whose content is not text is a failure, not a permission refusal.
  expect(checkUnanswered([edit, use('c3', CHECK), answer('c3', [{ type: 'image' }], true)], '/r')).toBe(true);
});

test('a notebook edit inside the repository counts as a change; a Bash call without a command does not', () => {
  expect(doneCheckPending([use('n1', 'NotebookEdit', { notebook_path: 'nb/a.ipynb' })], '/r')).toBe(true);
  expect(doneCheckPending([use('n2', 'NotebookEdit', { notebook_path: '/elsewhere/a.ipynb' })], '/r')).toBe(false);
  expect(doneCheckPending([use('b1', 'Bash', {})], '/r')).toBe(false);
  expect(editedSince([use('n3', 'NotebookEdit', { notebook_path: 'nb/a.ipynb' })], '/r')).toEqual(['nb/a.ipynb']);
});

test('stopDecision names the first 20 edited files and counts the rest', () => {
  const paths = Array.from({ length: 23 }, (_, i) => `src/f${i}.ts`);
  const d = stopDecision({ session_id: 's1' }, true, 'demo', paths);
  expect(d.reason).toContain('src/f19.ts and 3 more');
  expect(d.reason).not.toContain('src/f20.ts');
});

test('mcpText is null for an answer with no text block', () => {
  expect(mcpText(JSON.stringify({ result: { content: [{ type: 'image', data: 'x' }] } }))).toBeNull();
  expect(mcpText(JSON.stringify({ result: {} }))).toBeNull();
});
