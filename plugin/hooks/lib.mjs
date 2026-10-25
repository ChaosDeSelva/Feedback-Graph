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
  if (p.length < 20 || p.startsWith('/') || p.startsWith('!')) return false;
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

/** The lesson ids get_task_context cites ("lesson <id> · relevance ..."), in order, once each. */
export function lessonIds(markdown) {
  const ids = [...markdown.matchAll(/\blesson (\S+?)[,·]?(?=\s|$)/g)].map((m) => m[1]);
  return [...new Set(ids)];
}

const clip = (text) => (text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT)}\n(clipped: call get_task_context for the rest)` : text);
const KEEP = /^## (Approved lessons|Past misses on the files you named)\b/;
const POINTER = 'Similar past misses, code facts and docs: call get_task_context (with the files you will touch). Before you say done: check_before_done.';

/**
 * The part of get_task_context worth putting in front of every request: the approved lessons, the past misses on the
 * files the prompt names, and the notice that no lesson is approved yet, about 1,500 characters at most. Null when it
 * holds none of those: the rest (similar misses, facts, docs) stays one tool call away.
 */
export function compactContext(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let keep = false;
  for (const l of lines) {
    if (l.startsWith('## ')) keep = KEEP.test(l);
    if (keep) out.push(l);
    else if (/^No lesson is approved for /.test(l)) out.push(l, '');
  }
  if (!out.some((l) => l.trim())) return null;
  const head = lines[0]?.startsWith('# ') ? [lines[0], ''] : [];
  return `${clip([...head, ...out].join('\n').trim())}\n\n${POINTER}`;
}

/**
 * What to add to this prompt: the compact context the first time in a session, after that only when it cites a
 * lesson this session has not been shown. `state` is { asked, shown }, kept per session by the caller.
 */
export function contextForPrompt(markdown, state) {
  const ids = lessonIds(markdown);
  const fresh = ids.filter((id) => !state.shown.includes(id));
  const next = { asked: true, shown: [...state.shown, ...fresh] };
  return { text: !state.asked || fresh.length ? compactContext(markdown) : null, state: next };
}

/** get_module_context is worth interrupting an edit for only when the file has lessons or past misses. */
export function moduleWorthSaying(markdown) {
  return /^##\s.*\b(lessons?|miss(es)?)\b/im.test(markdown);
}

function toolUses(lines) {
  const out = [];
  for (const l of lines) {
    let entry;
    try {
      entry = JSON.parse(l);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (entry?.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const c of content) if (c?.type === 'tool_use') out.push(c);
  }
  return out;
}

const changes = (u) => EDIT_TOOLS.has(u.name) || (u.name === 'Bash' && /\bgit\s+commit\b/.test(u.input?.command ?? ''));
const checks = (u) => typeof u.name === 'string' && u.name.endsWith('check_before_done');

/** The transcript's lines: did the session change files (or commit) after its last check_before_done? */
export function doneCheckPending(lines) {
  let pending = false;
  for (const u of toolUses(lines)) {
    if (changes(u)) pending = true;
    else if (checks(u)) pending = false;
  }
  return pending;
}

/** The files the session edited after its last check_before_done, once each, in the order first edited. */
export function editedSince(lines) {
  let paths = [];
  for (const u of toolUses(lines)) {
    if (checks(u)) paths = [];
    else if (EDIT_TOOLS.has(u.name)) {
      const p = u.input?.file_path ?? u.input?.notebook_path;
      if (typeof p === 'string' && !paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

const MAX_PATHS = 20;

/**
 * The Stop hook's answer: block once so the agent runs check_before_done; never while continuing from a block.
 * `paths`: the files it edited since the last check (editedSince), named in the reason so files_changed is right.
 */
export function stopDecision(input, pending, project, paths = []) {
  if (!pending || input?.stop_hook_active) return null;
  const shown = paths.slice(0, MAX_PATHS);
  const what = shown.length
    ? `this session edited ${shown.join(', ')}${paths.length > shown.length ? ` and ${paths.length - shown.length} more` : ''}`
    : `this session committed changes in ${project}`;
  return {
    decision: 'block',
    reason:
      `Feedback Graph: ${what} and has not called check_before_done since. ` +
      `Call check_before_done with cwd, the task, a summary of what you built and how you verified it, and files_changed${shown.length ? `: ${JSON.stringify(shown)}` : ''}. ` +
      'Address each gap it lists, or tell the developer plainly why it does not apply, then finish.',
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
