/**
 * Ask: conversations about one project (and its confirmed linked projects) answered from everything the tool knows.
 * The api builds a context pack when a question is sent and stores it with a pending assistant turn; the worker's chat
 * runner answers it with the conversation's provider (prompt-only) and stores the answer. Chats live in the store like
 * everything else, are deleted with their project, and are never exported or synced.
 */
import { redactSecrets } from './redact.ts';

/** What the UI offers; a conversation with null uses CHAT_LLM's default. */
export const CHAT_PROVIDERS = ['claude', 'codex', 'local'] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];
export const CHAT_TURN_STATUSES = ['pending', 'answering', 'done', 'failed'] as const;
export type ChatTurnStatus = (typeof CHAT_TURN_STATUSES)[number];
export const CHAT_SOURCE_KINDS = ['lesson', 'miss', 'fact', 'doc', 'code', 'session', 'linked'] as const;
/** One numbered source of a pack: id "S1", "S2"...; ref a path:lines, a lesson id, a doc name... */
export type ChatSource = { id: string; kind: (typeof CHAT_SOURCE_KINDS)[number]; ref: string; title: string };
export type ChatExample = { path: string; lines: string | null; why: string; usages: string[] };
/** answer: markdown citing [S1]; prompt: a self-contained brief for Claude Code or Codex, ending with the MCP footer. */
export type ChatAnswer = { answer: string; examples: ChatExample[]; prompt: string };

/**
 * A user message is one turn (role 'user'); its answer is a separate turn (role 'assistant'): pending, answering,
 * then done or failed. The assistant turn's sources are filled when the pack is built, its answer when it is done.
 */
export type ChatTurn = {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  status: ChatTurnStatus;
  error: string | null;
  answer: ChatAnswer | null;
  sources: ChatSource[];
  /** The provider id that answered, e.g. "claude-cli". */
  provider: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * On an assistant turn: how big the pack it is answered from is (the context as stored, which is what the model
   * gets, and its numbered sources). Null on a user turn, or when the question's pack is not stored.
   */
  pack?: ChatPackSize | null;
};

/** chars: characters of the stored pack (at most MAX_CHAT_CONTEXT); sources: how many numbered sources it cites. */
export type ChatPackSize = { chars: number; sources: number };

/** Each assistant turn's pack size, from the context stored on the user turn before it (seq - 1). Both stores use it. */
export function withPackSizes(turns: { turn: ChatTurn; contextChars: number | null }[]): ChatTurn[] {
  const chars = new Map(turns.map((t) => [t.turn.seq, t.contextChars]));
  return turns.map(({ turn }) => {
    const c = turn.role === 'assistant' ? chars.get(turn.seq - 1) : null;
    return { ...turn, pack: c == null ? null : { chars: c, sources: turn.sources.length } };
  });
}

/** pending: a turn of it is pending or answering. */
export type ChatConversation = { id: string; projectKey: string; title: string; provider: ChatProvider | null; createdAt: string; updatedAt: string; pending: boolean };
export type ChatThread = ChatConversation & { turns: ChatTurn[] };

/** What the api stores with a question: the pack (markdown, numbered sources) the answer is built from. */
export type ChatPack = { context: string; sources: ChatSource[] };

/** A pending assistant turn as the worker picks it up: its conversation, the question and the stored pack. */
export type ChatJob = { conversation: ChatThread; turn: ChatTurn; question: ChatTurn; context: string };

/** A question was sent while another one of the same conversation still waits for its answer. */
export class ChatBusyError extends Error {
  constructor() {
    super('a question in this conversation is still being answered');
    this.name = 'ChatBusyError';
  }
}

/** The error on a pending answer whose conversation or question is gone (a cut-short delete). */
export const ORPHANED_TURN = 'its conversation or question is gone';
export const MAX_CHAT_TEXT = 4000;
export const MAX_CHAT_TITLE = 120;
/** The pack as stored on the user turn, for debugging and retries. */
export const MAX_CHAT_CONTEXT = 60_000;
export const MAX_CHAT_ERROR = 1000;
const MAX_ANSWER = 40_000;
const MAX_PROMPT = 40_000;
const MAX_EXAMPLES = 20;
const MAX_USAGES = 12;
const MAX_SOURCES = 80;

/** A title from the first question: one line, at most 60 characters. */
export function chatTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 60 ? flat || 'New chat' : `${flat.slice(0, 59).trimEnd()}…`;
}

/** What the stores keep, redacted and capped (both backends call these). */
export const cleanChatTitle = (t: string) => redactSecrets(t.replace(/\s+/g, ' ').trim()).slice(0, MAX_CHAT_TITLE) || 'New chat';
export const cleanChatText = (t: string) => redactSecrets(t).slice(0, MAX_CHAT_TEXT);
export const cleanChatContext = (t: string) => redactSecrets(t).slice(0, MAX_CHAT_CONTEXT);
export const cleanChatError = (t: string) => redactSecrets(t).slice(0, MAX_CHAT_ERROR);
export const cleanChatSources = (s: ChatSource[]): ChatSource[] =>
  s.slice(0, MAX_SOURCES).map((x) => ({ id: x.id, kind: x.kind, ref: redactSecrets(x.ref).slice(0, 500), title: redactSecrets(x.title).slice(0, 300) }));
export function cleanChatAnswer(a: ChatAnswer): ChatAnswer {
  return {
    answer: redactSecrets(a.answer).slice(0, MAX_ANSWER),
    prompt: redactSecrets(a.prompt).slice(0, MAX_PROMPT),
    examples: a.examples.slice(0, MAX_EXAMPLES).map((e) => ({
      path: redactSecrets(e.path).slice(0, 500),
      lines: e.lines === null ? null : redactSecrets(e.lines).slice(0, 40),
      why: redactSecrets(e.why).slice(0, 1000),
      usages: e.usages.slice(0, MAX_USAGES).map((u) => redactSecrets(u).slice(0, 500)),
    })),
  };
}
