import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// scripts/install-agent.sh, run against a throwaway HOME with stand-in `claude` / `codex` commands.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(repoRoot, 'scripts', 'install-agent.sh');
const TOKEN = 'a'.repeat(48);

function sandbox(agents: ('claude' | 'codex')[]) {
  const home = mkdtempSync(join(tmpdir(), 'fbinstall-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const calls = join(home, 'claude-calls.txt');
  // `claude mcp get` says "not registered"; every call is logged.
  if (agents.includes('claude')) writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$*" >> '${calls}'\n[ "$2" = get ] && exit 1\nexit 0\n`);
  if (agents.includes('codex')) writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n');
  for (const f of readdirSync(bin)) chmodSync(join(bin, f), 0o755);
  const run = (args: string[] = [], env: Record<string, string> = {}) =>
    execFileSync('bash', [script, ...args], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, FEEDBACK_GRAPH_ENV: join(home, 'no.env'), ...env },
      encoding: 'utf8',
    });
  const codexDir = join(home, '.codex');
  return { home, run, calls, codexDir, config: join(codexDir, 'config.toml'), agentsMd: join(codexDir, 'AGENTS.md') };
}

const backups = (dir: string, base: string) => readdirSync(dir).filter((f) => f.startsWith(`${base}.bak.`));

test('Codex: registers the MCP server over streamable HTTP with the bearer header, and adds the guidance to AGENTS.md', () => {
  const s = sandbox(['codex']);
  const out = s.run([], { API_TOKEN: TOKEN, FEEDBACK_GRAPH_URL: 'https://fg.example.com' });
  const cfg = readFileSync(s.config, 'utf8');
  expect(cfg).toContain('[mcp_servers.feedback-graph]\nurl = "https://fg.example.com/mcp"\n');
  expect(cfg).toContain(`http_headers = { "Authorization" = "Bearer ${TOKEN}" }`);
  expect(statSync(s.config).mode & 0o077).toBe(0); // it holds the token
  const md = readFileSync(s.agentsMd, 'utf8');
  expect(md).toMatch(/<!-- BEGIN feedback-graph[^\n]*-->\n[\s\S]*get_task_context[\s\S]*check_before_done[\s\S]*<!-- END feedback-graph -->/);
  expect(md).not.toContain('~/Vibe');
  expect(out).toMatch(/codex/i);
  expect(out).not.toContain(TOKEN);
});

test('Codex: existing config and AGENTS.md are kept, backed up, appended once; re-running changes nothing', () => {
  const s = sandbox(['codex']);
  mkdirSync(s.codexDir);
  const mine = 'model = "o4"\n\n[mcp_servers.other]\ncommand = "x"';
  writeFileSync(s.config, mine);
  writeFileSync(s.agentsMd, '# My rules\n\nAlways write tests.\n');
  s.run();
  const cfg = readFileSync(s.config, 'utf8');
  expect(cfg.startsWith(`${mine}\n`)).toBe(true);
  expect(cfg).toContain('\n[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\n');
  expect(cfg).not.toContain('http_headers'); // no API_TOKEN
  expect(readFileSync(s.agentsMd, 'utf8').startsWith('# My rules\n\nAlways write tests.\n')).toBe(true);
  expect(backups(s.codexDir, 'config.toml')).toHaveLength(1);
  expect(backups(s.codexDir, 'AGENTS.md')).toHaveLength(1);
  const before = [readFileSync(s.config, 'utf8'), readFileSync(s.agentsMd, 'utf8')];
  const again = s.run();
  expect([readFileSync(s.config, 'utf8'), readFileSync(s.agentsMd, 'utf8')]).toEqual(before);
  expect(backups(s.codexDir, 'config.toml')).toHaveLength(1);
  expect(backups(s.codexDir, 'AGENTS.md')).toHaveLength(1);
  expect(again).toMatch(/already/i);
});

test('Codex: an out-of-date guidance block is replaced in place, leaving the rest of AGENTS.md alone', () => {
  const s = sandbox(['codex']);
  mkdirSync(s.codexDir);
  writeFileSync(s.agentsMd, '# Mine\n\n<!-- BEGIN feedback-graph (old) -->\nold guidance\n<!-- END feedback-graph -->\n\n# More of mine\n');
  s.run();
  const md = readFileSync(s.agentsMd, 'utf8');
  expect(md.startsWith('# Mine\n\n<!-- BEGIN feedback-graph')).toBe(true);
  expect(md.endsWith('<!-- END feedback-graph -->\n\n# More of mine\n')).toBe(true);
  expect(md).not.toContain('old guidance');
  expect(md.match(/BEGIN feedback-graph/g)).toHaveLength(1);
});

test('a URL or token that would break the TOML is refused before anything is written', () => {
  const s = sandbox(['codex']);
  expect(() => s.run(['codex'], { FEEDBACK_GRAPH_URL: 'http://x y' })).toThrow();
  expect(() => s.run(['codex'], { API_TOKEN: `${'a'.repeat(30)}"b` })).toThrow();
  expect(existsSync(s.config)).toBe(false);
});

test('CODEX_HOME is respected', () => {
  const s = sandbox(['codex']);
  const elsewhere = join(s.home, 'codex-home');
  s.run([], { CODEX_HOME: elsewhere });
  expect(existsSync(join(elsewhere, 'config.toml'))).toBe(true);
  expect(existsSync(s.config)).toBe(false);
});

test('Claude Code: links both skills and registers the MCP server with the token', () => {
  const s = sandbox(['claude']);
  s.run([], { API_TOKEN: TOKEN });
  expect(readlinkSync(join(s.home, '.claude', 'skills', 'feedback-graph'))).toBe(join(repoRoot, 'skill', 'feedback-graph'));
  expect(readlinkSync(join(s.home, '.claude', 'skills', 'postmortem'))).toBe(join(repoRoot, 'skill', 'postmortem'));
  expect(readFileSync(s.calls, 'utf8')).toContain(`mcp add --transport http --scope user feedback-graph http://localhost:8787/mcp --header Authorization: Bearer ${TOKEN}`);
  expect(existsSync(s.codexDir)).toBe(false);
});

test('both agents found: both set up; naming one sets up only that one; none found is an error', () => {
  const both = sandbox(['claude', 'codex']);
  both.run();
  expect(existsSync(both.config)).toBe(true);
  expect(existsSync(both.calls)).toBe(true);
  const onlyCodex = sandbox(['claude', 'codex']);
  onlyCodex.run(['codex']);
  expect(existsSync(onlyCodex.config)).toBe(true);
  expect(existsSync(onlyCodex.calls)).toBe(false);
  expect(() => sandbox([]).run()).toThrow(/neither Claude Code nor Codex/i);
  expect(() => sandbox(['codex']).run(['claude'])).toThrow(/claude.*not found/i);
});

test('without FEEDBACK_GRAPH_URL, the URL follows API_PORT and API_BIND from .env (or the environment)', () => {
  const urlFor = (envFile: string, env: Record<string, string> = {}) => {
    const s = sandbox(['codex']);
    const file = join(s.home, 'test.env');
    writeFileSync(file, envFile);
    s.run(['codex'], { FEEDBACK_GRAPH_ENV: file, ...env });
    return readFileSync(s.config, 'utf8').match(/^url = "(.*)"$/m)?.[1];
  };
  expect(urlFor('API_PORT=18787\n')).toBe('http://localhost:18787/mcp');
  expect(urlFor('API_PORT="18787"\nAPI_BIND=127.0.0.1\n')).toBe('http://localhost:18787/mcp');
  expect(urlFor('API_PORT=18787\nAPI_BIND=0.0.0.0\n')).toBe('http://localhost:18787/mcp');
  expect(urlFor('API_PORT=18787\nAPI_BIND=192.168.1.20\n')).toBe('http://192.168.1.20:18787/mcp');
  expect(urlFor('API_PORT=\n')).toBe('http://localhost:8787/mcp');
  expect(urlFor('API_PORT=18787\n', { API_PORT: '19999' })).toBe('http://localhost:19999/mcp');
  expect(urlFor('API_PORT=18787\n', { FEEDBACK_GRAPH_URL: 'https://fg.example.com' })).toBe('https://fg.example.com/mcp');
  expect(() => urlFor('API_PORT=80;rm\n')).toThrow(/API_PORT/);
});
