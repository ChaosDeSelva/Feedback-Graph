import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';

// Each test runs the real script in a subshell; on a loaded machine that can pass vitest's 5 s default.
vi.setConfig({ testTimeout: 20_000 });

// scripts/setup.sh, run on a copy of the files it reads (so it never writes this repo's .env), with a throwaway HOME and
// stand-ins for docker, curl (Ollama not answering) and, to play Linux, uname and id.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Ollama's /api/chat answer to the structured-output probe: an HTTP status and a body. */
type Chat = { code: number; body: string };
const CHAT_OK: Chat = { code: 200, body: JSON.stringify({ message: { role: 'assistant', content: '{"ok": true}' }, done: true }) };
const CHAT_501: Chat = { code: 501, body: JSON.stringify({ error: 'structured output is unavailable: this build of Ollama has no grammar support' }) };

/** A Compose container Docker knows about: its project, the folder it was started from, its published ports. */
type Container = { project: string; dir: string; ports?: string };

function sandbox(o: { linuxUid?: number; tags?: string; claude?: boolean; chat?: Chat; containers?: Container[] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fbsetup-'));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  for (const d of [join(repo, 'scripts', 'lib'), home, bin, join(home, 'code'), join(home, 'work')]) mkdirSync(d, { recursive: true });
  for (const f of ['scripts/setup.sh', 'scripts/lib/env.sh', 'scripts/lib/ollama.sh', 'scripts/lib/runner-apparmor.sh', '.env.example']) copyFileSync(join(repoRoot, f), join(repo, f));
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // Each stand-in appends what it was asked to ${base}/calls, so a test can see what setup.sh ran.
  const calls = join(base, 'calls');
  // docker ps (not recorded) answers from o.containers: by project label (-a --filter), or every container's published ports.
  const containers = join(base, 'containers');
  writeFileSync(containers, (o.containers ?? []).map((c) => `${c.project}\t${c.dir}\t${c.ports ?? ''}\n`).join(''));
  stub(
    'docker',
    `case "$1" in ps) ;; *) echo "docker $*" >> '${calls}' ;; esac
    case "$1 $2" in
      "ps -a") p="$(printf '%s\\n' "$@" | sed -n 's/^label=com.docker.compose.project=//p')"; awk -F'\t' -v p="$p" '$1 == p { print $2 }' '${containers}' ;;
      "ps --format") awk -F'\t' '{ print $3 }' '${containers}' ;;
    esac`,
  );
  // Ollama answers /api/tags with o.tags (not at all without it) and /api/chat with o.chat (the body, then the status on
  // its own line, as curl -w prints it); the Feedback Graph answers /api/status. Each chat request body is kept.
  const chat = o.chat ?? CHAT_OK;
  writeFileSync(join(base, 'chat'), `${chat.body}\n${chat.code}`);
  stub(
    'curl',
    `case "$*" in *api/tags*) ${o.tags === undefined ? 'exit 7' : `printf '%s' '${o.tags}'`} ;;
      *api/chat*) ${o.tags === undefined ? 'exit 7' : `printf '%s\\n' "$*" >> '${join(base, 'chat-requests')}'; cat '${join(base, 'chat')}'`} ;;
      *api/status*) echo '{}' ;; *) exit 7 ;; esac`,
  );
  stub('ollama', `echo "OLLAMA_HOST=$OLLAMA_HOST ollama $*" >> '${calls}'`);
  if (o.claude) stub('claude', 'exit 0');
  writeFileSync(join(repo, 'scripts', 'install-agent.sh'), `#!/bin/sh\necho "install-agent $*" >> '${calls}'\n`);
  chmodSync(join(repo, 'scripts', 'install-agent.sh'), 0o755);
  if (o.linuxUid !== undefined) {
    stub('uname', 'echo Linux');
    stub('id', `case "$1" in -u) echo ${o.linuxUid} ;; -g) echo ${o.linuxUid + 1} ;; *) /usr/bin/id "$@" ;; esac`);
  } else {
    // Not Linux unless a test says so, whatever runs the suite (in a Linux container as root, setup.sh would set HOST_UID=0).
    stub('uname', 'echo Darwin');
  }
  const run = (env: Record<string, string> = {}, answers?: string, args: string[] = []) =>
    execFileSync('bash', [join(repo, 'scripts', 'setup.sh'), ...args], {
      // With answers, setup.sh asks its questions as in a terminal and reads them, one per line.
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...(answers === undefined ? {} : { FEEDBACK_SETUP_INTERACTIVE: '1' }), ...env },
      encoding: 'utf8',
      input: answers ?? '',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const ran = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
  const env = () => readFileSync(join(repo, '.env'), 'utf8');
  const value = (k: string) => env().match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1];
  const rootsFile = join(repo, 'state', 'settings', 'project-roots.json');
  /** The roots in the file Settings writes, read the way the api reads it. */
  const saved = () => (existsSync(rootsFile) ? (JSON.parse(readFileSync(rootsFile, 'utf8')) as { roots: string[] }).roots : null);
  /** What the api writes when you save roots in Settings. */
  const saveInSettings = (roots: string[]) => {
    mkdirSync(join(repo, 'state', 'settings'), { recursive: true });
    writeFileSync(rootsFile, `${JSON.stringify({ roots, updatedAt: '2026-10-24T00:00:00.000Z' }, null, 2)}\n`);
  };
  const runFailing = (env: Record<string, string> = {}, args: string[] = []) => {
    try {
      run(env, undefined, args);
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string };
      return String(x.stdout ?? '') + String(x.stderr ?? '');
    }
    throw new Error('setup.sh did not fail');
  };
  const chatRequests = () => (existsSync(join(base, 'chat-requests')) ? readFileSync(join(base, 'chat-requests'), 'utf8') : '');
  /** A file a person wrote, holding a secret, for the --*-file flags. */
  const secretFile = (name: string, text: string) => {
    const p = join(base, name);
    writeFileSync(p, text);
    return p;
  };
  return { base, repo, home, run, runFailing, ran, env, value, saved, saveInSettings, rootsFile, chatRequests, secretFile, override: join(repo, 'docker-compose.override.yml') };
}

test('PROJECTS_DIRS=~/code on a first run writes it into .env and the roots file, and the override mounts exactly it', () => {
  const s = sandbox();
  const out = s.run({ PROJECTS_DIRS: '~/code' });
  expect(s.value('PROJECTS_DIRS')).toBe(join(s.home, 'code'));
  expect(s.value('PROJECTS_DIR')).toBeUndefined();
  expect(s.value('FEEDBACK_TOOL_DIR')).toBeUndefined();
  expect(s.value('NEO4J_PASSWORD')).toMatch(/^[0-9a-f]{36}$/);
  expect(s.saved()).toEqual([join(s.home, 'code')]);
  const o = readFileSync(s.override, 'utf8');
  expect(o).toContain(`PROJECT_ROOTS: '/roots/1'`);
  expect(o).toContain(`HOST_PROJECT_ROOTS: '${join(s.home, 'code')}'`);
  expect(o.match(/:\/roots\/1:ro'/g)).toHaveLength(2); // worker and api
  expect(o).not.toContain('examples');
  expect(out).toContain('wrote .env');
  // Re-running reads it back (no environment) and changes nothing.
  const before = [s.env(), o, readFileSync(s.rootsFile, 'utf8')];
  expect(s.run()).toContain('.env exists; leaving it alone.');
  expect([s.env(), readFileSync(s.override, 'utf8'), readFileSync(s.rootsFile, 'utf8')]).toEqual(before);
});

test('several folders: all of them in .env, and the generated override mounts them', () => {
  const s = sandbox();
  s.run({ PROJECTS_DIRS: '~/code, ~/work' });
  expect(s.value('PROJECTS_DIRS')).toBe(`${join(s.home, 'code')},${join(s.home, 'work')}`);
  const o = readFileSync(s.override, 'utf8');
  expect(o).toContain(`'${join(s.home, 'work')}:/roots/2:ro'`);
});

test('creates the transcript folders Docker would create as root, honouring CLAUDE_PROJECTS_DIR', () => {
  const s = sandbox();
  const elsewhere = join(s.home, 'elsewhere', 'claude-projects');
  s.run({ PROJECTS_DIRS: '~/code', CLAUDE_PROJECTS_DIR: elsewhere });
  expect(existsSync(elsewhere)).toBe(true);
  expect(existsSync(join(s.home, '.claude', 'projects'))).toBe(false);
  expect(existsSync(join(s.home, '.codex', 'sessions'))).toBe(true);
  // Only the sessions folder: no config or login, which is what install-agent.sh takes as Codex being installed.
  expect(existsSync(join(s.home, '.codex', 'config.toml'))).toBe(false);
  expect(existsSync(join(s.home, '.codex', 'auth.json'))).toBe(false);
});

test('Linux with a uid other than 1000: a new .env runs the containers as you; an existing one is told how', () => {
  const s = sandbox({ linuxUid: 1234 });
  const out = s.run({ PROJECTS_DIRS: '~/code' });
  expect(s.value('HOST_UID')).toBe('1234');
  expect(s.value('HOST_GID')).toBe('1235');
  expect(out).toContain('containers run as uid 1234');

  const old = sandbox({ linuxUid: 1234 });
  writeFileSync(join(old.repo, '.env'), `NEO4J_PASSWORD=x\nPROJECTS_DIR=${join(old.home, 'code')}\n`);
  const said = old.run();
  expect(said).toContain('HOST_UID=1234');
  expect(said).toContain('HOST_GID=1235');
  // Kept as it was, apart from PROJECTS_DIRS saying what is mounted (PROJECTS_DIR, from an older version, is read once).
  expect(old.env()).toBe(`NEO4J_PASSWORD=x\nPROJECTS_DIR=${join(old.home, 'code')}\nPROJECTS_DIRS=${join(old.home, 'code')}\n`);

  // uid 1000, or not Linux: nothing to set.
  const mac = sandbox();
  mac.run({ PROJECTS_DIRS: '~/code' });
  expect(mac.value('HOST_UID')).toBe('');
});

const both = '{"models":[{"name":"gemma4:latest"},{"name":"nomic-embed-text:latest"}]}';

test('without a terminal it only reports: no pulls, no token question, no start, and .env untouched', () => {
  const s = sandbox({ tags: '{"models":[]}', claude: true });
  const out = s.run({ PROJECTS_DIRS: '~/code' });
  expect(out).toContain('ollama: gemma4 is missing');
  expect(out).toContain('next: docker compose up -d --build');
  expect(s.ran()).toBe('');
  expect(s.value('CLAUDE_CODE_OAUTH_TOKEN')).toBe('');
});

test('asked in a terminal, it pulls only the missing models, from the Ollama it checked', () => {
  const s = sandbox({ tags: '{"models":[{"name":"nomic-embed-text:latest"}]}' });
  s.run({ PROJECTS_DIRS: '~/code' }, 'y\nn\nn\n');
  expect(s.ran()).toBe('OLLAMA_HOST=http://localhost:11434 ollama pull gemma4\n');
});

test('a pasted Claude token goes into the existing .env, in place, never printed, and the file stays private', () => {
  const s = sandbox({ tags: both, claude: true });
  s.run({ PROJECTS_DIRS: '~/code' });
  const token = 'sk-ant-oat01-' + 'abcDEF123_-xyz';
  const out = s.run({}, `${token}\nn\n`);
  expect(s.value('CLAUDE_CODE_OAUTH_TOKEN')).toBe(token);
  expect(s.env().match(/^CLAUDE_CODE_OAUTH_TOKEN=/gm)).toHaveLength(1);
  expect(out).not.toContain(token);
  expect(out).toContain('post-mortems now run on Claude');
  expect(readFileSync(join(s.repo, '.env.example'), 'utf8').split('\n').length).toBe(s.env().split('\n').length);
  // Already set: not asked again (the next answer is taken by the start question).
  expect(s.run({}, 'n\n')).not.toContain('Paste');
});

test('a token with other characters is refused and .env keeps no token', () => {
  const s = sandbox({ tags: both, claude: true });
  s.run({ PROJECTS_DIRS: '~/code' });
  const out = s.run({}, 'not a token; rm -rf\nn\n');
  expect(out).toContain('that does not look like a token');
  expect(s.value('CLAUDE_CODE_OAUTH_TOKEN')).toBe('');
});

test('Enter skips the token; no claude on PATH means no question', () => {
  const s = sandbox({ tags: both, claude: true });
  s.run({ PROJECTS_DIRS: '~/code' });
  s.run({}, '\nn\n');
  expect(s.value('CLAUDE_CODE_OAUTH_TOKEN')).toBe('');
  const none = sandbox({ tags: both });
  expect(none.run({ PROJECTS_DIRS: '~/code' }, 'n\n')).not.toContain('Paste');
});

test('yes to starting: compose up, wait until it answers, then connect the agents', () => {
  const s = sandbox({ tags: both });
  const out = s.run({ PROJECTS_DIRS: '~/code' }, 'n\ny\ny\n');
  expect(s.ran()).toBe('docker compose up -d --build\ninstall-agent \n');
  expect(out).toContain('running: http://localhost:8787');
});

test('STORE=postgres without the profile set: the start includes the bundled database', () => {
  const s = sandbox({ tags: both });
  s.run({ PROJECTS_DIRS: '~/code', STORE: 'postgres' }, 'n\ny\nn\n');
  expect(s.ran()).toBe('docker compose --profile postgres up -d --build\n');
});

test('no project folder anywhere and no terminal: no guess, nothing mounted, and it says how to add one', () => {
  const s = sandbox();
  const out = s.run();
  expect(out).toContain('no project folders yet');
  expect(out).toContain('Settings');
  expect(s.value('PROJECTS_DIRS')).toBe('');
  expect(s.saved()).toBeNull(); // nothing was chosen, so nothing is recorded as chosen
  const o = readFileSync(s.override, 'utf8');
  expect(o).toContain(`PROJECT_ROOTS: ''`);
  expect(o).toContain(`HOST_PROJECT_ROOTS: ''`);
  expect(o).not.toContain('volumes:');
});

test('the roots saved in Settings win over .env, and are mounted as given, odd characters and all', () => {
  const s = sandbox();
  s.run({ PROJECTS_DIRS: '~/code' });
  const odd = join(s.home, "my 'odd' projects");
  mkdirSync(odd);
  s.saveInSettings([join(s.home, 'work'), odd]);
  const out = s.run();
  expect(out).toContain('from Settings');
  expect(s.value('PROJECTS_DIRS')).toBe(`${join(s.home, 'work')},${odd}`);
  const o = readFileSync(s.override, 'utf8');
  expect(o).toContain(`'${join(s.home, 'work')}:/roots/1:ro'`);
  expect(o).toContain(`'${odd.replaceAll("'", "''")}:/roots/2:ro'`);
  expect(o).not.toContain(`${join(s.home, 'code')}:`);
});

test('removing every root in Settings unmounts them all', () => {
  const s = sandbox();
  s.run({ PROJECTS_DIRS: '~/code,~/work' });
  s.saveInSettings([]);
  s.run();
  expect(s.value('PROJECTS_DIRS')).toBe('');
  const o = readFileSync(s.override, 'utf8');
  expect(o).toContain(`PROJECT_ROOTS: ''`);
  expect(o).not.toContain('/roots/');
});

test('a saved root that does not exist on this machine stops setup with a reason, before anything is remounted', () => {
  const s = sandbox();
  s.run({ PROJECTS_DIRS: '~/code' });
  const before = readFileSync(s.override, 'utf8');
  s.saveInSettings([join(s.home, 'nope')]);
  expect(s.runFailing()).toContain(`${join(s.home, 'nope')} does not exist on this machine (from Settings)`);
  expect(readFileSync(s.override, 'utf8')).toBe(before);
});

test('PROJECTS_DIRS edited in .env after the roots were saved replaces them', () => {
  const s = sandbox();
  s.run({ PROJECTS_DIRS: '~/code' });
  const envFile = join(s.repo, '.env');
  writeFileSync(envFile, s.env().replace(/^PROJECTS_DIRS=.*$/m, `PROJECTS_DIRS=${join(s.home, 'work')}`));
  const later = new Date(Date.now() + 60_000);
  utimesSync(envFile, later, later);
  s.run();
  expect(s.saved()).toEqual([join(s.home, 'work')]);
  expect(readFileSync(s.override, 'utf8')).toContain(`'${join(s.home, 'work')}:/roots/1:ro'`);
});

test('an install from before Settings keeps its PROJECTS_DIR, and the bundled examples are no longer mounted', () => {
  const s = sandbox();
  writeFileSync(join(s.repo, '.env'), `NEO4J_PASSWORD=x\nPROJECTS_DIR=${join(s.home, 'code')}\nFEEDBACK_TOOL_DIR=${s.repo}\n`);
  // The override an older setup.sh generated for two folders plus the examples.
  writeFileSync(s.override, `# Generated by scripts/setup.sh from PROJECTS_DIRS in .env.\nx-roots: &roots\n  PROJECT_ROOTS: '/vibe,/roots/2,/examples'\n`);
  s.run();
  expect(s.saved()).toEqual([join(s.home, 'code')]);
  const o = readFileSync(s.override, 'utf8');
  expect(o).toContain(`'${join(s.home, 'code')}:/roots/1:ro'`);
  expect(o).not.toContain('examples');
});

test('asked in a terminal: the folders typed are mounted; Enter mounts none, with no default taken', () => {
  const s = sandbox({ tags: both });
  const out = s.run({}, `~/work\nn\nn\n`);
  expect(out).toContain('Which folders hold your projects');
  expect(s.saved()).toEqual([join(s.home, 'work')]);
  expect(s.ran()).toBe(''); // the next answer was no to starting
  const none = sandbox({ tags: both });
  none.run({}, '\nn\n');
  expect(none.value('PROJECTS_DIRS')).toBe('');
  expect(none.saved()).toEqual([]);
});

test('an override you wrote yourself is never touched', () => {
  const s = sandbox();
  writeFileSync(s.override, 'services: {}\n');
  expect(s.run({ PROJECTS_DIRS: '~/code' })).toContain('is your own');
  expect(readFileSync(s.override, 'utf8')).toBe('services: {}\n');
});

test('the roots file setup.sh writes reads back in the api exactly', async () => {
  const { rootsFile } = await import('./roots.ts');
  const s = sandbox();
  s.run({ PROJECTS_DIRS: '~/code,~/work' });
  expect((await rootsFile(s.rootsFile).read())?.roots).toEqual([join(s.home, 'code'), join(s.home, 'work')]);
  s.run({ PROJECTS_DIRS: '~/code,~/work' }); // and again: the empty list form too
  s.saveInSettings([]);
  s.run();
  expect((await rootsFile(s.rootsFile).read())?.roots).toEqual([]);
});

test('structured output is probed with one real schema-constrained chat call to the classifier model', () => {
  const s = sandbox({ tags: both });
  const out = s.run({ PROJECTS_DIRS: '~/code' });
  expect(out).toContain('ollama: structured output works (gemma4)');
  const req = s.chatRequests();
  expect(req).toContain('/api/chat');
  expect(req).toContain('"format"');
  expect(req).toContain('"model":"gemma4"');
});

test('an Ollama without structured output stops setup loudly, with the fix (the official app, not the Homebrew formula)', () => {
  const s = sandbox({ tags: both, chat: CHAT_501 });
  const out = s.runFailing({ PROJECTS_DIRS: '~/code' });
  expect(out).toContain('FAIL ollama: structured output does not work');
  expect(out).toContain('structured output is unavailable');
  expect(out).toContain('official Ollama app');
  expect(out).toContain('brew services stop ollama');
  // .env and the mounts were still written: only the model check failed.
  expect(s.value('PROJECTS_DIRS')).toBe(join(s.home, 'code'));
});

test('no structured-output probe when the classifier runs on another provider, or its model is not pulled yet', () => {
  const other = sandbox({ tags: both, chat: CHAT_501 });
  expect(other.run({ PROJECTS_DIRS: '~/code', CLASSIFY_LLM: 'claude-cli' })).not.toContain('structured output');
  const missing = sandbox({ tags: '{"models":[{"name":"nomic-embed-text:latest"}]}', chat: CHAT_501 });
  expect(missing.run({ PROJECTS_DIRS: '~/code' })).not.toContain('FAIL');
  expect(missing.chatRequests()).toBe('');
});

test('--pull-models pulls the missing models without a terminal; --projects is PROJECTS_DIRS', () => {
  const s = sandbox({ tags: '{"models":[{"name":"nomic-embed-text:latest"}]}' });
  s.run({}, undefined, ['--projects', '~/code,~/work', '--pull-models']);
  expect(s.ran()).toBe('OLLAMA_HOST=http://localhost:11434 ollama pull gemma4\n');
  expect(s.saved()).toEqual([join(s.home, 'code'), join(s.home, 'work')]);
});

test('--yes answers yes to every question without a terminal: pull, start, connect the agents; nothing is read from stdin', () => {
  const s = sandbox({ tags: '{"models":[{"name":"nomic-embed-text:latest"}]}', claude: true });
  const out = s.run({}, undefined, ['--yes', '--projects', '~/code']);
  expect(s.ran()).toBe('OLLAMA_HOST=http://localhost:11434 ollama pull gemma4\ndocker compose up -d --build\ninstall-agent \n');
  expect(out).not.toContain('Paste');
  expect(out).toContain('running: http://localhost:8787');
});

test('the --*-file flags put a secret a person wrote into .env, private, and never print it', () => {
  const s = sandbox({ tags: both });
  const gh = 'g'.repeat(36);
  const lin = 'l'.repeat(40);
  const claude = 'c'.repeat(20) + '-_.x';
  const out = s.run({}, undefined, [
    '--projects', '~/code',
    '--github-token-file', s.secretFile('gh', `${gh}\n`),
    '--linear-key-file', s.secretFile('lin', `  ${lin}  \n`),
    '--claude-token-file', s.secretFile('claude', claude),
  ]);
  expect(s.value('GITHUB_TOKEN')).toBe(gh);
  expect(s.value('LINEAR_API_KEY')).toBe(lin);
  expect(s.value('CLAUDE_CODE_OAUTH_TOKEN')).toBe(claude);
  for (const secret of [gh, lin, claude]) expect(out).not.toContain(secret);
  expect(out).toContain('GITHUB_TOKEN saved to .env');
  expect(statSync(join(s.repo, '.env')).mode & 0o777).toBe(0o600);
  // Read again on a re-run: replaced in place, one line each.
  s.run({}, undefined, ['--github-token-file', s.secretFile('gh2', 'h'.repeat(36))]);
  expect(s.value('GITHUB_TOKEN')).toBe('h'.repeat(36));
  expect(s.env().match(/^GITHUB_TOKEN=/gm)).toHaveLength(1);
});

test('a secret file that is missing, empty or holds other characters stops setup, and .env keeps no value from it', () => {
  const s = sandbox({ tags: both });
  s.run({ PROJECTS_DIRS: '~/code' });
  expect(s.runFailing({}, ['--linear-key-file', join(s.home, 'nope')])).toContain('cannot read');
  expect(s.runFailing({}, ['--linear-key-file', s.secretFile('empty', '\n')])).toContain('is empty');
  const bad = 'x'.repeat(10) + ' $(rm -rf ~)';
  const out = s.runFailing({}, ['--linear-key-file', s.secretFile('bad', bad)]);
  expect(out).toContain('does not look like a key');
  expect(out).not.toContain(bad);
  expect(s.value('LINEAR_API_KEY')).toBe('');
});

test('an unknown flag, or a flag missing its value, says how to use it', () => {
  const s = sandbox();
  expect(s.runFailing({}, ['--frobnicate'])).toContain('usage:');
  expect(s.runFailing({}, ['--projects'])).toContain('--projects needs a value');
});

test('the operator token is generated only with --yes or a yes answer, never printed, and kept on re-runs', () => {
  const s = sandbox({ tags: both });
  // No terminal, no --yes: not asked, not made.
  s.run({ PROJECTS_DIRS: '~/code' });
  expect(s.value('FG_OPERATOR_TOKEN')).toBe('');
  // Asked: no keeps it empty.
  s.run({}, 'n\nn\n');
  expect(s.value('FG_OPERATOR_TOKEN')).toBe('');
  // Asked: yes makes one (48 hex characters), mentioned but not printed.
  const out = s.run({}, 'y\nn\n');
  const token = s.value('FG_OPERATOR_TOKEN')!;
  expect(token).toMatch(/^[0-9a-f]{48}$/);
  expect(out).toContain('FG_OPERATOR_TOKEN saved to .env');
  expect(out).not.toContain(token);
  expect(statSync(join(s.repo, '.env')).mode & 0o777).toBe(0o600);
  // Set already: not asked again, and --yes keeps it.
  s.run({}, undefined, ['--yes']);
  expect(s.value('FG_OPERATOR_TOKEN')).toBe(token);
  const fresh = sandbox({ tags: both });
  fresh.run({}, undefined, ['--yes', '--projects', '~/code']);
  expect(fresh.value('FG_OPERATOR_TOKEN')).toMatch(/^[0-9a-f]{48}$/);
}, 20_000);

// ── Two installs on one machine ────────────────────────────────────────

const PORTS = '127.0.0.1:8787->8787/tcp, 127.0.0.1:7476->7474/tcp, 127.0.0.1:7689->7687/tcp';

test('another folder\'s install is running: a new .env gets its own instance name and ports, and says why', () => {
  const s = sandbox({ containers: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph', ports: PORTS }] });
  const out = s.run({ PROJECTS_DIRS: '~/code' });
  expect(s.value('FG_INSTANCE')).toBe('feedback-graph-repo');
  expect([s.value('API_PORT'), s.value('NEO4J_HTTP_PORT'), s.value('NEO4J_BOLT_PORT'), s.value('POSTGRES_PORT'), s.value('OLLAMA_PORT')]).toEqual(['8797', '7486', '7699', '5444', '11445']);
  expect(out).toContain('/srv/acme/feedback-graph');
  expect(out).toContain('OLLAMA_PORT=11445');
  expect(out).toMatch(/FG_INSTANCE=feedback-graph-repo/);
  expect(out).toMatch(/http:\/\/localhost:8797/);
  // Re-running keeps them.
  s.run();
  expect(s.value('FG_INSTANCE')).toBe('feedback-graph-repo');
  expect(s.value('API_PORT')).toBe('8797');
});

test('the install running is this folder\'s own, or none is: the name and ports stay the defaults (existing volumes keep their names)', () => {
  const own = sandbox();
  writeFileSync(join(own.base, 'containers'), `feedback-graph\t${own.repo}\t${PORTS}\n`);
  own.run({ PROJECTS_DIRS: '~/code' });
  expect(own.value('FG_INSTANCE')).toBe('');
  expect(own.value('API_PORT')).toBe('8787');
  expect(own.value('OLLAMA_PORT')).toBe('');
  const none = sandbox();
  none.run({ PROJECTS_DIRS: '~/code' });
  expect(none.value('FG_INSTANCE')).toBe('');
  expect(none.value('POSTGRES_PORT')).toBe('5434');
});

test('a name or ports another install already took are skipped', () => {
  const s = sandbox({ containers: [
    { project: 'feedback-graph', dir: '/srv/acme/feedback-graph', ports: PORTS },
    { project: 'feedback-graph-repo', dir: '/srv/demo-shop/repo', ports: '127.0.0.1:8797->8787/tcp, 127.0.0.1:5444->5432/tcp' },
  ] });
  s.run({ PROJECTS_DIRS: '~/code' });
  expect(s.value('FG_INSTANCE')).toBe('feedback-graph-repo-2');
  expect([s.value('API_PORT'), s.value('NEO4J_HTTP_PORT'), s.value('NEO4J_BOLT_PORT'), s.value('POSTGRES_PORT'), s.value('OLLAMA_PORT')]).toEqual(['8807', '7496', '7709', '5454', '11455']);
});

test('the bundled ollama profile is reached on its own host port: OLLAMA_PORT, 11435 when unset', () => {
  const s = sandbox({ tags: '{"models":[{"name":"nomic-embed-text:latest"}]}' });
  s.run({ PROJECTS_DIRS: '~/code', OLLAMA_URL: 'http://ollama:11434' }, 'y\nn\nn\n');
  expect(s.ran()).toContain('OLLAMA_HOST=http://localhost:11435 ollama pull gemma4\n');
  const other = sandbox({ tags: '{"models":[{"name":"nomic-embed-text:latest"}]}' });
  other.run({ PROJECTS_DIRS: '~/code', OLLAMA_URL: 'http://ollama:11434', OLLAMA_PORT: '11445' }, 'y\nn\nn\n');
  expect(other.ran()).toContain('OLLAMA_HOST=http://localhost:11445 ollama pull gemma4\n');
});

test('a port another container publishes for the bundled ollama is skipped too', () => {
  const s = sandbox({ containers: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph', ports: `${PORTS}, 127.0.0.1:11445->11434/tcp` }] });
  s.run({ PROJECTS_DIRS: '~/code' });
  expect([s.value('API_PORT'), s.value('OLLAMA_PORT')]).toEqual(['8807', '11455']);
});

test('FG_INSTANCE given is used as it is; an existing .env is never renamed, only told how', () => {
  const given = sandbox({ containers: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph', ports: PORTS }] });
  given.run({ PROJECTS_DIRS: '~/code', FG_INSTANCE: 'fg-staging' });
  expect(given.value('FG_INSTANCE')).toBe('fg-staging');
  const old = sandbox({ containers: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph', ports: PORTS }] });
  writeFileSync(join(old.repo, '.env'), `NEO4J_PASSWORD=x\nPROJECTS_DIRS=${join(old.home, 'code')}\n`);
  const said = old.run();
  expect(old.value('FG_INSTANCE')).toBeUndefined();
  expect(said).toContain('/srv/acme/feedback-graph');
  expect(said).toMatch(/FG_INSTANCE=/);
  const bad = sandbox();
  expect(bad.runFailing({ PROJECTS_DIRS: '~/code', FG_INSTANCE: 'Has Spaces' })).toMatch(/FG_INSTANCE/);
});

test('--help documents a second install: FG_INSTANCE, the ports it moves (OLLAMA_PORT too) and --select', () => {
  const s = sandbox();
  const help = s.run({}, undefined, ['--help']);
  for (const k of ['FG_INSTANCE', 'API_PORT', 'NEO4J_HTTP_PORT', 'NEO4J_BOLT_PORT', 'POSTGRES_PORT', 'OLLAMA_PORT', '--select', 'INGEST_PROJECTS']) expect(help).toContain(k);
});

test('a hand-written .env under the name another folder\'s install runs as is never started, nor are agents connected', () => {
  const s = sandbox({ containers: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph', ports: PORTS }] });
  writeFileSync(join(s.repo, '.env'), `NEO4J_PASSWORD=x\nPROJECTS_DIRS=${join(s.home, 'code')}\n`);
  // --yes would start it and run install-agent.sh: both would take over the other folder's install.
  const out = s.runFailing({}, ['--yes']);
  expect(s.ran()).not.toContain('docker compose');
  expect(s.ran()).not.toContain('install-agent');
  expect(out).toMatch(/not starting/i);
  expect(out).toContain('/srv/acme/feedback-graph');
  expect(out).toMatch(/FG_INSTANCE=feedback-graph-repo/);
  // Without --yes it says the same instead of the usual "next: docker compose up", and nothing fails.
  const quiet = s.run();
  expect(quiet).toMatch(/not starting/i);
  expect(quiet).not.toMatch(/next: docker compose up/);
  // Its own folder's containers are no reason to refuse.
  const own = sandbox();
  writeFileSync(join(own.base, 'containers'), `feedback-graph\t${own.repo}\t${PORTS}\n`);
  own.run({ PROJECTS_DIRS: '~/code' }, undefined, ['--yes']);
  expect(own.ran()).toContain('docker compose up -d --build');
}, 20_000);

test('--select seeds the projects read until a selection is made: INGEST_PROJECTS in .env, checked against the folders', () => {
  const s = sandbox();
  for (const d of ['acme', 'demo-shop', '.hidden']) mkdirSync(join(s.home, 'code', d));
  const out = s.run({}, undefined, ['--projects', '~/code', '--select', 'acme, demo-shop']);
  expect(s.value('INGEST_PROJECTS')).toBe('acme,demo-shop');
  expect(out).toMatch(/INGEST_PROJECTS=acme,demo-shop/);
  expect(out).toMatch(/until a selection is made/i);
  // A re-run (the stack already started once with nothing chosen) sets it the same way.
  s.run({}, undefined, ['--select', 'demo-shop']);
  expect(s.value('INGEST_PROJECTS')).toBe('demo-shop');
  // A key that is no folder under the project folders is refused, and .env keeps what it had.
  expect(s.runFailing({}, ['--select', 'nope'])).toMatch(/nope.*not a folder under your project folders/);
  expect(s.value('INGEST_PROJECTS')).toBe('demo-shop');
  expect(s.runFailing({}, ['--select', 'a b'])).toMatch(/--select/);
  // A nested key (a__b is a/b) whose parts climb out of the project folders, or name a hidden folder, is refused.
  mkdirSync(join(s.home, 'outside'));
  for (const k of ['acme__..__..__outside', '..__outside', 'acme__.hidden', 'acme____demo-shop']) expect(s.runFailing({}, ['--select', k])).toMatch(/--select/);
  expect(s.value('INGEST_PROJECTS')).toBe('demo-shop');
});

test('a first run in a terminal offers to choose the projects to read from the folders found; Enter leaves it to Settings', () => {
  const s = sandbox();
  for (const d of ['acme', 'demo-shop']) mkdirSync(join(s.home, 'code', d));
  // Answers: projects to read, operator token (n), start (n).
  const out = s.run({ PROJECTS_DIRS: '~/code' }, 'demo-shop\nn\nn\n');
  expect(out).toContain('acme');
  expect(s.value('INGEST_PROJECTS')).toBe('demo-shop');
  const later = sandbox();
  mkdirSync(join(later.home, 'code', 'acme'));
  later.run({ PROJECTS_DIRS: '~/code' }, '\nn\nn\n');
  expect(later.value('INGEST_PROJECTS')).toBe('');
  // Not asked again on a re-run: the selection may already be made, in Settings.
  expect(later.run({}, 'n\nn\n')).not.toMatch(/Which of these projects/);
});

test('--yes alone never opts in to relaxed runner system paths', () => {
  const s = sandbox();
  s.run({}, undefined, ['--yes', '--projects', '~/code']);
  expect(existsSync(join(s.repo, 'docker-compose.runner-procfs.yml'))).toBe(false);
  expect(s.value('COMPOSE_FILE')).toBeUndefined();
});

test('explicit procfs opt-in generates only a separate runner override and preserves existing Compose files', () => {
  const s = sandbox();
  const out = s.run({ COMPOSE_FILE: 'docker-compose.yml:custom.yml:docker-compose.override.yml' }, undefined,
    ['--runner-procfs-compat', '--yes', '--projects', '~/code']);
  const compatibility = readFileSync(join(s.repo, 'docker-compose.runner-procfs.yml'), 'utf8');
  expect(compatibility).toContain('  codex-runner:');
  expect(compatibility).toContain('systempaths=unconfined');
  expect(compatibility).not.toContain('privileged');
  expect(compatibility).not.toContain('cap_add');
  expect(readFileSync(s.override, 'utf8')).not.toContain('systempaths');
  expect(s.value('COMPOSE_FILE')).toBe('docker-compose.yml:custom.yml:docker-compose.override.yml:docker-compose.runner-procfs.yml');
  expect(out.indexOf('removes an outer Docker filesystem defense')).toBeLessThan(out.indexOf('Saved runner procfs opt-in'));
  s.run({}, undefined, ['--runner-procfs-compat', '--yes']);
  expect(s.value('COMPOSE_FILE')?.split(':').filter(f => f === 'docker-compose.runner-procfs.yml')).toHaveLength(1);
});

test('explicit procfs flag without confirmation leaves Docker protections unchanged', () => {
  const s = sandbox();
  const out = s.run({ PROJECTS_DIRS: '~/code' }, undefined, ['--runner-procfs-compat']);
  expect(out).toContain('Runner procfs compatibility was not enabled.');
  expect(existsSync(join(s.repo, 'docker-compose.runner-procfs.yml'))).toBe(false);
  expect(s.value('COMPOSE_FILE')).toBeUndefined();
});

test('procfs opt-in refuses to overwrite an owner-authored override', () => {
  const s = sandbox();
  const file = join(s.repo, 'docker-compose.runner-procfs.yml');
  writeFileSync(file, '# owner settings\nservices: {}\n');
  expect(s.runFailing({ PROJECTS_DIRS: '~/code' }, ['--runner-procfs-compat', '--yes'])).toContain('refusing to overwrite');
  expect(readFileSync(file, 'utf8')).toBe('# owner settings\nservices: {}\n');
  expect(s.value('COMPOSE_FILE')).toBeUndefined();
});
