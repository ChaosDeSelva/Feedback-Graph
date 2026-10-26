import { ModelOutputError, providerUnavailableReason, redactSecrets, type ChatAnswer, type ChatConversation, type ChatJob, type ChatProvider, type ChatStore, type LlmProvider, type PendingChatTurn } from '@fb/core';
import { CHAT_TIMEOUT_MS } from './answer.ts';

export type ChatRunnerDeps = {
  store: Pick<ChatStore, 'pendingTurns' | 'nextPendingTurn' | 'setQueueAhead' | 'markAnswering' | 'saveAnswer' | 'failTurn' | 'requeueStaleTurns'>;
  /** The conversation's model (chatSpec), built; llm null with the reason when it cannot be built here. */
  provider(conversation: ChatConversation): { llm: LlmProvider | null; spec: string; reason?: string };
  /**
   * The line a chat's questions wait in (laneOf its chatSpec): one question per line is answered at a time, and
   * different lines at once. Unset: one line for every question.
   */
  lane?(provider: ChatProvider | null): string;
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
 * The line a model's questions wait in: one per provider (claude-cli, codex-cli, anthropic, openai...), and every
 * Ollama model in one, since the one Ollama runs one generation at a time.
 */
export function laneOf(spec: string): string {
  return spec.startsWith('ollama:') ? 'ollama' : spec.split(':')[0];
}

/**
 * Answers Ask questions beside the worker cycle (like ScanRunner): every intervalMs it looks at the waiting questions,
 * oldest first, and starts the first of each line (lane) that is free, so questions to different models are answered
 * at once and those to one model one at a time, each within timeoutMs. The others are told how many are ahead of them
 * in their line (ChatTurn.queueAhead). A model that cannot be built or asked fails the turn with the reason (the owner
 * retries it from the UI): no retry storm against a model that is down.
 */
export class ChatRunner {
  private readonly d: ChatRunnerDeps;
  /** The answer being written in each line, with its provider id. */
  private readonly current = new Map<string, { provider: string; done: Promise<unknown> }>();
  /** The positions last written, so only a change is written again. */
  private readonly told = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(d: ChatRunnerDeps) {
    this.d = d;
  }

  /** The provider ids of the answers being written now (for modelBusy: a local chat holds the same Ollama). */
  running(): string[] {
    return [...this.current.values()].map((c) => c.provider);
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

  /** Nothing new starts; resolves once the answers being written (if any) are saved. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.settled();
  }

  /** Resolves once every answer being written now has ended. */
  async settled(): Promise<void> {
    while (this.current.size) await Promise.all([...this.current.values()].map((c) => c.done.catch(() => {})));
  }

  /**
   * Start the oldest waiting question of each free line, and tell the rest how many are ahead of them. True when one
   * was started (its answer goes on in the background; settled() waits for it).
   */
  async tick(): Promise<boolean> {
    if (this.stopped) return false;
    const waiting = await this.d.store.pendingTurns();
    const lane = (t: PendingChatTurn) => this.d.lane?.(t.provider) ?? 'chat';
    let started = false;
    const queued = new Map<string, number>();
    const ahead: { id: string; ahead: number }[] = [];
    for (const t of waiting) {
      const l = lane(t);
      if (!this.current.has(l) && !queued.has(l) && (await this.begin(t.id, l))) {
        started = true;
        continue;
      }
      const n = (this.current.has(l) ? 1 : 0) + (queued.get(l) ?? 0);
      queued.set(l, (queued.get(l) ?? 0) + 1);
      if (this.told.get(t.id) !== n) ahead.push({ id: t.id, ahead: n });
    }
    if (ahead.length) {
      await this.d.store.setQueueAhead(ahead);
      for (const x of ahead) this.told.set(x.id, x.ahead);
    }
    const still = new Set(waiting.map((t) => t.id));
    for (const id of this.told.keys()) if (!still.has(id)) this.told.delete(id);
    return started;
  }

  /** Claim and start one waiting turn in line `lane`; false when it is gone or someone else took it. */
  private async begin(id: string, lane: string): Promise<boolean> {
    const job = await this.d.store.nextPendingTurn({ id });
    if (!job || this.stopped) return false;
    const { llm, spec, reason } = this.d.provider(job.conversation);
    if (!llm) {
      await this.d.store.failTurn(job.turn.id, `model unavailable: ${spec}${reason ? `: ${reason}` : ''}`);
      this.d.log?.('chat: no model', { conversation: job.conversation.id, spec, reason });
      return false;
    }
    if (!(await this.d.store.markAnswering(job.turn.id, llm.id))) return false;
    const done = this.answer(job, llm).finally(() => this.current.delete(lane));
    this.current.set(lane, { provider: llm.id, done });
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
