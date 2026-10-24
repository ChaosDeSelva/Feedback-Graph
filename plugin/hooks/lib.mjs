// The hooks' decisions, kept free of I/O so they can be tested. feedback-graph.mjs does the reading and the calls.

const MAX_CONTEXT = 8_000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** A prompt worth looking up context for: a real request, not a one-word reply, a slash command or a shell escape. */
export function asksForContext(prompt) {
  const p = (prompt ?? '').trim();
  return p.length >= 20 && !p.startsWith('/') && !p.startsWith('!');
}

/** The lesson ids get_task_context cites ("lesson <id> · relevance ..."), in order, once each. */
export function lessonIds(markdown) {
  const ids = [...markdown.matchAll(/\blesson (\S+?)[,·]?(?=\s|$)/g)].map((m) => m[1]);
  return [...new Set(ids)];
}

const clip = (text) => (text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT)}\n\n(clipped: call get_task_context for the rest)` : text);

/**
 * What to add to this prompt: the whole context the first time in a session, after that only when it cites a lesson
 * this session has not been shown. `state` is { asked, shown }, kept per session by the caller.
 */
export function contextForPrompt(markdown, state) {
  const ids = lessonIds(markdown);
  const fresh = ids.filter((id) => !state.shown.includes(id));
  const next = { asked: true, shown: [...state.shown, ...fresh] };
  return { text: !state.asked || fresh.length ? clip(markdown) : null, state: next };
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

/** The Stop hook's answer: block once so the agent runs check_before_done; never while continuing from a block. */
export function stopDecision(input, pending, project) {
  if (!pending || input?.stop_hook_active) return null;
  return {
    decision: 'block',
    reason:
      `Feedback Graph: this session changed files in ${project} and has not called check_before_done since. ` +
      'Call check_before_done with cwd, the task, a summary of what you built and how you verified it, and files_changed. ' +
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
