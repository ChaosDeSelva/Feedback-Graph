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

test('Claude Code: links the three skills and registers the MCP server with the token', () => {
  const s = sandbox(['claude']);
  s.run([], { API_TOKEN: TOKEN });
  expect(readlinkSync(join(s.home, '.claude', 'skills', 'feedback-graph'))).toBe(join(repoRoot, 'plugin', 'skills', 'feedback-graph'));
  expect(readlinkSync(join(s.home, '.claude', 'skills', 'postmortem'))).toBe(join(repoRoot, 'plugin', 'skills', 'postmortem'));
  expect(readlinkSync(join(s.home, '.claude', 'skills', 'test-from-feedback'))).toBe(join(repoRoot, 'plugin', 'skills', 'test-from-feedback'));
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

/** Every file and link under a folder, with its content or target, to compare before and after. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) out[p] = `-> ${readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[p] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

test('--help prints the usage and exits 0; an unknown option is an error', () => {
  const s = sandbox([]);
  const out = s.run(['--help']);
  expect(out).toMatch(/^usage: .*install-agent\.sh \[--dry-run\] \[claude\|codex\]/);
  expect(out).toContain('--dry-run');
  expect(s.run(['-h'])).toBe(out);
  expect(() => s.run(['--bogus'])).toThrow(/unknown option/);
});

test('--dry-run says what it would change and changes nothing: no files, no links, no claude mcp add', () => {
  const s = sandbox(['claude', 'codex']);
  mkdirSync(s.codexDir);
  writeFileSync(s.agentsMd, '# Mine\n');
  const before = snapshot(s.home);
  const out = s.run(['--dry-run'], { API_TOKEN: TOKEN });
  // The stand-in claude logs its calls to a file of its own; everything else is untouched.
  const { [s.calls]: _log, ...after } = snapshot(s.home);
  expect(after).toEqual(before);
  // claude was asked whether the plugin is installed and the server exists (both read-only), never to add it.
  expect(readFileSync(s.calls, 'utf8').trim().split('\n')).toEqual(['plugin list', 'mcp get feedback-graph']);
  expect(out).toContain('would: link ~/.claude/skills/feedback-graph');
  expect(out).toContain('would: claude mcp add --transport http --scope user feedback-graph http://localhost:8787/mcp');
  expect(out).toContain(`would: add [mcp_servers.feedback-graph] with url = "http://localhost:8787/mcp"`);
  expect(out).toContain(`would: copy ${s.agentsMd} to`);
  expect(out).toContain(`would: add the Feedback Graph guidance to ${s.agentsMd}`);
  expect(out).toContain('dry run: nothing was changed');
  expect(out).not.toContain(TOKEN);
  // Then for real, and a dry run after that has nothing left to do.
  s.run([], { API_TOKEN: TOKEN });
  const again = s.run(['--dry-run', 'codex'], { API_TOKEN: TOKEN });
  expect(again).not.toContain('would:');
  expect(again).toMatch(/already/);
});

test('a bare ~/.codex/sessions (setup.sh creates it for the Docker mount) does not count as Codex; a config or login does', () => {
  const s = sandbox([]);
  mkdirSync(join(s.codexDir, 'sessions'), { recursive: true });
  expect(() => s.run()).toThrow(/neither Claude Code nor Codex/i);
  expect(existsSync(s.config)).toBe(false);
  writeFileSync(join(s.codexDir, 'auth.json'), '{}');
  expect(s.run()).toMatch(/Codex: registered/);
  const t = sandbox([]);
  mkdirSync(t.codexDir);
  writeFileSync(t.config, 'model = "o4"\n');
  expect(t.run()).toMatch(/Codex: registered/);
});

test('Claude Code with the feedback-graph plugin installed: nothing is registered or linked, so the tools are not doubled', () => {
  const s = sandbox(['claude']);
  // `claude plugin list` names the plugin.
  writeFileSync(join(s.home, 'bin', 'claude'), `#!/bin/sh\necho "$*" >> '${s.calls}'\n[ "$1" = plugin ] && echo '  ❯ feedback-graph@feedback-graph'\n[ "$2" = get ] && exit 1\nexit 0\n`);
  const out = s.run(['claude']);
  expect(out).toMatch(/plugin/);
  expect(readFileSync(s.calls, 'utf8')).not.toContain('mcp add');
  expect(existsSync(join(s.home, '.claude', 'skills', 'feedback-graph'))).toBe(false);
});
