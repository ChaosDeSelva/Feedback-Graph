#!/usr/bin/env node
// Claude Code hooks for the Feedback Graph. One script, one event per call:
//   prompt   UserPromptSubmit: adds the task's approved lessons and the past misses on the files the prompt names
//            (from get_task_context, about 1,500 characters) to a request; skips pure questions
//   edit     PreToolUse on Edit/Write/MultiEdit/NotebookEdit: adds a file's lessons and misses (get_module_context)
//            the first time this session edits it, when it has any
//   stop     Stop: once, asks the agent to run check_before_done, naming the files it edited since its last check
//            and its session id (so the check is recorded as the session's; get_task_context gets it too)
//            (a check counts only when it returned an answer: a denied or failed call checked nothing)
//   session  SessionStart after /clear or a compaction: forgets what this session was shown, so it is shown again
// The first hook that runs in a tracked project records the commit the session started from (HEAD then), so the
// Stop hook can ask for one diff covering staged, unstaged and committed work.
// Every hook is silent outside a project selected in the Feedback Graph, and when the Feedback Graph is unreachable:
// it never blocks or slows real work beyond its timeout.
// FEEDBACK_GRAPH_URL (default http://localhost:8787), FEEDBACK_GRAPH_TOKEN (the API_TOKEN, when one is set),
// FEEDBACK_GRAPH_HOOKS=off to turn them all off.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asksForContext, inRepo, contextForPrompt, mcpText, moduleWorthSaying, sessionBase, stopHook, taskContextArgs } from './lib.mjs';

const BASE = (process.env.FEEDBACK_GRAPH_URL || 'http://localhost:8787').replace(/\/+$/, '');
const TOKEN = process.env.FEEDBACK_GRAPH_TOKEN || '';
const headers = { accept: 'application/json, text/event-stream', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...(process.env.FG_RUN ? { 'x-fg-run': process.env.FG_RUN } : {}), ...(process.env.FG_RUN_KEY ? { 'x-fg-run-key': process.env.FG_RUN_KEY } : {}), ...(/^(1|true)$/i.test(process.env.FG_SANDBOX || '') ? { 'x-fg-sandbox': 'true' } : {}) };
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

/** HEAD in cwd, read-only (no fsmonitor, hooks or index lock); null outside a repo. */
function head(cwd) {
  try {
    return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}
/** The state with the session's start commit, read once per session. */
const withBase = (state, cwd) => (state.base ? state : { ...state, base: sessionBase(state, head(cwd)) });

const addContext = (event, text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));

const handlers = {
  async prompt(input) {
    if (!asksForContext(input.prompt) || !(await tracked(input.cwd))) return;
    const md = await tool('get_task_context', taskContextArgs(input), 12_000);
    if (!md) return;
    const state = withBase(loadState(input.session_id), input.cwd);
    const r = contextForPrompt(md, state);
    saveState(input.session_id, { ...state, ...r.state });
    if (r.text) addContext('UserPromptSubmit', r.text);
  },

  async edit(input) {
    const path = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (!path || !inRepo(path, input.cwd) || !(await tracked(input.cwd))) return;
    const state = withBase(loadState(input.session_id), input.cwd);
    if (state.files.includes(path)) return;
    saveState(input.session_id, { ...state, files: [...state.files, path] });
    const md = await tool('get_module_context', { cwd: input.cwd, path }, 6_000);
    if (md && moduleWorthSaying(md)) addContext('PreToolUse', md);
  },

  async stop(input) {
    if (!input.transcript_path) return;
    const project = await tracked(input.cwd);
    if (!project) return;
    const lines = readFileSync(input.transcript_path, 'utf8').split('\n');
    const state = loadState(input.session_id);
    const { out, state: next } = stopHook(input, lines, project, state);
    if (next.checkDenied !== !!state.checkDenied || next.deniedSaid !== !!state.deniedSaid) saveState(input.session_id, next);
    if (out) process.stdout.write(JSON.stringify(out));
  },

  async session(input) {
    if (process.env.FG_RUN && input.session_id) {
      const res = await fetch(`${BASE}/api/sessions/${encodeURIComponent(input.session_id)}/run`, {
        method: 'POST', headers, signal: AbortSignal.timeout(2_000),
      });
      if (!res.ok) throw new Error(`Run session binding refused (${res.status})`);
    }
    // What was shown is forgotten; where the session started is not (its diff still runs from there), nor that the
    // owner denied check_before_done (stopHook).
    const { base, checkDenied, deniedSaid } = loadState(input.session_id);
    rmSync(stateFile(input.session_id), { force: true });
    if (base || checkDenied) saveState(input.session_id, { asked: false, shown: [], files: [], ...(base && { base }), ...(checkDenied && { checkDenied, deniedSaid }) });
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
