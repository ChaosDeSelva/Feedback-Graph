import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatProvider } from '@fb/core';

type Env = Record<string, string | undefined>;
export type ChatSpecOpts = {
  /** CHAT_LLM. */
  chatLlm: string | null;
  /** ollama:<OLLAMA_MODEL>. */
  localModel: string;
  env: Env;
  /** A Codex login exists (codexLoggedIn). */
  codexLogin: boolean;
};

/** A non-empty auth.json in CODEX_HOME: docker-compose.yml mounts an empty placeholder when you do not use Codex. */
export function codexLoggedIn(env: Env): boolean {
  if (!env.CODEX_HOME) return false;
  try {
    return statSync(join(env.CODEX_HOME, 'auth.json')).size > 0;
  } catch {
    return false;
  }
}

/** codex-cli may run here: confined in the codex-runner, or unconfined with the owner's ALLOW_UNCONFINED_CODEX=1. */
const codexAllowed = (env: Env) => !!env.CODEX_RUNNER_URL || env.ALLOW_UNCONFINED_CODEX === '1';
const claudeSpec = (env: Env) => (env.CLAUDE_CODE_OAUTH_TOKEN ? 'claude-cli' : env.ANTHROPIC_API_KEY ? 'anthropic' : null);

/**
 * The model of conversations with no provider of their own: CHAT_LLM; else claude-cli when a Claude token is set (an
 * Anthropic API key: Claude through the API); else codex-cli when a Codex login exists and codex may run; else local.
 */
export function defaultChatSpec(o: ChatSpecOpts): string {
  if (o.chatLlm) return o.chatLlm;
  return claudeSpec(o.env) ?? (o.codexLogin && codexAllowed(o.env) ? 'codex-cli' : o.localModel);
}

/**
 * The provider spec for a conversation's choice: claude -> claude-cli, codex -> codex-cli, local -> the local Ollama
 * model, null -> the default. CHAT_LLM's own model is kept when it names that provider (claude-cli:opus for claude).
 */
export function chatSpec(provider: ChatProvider | null, o: ChatSpecOpts): string {
  const llm = o.chatLlm ?? '';
  switch (provider) {
    case null:
      return defaultChatSpec(o);
    case 'claude':
      return /^(claude-cli|anthropic)(:|$)/.test(llm) ? llm : (claudeSpec(o.env) ?? 'claude-cli');
    case 'codex':
      return /^codex-cli(:|$)/.test(llm) ? llm : 'codex-cli';
    case 'local':
      return /^ollama:/.test(llm) ? llm : o.localModel;
  }
}
