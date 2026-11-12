import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, execResult, SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';
import { expect, test, vi } from 'vitest';

vi.setConfig({ testTimeout: SCRIPT_TEST_TIMEOUT_MS });

// scripts/install-agent.sh, run against a throwaway HOME with stand-in `claude` / `codex` commands.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(repoRoot, 'scripts', 'install-agent.sh');
const RUN_HEADERS = 'env_http_headers = { "X-FG-Run" = "FG_RUN", "X-FG-Sandbox" = "FG_SANDBOX", "X-FG-Run-Key" = "FG_RUN_KEY" }';
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
  // A set-up checkout's env file. The environment gives each run its settings; FG_INSTANCE, which the env file decides
  // once there is one, is written there too.
  writeFileSync(join(home, 'install.env'), '');
  const run = (args: string[] = [], env: Record<string, string> = {}) => {
    writeFileSync(join(home, 'install.env'), env.FG_INSTANCE ? `FG_INSTANCE=${env.FG_INSTANCE}\n` : '');
    return exec('bash', [script, ...args], {
      env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, FEEDBACK_GRAPH_ENV: join(home, 'install.env'), ...env },
    });
  };
  const codexDir = join(home, '.codex');
  return { home, run, calls, codexDir, config: join(codexDir, 'config.toml'), agentsMd: join(codexDir, 'AGENTS.md') };
}

const backups = (dir: string, base: string) => readdirSync(dir).filter((f) => f.startsWith(`${base}.bak.`));

test('Codex: registers the MCP server over streamable HTTP with the bearer header, and adds the guidance to AGENTS.md', async () => {
  const s = sandbox(['codex']);
  const out = await s.run([], { API_TOKEN: TOKEN, FEEDBACK_GRAPH_URL: 'https://fg.example.com' });
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

test('Codex: existing config and AGENTS.md are kept, backed up, appended once; re-running changes nothing', async () => {
  const s = sandbox(['codex']);
  mkdirSync(s.codexDir);
  const mine = 'model = "o4"\n\n[mcp_servers.other]\ncommand = "x"';
  writeFileSync(s.config, mine);
  writeFileSync(s.agentsMd, '# My rules\n\nAlways write tests.\n');
  await s.run();
  const cfg = readFileSync(s.config, 'utf8');
  expect(cfg.startsWith(`${mine}\n`)).toBe(true);
  expect(cfg).toContain('\n[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\n');
  expect(cfg).not.toMatch(/^\s*http_headers\s*=/m); // no API_TOKEN
  expect(readFileSync(s.agentsMd, 'utf8').startsWith('# My rules\n\nAlways write tests.\n')).toBe(true);
  expect(backups(s.codexDir, 'config.toml')).toHaveLength(1);
  expect(backups(s.codexDir, 'AGENTS.md')).toHaveLength(1);
  const before = [readFileSync(s.config, 'utf8'), readFileSync(s.agentsMd, 'utf8')];
  const again = await s.run();
  expect([readFileSync(s.config, 'utf8'), readFileSync(s.agentsMd, 'utf8')]).toEqual(before);
  expect(backups(s.codexDir, 'config.toml')).toHaveLength(1);
  expect(backups(s.codexDir, 'AGENTS.md')).toHaveLength(1);
  expect(again).toMatch(/already/i);
});

test('Codex: an out-of-date guidance block is replaced in place, leaving the rest of AGENTS.md alone', async () => {
  const s = sandbox(['codex']);
  mkdirSync(s.codexDir);
  writeFileSync(s.agentsMd, '# Mine\n\n<!-- BEGIN feedback-graph (old) -->\nold guidance\n<!-- END feedback-graph -->\n\n# More of mine\n');
  await s.run();
  const md = readFileSync(s.agentsMd, 'utf8');
  expect(md.startsWith('# Mine\n\n<!-- BEGIN feedback-graph')).toBe(true);
  expect(md.endsWith('<!-- END feedback-graph -->\n\n# More of mine\n')).toBe(true);
  expect(md).not.toContain('old guidance');
  expect(md.match(/BEGIN feedback-graph/g)).toHaveLength(1);
});

test('a URL or token that would break the TOML is refused before anything is written', async () => {
  const s = sandbox(['codex']);
  await expect(s.run(['codex'], { FEEDBACK_GRAPH_URL: 'http://x y' })).rejects.toThrow();
  await expect(s.run(['codex'], { API_TOKEN: `${'a'.repeat(30)}"b` })).rejects.toThrow();
  expect(existsSync(s.config)).toBe(false);
});

test('CODEX_HOME is respected', async () => {
  const s = sandbox(['codex']);
  const elsewhere = join(s.home, 'codex-home');
  await s.run([], { CODEX_HOME: elsewhere });
  expect(existsSync(join(elsewhere, 'config.toml'))).toBe(true);
  expect(existsSync(s.config)).toBe(false);
});

test('Claude Code: links the three skills and registers the MCP server with the token', async () => {
  const s = sandbox(['claude']);
  await s.run([], { API_TOKEN: TOKEN });
  expect(readlinkSync(join(s.home, '.claude', 'skills', 'feedback-graph'))).toBe(join(repoRoot, 'plugin', 'skills', 'feedback-graph'));
  expect(readlinkSync(join(s.home, '.claude', 'skills', 'postmortem'))).toBe(join(repoRoot, 'plugin', 'skills', 'postmortem'));
  expect(readlinkSync(join(s.home, '.claude', 'skills', 'test-from-feedback'))).toBe(join(repoRoot, 'plugin', 'skills', 'test-from-feedback'));
  expect(readFileSync(s.calls, 'utf8')).toContain(`mcp add --transport http --scope user feedback-graph http://localhost:8787/mcp --header Authorization: Bearer ${TOKEN}`);
  expect(existsSync(s.codexDir)).toBe(false);
});

test('Claude Code: an existing registration is recreated when credentials may have changed', async () => {
  const s = sandbox(['claude']);
  writeFileSync(join(s.home, 'bin', 'claude'), `#!/bin/sh\necho "$*" >> '${s.calls}'\n[ "$2" = get ] && exit 0\nexit 0\n`);
  await s.run(['claude'], { API_TOKEN: TOKEN });
  const calls = readFileSync(s.calls, 'utf8');
  expect(calls).toContain('mcp remove feedback-graph --scope user');
  expect(calls).toContain(`mcp add --transport http --scope user feedback-graph http://localhost:8787/mcp --header Authorization: Bearer ${TOKEN}`);
});

test('Claude Code: an installed plugin receives the current URL and token for its MCP server and hooks', async () => {
  const s = sandbox(['claude']);
  writeFileSync(join(s.home, 'bin', 'claude'), `#!/bin/sh\necho "$*" >> '${s.calls}'\n[ "$1 $2" = "plugin list" ] && echo 'feedback-graph@feedback-graph'\nexit 0\n`);
  const settingsDir = join(s.home, '.claude');
  mkdirSync(settingsDir);
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({ theme: 'dark', env: { MINE: 'kept' } }));
  const out = await s.run(['claude'], { API_TOKEN: TOKEN });
  const settings = JSON.parse(readFileSync(join(settingsDir, 'settings.json'), 'utf8'));
  expect(settings).toEqual({ theme: 'dark', env: { MINE: 'kept', FEEDBACK_GRAPH_URL: 'http://localhost:8787', FEEDBACK_GRAPH_TOKEN: TOKEN } });
  expect(statSync(join(settingsDir, 'settings.json')).mode & 0o077).toBe(0);
  expect(readFileSync(s.calls, 'utf8')).not.toContain('mcp add');
  expect(out).toContain('restart Claude Code');
  expect(out).not.toContain(TOKEN);
});

test('Codex: an existing registration receives a newly configured token without changing other servers', async () => {
  const s = sandbox(['codex']);
  mkdirSync(s.codexDir);
  writeFileSync(s.config, '[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\n\n[mcp_servers.other]\nurl = "https://other.example/mcp"\n');
  await s.run(['codex'], { API_TOKEN: TOKEN });
  const cfg = readFileSync(s.config, 'utf8');
  expect(cfg).toMatch(new RegExp(`\\[mcp_servers\\.feedback-graph\\][\\s\\S]*http_headers = \\{ "Authorization" = "Bearer ${TOKEN}" \\}[\\s\\S]*url = "http://localhost:8787/mcp"`));
  expect(cfg).toContain('[mcp_servers.other]\nurl = "https://other.example/mcp"');
  expect(statSync(s.config).mode & 0o077).toBe(0);
});

test('both agents found: both set up; naming one sets up only that one; none found is an error', async () => {
  const both = sandbox(['claude', 'codex']);
  await both.run();
  expect(existsSync(both.config)).toBe(true);
  expect(existsSync(both.calls)).toBe(true);
  const onlyCodex = sandbox(['claude', 'codex']);
  await onlyCodex.run(['codex']);
  expect(existsSync(onlyCodex.config)).toBe(true);
  expect(existsSync(onlyCodex.calls)).toBe(false);
  await expect(sandbox([]).run()).rejects.toThrow(/neither Claude Code nor Codex/i);
  await expect(sandbox(['codex']).run(['claude'])).rejects.toThrow(/claude.*not found/i);
});

test('without FEEDBACK_GRAPH_URL, the URL follows API_PORT and API_BIND from .env (or the environment)', async () => {
  const urlFor = async (envFile: string, env: Record<string, string> = {}) => {
    const s = sandbox(['codex']);
    const file = join(s.home, 'test.env');
    writeFileSync(file, envFile);
    await s.run(['codex'], { FEEDBACK_GRAPH_ENV: file, ...env });
    return readFileSync(s.config, 'utf8').match(/^url = "(.*)"$/m)?.[1];
  };
  expect(await urlFor('API_PORT=18787\n')).toBe('http://localhost:18787/mcp');
  expect(await urlFor('API_PORT="18787"\nAPI_BIND=127.0.0.1\n')).toBe('http://localhost:18787/mcp');
  expect(await urlFor('API_PORT=18787\nAPI_BIND=0.0.0.0\n')).toBe('http://localhost:18787/mcp');
  expect(await urlFor('API_PORT=18787\nAPI_BIND=192.168.1.20\n')).toBe('http://192.168.1.20:18787/mcp');
  expect(await urlFor('API_PORT=\n')).toBe('http://localhost:8787/mcp');
  expect(await urlFor('API_PORT=18787\n', { API_PORT: '19999' })).toBe('http://localhost:19999/mcp');
  expect(await urlFor('API_PORT=18787\n', { FEEDBACK_GRAPH_URL: 'https://fg.example.com' })).toBe('https://fg.example.com/mcp');
  await expect(urlFor('API_PORT=80;rm\n')).rejects.toThrow(/API_PORT/);
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

test('--help prints the usage and exits 0; an unknown option is an error', async () => {
  const s = sandbox([]);
  const out = await s.run(['--help']);
  expect(out).toMatch(/^usage: .*install-agent\.sh \[--dry-run\] \[--codex-auto-approve\] \[claude\|codex\]/);
  expect(out).toContain('default_tools_approval_mode');
  expect(out).toContain('--dry-run');
  expect(await s.run(['-h'])).toBe(out);
  await expect(s.run(['--bogus'])).rejects.toThrow(/unknown option/);
});

test('--dry-run says what it would change and changes nothing: no files, no links, no claude mcp add', async () => {
  const s = sandbox(['claude', 'codex']);
  mkdirSync(s.codexDir);
  writeFileSync(s.agentsMd, '# Mine\n');
  const before = snapshot(s.home);
  const out = await s.run(['--dry-run'], { API_TOKEN: TOKEN });
  // The stand-in claude logs its calls to a file of its own; everything else is untouched.
  const { [s.calls]: _log, ...after } = snapshot(s.home);
  expect(after).toEqual(before);
  // claude itself never ran: any claude command may rewrite ~/.claude.json and back it up.
  expect(existsSync(s.calls)).toBe(false);
  expect(out).toContain('would: link ~/.claude/skills/feedback-graph');
  expect(out).toContain('would: claude mcp add --transport http --scope user feedback-graph http://localhost:8787/mcp');
  expect(out).toContain(`would: add [mcp_servers.feedback-graph] with url = "http://localhost:8787/mcp"`);
  expect(out).toContain(`would: copy ${s.agentsMd} to`);
  expect(out).toContain(`would: add the Feedback Graph guidance to ${s.agentsMd}`);
  expect(out).toContain('dry run: nothing was changed');
  expect(out).not.toContain(TOKEN);
  // Then for real, and a dry run after that has nothing left to do.
  await s.run([], { API_TOKEN: TOKEN });
  const again = await s.run(['--dry-run', 'codex'], { API_TOKEN: TOKEN });
  expect(again).not.toContain('would:');
  expect(again).toMatch(/already/);
});

test('a bare ~/.codex/sessions (setup.sh creates it for the Docker mount) does not count as Codex; a config or login does', async () => {
  const s = sandbox([]);
  mkdirSync(join(s.codexDir, 'sessions'), { recursive: true });
  await expect(s.run()).rejects.toThrow(/neither Claude Code nor Codex/i);
  expect(existsSync(s.config)).toBe(false);
  writeFileSync(join(s.codexDir, 'auth.json'), '{}');
  expect(await s.run()).toMatch(/Codex: registered/);
  const t = sandbox([]);
  mkdirSync(t.codexDir);
  writeFileSync(t.config, 'model = "o4"\n');
  expect(await t.run()).toMatch(/Codex: registered/);
});

test('Claude Code with the feedback-graph plugin installed: refreshes its environment without doubling tools or skills', async () => {
  const s = sandbox(['claude']);
  // `claude plugin list` names the plugin.
  writeFileSync(join(s.home, 'bin', 'claude'), `#!/bin/sh\necho "$*" >> '${s.calls}'\n[ "$1" = plugin ] && echo '  ❯ feedback-graph@feedback-graph'\n[ "$2" = get ] && exit 1\nexit 0\n`);
  const out = await s.run(['claude']);
  expect(out).toMatch(/plugin/);
  expect(readFileSync(s.calls, 'utf8')).not.toContain('mcp add');
  expect(existsSync(join(s.home, '.claude', 'skills', 'feedback-graph'))).toBe(false);
  expect(JSON.parse(readFileSync(join(s.home, '.claude', 'settings.json'), 'utf8')).env.FEEDBACK_GRAPH_URL).toBe('http://localhost:8787');
});

// Codex refuses MCP tool calls under `codex exec` (approval policy "never") unless the server's table says
// default_tools_approval_mode = "approve" (a per-server key; values auto, prompt, writes, approve).
const APPROVE = 'default_tools_approval_mode = "approve"';

test('Codex --codex-auto-approve: the server table lets Codex call the tools without asking', async () => {
  const s = sandbox(['codex']);
  const out = await s.run(['codex', '--codex-auto-approve']);
  expect(readFileSync(s.config, 'utf8')).toContain(`[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\n${APPROVE}\n`);
  expect(out).toContain('without asking');
});

test('Codex --codex-auto-approve on a server already registered adds the key inside its table, once, with a backup', async () => {
  const s = sandbox(['codex']);
  mkdirSync(s.codexDir);
  writeFileSync(s.config, 'model = "o4"\n\n[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\n\n[mcp_servers.other]\ncommand = "x"\n');
  await s.run(['codex', '--codex-auto-approve']);
  const cfg = readFileSync(s.config, 'utf8');
  expect(cfg).toBe(`model = "o4"\n\n[mcp_servers.feedback-graph]\n${APPROVE}\n${RUN_HEADERS}\nurl = "http://localhost:8787/mcp"\n\n[mcp_servers.other]\ncommand = "x"\n`);
  expect(backups(s.codexDir, 'config.toml')).toHaveLength(1);
  expect(await s.run(['codex', '--codex-auto-approve'])).toMatch(/already/);
  expect(readFileSync(s.config, 'utf8')).toBe(cfg);
  expect(backups(s.codexDir, 'config.toml')).toHaveLength(1);
});

test('Codex without the flag: no approval key unasked; without a terminal it says how, in a terminal it asks (default no)', async () => {
  const s = sandbox(['codex']);
  const out = await s.run(['codex']);
  expect(readFileSync(s.config, 'utf8')).not.toContain('default_tools_approval_mode');
  expect(out).toContain('--codex-auto-approve');
  // The one-run form, for a headless `codex exec` without changing config.toml.
  expect(out).toContain(`codex exec -c 'mcp_servers.feedback-graph.default_tools_approval_mode="approve"'`);

  const asked = sandbox(['codex']);
  const ask = (answer: string) =>
    exec('bash', [script, 'codex'], {
      env: { PATH: `${join(asked.home, 'bin')}:/usr/bin:/bin`, HOME: asked.home, FEEDBACK_GRAPH_ENV: join(asked.home, 'install.env'), FEEDBACK_INSTALL_INTERACTIVE: '1' },
      input: answer,
    });
  await ask('\n');
  expect(readFileSync(asked.config, 'utf8')).not.toContain('default_tools_approval_mode');
  await ask('y\n');
  expect(readFileSync(asked.config, 'utf8')).toContain(APPROVE);
});

test('--dry-run with --codex-auto-approve writes nothing', async () => {
  const s = sandbox(['codex']);
  expect(await s.run(['codex', '--dry-run', '--codex-auto-approve'])).toContain(`would: add ${APPROVE}`);
  expect(existsSync(s.config)).toBe(false);
});

// ── A second install on the same machine ───────────────────────────────
// setup.sh gives a second checkout FG_INSTANCE=feedback-graph-<folder> and its own API_PORT. Its agents get a server of
// their own next to the first one's, never the first one's name pointed at another port.

test('a second instance registers under its own name and port in Claude Code and Codex; the default keeps feedback-graph', async () => {
  const s = sandbox(['claude', 'codex']);
  mkdirSync(s.codexDir);
  writeFileSync(s.config, '[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\n');
  const file = join(s.home, 'second.env');
  writeFileSync(file, 'FG_INSTANCE=feedback-graph-repo\nAPI_PORT=8797\n');
  const out = await s.run(['--codex-auto-approve'], { FEEDBACK_GRAPH_ENV: file });
  expect(readFileSync(s.calls, 'utf8')).toContain('mcp add --transport http --scope user feedback-graph-repo http://localhost:8797/mcp');
  expect(readFileSync(s.calls, 'utf8')).toContain('mcp get feedback-graph-repo');
  const cfg = readFileSync(s.config, 'utf8');
  // The first install's table is untouched; the second one's is added beside it.
  expect(cfg.startsWith('[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\n')).toBe(true);
  expect(cfg).toContain(`[mcp_servers.feedback-graph-repo]\nurl = "http://localhost:8797/mcp"\n${APPROVE}\n`);
  expect(out).toContain('feedback-graph-repo');
  // Re-running finds its own table, and does not mistake the first install's for it (or the reverse).
  expect(await s.run(['codex', '--codex-auto-approve'], { FEEDBACK_GRAPH_ENV: file })).toMatch(/feedback-graph-repo already/);
  expect(readFileSync(s.config, 'utf8')).toBe(cfg);
});

test('server names: the default instance is feedback-graph, feedback-graph-<x> is used as it is, any other name is prefixed', async () => {
  const nameFor = async (instance: string) => {
    const s = sandbox(['codex']);
    await s.run(['codex'], { FG_INSTANCE: instance });
    return readFileSync(s.config, 'utf8').match(/^\[mcp_servers\.(.*)\]$/m)?.[1];
  };
  expect(await nameFor('')).toBe('feedback-graph');
  expect(await nameFor('feedback-graph')).toBe('feedback-graph');
  expect(await nameFor('feedback-graph-demo-shop')).toBe('feedback-graph-demo-shop');
  expect(await nameFor('fg-staging')).toBe('feedback-graph-fg-staging');
  await expect(nameFor('Bad Name')).rejects.toThrow(/FG_INSTANCE/);
});

test('a second instance with the plugin installed still registers its own server (the plugin\'s fg reaches one install)', async () => {
  const s = sandbox(['claude']);
  writeFileSync(join(s.home, 'bin', 'claude'), `#!/bin/sh\necho "$*" >> '${s.calls}'\n[ "$1" = plugin ] && echo '  ❯ feedback-graph@feedback-graph'\n[ "$2" = get ] && exit 1\nexit 0\n`);
  const out = await s.run(['claude'], { FG_INSTANCE: 'feedback-graph-repo', API_PORT: '8797' });
  expect(readFileSync(s.calls, 'utf8')).toContain('mcp add --transport http --scope user feedback-graph-repo http://localhost:8797/mcp');
  // The skills come with the plugin already.
  expect(existsSync(join(s.home, '.claude', 'skills', 'feedback-graph'))).toBe(false);
  expect(out).toMatch(/plugin/);
});

test('a second instance leaves the first install\'s skill links and Codex guidance alone, and says so; with none there, it adds them', async () => {
  const s = sandbox(['claude', 'codex']);
  const skills = join(s.home, '.claude', 'skills');
  const first = join(s.home, 'first-install');
  const names = ['feedback-graph', 'postmortem', 'test-from-feedback'];
  mkdirSync(skills, { recursive: true });
  for (const k of names) {
    mkdirSync(join(first, 'plugin', 'skills', k), { recursive: true });
    symlinkSync(join(first, 'plugin', 'skills', k), join(skills, k));
  }
  mkdirSync(s.codexDir);
  // The first install is registered: its unnamed (pre-0.7.6) block stays its own.
  writeFileSync(s.config, '[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\n');
  const guidance = '# Mine\n\n<!-- BEGIN feedback-graph (managed) -->\nthe first install guidance\n<!-- END feedback-graph -->\n';
  writeFileSync(s.agentsMd, guidance);
  const out = await s.run([], { FG_INSTANCE: 'feedback-graph-repo', API_PORT: '8797' });
  for (const k of names) expect(readlinkSync(join(skills, k))).toBe(join(first, 'plugin', 'skills', k));
  expect(readFileSync(s.agentsMd, 'utf8')).toBe(guidance);
  expect(backups(s.codexDir, 'AGENTS.md')).toHaveLength(0);
  expect(out).toMatch(/skill .*another install.*left as it is/i);
  expect(out).toMatch(/guidance .*left as it is/i);
  // Its own server is still registered, beside the first's.
  expect(readFileSync(s.calls, 'utf8')).toContain('mcp add --transport http --scope user feedback-graph-repo http://localhost:8797/mcp');
  expect(readFileSync(s.config, 'utf8')).toContain('[mcp_servers.feedback-graph-repo]');
  // Nothing there yet: the second install links and writes them.
  const bare = sandbox(['claude', 'codex']);
  await bare.run([], { FG_INSTANCE: 'feedback-graph-repo' });
  expect(existsSync(join(bare.home, '.claude', 'skills', 'postmortem'))).toBe(true);
  expect(readFileSync(bare.agentsMd, 'utf8')).toContain('BEGIN feedback-graph');
  // The default install takes its links and its block back, as before.
  await s.run([]);
  expect(readlinkSync(join(skills, 'postmortem'))).toBe(join(repoRoot, 'plugin', 'skills', 'postmortem'));
  expect(readFileSync(s.agentsMd, 'utf8')).not.toContain('the first install guidance');
});

test('--dry-run reads what Claude Code has registered from its files, without running claude', async () => {
  const s = sandbox(['claude']);
  writeFileSync(join(s.home, '.claude.json'), JSON.stringify({ mcpServers: { 'feedback-graph': { type: 'http', url: 'http://localhost:8787/mcp' } } }));
  const out = await s.run(['--dry-run', 'claude'], { API_TOKEN: TOKEN });
  expect(out).toContain('would: refresh Claude Code MCP server feedback-graph');
  expect(existsSync(s.calls)).toBe(false);
  mkdirSync(join(s.home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(s.home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'feedback-graph@feedback-graph': [{}] } }));
  expect(await s.run(['--dry-run', 'claude'], { API_TOKEN: TOKEN })).toContain('would: refresh the feedback-graph plugin environment');
  expect(existsSync(s.calls)).toBe(false);
});

test('an unconfigured checkout (no env file, or FEEDBACK_GRAPH_ENV naming a missing one) is refused: nothing is registered or linked', async () => {
  const s = sandbox(['claude', 'codex']);
  mkdirSync(s.codexDir);
  const config = '[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\nhttp_headers = { "Authorization" = "Bearer kept" }\n';
  writeFileSync(s.config, config);
  // A copy of this checkout with no .env, as a fresh clone is.
  const clone = mkdtempSync(join(tmpdir(), 'fbinstall-clone-'));
  mkdirSync(join(clone, 'scripts'));
  writeFileSync(join(clone, 'scripts', 'install-agent.sh'), readFileSync(script, 'utf8'));
  const env = { PATH: `${join(s.home, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: s.home };
  for (const [what, args, extra] of [
    ['FEEDBACK_GRAPH_ENV missing', [script], { FEEDBACK_GRAPH_ENV: join(s.home, 'missing.env') }],
    ['no .env in the checkout', [join(clone, 'scripts', 'install-agent.sh')], {}],
    ['--dry-run', [script, '--dry-run'], { FEEDBACK_GRAPH_ENV: join(s.home, 'missing.env') }],
  ] as [string, string[], Record<string, string>][]) {
    const r = await execResult('bash', args, { env: { ...env, ...extra } });
    expect(r.status, what).toBe(1);
    expect(r.stderr, what).toMatch(/this checkout is not set up \(missing .*\): run \.\/scripts\/setup\.sh first, or set FEEDBACK_GRAPH_URL/);
    expect(r.stdout, what).toBe('');
  }
  expect(existsSync(s.calls)).toBe(false);
  expect(existsSync(join(s.home, '.claude'))).toBe(false);
  expect(readFileSync(s.config, 'utf8')).toBe(config);
  expect(readdirSync(s.codexDir)).toEqual(['config.toml']);
  // FEEDBACK_GRAPH_URL names an install elsewhere: connecting to it needs no checkout set up here.
  expect(await s.run(['codex'], { FEEDBACK_GRAPH_ENV: join(s.home, 'missing.env'), FEEDBACK_GRAPH_URL: 'https://fg.example.com' })).toContain('Codex');
});

test('refuses when this name\'s containers were started from another folder: no server registered, no skill linked', async () => {
  const s = sandbox(['claude']);
  // docker: the service containers under this install's name, started from $STARTED_IN.
  writeFileSync(join(s.home, 'bin', 'docker'), '#!/bin/sh\ncase "$*" in "ps -a "*) [ -z "$STARTED_IN" ] || echo "$STARTED_IN" ;; esac\nexit 0\n');
  chmodSync(join(s.home, 'bin', 'docker'), 0o755);
  writeFileSync(join(s.home, 'install.env'), 'FG_INSTANCE=other\nAPI_PORT=8797\n');
  const run = (startedIn: string) => execResult('bash', [script, 'claude'], {
    env: { PATH: `${join(s.home, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: s.home, FEEDBACK_GRAPH_ENV: join(s.home, 'install.env'), STARTED_IN: startedIn },
  });
  const r = await run('/srv/other/feedback-graph');
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('the containers named other were started from /srv/other/feedback-graph, not this folder');
  expect(existsSync(s.calls)).toBe(false);
  expect(existsSync(join(s.home, '.claude', 'skills'))).toBe(false);
  // Its own folder's containers are no reason to refuse.
  expect((await run(repoRoot.replace(/\/$/, ''))).status).toBe(0);
  expect(readFileSync(s.calls, 'utf8')).toContain('mcp add');
});
