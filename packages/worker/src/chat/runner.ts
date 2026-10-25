import { ModelOutputError, providerUnavailableReason, redactSecrets, type ChatAnswer, type ChatConversation, type ChatJob, type ChatStore, type LlmProvider } from '@fb/core';
import { CHAT_TIMEOUT_MS } from './answer.ts';

export type ChatRunnerDeps = {
  store: Pick<ChatStore, 'nextPendingTurn' | 'markAnswering' | 'saveAnswer' | 'failTurn' | 'requeueStaleTurns'>;
  /** The conversation's model (chatSpec), built; llm null with the reason when it cannot be built here. */
  provider(conversation: ChatConversation): { llm: LlmProvider | null; spec: string; reason?: string };
  /** answerTurn. */
  answer(job: ChatJob, llm: LlmProvider): Promise<ChatAnswer>;
  /** Default CHAT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** How often the queue is looked at; default 2 s. */
  intervalMs?: number;
  log?: (msg: string, extra?: object) => void;
};

const INTERVAL_MS = 2000;
const ERROR_CHARS = 600;

class ChatTimeoutError extends Error {}

/**
 * Whether a chat answering with `chat` holds the model another job uses: the same provider, or two models on the one
 * Ollama (it runs one generation at a time). The cycle then treats that job's timeout as a queue, not a strike.
 */
export function sharesModel(chat: string | null, other: string | null | undefined): boolean {
  if (!chat || !other) return false;
  return chat === other || (chat.startsWith('ollama:') && other.startsWith('ollama:'));
}

/** Why a turn failed, in a sentence the owner can act on (redacted: it is stored and shown). */
function reasonOf(err: unknown, timeoutMs: number): string {
  if (err instanceof ChatTimeoutError) return `no answer within ${Math.round(timeoutMs / 1000)} s: try again, or pick a faster model for this chat`;
  const unavailable = providerUnavailableReason(err);
  if (unavailable) return `model unavailable: ${unavailable}`;
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof ModelOutputError) return redactSecrets(`the model's answer could not be used: ${msg}`).slice(0, ERROR_CHARS);
  return redactSecrets(msg).slice(0, ERROR_CHARS);
}

/**
 * Answers Ask questions beside the worker cycle (like ScanRunner): every intervalMs it takes the oldest pending turn,
 * one at a time, and answers it with its conversation's model within timeoutMs. A model that cannot be built or asked
 * fails the turn with the reason (the owner retries it from the UI): no retry storm against a model that is down.
 */
export class ChatRunner {
  private readonly d: ChatRunnerDeps;
  private current: { provider: string; done: Promise<unknown> } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(d: ChatRunnerDeps) {
    this.d = d;
  }

  /** The provider id of the answer being written now, or null (for modelBusy: a local chat holds the same Ollama). */
  running(): string | null {
    return this.current?.provider ?? null;
  }

  /** Turns left answering by a worker that died go back to pending, then the queue is polled. */
  async start(): Promise<void> {
    const n = await this.d.store.requeueStaleTurns();
    if (n) this.d.log?.('chat: turns left answering went back to the queue', { turns: n });
    const loop = async () => {
      if (this.stopped) return;
      await this.tick().catch((err) => this.d.log?.('chat: could not read the queue', { error: redactSecrets(String(err)) }));
      if (!this.stopped) this.timer = setTimeout(loop, this.d.intervalMs ?? INTERVAL_MS);
    };
    this.timer = setTimeout(loop, 0);
  }

  /** Nothing new starts; resolves once the answer being written (if any) is saved. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.current?.done.catch(() => {});
  }

  /** Answer the oldest pending turn, if any and none is running; true when one was taken. */
  async tick(): Promise<boolean> {
    if (this.current || this.stopped) return false;
    const job = await this.d.store.nextPendingTurn();
    if (!job || this.current) return false;
    const { llm, spec, reason } = this.d.provider(job.conversation);
    if (!llm) {
      await this.d.store.failTurn(job.turn.id, `model unavailable: ${spec}${reason ? `: ${reason}` : ''}`);
      this.d.log?.('chat: no model', { conversation: job.conversation.id, spec, reason });
      return true;
    }
    if (!(await this.d.store.markAnswering(job.turn.id, llm.id))) return true;
    const done = this.answer(job, llm);
    this.current = { provider: llm.id, done };
    try {
      await done;
    } finally {
      this.current = null;
    }
    return true;
  }

  private async answer(job: ChatJob, llm: LlmProvider): Promise<void> {
    const timeoutMs = this.d.timeoutMs ?? CHAT_TIMEOUT_MS;
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const call = this.d.answer(job, llm);
    try {
      const a = await Promise.race([
        call,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ChatTimeoutError()), timeoutMs); }),
      ]);
      await this.d.store.saveAnswer(job.turn.id, a);
      this.d.log?.('chat answered', { conversation: job.conversation.id, provider: llm.id, ms: Date.now() - started });
    } catch (err) {
      const reason = reasonOf(err, timeoutMs);
      await this.d.store.failTurn(job.turn.id, reason).catch((e) => this.d.log?.('chat: could not record a failure', { error: redactSecrets(String(e)) }));
      this.d.log?.('chat failed', { conversation: job.conversation.id, provider: llm.id, reason });
      // The turn is failed, but nothing cancels the call under the timeout (a strict retry may even have started): the
      // model stays busy until it ends, so running() keeps saying so and nothing new starts. At most one timeout more.
      if (err instanceof ChatTimeoutError) {
        let wait: NodeJS.Timeout | undefined;
        await Promise.race([call.catch(() => {}), new Promise((r) => { wait = setTimeout(r, timeoutMs); })]);
        clearTimeout(wait);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
