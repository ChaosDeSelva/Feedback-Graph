import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { chatSpec, codexLoggedIn, defaultChatSpec } from './provider.ts';

const local = 'ollama:gemma4';
const claudeToken = { CLAUDE_CODE_OAUTH_TOKEN: 'x'.repeat(30) };
const runner = { CODEX_RUNNER_URL: 'http://codex-runner:8790' };

test('the default Ask model: claude-cli with a Claude token, else codex-cli with a Codex login it may run, else the local model', () => {
  expect(defaultChatSpec({ chatLlm: null, localModel: local, env: claudeToken, codexLogin: true })).toBe('claude-cli');
  // An Anthropic API key is Claude too, through the API.
  expect(defaultChatSpec({ chatLlm: null, localModel: local, env: { ANTHROPIC_API_KEY: 'x'.repeat(30) }, codexLogin: false })).toBe('anthropic');
  expect(defaultChatSpec({ chatLlm: null, localModel: local, env: runner, codexLogin: true })).toBe('codex-cli');
  expect(defaultChatSpec({ chatLlm: null, localModel: local, env: { ALLOW_UNCONFINED_CODEX: '1' }, codexLogin: true })).toBe('codex-cli');
  // A login codex may not use (unconfined, not accepted) is no login.
  expect(defaultChatSpec({ chatLlm: null, localModel: local, env: {}, codexLogin: true })).toBe(local);
  expect(defaultChatSpec({ chatLlm: null, localModel: local, env: runner, codexLogin: false })).toBe(local);
  // CHAT_LLM wins.
  expect(defaultChatSpec({ chatLlm: 'openai:gpt-5.1', localModel: local, env: claudeToken, codexLogin: true })).toBe('openai:gpt-5.1');
});

test('a conversation\'s provider maps claude to claude-cli, codex to codex-cli and local to the local model; null is the default', () => {
  const o = { chatLlm: null, localModel: local, env: claudeToken, codexLogin: false };
  expect(chatSpec(null, o)).toBe('claude-cli');
  expect(chatSpec('claude', o)).toBe('claude-cli');
  expect(chatSpec('codex', o)).toBe('codex-cli');
  expect(chatSpec('local', o)).toBe(local);
  // Without a token, Claude through an API key; with neither, claude-cli (which then says what is missing).
  expect(chatSpec('claude', { ...o, env: { ANTHROPIC_API_KEY: 'x'.repeat(30) } })).toBe('anthropic');
  expect(chatSpec('claude', { ...o, env: {} })).toBe('claude-cli');
  // CHAT_LLM's model is kept when it is that provider.
  expect(chatSpec('claude', { ...o, chatLlm: 'claude-cli:opus' })).toBe('claude-cli:opus');
  expect(chatSpec('codex', { ...o, chatLlm: 'codex-cli:gpt-5' })).toBe('codex-cli:gpt-5');
  expect(chatSpec('local', { ...o, chatLlm: 'ollama:qwen3' })).toBe('ollama:qwen3');
  expect(chatSpec('local', { ...o, chatLlm: 'claude-cli' })).toBe(local);
});

test('a Codex login is a non-empty auth.json in CODEX_HOME (the compose placeholder is empty)', () => {
  const home = mkdtempSync(join(tmpdir(), 'fb-codex-'));
  expect(codexLoggedIn({ CODEX_HOME: home })).toBe(false);
  writeFileSync(join(home, 'auth.json'), '');
  expect(codexLoggedIn({ CODEX_HOME: home })).toBe(false);
  writeFileSync(join(home, 'auth.json'), '{"tokens":{}}');
  expect(codexLoggedIn({ CODEX_HOME: home })).toBe(true);
  expect(codexLoggedIn({})).toBe(false);
});
