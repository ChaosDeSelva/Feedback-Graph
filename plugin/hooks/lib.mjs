import { isAbsolute, relative, resolve } from 'node:path';
// The hooks' decisions, kept free of I/O so they can be tested. feedback-graph.mjs does the reading and the calls.

const MAX_CONTEXT = 1_500;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const QUESTION = /^(explain|what|what's|why|how|where|when|who|which|is|are|was|does|do|did|describe|tell me|show me|walk me through|help me understand|(can|could) you (explain|tell|show|describe))\b/i;
const CHANGE = /\b(add|fix|implement|change|refactor|write|update|remove|delete|create|build|make|rename|migrate|move|replace|wire|support|introduce|extract|convert|port|upgrade|bump|edit|modify|patch)\b/i;

/**
 * A prompt worth looking up context for: a real request, not a one-word reply, a slash command, a shell escape, or a
 * question that asks for no change ("explain what pool.ts does").
 */
export function asksForContext(prompt) {
  const p = (prompt ?? '').trim();
  if (p.length < 20 || /^(?:[/!]|<(?:task-notification|local-command|command-name|system-reminder)\b)/i.test(p)) return false;
  return !((QUESTION.test(p) || p.endsWith('?')) && !CHANGE.test(p));
}

/** File paths a prompt names (src/db/pool.ts, README.md), at most 10, for the file-scoped part of the context. */
export function promptFiles(prompt) {
  const out = [];
  for (const [, p] of (prompt ?? '').matchAll(/(?<![\w/:.@-])((?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,5})(?![\w/])/g)) {
    if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, 10);
}

/**
 * The lesson ids get_task_context cites ("lesson <id> · relevance ...", "lesson <id>" ending a line), in order, once
 * each. A citation is always followed by a separator or the end of its line, so prose ("No lesson is approved") is not.
 */
export function lessonIds(markdown) {
  const ids = [...markdown.matchAll(/\blesson ([^\s,·]+)(?=[ \t]*(?:[,·]|$))/gm)].map((m) => m[1]);
  return [...new Set(ids)];
}

const CLIPPED = '(clipped: call get_task_context for the rest)';
const KEEP = /^## (Approved lessons|Past misses on the files you named)\b/;
const POINTER = 'Similar past misses, code facts and docs: call get_task_context (with the files you will touch). Before you say done: check_before_done.';

/**
 * The kept part of get_task_context as blocks: an item ("- " and its indented lines) with its key (the lesson id, or
 * "miss:" and the miss's first line), or a heading or note (key null). Null when nothing worth injecting is there.
 */
function compactBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let section = null;
  for (const l of lines) {
    if (l.startsWith('## ')) {
      section = KEEP.test(l) ? l : null;
      if (section) blocks.push({ key: null, lines: [l] });
      continue;
    }
    if (section) {
      const last = blocks[blocks.length - 1];
      if (/^\s+\S/.test(l) && last?.item) last.lines.push(l);
      else if (l.startsWith('- ')) blocks.push({ key: null, item: true, section, lines: [l] });
      else blocks.push({ key: null, lines: [l] });
    } else if (/^No lesson is (approved|proposed or approved) for |^Only approved lessons are rules/.test(l)) {
      // The notice, and the answer's one note that misses are data, not instructions (said once, at the top).
      blocks.push({ key: null, notice: /^No lesson is/.test(l), lines: [l, ''] });
    }
  }
  for (const b of blocks.filter((x) => x.item)) {
    b.key = b.section.startsWith('## Approved lessons') ? (lessonIds(b.lines.join('\n'))[0] ?? `item:${b.lines[0].slice(2, 82)}`) : `miss:${b.lines[0].slice(2, 82)}`;
  }
  // The note alone is nothing worth injecting.
  if (!blocks.some((b) => b.item || b.notice)) return null;
  const head = lines[0]?.startsWith('# ') ? [lines[0], ''] : [];
  return { head, blocks };
}

/**
 * The blocks `want` keeps (headings and notes always), within about MAX_CONTEXT characters, cut between items, never
 * through one; and the keys of the items shown in full. A heading left with none of its items is dropped.
 */
function render({ head, blocks }, want = () => true) {
  const out = [];
  const shown = [];
  let size = head.join('\n').length;
  let clipped = false;
  for (const b of blocks) {
    if (b.item && !want(b.key)) continue;
    const text = b.lines.join('\n');
    if (b.item && (clipped || size + text.length + 1 > MAX_CONTEXT)) {
      clipped = true;
      continue;
    }
    out.push(b);
    size += text.length + 1;
    if (b.item) shown.push(b.key);
  }
  // A heading whose items were all clipped or shown before goes with them.
  const kept = out.filter((b, i) => !b.lines[0].startsWith('## ') || out.slice(i + 1).find((x) => x.item || x.lines[0].startsWith('## '))?.item);
  if (!shown.length && !kept.some((b) => b.notice)) return { text: null, shown };
  const body = [...head, ...kept.flatMap((b) => b.lines)].join('\n').trim();
  return { text: `${body}${clipped ? `\n${CLIPPED}` : ''}\n\n${POINTER}`, shown };
}

/**
 * The part of get_task_context worth putting in front of every request: the approved lessons, the past misses on the
 * files the prompt names, and the notice that no lesson is approved yet, about 1,500 characters at most, cut between
 * items. Null when it holds none of those: the rest (similar misses, facts, docs) stays one tool call away.
 */
export function compactContext(markdown) {
  const c = compactBlocks(markdown);
  return c ? render(c).text : null;
}

/**
 * What to add to this prompt: the compact context the first time in a session; after that only the lessons and past
 * misses this session has not been shown in full (one clipped before comes back). `state` is { asked, shown }, kept
 * per session by the caller; shown holds lesson ids and "miss:" keys, recorded only for items shown whole.
 */
export function contextForPrompt(markdown, state) {
  const c = compactBlocks(markdown);
  const seen = new Set(state.shown);
  const fresh = c ? c.blocks.filter((b) => b.item && !seen.has(b.key)) : [];
  if (!c || (state.asked && !fresh.length)) return { text: null, state: { ...state, asked: true } };
  const r = render(c, state.asked ? (key) => !seen.has(key) : () => true);
  return { text: r.text, state: { asked: true, shown: [...state.shown, ...r.shown.filter((k) => !seen.has(k))] } };
}

/** A session id Claude Code gives a hook (a uuid), checked before it is sent or put in front of the agent; else null. */
const sessionIdOf = (input) => (typeof input?.session_id === 'string' && /^[\w.-]{1,128}$/.test(input.session_id) ? input.session_id : null);

/** The prompt hook's get_task_context arguments: the task, the files it names and the session, so what it was served is the session's. */
export function taskContextArgs(input) {
  const files = promptFiles(input.prompt);
  const session = sessionIdOf(input);
  return { cwd: input.cwd, task: (input.prompt ?? '').slice(0, 1_000), ...(files.length ? { files } : {}), ...(session ? { session_id: session } : {}) };
}

/** get_module_context is worth interrupting an edit for only when the file has lessons or past misses. */
export function moduleWorthSaying(markdown) {
  return /^##\s.*\b(lessons?|miss(es)?)\b/im.test(markdown);
}

/**
 * What Claude Code writes as the result of a tool call that permission refused: a deny rule or a headless session's
 * "has been denied", a call never granted, or the owner rejecting it at the prompt.
 */
const PERMISSION_DENIED = /Permission to use \S+ has been denied|requested permissions? to use \S+, but you haven't granted it|doesn't want to proceed with this tool use|tool use was rejected/i;
const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n') : '');

/**
 * The transcript's tool calls in order, each with `answered`: true when a result came back for it that is not an
 * error. A call that was denied (permission, a hook), failed, or never got a result is written with is_error or not
 * at all, and is not answered. `denied`: its error result is a permission refusal (PERMISSION_DENIED), not a failure.
 */
function toolUses(lines) {
  const out = [];
  const answered = new Map();
  const denied = new Set();
  for (const l of lines) {
    let entry;
    try {
      entry = JSON.parse(l);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    if (entry?.type === 'assistant') for (const c of content) if (c?.type === 'tool_use') out.push(c);
    if (entry?.type !== 'user') continue;
    for (const c of content) {
      if (c?.type !== 'tool_result' || !c.tool_use_id) continue;
      answered.set(c.tool_use_id, c.is_error !== true);
      if (c.is_error === true && PERMISSION_DENIED.test(resultText(c.content))) denied.add(c.tool_use_id);
    }
  }
  return out.map((u) => ({ ...u, answered: answered.get(u.id) === true, denied: denied.has(u.id) }));
}

const isCheck = (u) => typeof u.name === 'string' && u.name.endsWith('check_before_done');
export const inRepo = (path, cwd) => typeof path === 'string' && (!cwd || (() => { const r = relative(resolve(cwd), resolve(cwd, path)); return r !== '..' && !r.startsWith('../') && !isAbsolute(r); })());
const changes = (u, cwd) => (EDIT_TOOLS.has(u.name) && (!cwd || inRepo(u.input?.file_path ?? u.input?.notebook_path, cwd))) || (u.name === 'Bash' && /\bgit\s+commit\b/.test(u.input?.command ?? ''));
// Only a check_before_done that returned its answer: a denied or failed call checked nothing.
const checks = (u) => isCheck(u) && u.answered;

/** The transcript's lines: did the session change files (or commit) after its last check_before_done? */
export function doneCheckPending(lines, cwd) {
  let pending = false;
  for (const u of toolUses(lines)) {
    if (changes(u, cwd)) pending = true;
    else if (checks(u)) pending = false;
  }
  return pending;
}

/** Did the session call check_before_done after its last change, and get no answer (denied, failed)? */
export function checkUnanswered(lines, cwd) {
  let unanswered = false;
  for (const u of toolUses(lines)) {
    if (changes(u, cwd)) unanswered = false;
    else if (typeof u.name === 'string' && u.name.endsWith('check_before_done')) unanswered = !u.answered;
  }
  return unanswered;
}

/** The files the session edited after its last check_before_done, once each, in the order first edited. */
export function editedSince(lines, cwd) {
  let paths = [];
  for (const u of toolUses(lines)) {
    if (checks(u)) paths = [];
    else if (EDIT_TOOLS.has(u.name)) {
      const p = u.input?.file_path ?? u.input?.notebook_path;
      if (inRepo(p, cwd) && !paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

const MAX_PATHS = 20;
const COMMIT = /^[0-9a-f]{7,64}$/;

/**
 * The commit this session started from: the one already recorded, else `head` (the output of `git rev-parse HEAD`
 * the first time a hook ran in a project), else null. Only a commit id is ever kept: it goes into a command the
 * agent is asked to run.
 */
export function sessionBase(state, head) {
  if (typeof state?.base === 'string' && COMMIT.test(state.base)) return state.base;
  const h = typeof head === 'string' ? head.trim() : '';
  return COMMIT.test(h) ? h : null;
}

/** How the agent gets the diff for check_before_done: everything since `base` in one command, or HEAD plus its commits. */
function diffAsk(base) {
  const known = typeof base === 'string' && COMMIT.test(base);
  return known
    ? `diff: the output of \`git diff ${base}\` (staged, unstaged and committed since this session started; run \`git add -N\` on new files first)`
    : 'diff: the output of `git diff HEAD` (staged and unstaged; run `git add -N` on new files first) plus the commits you made this session';
}

/**
 * The Stop hook's answer: block once so the agent runs check_before_done; never while continuing from a block.
 * `paths`: the files it edited since the last check (editedSince), named in the reason so files_changed is right.
 * `unanswered`: it did call check_before_done since, but the call was denied or failed (checkUnanswered).
 * `base`: the commit the session started from (sessionBase), so the diff it is asked for covers its commits too.
 */
export function stopDecision(input, pending, project, paths = [], unanswered = false, base = null) {
  if (!pending || input?.stop_hook_active) return null;
  const shown = paths.slice(0, MAX_PATHS);
  const session = sessionIdOf(input);
  const what = shown.length
    ? `this session edited ${shown.join(', ')}${paths.length > shown.length ? ` and ${paths.length - shown.length} more` : ''}`
    : `this session committed changes in ${project}`;
  return {
    decision: 'block',
    reason:
      `Feedback Graph: ${what} and ${unanswered ? 'called check_before_done but it returned no answer (denied or failed), so nothing was checked' : 'has not called check_before_done since'}. ` +
      `Call check_before_done with cwd, the task, a summary of what you built and how you verified it, files_changed${shown.length ? `: ${JSON.stringify(shown)}` : ''}, ` +
      (session ? `session_id: "${session}" (so the check is recorded as this session's), ` : '') +
      `and ${diffAsk(base)}. Pass the whole diff: over about 30 KB the judge reads the files most related to the lessons first, then files_changed in order, and the answer says which files it did not read. ` +
      'Address each gap it lists, or tell the developer plainly why it does not apply, then finish.' +
      (unanswered ? ' If it cannot be allowed, tell the developer plainly that the check did not run.' : ''),
  };
}

/**
 * The Stop hook's whole answer from the transcript and the session's state: stopDecision, unless check_before_done
 * was refused by permission. Then it is not asked for again this session (state.checkDenied, kept even when the
 * transcript is compacted) and the agent is told once to say the check did not run; a later answered check lifts it.
 * A call that failed (an error, not a refusal) is no check and no refusal: the check is asked for as before.
 */
export function stopHook(input, lines, project, state) {
  const last = toolUses(lines).filter(isCheck).at(-1);
  const checkDenied = last ? last.denied || (!!state.checkDenied && !last.answered) : !!state.checkDenied;
  if (!checkDenied) return { out: stopDecision(input, doneCheckPending(lines, input.cwd), project, editedSince(lines, input.cwd), checkUnanswered(lines, input.cwd), state.base ?? null), state: { ...state, checkDenied: false, deniedSaid: false } };
  const next = { ...state, checkDenied: true, deniedSaid: true };
  if (state.deniedSaid || input?.stop_hook_active) return { out: null, state: next };
  return {
    out: {
      decision: 'block',
      reason: `Feedback Graph: check_before_done was denied by permission in this session, so the pre-done check did not run. Do not call it again in this session: tell the developer plainly that the check was denied and did not run, then finish.`,
    },
    state: next,
  };
}

/** The text of a tools/call answer, sent as JSON or as an event stream; null on any error. */
export function mcpText(body) {
  const json = body.trim().startsWith('{') ? body : body.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
  try {
    const r = JSON.parse(json ?? '');
    if (!r.result || r.result.isError) return null;
    return r.result.content?.find((c) => c.type === 'text')?.text ?? null;
  } catch {
    return null;
  }
}
