import { lstat, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { HumanTurn, ParsedSession, ToolCall } from '@fb/core';
import { redactSecrets } from '@fb/core';
import type { FileInfo } from '../cycle.ts';

/**
 * OpenAI Codex CLI / Codex Desktop session transcripts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl),
 * parsed into the same ParsedSession shape as the Claude Code parser.
 *
 * Formats handled:
 * - wrapped (CLI 0.2x onward, verified on 0.155-0.162): one `{timestamp, type, payload, ordinal?}` per
 *   line, type session_meta | turn_context | response_item | event_msg | compacted | ...
 * - bare (earliest CLI): a meta line `{id, timestamp, git?}`, then bare response items and
 *   `{record_type: "state"}` markers, no per-line timestamps.
 *
 * Human turns come only from response_item user messages, with injected context parts removed.
 * event_msg copies of the same messages (user_message, item_completed UserMessage) are ignored.
 * Tool work comes from direct calls (shell, exec_command, local_shell_call, apply_patch, ...) and
 * from item_completed CommandExecution / FileChange / McpToolCall records, de-duplicated by call id.
 * Anything else, including unknown record types, is skipped rather than guessed at.
 */

const MAX_ASSISTANT_CHARS = 2000;

/** Thread sources a human typed into. Guardian reviewers and spawned sub-agents are prompted by an agent. */
const HUMAN_THREAD_SOURCES = new Set(['user', 'voice_chat']);

/** User-role parts that start with these are context Codex injected, not something a human typed. */
const INJECTED_PREFIXES = [
  '# AGENTS.md instructions',
  '# Files mentioned by the user',
  '# Files pasted by the user',
  '# Context from my IDE setup',
  '<environment_context',
  '<user_instructions',
  '<user_shell_command',
  '<INSTRUCTIONS',
  '<turn_aborted',
  '<heartbeat',
  '<image',
  '</image',
  '<in-app-browser-context',
  '<send_user_message_question_reply',
  '<no retained transcript delta entries',
  '<guardian_',
  '<node_repl_review_evidence',
  '<external_codex_apps_open_page',
  '<recommended_plugins',
  '<permissions instructions',
  '<skills_instructions',
  '<collaboration_mode',
];
/** A part that is entirely one tagged block, e.g. `<foo_context>...</foo_context>`. */
const WHOLE_TAGGED_BLOCK = /^<([A-Za-z][\w-]*)[^>]*>[\s\S]*<\/\1>$/;
/** Context blocks put the human's words after this heading (older builds: "for Codex"). */
const REQUEST_HEADING = /^## My request(?: for Codex)?:[ \t]*$/gm;
const QUESTION_REPLY = /^<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>$/;

/** Code-mode wrappers: their real effects arrive as item_completed records with their own ids. */
const WRAPPER_TOOLS = new Set(['exec', 'js']);
const SHELL_FUNCTIONS = new Set(['shell', 'shell_command', 'exec_command', 'container.exec']);
const ROLLOUT_FILE = /^rollout-.*\.jsonl$/;
/** root / YYYY / MM / DD */
const MAX_DEPTH = 3;

type Obj = Record<string, unknown>;

export type CodexSessionParser = {
  /** Feed one line of the rollout file (without its newline). */
  push(line: string): void;
  /** The sessions parsed so far: one per cwd segment, none for a sub-agent session. */
  finish(): ParsedSession[];
};

export function parseCodexSession(text: string, file: string): ParsedSession[] {
  const p = codexSessionParser(file);
  for (const line of text.split('\n')) p.push(line);
  return p.finish();
}

/** Line-at-a-time parser, for rollout files too large to hold as one string. */
export function codexSessionParser(file: string): CodexSessionParser {
  let id: string | null = null;
  let human = false;
  let lastTs = '';
  let lineNo = 0;
  let lastAssistantText = '';
  /** Turns so far in the whole rollout: a segment's first turn after a cwd switch follows agent work, so not index 0. */
  let turnCount = 0;
  let pending: ToolCall[] = [];
  const seenCallIds = new Set<string>();
  const segments: ParsedSession[] = [];
  const current = () => segments[segments.length - 1];

  function emit(call: ToolCall) {
    pending.push(call);
    current().toolCalls.push(call);
  }

  function touch(ts: string) {
    const s = current();
    if (ts < s.startedAt) s.startedAt = ts;
    if (ts > s.endedAt) s.endedAt = ts;
  }

  /** A cwd switch after a human turn starts a new segment, so its turns map to the right project. */
  function setCwd(cwd: string, ts: string) {
    const s = current();
    if (!cwd || cwd === s.cwd) return;
    if (!s.turns.length) {
      s.cwd = cwd;
      return;
    }
    segments.push(newSession(`${id}#${segments.length + 1}`, file, cwd, s.gitBranch, ts));
  }

  function startSession(meta: Obj, ts: string) {
    const sid = str(meta.id);
    if (!sid) return;
    id = sid;
    human = isHumanSession(meta);
    const git = obj(meta.git);
    lastTs = ts || str(meta.timestamp) || '';
    segments.push(newSession(sid, file, str(meta.cwd) ?? '', (git && str(git.branch)) || null, lastTs));
  }

  function readUser(payload: Obj, ts: string, ordinal: unknown) {
    const parts = arr(payload.content);
    const s = current();
    if (!s.cwd) {
      const cwd = cwdFromEnvironment(parts);
      if (cwd) s.cwd = cwd;
    }
    const human = humanTextOf(parts);
    if (human === null) return;
    s.turns.push({
      uuid: `${id}:${typeof ordinal === 'number' ? ordinal : `L${lineNo}`}`,
      sessionId: s.sessionId,
      ts,
      index: turnCount++,
      text: human.text,
      // An answer replies to the agent's question, which was never an assistant message.
      precedingAssistantText: human.questions.length ? human.questions.join('\n').slice(-MAX_ASSISTANT_CHARS) : lastAssistantText,
      precedingToolCalls: pending,
    } satisfies HumanTurn);
    s.finalReply = null;
    lastAssistantText = '';
    pending = [];
  }

  function readAssistant(payload: Obj, ts: string) {
    for (const part of arr(payload.content)) {
      const p = obj(part);
      const text = p && p.type === 'output_text' ? str(p.text)?.trim() : undefined;
      if (!text) continue;
      lastAssistantText = redactSecrets(text).slice(-MAX_ASSISTANT_CHARS);
      // After the segment's last human turn, this is its final reply (until another human turn takes it in).
      const s = current();
      if (s.turns.length) s.finalReply = { text: lastAssistantText, ts };
    }
  }

  function readCall(payload: Obj, ts: string) {
    const name = str(payload.name);
    const callId = str(payload.call_id);
    if (payload.type === 'local_shell_call') {
      if (callId) seenCallIds.add(callId);
      const action = obj(payload.action);
      return emit(bashCall(ts, action ? action.command : undefined));
    }
    if (!name || WRAPPER_TOOLS.has(name)) return;
    if (callId) seenCallIds.add(callId);
    const base = current().cwd;
    if (payload.type === 'custom_tool_call') {
      if (name === 'apply_patch' && typeof payload.input === 'string') return patchCalls(payload.input, ts, base).forEach(emit);
      return emit({ name, ts });
    }
    const args = parseArgs(payload.arguments);
    if (SHELL_FUNCTIONS.has(name)) return emit(bashCall(ts, args ? (args.cmd ?? args.command) : undefined));
    if (name === 'apply_patch') {
      const patch = args ? str(args.input) ?? str(args.patch) : undefined;
      return patch ? patchCalls(patch, ts, base).forEach(emit) : emit({ name: 'Edit', ts });
    }
    emit({ name, ts });
  }

  function readItem(item: Obj, ts: string) {
    const itemId = str(item.id);
    if (itemId && seenCallIds.has(itemId)) return;
    const base = str(item.cwd) || current().cwd;
    if (item.type === 'CommandExecution') {
      emit(bashCall(ts, item.command));
      for (const p of arr(item.parsed_cmd)) {
        const parsed = obj(p);
        const path = parsed && parsed.type === 'read' ? str(parsed.path) : undefined;
        if (path) emit({ name: 'Read', ts, filePath: resolvePath(base, path) });
      }
    } else if (item.type === 'FileChange') {
      for (const [path, change] of Object.entries(obj(item.changes) ?? {})) {
        const call = fileChangeCall(path, obj(change), ts, base);
        if (call) emit(call);
      }
    } else if (item.type === 'McpToolCall') {
      const server = str(item.server);
      const tool = str(item.tool);
      if (server && tool) emit({ name: `mcp__${server}__${tool}`, ts });
    }
  }

  function push(rawLine: string) {
    lineNo++;
    const rec = parseLine(rawLine);
    if (!rec) return;
    const norm = normalise(rec, id === null);
    if (!norm) return;
    const ts = norm.ts ?? lastTs;
    if (norm.type === 'session_meta') {
      if (id === null) startSession(norm.payload, ts);
      return;
    }
    if (id === null || !human) return;
    lastTs = ts;

    if (norm.type === 'turn_context') setCwd(str(norm.payload.cwd) ?? '', ts);
    if (ts) touch(ts);

    const payload = norm.payload;
    if (norm.type === 'response_item') {
      if (payload.type === 'message') {
        if (payload.role === 'user') readUser(payload, ts, norm.ordinal);
        else if (payload.role === 'assistant') readAssistant(payload, ts);
      } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call' || payload.type === 'local_shell_call') {
        readCall(payload, ts);
      }
    } else if (norm.type === 'event_msg' && payload.type === 'item_completed') {
      const item = obj(payload.item);
      if (item) readItem(item, ts);
    }
  }

  return {
    push,
    finish: () => (human ? segments.map((s) => ({ ...s, turns: [...s.turns], toolCalls: [...s.toolCalls], finalReply: s.finalReply ?? null })) : []),
  };
}

/** Rollout files under a Codex sessions root (YYYY/MM/DD) or a flat archive dir. Symlinks are never followed. */
export async function codexSessionFiles(root: string): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  const s = await lstat(root).catch(() => null);
  if (s?.isDirectory()) await walk(root, 0, out);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function walk(dir: string, depth: number, out: FileInfo[]) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(path, depth + 1, out);
    } else if (e.isFile() && ROLLOUT_FILE.test(e.name)) {
      const s = await lstat(path).catch(() => null); // gone, or swapped for a link, since readdir
      if (s?.isFile()) out.push({ path, size: s.size, mtimeMs: s.mtimeMs });
    }
  }
}

type Normalised = { type: string; payload: Obj; ts: string | undefined; ordinal: unknown };

/** Wrapped records pass through; bare-format lines are mapped onto the wrapped shape. */
function normalise(rec: Obj, beforeMeta: boolean): Normalised | null {
  const type = str(rec.type);
  const payload = obj(rec.payload);
  if (type && payload) return { type, payload, ts: str(rec.timestamp), ordinal: rec.ordinal };
  if ('record_type' in rec) return null;
  if (!type && beforeMeta && str(rec.id) && str(rec.timestamp)) return { type: 'session_meta', payload: rec, ts: str(rec.timestamp), ordinal: undefined };
  if (type && !('payload' in rec)) return { type: 'response_item', payload: rec, ts: str(rec.timestamp), ordinal: undefined };
  return null;
}

function newSession(sessionId: string, sourceFile: string, cwd: string, gitBranch: string | null, ts: string): ParsedSession {
  return { sessionId, sourceFile, cwd, gitBranch, startedAt: ts, endedAt: ts, turns: [], toolCalls: [] };
}

/** A session a human typed into, from its session_meta: guardian reviewers and spawned sub-agents are not. */
export function isHumanSession(meta: Obj): boolean {
  const threadSource = str(meta.thread_source);
  if (threadSource) return HUMAN_THREAD_SOURCES.has(threadSource);
  const source = meta.source;
  if (source === 'subagent') return false;
  const src = obj(source);
  return !(src && 'subagent' in src);
}

type HumanText = { text: string; questions: string[] };

/**
 * What a human typed, or null when every part is injected context or not text. Context blocks
 * (files mentioned, in-app browser) carry the human's words after a `## My request:` heading, and
 * an answer to the agent's request_user_input question arrives as a JSON reply block.
 */
function humanTextOf(parts: unknown[]): HumanText | null {
  const kept: string[] = [];
  const questions: string[] = [];
  for (const part of parts) {
    const p = obj(part);
    if (!p || (p.type !== 'input_text' && p.type !== 'text')) continue;
    const text = str(p.text)?.trim();
    if (!text) continue;
    const reply = QUESTION_REPLY.exec(text);
    if (reply) {
      for (const qa of questionReply(reply[1])) {
        if (qa.answer) kept.push(qa.answer);
        if (qa.question) questions.push(qa.question);
      }
      continue;
    }
    const request = afterRequestHeading(text);
    if (request !== undefined) {
      if (request) kept.push(request);
      continue;
    }
    if (!isInjected(text)) kept.push(text);
  }
  const text = kept.join('\n').trim();
  return text ? { text: redactSecrets(text), questions: questions.map(redactSecrets) } : null;
}

function afterRequestHeading(text: string): string | undefined {
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(REQUEST_HEADING)) last = m;
  return last ? text.slice(last.index + last[0].length).trim() : undefined;
}

function questionReply(json: string): { question?: string; answer?: string }[] {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  return arr(v).map((x) => {
    const qa = obj(x);
    return { question: str(qa?.question)?.trim(), answer: str(qa?.answer)?.trim() };
  });
}

function isInjected(text: string): boolean {
  return INJECTED_PREFIXES.some((p) => text.startsWith(p)) || WHOLE_TAGGED_BLOCK.test(text);
}

function cwdFromEnvironment(parts: unknown[]): string | undefined {
  for (const part of parts) {
    const text = str(obj(part)?.text);
    if (!text?.trimStart().startsWith('<environment_context')) continue;
    const m = /<cwd>([^<]+)<\/cwd>/.exec(text);
    if (m) return m[1].trim();
  }
  return undefined;
}

function bashCall(ts: string, command: unknown): ToolCall {
  const text = commandText(command);
  return text ? { name: 'Bash', ts, command: redactSecrets(text) } : { name: 'Bash', ts };
}

/** `["/bin/zsh", "-lc", "pnpm test"]` → `pnpm test`; other argv arrays are joined. */
function commandText(command: unknown): string | undefined {
  if (typeof command === 'string') return command.trim() || undefined;
  if (!Array.isArray(command) || !command.every((c) => typeof c === 'string')) return undefined;
  const argv = command as string[];
  if (argv.length === 3 && /(^|\/)(ba|z|da|k)?sh$/.test(argv[0]) && (argv[1] === '-lc' || argv[1] === '-c')) return argv[2].trim() || undefined;
  return argv.join(' ').trim() || undefined;
}

/** Files named by an apply_patch envelope. A moved file is reported at its destination. */
function patchCalls(patch: string, ts: string, base: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let lastUpdate: ToolCall | null = null;
  for (const line of patch.split('\n')) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line.trimEnd());
    if (m) {
      const call: ToolCall = { name: m[1] === 'Add' ? 'Write' : m[1] === 'Delete' ? 'Delete' : 'Edit', ts, filePath: resolvePath(base, m[2].trim()) };
      calls.push(call);
      lastUpdate = m[1] === 'Update' ? call : null;
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line.trimEnd());
    if (move && lastUpdate) lastUpdate.filePath = resolvePath(base, move[1].trim());
  }
  return calls;
}

function fileChangeCall(path: string, change: Obj | undefined, ts: string, base: string): ToolCall | null {
  if (!change) return null;
  const kind = obj(change.kind);
  const type = str(change.type) ?? (kind && str(kind.type));
  const moved = str(change.move_path) ?? (kind && str(kind.move_path));
  if (type === 'add') return { name: 'Write', ts, filePath: resolvePath(base, path) };
  if (type === 'delete') return { name: 'Delete', ts, filePath: resolvePath(base, path) };
  if (type === 'update') return { name: 'Edit', ts, filePath: resolvePath(base, moved ?? path) };
  return null;
}

function resolvePath(base: string, path: string): string {
  return path.startsWith('/') || !base ? path : posix.join(base, path);
}

function parseArgs(raw: unknown): Obj | undefined {
  if (typeof raw !== 'string') return obj(raw);
  try {
    return obj(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function parseLine(line: string): Obj | null {
  if (!line.trim()) return null;
  try {
    return obj(JSON.parse(line)) ?? null;
  } catch {
    return null;
  }
}

function obj(v: unknown): Obj | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
