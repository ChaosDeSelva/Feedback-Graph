// Claude Code hooks for the Feedback Graph. One event per call:
//   prompt   UserPromptSubmit: adds the task's approved lessons and the past misses on the files the prompt names
//            (from get_task_context, about 1,500 characters) to a request; skips pure questions, and for 2 minutes
//            after a get_task_context that failed slowly (a hanging model), so one such wait is not paid on every prompt
//   edit     PreToolUse on Edit/Write/MultiEdit/NotebookEdit: adds a file's lessons and misses (get_module_context)
//            the first time this session edits it, when it has any (at most 9,000 characters, cut between lines)
//   stop     Stop: once, asks the agent to run check_before_done, naming the files it edited since its last check
//            and its session id (so the check is recorded as the session's; get_task_context gets it too)
//            (a check counts only when it returned an answer: a denied or failed call checked nothing)
//            (a check whose judge failed, or still queued after 3 rounds, is said once a session not to have run, and the stop goes through)
//   session  SessionStart registers a labelled run; after /clear or a compaction it forgets what this session was shown, so it is shown again
// The first hook that runs in a tracked project records the commit the session started from (HEAD then), so the
// Stop hook can ask for one diff covering staged, unstaged and committed work.
// Every hook is silent outside a project selected in the Feedback Graph, and when the Feedback Graph is unreachable:
// it never blocks or slows real work beyond its timeout.
// FEEDBACK_GRAPH_URL (default http://localhost:8787), FEEDBACK_GRAPH_TOKEN (the API_TOKEN, when one is set),
// FEEDBACK_GRAPH_HOOKS=off to turn them all off.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { asksForContext, inRepo, contextForPrompt, mcpText, moduleContext, moduleWorthSaying, sessionBase, stopHook, taskContextArgs } from './lib.mjs';

/** `git rev-parse <what>` in cwd, read-only (no fsmonitor, hooks or index lock); null outside a repo. */
function revParse(cwd, ...what) {
  try {
    return execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-C', cwd, 'rev-parse', ...what], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}
const head = (cwd) => revParse(cwd, 'HEAD');
/**
 * The repository's top level, so an edit outside cwd but inside the repository counts; cwd outside a repo. Spelled
 * from cwd (git answers with links resolved, /private/var for /var), as the paths Claude Code gives are.
 */
function repoRoot(cwd) {
  const top = revParse(cwd, '--show-toplevel')?.trim();
  return top ? resolve(cwd, relative(realpathSync(cwd), top)) : cwd;
}

/** A get_task_context that failed after this long makes the prompt hook skip it for SLOW_BACKOFF_MS. */
const SLOW_FAILURE_MS = 3_000;
const SLOW_BACKOFF_MS = 2 * 60_000;

function hooks(env, stateDir) {
  const base = (env.FEEDBACK_GRAPH_URL || 'http://localhost:8787').replace(/\/+$/, '');
  const token = env.FEEDBACK_GRAPH_TOKEN || '';
  const headers = { accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(env.FG_RUN ? { 'x-fg-run': env.FG_RUN } : {}), ...(env.FG_RUN_KEY ? { 'x-fg-run-key': env.FG_RUN_KEY } : {}), ...(/^(1|true)$/i.test(env.FG_SANDBOX || '') ? { 'x-fg-sandbox': 'true' } : {}) };
  const out = { stdout: '', stderr: '' };

  async function get(path, ms) {
    const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(ms) });
    return res.ok ? res.json() : null;
  }

  async function tool(name, args, ms) {
    const res = await fetch(`${base}/mcp`, {
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

  const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
  const writeJson = (file, value) => { mkdirSync(stateDir, { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); };
  /** When get_task_context last failed slowly at this API (SLOW_FAILURE_MS), until when the prompt hook skips it. */
  const slowFile = join(stateDir, `slow-${createHash('sha256').update(base).digest('hex').slice(0, 16)}.json`);
  const stateFile = (session) => join(stateDir, `${String(session || 'none').replace(/[^\w.-]/g, '_')}.json`);
  function loadState(session) {
    try {
      return { asked: false, shown: [], files: [], ...JSON.parse(readFileSync(stateFile(session), 'utf8')) };
    } catch {
      return { asked: false, shown: [], files: [] };
    }
  }
  function saveState(session, state) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(stateFile(session), JSON.stringify(state), { mode: 0o600 });
  }
  /** The state with the session's start commit, read once per session. */
  const withBase = (state, cwd) => (state.base ? state : { ...state, base: sessionBase(state, head(cwd)) });

  const addContext = (event, text) => { out.stdout += JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }); };

  const handlers = {
    async prompt(input) {
      if (!asksForContext(input.prompt) || !(await tracked(input.cwd))) return;
      // A get_task_context that failed slowly (a hanging model takes about 10 s to fail) is not asked again for a
      // while, by any session, so it does not hold up every prompt.
      if (Date.now() < (readJson(slowFile)?.until ?? 0)) return;
      const began = Date.now();
      const md = await tool('get_task_context', taskContextArgs(input), 12_000).catch(() => null);
      if (!md) {
        if (Date.now() - began >= SLOW_FAILURE_MS) writeJson(slowFile, { until: Date.now() + SLOW_BACKOFF_MS });
        return;
      }
      const state = withBase(loadState(input.session_id), input.cwd);
      const r = contextForPrompt(md, state);
      saveState(input.session_id, { ...state, ...r.state });
      if (r.text) addContext('UserPromptSubmit', r.text);
    },

    async edit(input) {
      const path = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      if (!path || !(inRepo(path, input.cwd) || inRepo(path, input.cwd, repoRoot(input.cwd))) || !(await tracked(input.cwd))) return;
      const state = withBase(loadState(input.session_id), input.cwd);
      if (state.files.includes(path)) return;
      saveState(input.session_id, { ...state, files: [...state.files, path] });
      const md = await tool('get_module_context', { cwd: input.cwd, path }, 6_000);
      if (md && moduleWorthSaying(md)) addContext('PreToolUse', moduleContext(md));
    },

    async stop(input) {
      if (!input.transcript_path) return;
      const project = await tracked(input.cwd);
      if (!project) return;
      const lines = readFileSync(input.transcript_path, 'utf8').split('\n');
      const state = loadState(input.session_id);
      const { out: decision, state: next } = stopHook(input, lines, project, state, repoRoot(input.cwd));
      if (JSON.stringify(next) !== JSON.stringify(state)) saveState(input.session_id, next);
      if (decision) out.stdout += JSON.stringify(decision);
    },

    async session(input) {
      if (env.FG_RUN && input.session_id) {
        let failure = '';
        try {
          const res = await fetch(`${base}/api/sessions/${encodeURIComponent(input.session_id)}/run`, {
            method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2_000),
          });
          if (!res.ok) failure = `HTTP ${res.status}`;
        } catch { failure = 'server unavailable or timed out'; }
        if (failure) {
          // Status only: server responses and exceptions can contain secrets or untrusted text.
          const warning = `Feedback Graph run registration failed (${failure}). This session was not tagged. Check the API connection and run credentials, then start a new labelled session before testing sandbox behavior.`;
          out.stderr += `${warning}\n`;
          addContext('SessionStart', warning);
          return;
        }
      }
      // What was shown is forgotten; where the session started is not (its diff still runs from there), nor that the
      // owner denied check_before_done, that the agent was told the check did not run, or how many Stop rounds a check has
      // been queued for (stopHook): a compaction between rounds must not restart that count.
      const { base: start, checkDenied, deniedSaid, notRunSaid, queuedRounds } = loadState(input.session_id);
      rmSync(stateFile(input.session_id), { force: true });
      if (start || checkDenied || notRunSaid || queuedRounds) saveState(input.session_id, { asked: false, shown: [], files: [], ...(start && { base: start }), ...(checkDenied && { checkDenied, deniedSaid }), ...(notRunSaid && { notRunSaid }), ...(queuedRounds && { queuedRounds }) });
    },
  };
  return { handlers, out };
}

/**
 * Runs one hook event on the hook's stdin and returns what to print. Fail open: a hook that cannot reach the Feedback
 * Graph, or hits anything unexpected (malformed input included), says nothing, so it never breaks the session.
 */
export async function runHook(event, readInput, { env = process.env, stateDir = join(tmpdir(), 'feedback-graph-hooks') } = {}) {
  const { handlers, out } = hooks(env, stateDir);
  if (!Object.hasOwn(handlers, event) || env.FEEDBACK_GRAPH_HOOKS === 'off') return { stdout: '', stderr: '' };
  try {
    await handlers[event](JSON.parse((await readInput()) || '{}'));
    return out;
  } catch {
    return { stdout: '', stderr: '' };
  }
}
