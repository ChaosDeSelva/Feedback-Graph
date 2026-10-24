#!/usr/bin/env node
// Claude Code hooks for the Feedback Graph. One script, one event per call:
//   prompt   UserPromptSubmit: adds the task's lessons, past misses and code map (get_task_context) to the prompt
//   edit     PreToolUse on Edit/Write/MultiEdit/NotebookEdit: adds a file's lessons and misses (get_module_context)
//            the first time this session edits it, when it has any
//   stop     Stop: once, asks the agent to run check_before_done when it changed files and has not checked since
//   session  SessionStart after /clear or a compaction: forgets what this session was shown, so it is shown again
// Every hook is silent outside a project selected in the Feedback Graph, and when the Feedback Graph is unreachable:
// it never blocks or slows real work beyond its timeout.
// FEEDBACK_GRAPH_URL (default http://localhost:8787), FEEDBACK_GRAPH_TOKEN (the API_TOKEN, when one is set),
// FEEDBACK_GRAPH_HOOKS=off to turn them all off.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asksForContext, contextForPrompt, doneCheckPending, mcpText, moduleWorthSaying, stopDecision } from './lib.mjs';

const BASE = (process.env.FEEDBACK_GRAPH_URL || 'http://localhost:8787').replace(/\/+$/, '');
const TOKEN = process.env.FEEDBACK_GRAPH_TOKEN || '';
const headers = { accept: 'application/json, text/event-stream', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };
const STATE_DIR = join(tmpdir(), 'feedback-graph-hooks');

async function get(path, ms) {
  const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(ms) });
  return res.ok ? res.json() : null;
}

async function tool(name, args, ms) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(ms),
  });
  return res.ok ? mcpText(await res.text()) : null;
}

async function tracked(cwd) {
  if (!cwd) return null;
  const r = await get(`/api/agent/project?cwd=${encodeURIComponent(cwd)}`, 2_000);
  return r?.tracked ? r.project : null;
}

const stateFile = (session) => join(STATE_DIR, `${String(session || 'none').replace(/[^\w.-]/g, '_')}.json`);
function loadState(session) {
  try {
    return { asked: false, shown: [], files: [], ...JSON.parse(readFileSync(stateFile(session), 'utf8')) };
  } catch {
    return { asked: false, shown: [], files: [] };
  }
}
function saveState(session, state) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(session), JSON.stringify(state), { mode: 0o600 });
}

const addContext = (event, text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));

const handlers = {
  async prompt(input) {
    if (!asksForContext(input.prompt) || !(await tracked(input.cwd))) return;
    const md = await tool('get_task_context', { cwd: input.cwd, task: input.prompt.slice(0, 1_000) }, 12_000);
    if (!md) return;
    const state = loadState(input.session_id);
    const r = contextForPrompt(md, state);
    saveState(input.session_id, { ...state, ...r.state });
    if (r.text) addContext('UserPromptSubmit', r.text);
  },

  async edit(input) {
    const path = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (!path || !(await tracked(input.cwd))) return;
    const state = loadState(input.session_id);
    if (state.files.includes(path)) return;
    saveState(input.session_id, { ...state, files: [...state.files, path] });
    const md = await tool('get_module_context', { cwd: input.cwd, path }, 6_000);
    if (md && moduleWorthSaying(md)) addContext('PreToolUse', md);
  },

  async stop(input) {
    if (input.stop_hook_active || !input.transcript_path) return;
    const project = await tracked(input.cwd);
    if (!project) return;
    const lines = readFileSync(input.transcript_path, 'utf8').split('\n');
    const d = stopDecision(input, doneCheckPending(lines), project);
    if (d) process.stdout.write(JSON.stringify(d));
  },

  async session(input) {
    rmSync(stateFile(input.session_id), { force: true });
  },
};

async function main() {
  const handler = handlers[process.argv[2]];
  if (!handler || process.env.FEEDBACK_GRAPH_HOOKS === 'off') return;
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  await handler(JSON.parse(raw || '{}'));
}

// Fail open: a hook that cannot reach the Feedback Graph, or hits anything unexpected, says nothing.
main().catch(() => {}).finally(() => process.exit(0));
