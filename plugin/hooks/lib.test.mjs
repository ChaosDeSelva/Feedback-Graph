import { expect, test } from 'vitest';
import { asksForContext, contextForPrompt, doneCheckPending, lessonIds, mcpText, moduleWorthSaying, stopDecision } from './lib.mjs';

const line = (o) => JSON.stringify(o);
const use = (name, input = {}) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

test('asksForContext skips short prompts, slash commands and shell escapes', () => {
  expect(asksForContext('Add a GET /invoices endpoint with pagination')).toBe(true);
  expect(asksForContext('yes')).toBe(false);
  expect(asksForContext('/postmortem you missed the tenant check')).toBe(false);
  expect(asksForContext('! git status && git log --oneline')).toBe(false);
  expect(asksForContext(undefined)).toBe(false);
});

test('lessonIds reads the lesson citations out of get_task_context markdown', () => {
  const md = '- **A**: rule\n  - applies when: x · scope: project · lesson lesson:linear:REA-108/6bb0 · relevance 0.83\n- **B** · lesson l2, relevance';
  expect(lessonIds(md)).toEqual(['lesson:linear:REA-108/6bb0', 'l2']);
});

test('contextForPrompt sends the first context in a session, then only when it brings a lesson not yet shown', () => {
  const md = '# Feedback Graph context\n- **A** · lesson l1 · relevance 0.8';
  const first = contextForPrompt(md, { asked: false, shown: [] });
  expect(first.text).toBe(md);
  expect(first.state).toEqual({ asked: true, shown: ['l1'] });
  expect(contextForPrompt(md, first.state).text).toBeNull();
  const more = contextForPrompt(`${md}\n- **B** · lesson l2 · relevance 0.7`, first.state);
  expect(more.text).toContain('lesson l2');
  expect(more.state.shown).toEqual(['l1', 'l2']);
});

test('contextForPrompt clips a long answer', () => {
  const r = contextForPrompt('x'.repeat(20_000), { asked: false, shown: [] });
  expect(r.text.length).toBeLessThan(9_000);
  expect(r.text).toMatch(/clipped/);
});

test('moduleWorthSaying only when the file has lessons or past misses', () => {
  expect(moduleWorthSaying('# Module context\n## Imported by (1)\n- a.ts')).toBe(false);
  expect(moduleWorthSaying('# Module context\n## Lessons for this file (1)\n- x')).toBe(true);
  expect(moduleWorthSaying('# Module context\n## Past misses here (2)\n- x')).toBe(true);
});

test('doneCheckPending: files changed (or a commit) after the last check_before_done', () => {
  const check = use('mcp__plugin_feedback-graph_feedback-graph__check_before_done');
  expect(doneCheckPending([use('Read', { file_path: 'a' })])).toBe(false);
  expect(doneCheckPending([use('Edit', { file_path: 'a' })])).toBe(true);
  expect(doneCheckPending([use('Edit'), check])).toBe(false);
  expect(doneCheckPending([use('Write'), check, use('MultiEdit')])).toBe(true);
  expect(doneCheckPending([use('Bash', { command: 'git commit -m x' })])).toBe(true);
  expect(doneCheckPending([use('Bash', { command: 'git status' })])).toBe(false);
  // A check by the user-scope server counts too, and junk lines are skipped.
  expect(doneCheckPending([use('Edit'), 'not json', use('mcp__feedback-graph__check_before_done')])).toBe(false);
});

test('stopDecision blocks once, never while already continuing from a block', () => {
  expect(stopDecision({ stop_hook_active: false }, true, 'demo')).toMatchObject({ decision: 'block' });
  expect(stopDecision({ stop_hook_active: false }, true, 'demo').reason).toMatch(/check_before_done/);
  expect(stopDecision({ stop_hook_active: true }, true, 'demo')).toBeNull();
  expect(stopDecision({ stop_hook_active: false }, false, 'demo')).toBeNull();
});

test('mcpText reads a JSON or an event-stream answer, and is null on an error', () => {
  const ok = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'hi' }] } };
  expect(mcpText(JSON.stringify(ok))).toBe('hi');
  expect(mcpText(`event: message\ndata: ${JSON.stringify(ok)}\n\n`)).toBe('hi');
  expect(mcpText(JSON.stringify({ ...ok, result: { ...ok.result, isError: true } }))).toBeNull();
  expect(mcpText('<html>')).toBeNull();
});
