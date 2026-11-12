import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execResult, SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';
import { expect, test, vi } from 'vitest';

vi.setConfig({ testTimeout: SCRIPT_TEST_TIMEOUT_MS });

// scripts/install-agent.sh against the forms a Codex config.toml, an AGENTS.md, ~/.claude/skills and a Claude Code
// settings.json take in the wild, in a throwaway HOME with stand-in `claude` / `codex` commands.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(repoRoot, 'scripts', 'install-agent.sh');
const TOKEN = 'a'.repeat(48);
const OLD = 'OLDTOKEN0123456789';

function sandbox(agents: ('claude' | 'codex')[] = ['codex']) {
  const home = mkdtempSync(join(tmpdir(), 'fbinstall-forms-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const calls = join(home, 'claude-calls.txt');
  if (agents.includes('claude')) writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$*" >> '${calls}'\n[ "$2" = get ] && exit 1\nexit 0\n`);
  if (agents.includes('codex')) writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n');
  for (const f of readdirSync(bin)) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(home, 'install.env'), '');
  const codexDir = join(home, '.codex');
  mkdirSync(codexDir);
  const run = (args: string[] = ['codex'], env: Record<string, string> = {}, timeout?: number) => execResult('bash', [script, ...args], {
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, FEEDBACK_GRAPH_ENV: join(home, 'install.env'), ...env },
    timeout,
  });
  return { home, bin, run, calls, codexDir, config: join(codexDir, 'config.toml'), agentsMd: join(codexDir, 'AGENTS.md') };
}

const backups = (dir: string, base: string) => readdirSync(dir).filter((f) => f.startsWith(`${base}.bak.`)).sort();

/** python3 tomllib's verdict on a file, or null when this machine has no python3 with tomllib. */
function tomlValid(file: string): boolean | null {
  try {
    execFileSync('python3', ['-I', '-c', 'import tomllib'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  try {
    execFileSync('python3', ['-I', '-c', 'import sys, tomllib; tomllib.load(open(sys.argv[1], "rb"))', file], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const expectValid = (file: string) => expect([true, null]).toContain(tomlValid(file));

test('a refresh backs config.toml up once, and the backup is the original; a second run in the same second gets its own', async () => {
  const s = sandbox();
  // Both runs in the same second, always: a stand-in date gives the backup stamp (the sandbox's path has a dash in it,
  // which a same-second backup once cut the path at, writing it outside the folder).
  writeFileSync(join(s.bin, 'date'), '#!/bin/sh\n[ "$1" = +%Y%m%d%H%M%S ] && { echo 20261111120000; exit 0; }\nexec /bin/date "$@"\n');
  chmodSync(join(s.bin, 'date'), 0o755);
  const original = `[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\nhttp_headers = { "Authorization" = "Bearer ${OLD}" }\n`;
  writeFileSync(s.config, original);
  const r = await s.run(['codex'], { API_TOKEN: TOKEN });
  expect(r.status).toBe(0);
  expect(r.stdout.match(/backed up .*config\.toml/g)).toHaveLength(1);
  const [only] = backups(s.codexDir, 'config.toml');
  expect(backups(s.codexDir, 'config.toml')).toHaveLength(1);
  expect(readFileSync(join(s.codexDir, only), 'utf8')).toBe(original);
  expect(readFileSync(s.config, 'utf8')).toContain(`"Bearer ${TOKEN}"`);
  // Rotated again at once: a new backup beside the first, which still holds the original.
  await s.run(['codex'], { API_TOKEN: 'b'.repeat(48) });
  expect(backups(s.codexDir, 'config.toml')).toEqual(['config.toml.bak.20261111120000', 'config.toml.bak.20261111120000-1']);
  expect(readFileSync(join(s.codexDir, only), 'utf8')).toBe(original);
  expect(readFileSync(join(s.codexDir, 'config.toml.bak.20261111120000-1'), 'utf8')).toContain(`"Bearer ${TOKEN}"`);
});

test('a refresh replaces only the Authorization header: custom headers stay, and without a token only Authorization goes', async () => {
  const s = sandbox();
  writeFileSync(s.config, `[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\nhttp_headers = { "Authorization" = "Bearer ${OLD}", "X-Team" = "blue" }\n`);
  expect((await s.run(['codex'], { API_TOKEN: TOKEN })).status).toBe(0);
  expect(readFileSync(s.config, 'utf8')).toContain(`http_headers = { "Authorization" = "Bearer ${TOKEN}", "X-Team" = "blue" }`);
  expectValid(s.config);
  expect((await s.run(['codex'])).status).toBe(0);
  const cfg = readFileSync(s.config, 'utf8');
  expect(cfg).toContain('http_headers = { "X-Team" = "blue" }');
  expect(cfg).not.toContain('Authorization');
  // A map without Authorization gets it first, the rest kept.
  writeFileSync(s.config, '[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\nhttp_headers = { X-Team = \'blue\' }\n');
  await s.run(['codex'], { API_TOKEN: TOKEN });
  expect(readFileSync(s.config, 'utf8')).toContain(`http_headers = { "Authorization" = "Bearer ${TOKEN}", X-Team = 'blue' }`);
});

test('a table header with a comment after it is this install\'s table: refreshed in place, never a second one', async () => {
  const s = sandbox();
  writeFileSync(s.config, `[mcp_servers.feedback-graph] # mine\nurl = "http://localhost:8787/mcp"\nhttp_headers = { "Authorization" = "Bearer ${OLD}" }\n`);
  expect((await s.run(['codex'], { API_TOKEN: TOKEN })).status).toBe(0);
  const cfg = readFileSync(s.config, 'utf8');
  expect(cfg.match(/\[mcp_servers\.feedback-graph\]/g)).toHaveLength(1);
  expect(cfg).toContain(`"Bearer ${TOKEN}"`);
  expectValid(s.config);
  expect((await s.run(['codex'], { API_TOKEN: TOKEN })).stdout).toMatch(/already registered/);
});

test('CRLF line ends: one refresh keeps them, and a re-run finds nothing to do', async () => {
  const s = sandbox();
  writeFileSync(s.config, `model = "o4"\r\n\r\n[mcp_servers.feedback-graph]\r\nurl = "http://localhost:8787/mcp"\r\nhttp_headers = { "Authorization" = "Bearer ${OLD}" }\r\n`);
  await s.run(['codex'], { API_TOKEN: TOKEN });
  const cfg = readFileSync(s.config, 'utf8');
  expect(cfg).toContain(`http_headers = { "Authorization" = "Bearer ${TOKEN}" }\r\n`);
  expect(cfg.split('\n').slice(0, -1).every((l) => l.endsWith('\r'))).toBe(true);
  await s.run(['codex'], { API_TOKEN: TOKEN });
  expect(readFileSync(s.config, 'utf8')).toBe(cfg);
  expect(backups(s.codexDir, 'config.toml')).toHaveLength(1);
});

test.each([
  ['a header subtable', `[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\n\n[mcp_servers.feedback-graph.http_headers]\nAuthorization = "Bearer ${OLD}"\n`, /\[mcp_servers\.feedback-graph\.http_headers\] table/],
  ['an inline table under [mcp_servers]', '[mcp_servers]\nfeedback-graph = { url = "http://localhost:8787/mcp" }\n', /inline table or dotted keys under \[mcp_servers\]/],
  ['dotted keys at the top level', 'mcp_servers.feedback-graph.url = "http://localhost:8787/mcp"\n', /dotted keys or an inline table at the top level/],
  ['mcp_servers as an inline table', 'mcp_servers = { other = { url = "http://x/mcp" } }\n', /dotted keys or an inline table at the top level/],
  ['dotted header keys in the table', `[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\nhttp_headers.Authorization = "Bearer ${OLD}"\n`, /dotted header keys/],
  ['a header map that is not strings on one line', '[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\nhttp_headers = { "X-Retries" = 3 }\n', /http_headers that is not one line/],
  ['an array of tables', '[[mcp_servers.feedback-graph]]\nurl = "http://localhost:8787/mcp"\n', /array of tables/],
  ['a url that spans lines', '[mcp_servers.feedback-graph]\nurl = \"\"\"\nhttp://localhost:8787/mcp\"\"\"\n', /a url that spans lines/],
])('a server written as %s is refused: exit 1, a clear reason, config.toml and AGENTS.md untouched, no backup', async (_what, config, reason) => {
  const s = sandbox();
  writeFileSync(s.config, config);
  writeFileSync(s.agentsMd, '# Mine\n');
  const r = await s.run(['codex'], { API_TOKEN: TOKEN });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(reason);
  expect(r.stderr).toMatch(/left it and .*AGENTS\.md unchanged/);
  expect(r.stdout + r.stderr).not.toContain(TOKEN);
  expect(readFileSync(s.config, 'utf8')).toBe(config);
  expect(readFileSync(s.agentsMd, 'utf8')).toBe('# Mine\n');
  expect(readdirSync(s.codexDir).sort()).toEqual(['AGENTS.md', 'config.toml']);
});

test('a result python3 tomllib rejects is never written: config.toml stays as it was, exit 1', async () => {
  const s = sandbox();
  // python3 with tomllib that finds the edited copy invalid (and the original fine).
  writeFileSync(join(s.bin, 'python3'), '#!/bin/sh\ncase "$4" in *.fg-tmp.*) echo "Cannot declare (\'x\',) twice (at line 4, column 1)"; exit 1 ;; esac\nexit 0\n');
  chmodSync(join(s.bin, 'python3'), 0o755);
  const original = `[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\nhttp_headers = { "Authorization" = "Bearer ${OLD}" }\n`;
  writeFileSync(s.config, original);
  const r = await s.run(['codex'], { API_TOKEN: TOKEN });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/would leave it invalid TOML \(Cannot declare/);
  expect(readFileSync(s.config, 'utf8')).toBe(original);
  expect(readdirSync(s.codexDir)).toEqual(['config.toml']);
  // A config.toml that is not valid TOML to begin with is refused before anything is changed.
  writeFileSync(join(s.bin, 'python3'), '#!/bin/sh\necho "Invalid value (at line 1, column 7)"; exit 1\n');
  const bad = await s.run(['codex'], { API_TOKEN: TOKEN });
  expect(bad.status).toBe(1);
  expect(bad.stderr).toMatch(/is not valid TOML \(Invalid value/);
  expect(readdirSync(s.codexDir)).toEqual(['config.toml']);
});

test('a refused Codex config fails the run, after Claude Code is still set up', async () => {
  const s = sandbox(['claude', 'codex']);
  writeFileSync(s.config, '[[mcp_servers.feedback-graph]]\nurl = "http://localhost:8787/mcp"\n');
  const r = await s.run([]);
  expect(r.status).toBe(1);
  expect(readFileSync(s.calls, 'utf8')).toContain('mcp add --transport http --scope user feedback-graph');
});

test('a linked config.toml is written through to its target and stays a link', async () => {
  const s = sandbox();
  const dotfiles = join(s.home, 'dotfiles');
  mkdirSync(dotfiles);
  writeFileSync(join(dotfiles, 'config.toml'), `[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\nhttp_headers = { "Authorization" = "Bearer ${OLD}" }\n`);
  symlinkSync(join(dotfiles, 'config.toml'), s.config);
  expect((await s.run(['codex'], { API_TOKEN: TOKEN })).status).toBe(0);
  expect(lstatSync(s.config).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(dotfiles, 'config.toml'), 'utf8')).toContain(`"Bearer ${TOKEN}"`);
});

test('an AGENTS.md block missing its END marker is refused and left whole', async () => {
  const s = sandbox();
  const md = '# Mine\n\n<!-- BEGIN feedback-graph (managed) -->\nold guidance\n\n## My other section\nKeep this text.\n';
  writeFileSync(s.agentsMd, md);
  const r = await s.run(['codex']);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/BEGIN marker but no <!-- END feedback-graph --> after it; left .*AGENTS\.md unchanged/);
  expect(readFileSync(s.agentsMd, 'utf8')).toBe(md);
  expect(backups(s.codexDir, 'AGENTS.md')).toHaveLength(0);
});

test('Claude Code: a skill folder of your own is skipped and said so, never given a link inside it', async () => {
  const s = sandbox(['claude']);
  const own = join(s.home, '.claude', 'skills', 'feedback-graph');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'SKILL.md'), 'mine');
  const r = await s.run(['claude']);
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/skill ~\/\.claude\/skills\/feedback-graph is your own folder, not a link; skipped it/);
  expect(r.stdout).not.toMatch(/linked skill: ~\/\.claude\/skills\/feedback-graph\n/);
  expect(readdirSync(own)).toEqual(['SKILL.md']);
  expect(readlinkSync(join(s.home, '.claude', 'skills', 'postmortem'))).toBe(join(repoRoot, 'plugin', 'skills', 'postmortem'));
});

test('Claude Code with the plugin: a linked settings.json stays a link to its updated target; one that is not JSON is refused plainly', async () => {
  const s = sandbox(['claude']);
  writeFileSync(join(s.bin, 'claude'), `#!/bin/sh\necho "$*" >> '${s.calls}'\n[ "$1" = plugin ] && echo '  ❯ feedback-graph@feedback-graph'\nexit 0\n`);
  const dotfiles = join(s.home, 'dotfiles');
  mkdirSync(dotfiles);
  mkdirSync(join(s.home, '.claude'));
  writeFileSync(join(dotfiles, 'settings.json'), JSON.stringify({ theme: 'dark' }));
  const settings = join(s.home, '.claude', 'settings.json');
  symlinkSync(join(dotfiles, 'settings.json'), settings);
  expect((await s.run(['claude'], { API_TOKEN: TOKEN })).status).toBe(0);
  expect(lstatSync(settings).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(join(dotfiles, 'settings.json'), 'utf8'))).toMatchObject({ theme: 'dark', env: { FEEDBACK_GRAPH_TOKEN: TOKEN } });
  writeFileSync(join(dotfiles, 'settings.json'), '{ not json');
  const r = await s.run(['claude'], { API_TOKEN: TOKEN });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/settings\.json is not valid JSON; left it unchanged/);
  expect(r.stderr).not.toMatch(/\n\s+at /);
  expect(readFileSync(join(dotfiles, 'settings.json'), 'utf8')).toBe('{ not json');
  expect(existsSync(join(s.home, '.claude', 'settings.json.tmp'))).toBe(false);
});

test('a symbolic link loop or a link into a missing folder is refused at once, saying so, with nothing changed', async () => {
  const s = sandbox(['claude', 'codex']);
  writeFileSync(join(s.bin, 'claude'), `#!/bin/sh\necho "$*" >> '${s.calls}'\n[ "$1" = plugin ] && echo '  ❯ feedback-graph@feedback-graph'\nexit 0\n`);
  symlinkSync('b.toml', s.config);
  symlinkSync('config.toml', join(s.codexDir, 'b.toml'));
  mkdirSync(join(s.home, '.claude'));
  const settings = join(s.home, '.claude', 'settings.json');
  symlinkSync(settings, settings);
  const loop = await s.run([], { API_TOKEN: TOKEN }, 20_000);
  expect(loop.signal).toBeNull();
  expect(loop.status).toBe(1);
  expect(loop.stderr).toMatch(/Codex: \S+config\.toml is a loop of symbolic links; left it and \S+AGENTS\.md unchanged/);
  expect(loop.stderr).toMatch(/Claude Code: \S+settings\.json is a loop of symbolic links; left it unchanged/);
  expect(readdirSync(s.codexDir).sort()).toEqual(['b.toml', 'config.toml']);
  expect(readlinkSync(settings)).toBe(settings);
  rmSync(s.config);
  symlinkSync(join(s.home, 'nowhere', 'config.toml'), s.config);
  const dangling = await s.run(['codex'], { API_TOKEN: TOKEN }, 20_000);
  expect(dangling.status).toBe(1);
  expect(dangling.stderr).toMatch(/config\.toml links to \S+nowhere\/config\.toml, in a folder that does not exist; left it/);
  expect(dangling.stderr).not.toMatch(/No such file or directory/);
  expect(existsSync(join(s.home, 'nowhere'))).toBe(false);
});

test('a linked AGENTS.md has its guidance block updated in its target and stays a link', async () => {
  const s = sandbox();
  expect((await s.run(['codex'])).status).toBe(0);
  const current = readFileSync(s.agentsMd, 'utf8');
  const dotfiles = join(s.home, 'dot');
  mkdirSync(dotfiles);
  const stale = current.replace(/(<!-- BEGIN feedback-graph[^\n]*\n)/, '$1stale line\n');
  writeFileSync(join(dotfiles, 'AGENTS.md'), `# Mine\n\n${stale}`);
  rmSync(s.agentsMd);
  symlinkSync(join(dotfiles, 'AGENTS.md'), s.agentsMd);
  const r = await s.run(['codex']);
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/updated the Feedback Graph guidance/);
  expect(lstatSync(s.agentsMd).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(dotfiles, 'AGENTS.md'), 'utf8')).toBe(`# Mine\n\n${current}`);
});

test('a second BEGIN marker without its own END is refused, and the text after it kept', async () => {
  const s = sandbox();
  expect((await s.run(['codex'])).status).toBe(0);
  const block = readFileSync(s.agentsMd, 'utf8').trim();
  const begin = block.split('\n')[0];
  const md = `# Mine\n\n${block.replace(begin, `${begin}\nstale`)}\n\n## Section A\nkeep A\n\n${begin}\nold stale copy\n\n## Section B\nKeep this text B.\n`;
  writeFileSync(s.agentsMd, md);
  const r = await s.run(['codex']);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/has a BEGIN marker but no <!-- END feedback-graph --> after it; left .*AGENTS\.md unchanged/);
  expect(readFileSync(s.agentsMd, 'utf8')).toBe(md);
});

// A python3 with tomllib from this machine, put on the script's PATH as it is, or with tomllib hidden (Python 3.10 and
// older, such as macOS's /usr/bin/python3).
const realPython = (() => {
  try {
    return execFileSync('python3', ['-I', '-c', 'import sys, tomllib; print(sys.executable)'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();
function usePython(s: ReturnType<typeof sandbox>, tomllib: boolean) {
  const hide = tomllib ? '' : 'import sys; sys.modules["tomllib"] = None\n';
  writeFileSync(join(s.bin, 'python3'), `#!/bin/sh\n[ "$1" = -I ] && [ "$2" = -c ] || exit 64\ncode=$3; shift 3\nexec '${realPython}' -I -c '${hide}'"$code" "$@"\n`);
  chmodSync(join(s.bin, 'python3'), 0o755);
}

test.skipIf(!realPython).each([['"""'], ["'''"]])('a table header inside a %s multi-line string is part of the string: the server gets a table of its own', async (q) => {
  const s = sandbox();
  usePython(s, true);
  const config = `[other]\nnote = ${q}\n[mcp_servers.feedback-graph]\nurl = "http://evil/mcp"\n${q}\n`;
  writeFileSync(s.config, config);
  const r = await s.run(['codex'], { API_TOKEN: TOKEN });
  expect(r.status).toBe(0);
  const out = readFileSync(s.config, 'utf8');
  expect(out.startsWith(config)).toBe(true);
  const parsed = JSON.parse(execFileSync(realPython!, ['-I', '-c', 'import sys, json, tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))))', s.config], { encoding: 'utf8' }));
  expect(parsed.other.note).toBe('[mcp_servers.feedback-graph]\nurl = "http://evil/mcp"\n');
  expect(parsed.mcp_servers['feedback-graph']).toMatchObject({ url: 'http://localhost:8787/mcp', http_headers: { Authorization: `Bearer ${TOKEN}` } });
});

test.skipIf(!realPython)('a multi-line array in the table is read past as a value: its lines kept, the url after it edited in place', async () => {
  const s = sandbox();
  usePython(s, true);
  writeFileSync(s.config, '[mcp_servers.feedback-graph]\nargs = [\n  ["nested]"],\n  "a",\n]\nurl = "http://localhost:1/mcp"\n');
  expect((await s.run(['codex'], { API_TOKEN: TOKEN })).status).toBe(0);
  expect(readFileSync(s.config, 'utf8')).toBe(`[mcp_servers.feedback-graph]\nenv_http_headers = { "X-FG-Run" = "FG_RUN", "X-FG-Sandbox" = "FG_SANDBOX", "X-FG-Run-Key" = "FG_RUN_KEY" }\nhttp_headers = { "Authorization" = "Bearer ${TOKEN}" }\nargs = [\n  ["nested]"],\n  "a",\n]\nurl = "http://localhost:8787/mcp"\n`);
});

test.skipIf(!realPython).each([[true], [false]])('a byte-order mark before the table: the table is edited in place and the mark kept (tomllib: %s)', async (tomllib) => {
  const s = sandbox();
  usePython(s, tomllib);
  writeFileSync(s.config, '\uFEFF[mcp_servers.feedback-graph]\nurl = "http://localhost:1/mcp"\n');
  const r = await s.run(['codex'], { API_TOKEN: TOKEN });
  expect(r.status).toBe(0);
  const out = readFileSync(s.config, 'utf8');
  expect(out).toBe(`\uFEFF[mcp_servers.feedback-graph]\nenv_http_headers = { "X-FG-Run" = "FG_RUN", "X-FG-Sandbox" = "FG_SANDBOX", "X-FG-Run-Key" = "FG_RUN_KEY" }\nhttp_headers = { "Authorization" = "Bearer ${TOKEN}" }\nurl = "http://localhost:8787/mcp"\n`);
});

test.skipIf(!realPython)('without a python3 that has tomllib, a one-line config is edited and the missing check said; a multi-line one is refused', async () => {
  const s = sandbox();
  usePython(s, false);
  writeFileSync(s.config, '[mcp_servers.feedback-graph]\nurl = "http://localhost:1/mcp"\n');
  const r = await s.run(['codex'], { API_TOKEN: TOKEN });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/could not check that \S+config\.toml still parses \(no python3 3\.11\+ with tomllib\)/);
  expect(readFileSync(s.config, 'utf8')).toContain(`"Bearer ${TOKEN}"`);
  const multi = `[other]\nnote = """\n[mcp_servers.x]\n"""\n`;
  writeFileSync(s.config, multi);
  writeFileSync(s.agentsMd, '# Mine\n');
  const refused = await s.run(['codex'], { API_TOKEN: TOKEN });
  expect(refused.status).toBe(1);
  expect(refused.stderr).toMatch(/has multi-line strings or arrays, and there is no python3 3\.11\+ \(with tomllib\) here to check that an edit of it still parses; left it and \S+AGENTS\.md unchanged/);
  expect(readFileSync(s.config, 'utf8')).toBe(multi);
  expect(readFileSync(s.agentsMd, 'utf8')).toBe('# Mine\n');
});

test('--codex-auto-approve keeps an approval mode you set to something else, and says so', async () => {
  const s = sandbox();
  const config = `[mcp_servers.feedback-graph]\nurl = "http://localhost:8787/mcp"\ndefault_tools_approval_mode = "prompt" # mine\nenv_http_headers = { "X-FG-Run" = "FG_RUN", "X-FG-Sandbox" = "FG_SANDBOX", "X-FG-Run-Key" = "FG_RUN_KEY" }\n`;
  writeFileSync(s.config, config);
  const r = await s.run(['codex', '--codex-auto-approve']);
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/sets default_tools_approval_mode = "prompt" for feedback-graph; left your choice as it is\. codex exec refuses report_feedback unless it is "approve"/);
  expect(readFileSync(s.config, 'utf8')).toBe(config);
});
