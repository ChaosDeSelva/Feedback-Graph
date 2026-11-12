import type { HumanTurn, ParsedSession, ToolCall } from '@fb/core';
import { isGitCommit, redactSecrets } from '@fb/core';
import { addInstructionFiles, claudeInstructionFiles } from './instructions.ts';
import { storableTimestamp } from './timestamps.ts';

const MAX_ASSISTANT_CHARS = 2000;

/** How Claude Code opens the summary it writes when it compacts a conversation: the model's words, never the developer's. */
export const COMPACTION_SUMMARY = 'This session is being continued from a previous conversation';

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
  // A compaction summary Claude Code writes as a user message, also when it carries no isCompactSummary flag.
  COMPACTION_SUMMARY,
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
  /** Shown in the transcript only, never sent as the developer's message (a compaction summary among them). */
  isVisibleInTranscriptOnly?: boolean;
  message?: { content?: string | Part[] };
};

type SessionState = {
  /** The transcript's session id (a segment's own id adds #n). */
  root: string;
  session: ParsedSession;
  /** Turns so far in the whole session: a later segment's first turn follows agent work, so it is not index 0. */
  turnCount: number;
  lastAssistantText: string;
  /** When lastAssistantText was written. */
  lastAssistantTs: string;
  pendingToolCalls: ToolCall[];
  /** The branch the newest record was on, and the one the newest edit or commit was made on. */
  lastBranch: string | null;
  workBranch: string | null;
};

/** Tool calls that change the repository: the branch they ran on is the branch the session's work is on. */
const WORK_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const isWork = (c: ToolCall) => WORK_TOOLS.has(c.name) || (c.name === 'Bash' && !!c.command && isGitCommit(c.command));

export type TranscriptOpts = {
  /**
   * The project a cwd is in (null: none, a root itself or outside them). A session that moves to another project's
   * folder after a human turn goes on as a new segment (`<id>#2`, as a Codex rollout does), so each project gets the
   * turns typed in its folder; one that moves before any is that folder's from the start. Unset: the first cwd.
   */
  projectOf?: (cwd: string) => string | null;
};

export function parseTranscript(text: string, sourceFile: string, o: TranscriptOpts = {}): ParsedSession[] {
  const sessions = new Map<string, SessionState>();
  /** Every segment, in order: sessions holds each session's current one. */
  const segments: SessionState[] = [];

  for (const line of text.split('\n')) {
    const rec = parseLine(line);
    if (!rec?.sessionId || !rec.timestamp) continue;
    // A time no store can hold is the session's latest so far; a session's first record without one is skipped.
    if (!storableTimestamp(rec.timestamp)) {
      const latest = sessions.get(rec.sessionId)?.session.endedAt;
      if (!latest) continue;
      rec.timestamp = latest;
    }

    let state = sessionFor(sessions, segments, rec, sourceFile);
    if (o.projectOf && rec.cwd && rec.cwd !== state.session.cwd) {
      const seg = state.session;
      if (!seg.cwd) seg.cwd = rec.cwd;
      else if (o.projectOf(rec.cwd) !== o.projectOf(seg.cwd)) {
        if (!seg.turns.length) seg.cwd = rec.cwd;
        else {
          state = segmentOf(state, rec, `${rec.sessionId}#${segments.filter((x) => x.root === rec.sessionId).length + 1}`, sourceFile);
          sessions.set(rec.sessionId, state);
          segments.push(state);
        }
      }
    }
    const s = state.session;
    if (rec.timestamp < s.startedAt) s.startedAt = rec.timestamp;
    if (rec.timestamp > s.endedAt) s.endedAt = rec.timestamp;
    if (!s.cwd && rec.cwd) s.cwd = rec.cwd;
    if (s.gitBranch === null && rec.gitBranch) s.gitBranch = rec.gitBranch;
    if (rec.gitBranch) state.lastBranch = rec.gitBranch;
    if (rec.isSidechain) continue;
    addInstructionFiles(s.instructionFiles!, claudeInstructionFiles(rec as Record<string, unknown>));

    if (rec.type === 'assistant') {
      readAssistant(rec, state);
    } else if (rec.type === 'user') {
      const humanText = humanTextOf(rec);
      if (humanText === null || !rec.uuid) continue;
      s.turns.push({
        uuid: rec.uuid,
        sessionId: s.sessionId,
        ts: rec.timestamp,
        index: state.turnCount++,
        text: humanText,
        precedingAssistantText: state.lastAssistantText,
        precedingToolCalls: state.pendingToolCalls,
      } satisfies HumanTurn);
      state.lastAssistantText = '';
      state.pendingToolCalls = [];
    }
  }

  // What the agent said after the last human turn: nothing takes it in as preceding text, so it is kept on the session.
  // The branch is the one the files were changed on (a session that started on one branch and did its work on
  // another is about the second); with no edits or commits, the branch it was last on.
  return segments.map((st) => ({
    ...st.session,
    gitBranch: st.workBranch ?? st.lastBranch ?? st.session.gitBranch,
    finalReply: st.session.turns.length && st.lastAssistantText ? { text: st.lastAssistantText, ts: st.lastAssistantTs } : null,
  }));
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

function sessionFor(sessions: Map<string, SessionState>, segments: SessionState[], rec: RawRecord, sourceFile: string): SessionState {
  let st = sessions.get(rec.sessionId!);
  if (!st) {
    st = newState(rec.sessionId!, rec.sessionId!, sourceFile, rec, null);
    sessions.set(rec.sessionId!, st);
    segments.push(st);
  }
  return st;
}

/** The next segment of `prev`'s session, in `rec`'s folder: what the agent said before it is what the first turn answers. */
function segmentOf(prev: SessionState, rec: RawRecord, id: string, sourceFile: string): SessionState {
  const next = newState(prev.root, id, sourceFile, rec, prev.lastBranch);
  next.session.gitBranch = rec.gitBranch ?? prev.lastBranch;
  next.lastAssistantText = prev.lastAssistantText;
  next.lastAssistantTs = prev.lastAssistantTs;
  next.pendingToolCalls = prev.pendingToolCalls;
  next.turnCount = prev.turnCount;
  prev.lastAssistantText = '';
  prev.pendingToolCalls = [];
  return next;
}

function newState(root: string, id: string, sourceFile: string, rec: RawRecord, lastBranch: string | null): SessionState {
  return {
    root,
    session: {
      sessionId: id,
      sourceFile,
      cwd: rec.cwd ?? '',
      gitBranch: rec.gitBranch ?? null,
      startedAt: rec.timestamp!,
      endedAt: rec.timestamp!,
      turns: [],
      toolCalls: [],
      instructionFiles: [],
    },
    lastAssistantText: '',
    lastAssistantTs: '',
    pendingToolCalls: [],
    lastBranch,
    workBranch: null,
    turnCount: 0,
  };
}

function readAssistant(rec: RawRecord, state: SessionState) {
  const content = rec.message?.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part.type === 'text' && part.text?.trim()) {
      state.lastAssistantText = redactSecrets(part.text.trim()).slice(-MAX_ASSISTANT_CHARS);
      state.lastAssistantTs = rec.timestamp!;
    } else if (part.type === 'tool_use' && part.name) {
      const call = toolCallOf(part, rec.timestamp!);
      state.pendingToolCalls.push(call);
      state.session.toolCalls.push(call);
      if (rec.gitBranch && isWork(call)) state.workBranch = rec.gitBranch;
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
  if (rec.isMeta || rec.isCompactSummary || rec.isVisibleInTranscriptOnly) return null;
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
