import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { exec, SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';

// A Codex guidance block written before 0.7.6 names no server. A named install takes it over unless the default
// install's server (feedback-graph) is registered, in which case that one keeps it.
vi.setConfig({ testTimeout: SCRIPT_TEST_TIMEOUT_MS });
const script = join(fileURLToPath(new URL('../../../', import.meta.url)), 'scripts', 'install-agent.sh');
const LEGACY = '<!-- BEGIN feedback-graph (managed by scripts/install-agent.sh in the Feedback Graph folder; re-run it to update) -->\nolder guidance\n<!-- END feedback-graph -->\n';

function legacyHome(servers: string[], claudeHas: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'fglegacy-'));
  const bin = join(home, 'bin');
  const codex = join(home, '.codex');
  mkdirSync(bin);
  mkdirSync(codex);
  writeFileSync(join(codex, 'config.toml'), servers.map((s) => `[mcp_servers.${s}]\nurl = "http://localhost:8797/mcp"\n`).join('\n'));
  writeFileSync(join(codex, 'AGENTS.md'), `# Mine\n\n${LEGACY}`);
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n');
  // `claude mcp get <name>` succeeds only for the names listed.
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\n[ "$1 $2" = "mcp get" ] && case " ${claudeHas.join(' ')} " in *" $3 "*) exit 0 ;; *) exit 1 ;; esac\nexit 0\n`);
  for (const f of ['codex', 'claude']) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(home, 'install.env'), 'FG_INSTANCE=feedback-graph-old\n');
  const run = (args: string[] = ['codex']) =>
    exec('bash', [script, ...args], {
      env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, FEEDBACK_GRAPH_ENV: join(home, 'install.env'), FG_INSTANCE: 'feedback-graph-old', API_PORT: '8797' },
    });
  return { run, agentsMd: join(codex, 'AGENTS.md') };
}

test('a named install takes over an unnamed guidance block when no feedback-graph server is registered', async () => {
  const h = legacyHome(['feedback-graph-old']);
  const dry = await h.run(['--dry-run', 'codex']);
  expect(dry).toContain('would: the Feedback Graph guidance in');
  expect(readFileSync(h.agentsMd, 'utf8')).toBe(`# Mine\n\n${LEGACY}`);
  const out = await h.run();
  expect(out).toContain('no feedback-graph server is registered, so this install (the server feedback-graph-old) takes it over');
  expect(out).toContain('Codex: updated the Feedback Graph guidance');
  expect(out).not.toContain('registered as feedback-graph;');
  const md = readFileSync(h.agentsMd, 'utf8');
  expect(md).toMatch(/^# Mine\n\n<!-- BEGIN feedback-graph \(server feedback-graph-old; /);
  expect(md).not.toContain('older guidance');
  expect(await h.run()).toContain('Codex: guidance already up to date');
});

test('an unnamed guidance block stays with the default install when its server is registered in Codex or Claude Code', async () => {
  for (const h of [legacyHome(['feedback-graph', 'feedback-graph-old']), legacyHome(['feedback-graph-old'], ['feedback-graph'])]) {
    const out = await h.run();
    expect(out).toContain('belongs to the install registered as feedback-graph; left as it is (this install is the server feedback-graph-old)');
    expect(readFileSync(h.agentsMd, 'utf8')).toBe(`# Mine\n\n${LEGACY}`);
  }
});
