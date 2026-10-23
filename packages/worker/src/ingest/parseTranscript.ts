import type { HumanTurn, ParsedSession, ToolCall } from '@fb/core';
import { redactSecrets } from '@fb/core';

const MAX_ASSISTANT_CHARS = 2000;

/** User-typed strings that start with these are harness output, not feedback. */
const NOISE_PREFIXES = [
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<local-command-',
  '<command-name>',
  '<command-message>',
  '<task-notification>',
  '<user-prompt-submit-hook>',
  'Caveat: The messages below',
  '[Request interrupted',
];

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read']);

type Part = { type?: string; text?: string; name?: string; input?: Record<string, unknown> };
type RawRecord = {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: string | Part[] };
};

type SessionState = {
  session: ParsedSession;
  lastAssistantText: string;
  pendingToolCalls: ToolCall[];
};

export function parseTranscript(text: string, sourceFile: string): ParsedSession[] {
  const sessions = new Map<string, SessionState>();

  for (const line of text.split('\n')) {
    const rec = parseLine(line);
    if (!rec?.sessionId || !rec.timestamp) continue;

    const state = sessionFor(sessions, rec, sourceFile);
    const s = state.session;
    if (rec.timestamp < s.startedAt) s.startedAt = rec.timestamp;
    if (rec.timestamp > s.endedAt) s.endedAt = rec.timestamp;
    if (!s.cwd && rec.cwd) s.cwd = rec.cwd;
    if (s.gitBranch === null && rec.gitBranch) s.gitBranch = rec.gitBranch;
    if (rec.isSidechain) continue;

    if (rec.type === 'assistant') {
      readAssistant(rec, state);
    } else if (rec.type === 'user') {
      const humanText = humanTextOf(rec);
      if (humanText === null || !rec.uuid) continue;
      s.turns.push({
        uuid: rec.uuid,
        sessionId: s.sessionId,
        ts: rec.timestamp,
        index: s.turns.length,
        text: humanText,
        precedingAssistantText: state.lastAssistantText,
        precedingToolCalls: state.pendingToolCalls,
      } satisfies HumanTurn);
      state.lastAssistantText = '';
      state.pendingToolCalls = [];
    }
  }

  return [...sessions.values()].map((st) => st.session);
}

function parseLine(line: string): RawRecord | null {
  if (!line.trim()) return null;
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? (v as RawRecord) : null;
  } catch {
    return null;
  }
}

function sessionFor(sessions: Map<string, SessionState>, rec: RawRecord, sourceFile: string): SessionState {
  let st = sessions.get(rec.sessionId!);
  if (!st) {
    st = {
      session: {
        sessionId: rec.sessionId!,
        sourceFile,
        cwd: rec.cwd ?? '',
        gitBranch: rec.gitBranch ?? null,
        startedAt: rec.timestamp!,
        endedAt: rec.timestamp!,
        turns: [],
        toolCalls: [],
      },
      lastAssistantText: '',
      pendingToolCalls: [],
    };
    sessions.set(rec.sessionId!, st);
  }
  return st;
}

function readAssistant(rec: RawRecord, state: SessionState) {
  const content = rec.message?.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part.type === 'text' && part.text?.trim()) {
      state.lastAssistantText = redactSecrets(part.text.trim()).slice(-MAX_ASSISTANT_CHARS);
    } else if (part.type === 'tool_use' && part.name) {
      const call = toolCallOf(part, rec.timestamp!);
      state.pendingToolCalls.push(call);
      state.session.toolCalls.push(call);
    }
  }
}

function toolCallOf(part: Part, ts: string): ToolCall {
  const call: ToolCall = { name: part.name!, ts };
  const input = part.input ?? {};
  if (FILE_TOOLS.has(part.name!)) {
    const p = input.file_path ?? input.notebook_path;
    if (typeof p === 'string') call.filePath = p;
  } else if (part.name === 'Bash' && typeof input.command === 'string') {
    call.command = redactSecrets(input.command);
  }
  return call;
}

/** The text a human actually typed, or null when the record is harness noise. */
function humanTextOf(rec: RawRecord): string | null {
  if (rec.isMeta || rec.isCompactSummary) return null;
  const content = rec.message?.content;
  let raw: string;
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    if (content.some((p) => p.type === 'tool_result')) return null;
    raw = content.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
  } else {
    return null;
  }
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text || NOISE_PREFIXES.some((p) => text.startsWith(p))) return null;
  return redactSecrets(text);
}
