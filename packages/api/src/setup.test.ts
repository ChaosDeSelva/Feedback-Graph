import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';
import { expect, test, vi } from 'vitest';

vi.setConfig({ testTimeout: SCRIPT_TEST_TIMEOUT_MS });

// scripts/setup.sh, run on a copy of the files it reads (so it never writes this repo's .env), with a throwaway HOME and
// stand-ins for docker, curl (Ollama not answering) and, to play Linux, uname and id.
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Ollama's /api/chat answer to the structured-output probe: an HTTP status and a body. */
type Chat = { code: number; body: string };
const CHAT_OK: Chat = { code: 200, body: JSON.stringify({ message: { role: 'assistant', content: '{"ok": true}' }, done: true }) };
const CHAT_501: Chat = { code: 501, body: JSON.stringify({ error: 'structured output is unavailable: this build of Ollama has no grammar support' }) };

/** A Compose container Docker knows about: its project, the folder it was started from, its published ports, and whether
 * it is a one-off container (docker run by backup.sh or restore.sh). */
type Container = { project: string; dir: string; ports?: string; oneoff?: boolean };

function sandbox(o: { linuxUid?: number; tags?: string; claude?: boolean; chat?: Chat; containers?: Container[] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fbsetup-'));
  const repo = join(base, 'repo');
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  for (const d of [join(repo, 'scripts', 'lib'), home, bin, join(home, 'code'), join(home, 'work')]) mkdirSync(d, { recursive: true });
  for (const f of ['scripts/setup.sh', 'scripts/lib/env.sh', 'scripts/lib/ollama.sh', 'scripts/lib/runner-apparmor.sh', 'scripts/lib/api-settings.sh', 'scripts/lib/state-fs.sh', '.env.example']) copyFileSync(join(repoRoot, f), join(repo, f));
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // Each stand-in appends what it was asked to ${base}/calls, so a test can see what setup.sh ran.
  const calls = join(base, 'calls');
  // docker ps (not recorded) answers from o.containers: by project label (-a --filter), or every container's published ports.
  const containers = join(base, 'containers');
  writeFileSync(containers, (o.containers ?? []).map((c) => `${c.project}\t${c.dir}\t${c.ports ?? ''}\t${c.oneoff ? 'True' : 'False'}\n`).join(''));
  stub(
    'docker',
    `case "$1 $2" in "ps "* | "compose version") ;; *) echo "docker $*" >> '${calls}' ;; esac
    case "$1 $2" in
      "ps -a") p="$(printf '%s\\n' "$@" | sed -n 's/^label=com.docker.compose.project=//p')"; o="$(printf '%s\\n' "$@" | sed -n 's/^label=com.docker.compose.oneoff=//p')"
        awk -F'\t' -v p="$p" -v o="$o" '$1 == p && (o == "" || $4 == o) { print $2 }' '${containers}' ;;
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
    exec('bash', [join(repo, 'scripts', 'setup.sh'), ...args], {
      // With answers, setup.sh asks its questions as in a terminal and reads them, one per line.
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...(answers === undefined ? {} : { FEEDBACK_SETUP_INTERACTIVE: '1' }), ...env },
      input: answers ?? '',
    });
  const ran = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
  const env = () => readFileSync(join(repo, '.env'), 'utf8');
  const value = (k: string) => env().match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1];
  const rootsFile = join(repo, 'state', 'api-settings', 'project-roots.json');
  /** The roots in the file Settings writes, read the way the api reads it. */
  const saved = () => (existsSync(rootsFile) ? (JSON.parse(readFileSync(rootsFile, 'utf8')) as { roots: string[] }).roots : null);
  /** What the api writes when you save roots in Settings. */
  const saveInSettings = (roots: string[]) => {
    mkdirSync(join(repo, 'state', 'api-settings'), { recursive: true });
    writeFileSync(rootsFile, `${JSON.stringify({ roots, updatedAt: '2026-10-24T00:00:00.000Z' }, null, 2)}\n`);
  };
  const runFailing = async (env: Record<string, string> = {}, args: string[] = []) => {
    try {
      await run(env, undefined, args);
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

test('PROJECTS_DIRS=~/code on a first run writes it into .env and the roots file, and the override mounts exactly it', async () => {
  const s = sandbox();
  const out = await s.run({ PROJECTS_DIRS: '~/code' });
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
  expect(await s.run()).toContain('.env exists; its project folders are unchanged.');
  expect([s.env(), readFileSync(s.override, 'utf8'), readFileSync(s.rootsFile, 'utf8')]).toEqual(before);
});

test('several folders: all of them in .env, and the generated override mounts them', async () => {
  const s = sandbox();
  await s.run({ PROJECTS_DIRS: '~/code, ~/work' });
  expect(s.value('PROJECTS_DIRS')).toBe(`${join(s.home, 'code')},${join(s.home, 'work')}`);
  const o = readFileSync(s.override, 'utf8');
  expect(o).toContain(`'${join(s.home, 'work')}:/roots/2:ro'`);
});

test('creates the transcript folders Docker would create as root, honouring CLAUDE_PROJECTS_DIR', async () => {
  const s = sandbox();
  const elsewhere = join(s.home, 'elsewhere', 'claude-projects');
  await s.run({ PROJECTS_DIRS: '~/code', CLAUDE_PROJECTS_DIR: elsewhere });
  expect(existsSync(elsewhere)).toBe(true);
  expect(existsSync(join(s.home, '.claude', 'projects'))).toBe(false);
  expect(existsSync(join(s.home, '.codex', 'sessions'))).toBe(true);
  // Only the sessions folder: no config or login, which is what install-agent.sh takes as Codex being installed.
  expect(existsSync(join(s.home, '.codex', 'config.toml'))).toBe(false);
  expect(existsSync(join(s.home, '.codex', 'auth.json'))).toBe(false);
});

test('Linux with a uid other than 1000: a new .env runs the containers as you; an existing one is told how', async () => {
  const s = sandbox({ linuxUid: 1234 });
  const out = await s.run({ PROJECTS_DIRS: '~/code' });
  expect(s.value('HOST_UID')).toBe('1234');
  expect(s.value('HOST_GID')).toBe('1235');
  expect(out).toContain('containers run as uid 1234');

  const old = sandbox({ linuxUid: 1234 });
  writeFileSync(join(old.repo, '.env'), `NEO4J_PASSWORD=x\nPROJECTS_DIR=${join(old.home, 'code')}\n`);
  const said = await old.run();
  expect(said).toContain('HOST_UID=1234');
  expect(said).toContain('HOST_GID=1235');
  // Kept as it was, apart from PROJECTS_DIRS saying what is mounted (PROJECTS_DIR, from an older version, is read once).
  expect(old.env()).toBe(`NEO4J_PASSWORD=x\nPROJECTS_DIR=${join(old.home, 'code')}\nPROJECTS_DIRS=${join(old.home, 'code')}\n`);

  // uid 1000, or not Linux: nothing to set.
  const mac = sandbox();
  await mac.run({ PROJECTS_DIRS: '~/code' });
  expect(mac.value('HOST_UID')).toBe('');
});

const both = '{"models":[{"name":"gemma4:latest"},{"name":"nomic-embed-text:latest"}]}';

test('without a terminal it only reports: no pulls, no token question, no start, and .env untouched', async () => {
  const s = sandbox({ tags: '{"models":[]}', claude: true });
  const out = await s.run({ PROJECTS_DIRS: '~/code' });
  expect(out).toContain('ollama: gemma4 is missing');
  expect(out).toContain('next: docker compose up -d --build');
  expect(s.ran()).toBe('');
  expect(s.value('CLAUDE_CODE_OAUTH_TOKEN')).toBe('');
});

test('asked in a terminal, it pulls only the missing models, from the Ollama it checked', async () => {
  const s = sandbox({ tags: '{"models":[{"name":"nomic-embed-text:latest"}]}' });
  // Pull, then decline API, owner and operator credentials, then decline starting.
  await s.run({ PROJECTS_DIRS: '~/code' }, 'y\nn\nn\nn\nn\n');
  expect(s.ran()).toBe('OLLAMA_HOST=http://localhost:11434 ollama pull gemma4\n');
});

test('a pasted Claude token goes into the existing .env, in place, never printed, and the file stays private', async () => {
  const s = sandbox({ tags: both, claude: true });
  await s.run({ PROJECTS_DIRS: '~/code' });
  const token = 'sk-ant-oat01-' + 'abcDEF123_-xyz';
  const out = await s.run({}, `${token}\nn\n`);
  expect(s.value('CLAUDE_CODE_OAUTH_TOKEN')).toBe(token);
  expect(s.env().match(/^CLAUDE_CODE_OAUTH_TOKEN=/gm)).toHaveLength(1);
  expect(out).not.toContain(token);
  expect(out).toContain('post-mortems now run on Claude');
  expect(readFileSync(join(s.repo, '.env.example'), 'utf8').split('\n').length).toBe(s.env().split('\n').length);
  // Already set: not asked again (the next answer is taken by the start question).
  expect(await s.run({}, 'n\n')).not.toContain('Paste');
});

test('a token with other characters is refused and .env keeps no token', async () => {
  const s = sandbox({ tags: both, claude: true });
  await s.run({ PROJECTS_DIRS: '~/code' });
  const out = await s.run({}, 'not a token; rm -rf\nn\n');
  expect(out).toContain('that does not look like a token');
  expect(s.value('CLAUDE_CODE_OAUTH_TOKEN')).toBe('');
});

test('Enter skips the token; no claude on PATH means no question', async () => {
  const s = sandbox({ tags: both, claude: true });
  await s.run({ PROJECTS_DIRS: '~/code' });
  await s.run({}, '\nn\n');
  expect(s.value('CLAUDE_CODE_OAUTH_TOKEN')).toBe('');
  const none = sandbox({ tags: both });
  expect(await none.run({ PROJECTS_DIRS: '~/code' }, 'n\n')).not.toContain('Paste');
});

test('yes to starting: compose up, wait until it answers, then connect the agents', async () => {
  const s = sandbox({ tags: both });
  const out = await s.run({ PROJECTS_DIRS: '~/code' }, 'n\ny\ny\n');
  expect(s.ran()).toBe('docker compose -p feedback-graph up -d --build\ninstall-agent \n');
  expect(out).toContain('running: http://localhost:8787');
});

test('STORE=postgres without the profile set: the start includes the bundled database', async () => {
  const s = sandbox({ tags: both });
  // Decline API, owner and operator credentials; start, then do not connect agents.
  await s.run({ PROJECTS_DIRS: '~/code', STORE: 'postgres' }, 'n\nn\nn\ny\nn\n');
  expect(s.ran()).toBe('docker compose -p feedback-graph --profile postgres up -d --build\n');
});

test('no project folder anywhere and no terminal: no guess, nothing mounted, and it says how to add one', async () => {
  const s = sandbox();
  const out = await s.run();
  expect(out).toContain('no project folders yet');
  expect(out).toContain('Settings');
  expect(s.value('PROJECTS_DIRS')).toBe('');
  expect(s.saved()).toBeNull(); // nothing was chosen, so nothing is recorded as chosen
  const o = readFileSync(s.override, 'utf8');
  expect(o).toContain(`PROJECT_ROOTS: ''`);
  expect(o).toContain(`HOST_PROJECT_ROOTS: ''`);
  expect(o).not.toContain('volumes:');
});

test('the roots saved in Settings win over .env, and are mounted as given, odd characters and all', async () => {
  const s = sandbox();
  await s.run({ PROJECTS_DIRS: '~/code' });
  const odd = join(s.home, "my 'odd' projects");
  mkdirSync(odd);
  s.saveInSettings([join(s.home, 'work'), odd]);
  const out = await s.run();
  expect(out).toContain('from Settings');
  expect(s.value('PROJECTS_DIRS')).toBe(`${join(s.home, 'work')},${odd}`);
  const o = readFileSync(s.override, 'utf8');
  expect(o).toContain(`'${join(s.home, 'work')}:/roots/1:ro'`);
  expect(o).toContain(`'${odd.replaceAll("'", "''")}:/roots/2:ro'`);
  expect(o).not.toContain(`${join(s.home, 'code')}:`);
});

test('removing every root in Settings unmounts them all', async () => {
  const s = sandbox();
  await s.run({ PROJECTS_DIRS: '~/code,~/work' });
  s.saveInSettings([]);
  await s.run();
  expect(s.value('PROJECTS_DIRS')).toBe('');
  const o = readFileSync(s.override, 'utf8');
  expect(o).toContain(`PROJECT_ROOTS: ''`);
  expect(o).not.toContain('/roots/');
});

test('a saved root that does not exist on this machine stops setup with a reason, before anything is remounted', async () => {
  const s = sandbox();
  await s.run({ PROJECTS_DIRS: '~/code' });
  const before = readFileSync(s.override, 'utf8');
  s.saveInSettings([join(s.home, 'nope')]);
  expect(await s.runFailing()).toContain(`${join(s.home, 'nope')} does not exist on this machine (from Settings)`);
  expect(readFileSync(s.override, 'utf8')).toBe(before);
});

test('PROJECTS_DIRS edited in .env after the roots were saved replaces them', async () => {
  const s = sandbox();
  await s.run({ PROJECTS_DIRS: '~/code' });
  const envFile = join(s.repo, '.env');
  writeFileSync(envFile, s.env().replace(/^PROJECTS_DIRS=.*$/m, `PROJECTS_DIRS=${join(s.home, 'work')}`));
  const later = new Date(Date.now() + 60_000);
  utimesSync(envFile, later, later);
  await s.run();
  expect(s.saved()).toEqual([join(s.home, 'work')]);
  expect(readFileSync(s.override, 'utf8')).toContain(`'${join(s.home, 'work')}:/roots/1:ro'`);
});

test('an install from before Settings keeps its PROJECTS_DIR, and the bundled examples are no longer mounted', async () => {
  const s = sandbox();
  writeFileSync(join(s.repo, '.env'), `NEO4J_PASSWORD=x\nPROJECTS_DIR=${join(s.home, 'code')}\nFEEDBACK_TOOL_DIR=${s.repo}\n`);
  // The override an older setup.sh generated for two folders plus the examples.
  writeFileSync(s.override, `# Generated by scripts/setup.sh from PROJECTS_DIRS in .env.\nx-roots: &roots\n  PROJECT_ROOTS: '/vibe,/roots/2,/examples'\n`);
  await s.run();
  expect(s.saved()).toEqual([join(s.home, 'code')]);
  const o = readFileSync(s.override, 'utf8');
  expect(o).toContain(`'${join(s.home, 'code')}:/roots/1:ro'`);
  expect(o).not.toContain('examples');
});

test('asked in a terminal: the folders typed are mounted; Enter mounts none, with no default taken', async () => {
  const s = sandbox({ tags: both });
  const out = await s.run({}, `~/work\nn\nn\nn\nn\n`);
  expect(out).toContain('Which folders hold your projects');
  expect(s.saved()).toEqual([join(s.home, 'work')]);
  expect(s.ran()).toBe(''); // the next answer was no to starting
  const none = sandbox({ tags: both });
  await none.run({}, '\nn\nn\nn\nn\n');
  expect(none.value('PROJECTS_DIRS')).toBe('');
  expect(none.saved()).toEqual([]);
});

test('folder suggestions name each folder once, however many names reach it (~/code and ~/Code on macOS)', async () => {
  const s = sandbox({ tags: both });
  symlinkSync(join(s.home, 'code'), join(s.home, 'projects'));
  const out = await s.run({}, `\nn\nn\nn\nn\n`);
  const after = out.split('Suggestions:\n')[1].split('\n');
  const listed = after.slice(0, after.findIndex((l) => !l.startsWith('  '))).map((l) => l.trim());
  expect(listed).toEqual([join(s.home, 'code'), join(s.home, 'work')]);
});

test('an override you wrote yourself is never touched', async () => {
  const s = sandbox();
  writeFileSync(s.override, 'services: {}\n');
  expect(await s.run({ PROJECTS_DIRS: '~/code' })).toContain('is your own');
  expect(readFileSync(s.override, 'utf8')).toBe('services: {}\n');
});

test('the roots file setup.sh writes reads back in the api exactly', async () => {
  const { rootsFile } = await import('./roots.ts');
  const s = sandbox();
  await s.run({ PROJECTS_DIRS: '~/code,~/work' });
  expect((await rootsFile(s.rootsFile).read())?.roots).toEqual([join(s.home, 'code'), join(s.home, 'work')]);
  await s.run({ PROJECTS_DIRS: '~/code,~/work' }); // and again: the empty list form too
  s.saveInSettings([]);
  await s.run();
  expect((await rootsFile(s.rootsFile).read())?.roots).toEqual([]);
});

test('structured output is probed with one real schema-constrained chat call to the classifier model', async () => {
  const s = sandbox({ tags: both });
  const out = await s.run({ PROJECTS_DIRS: '~/code' });
  expect(out).toContain('ollama: structured output works (gemma4)');
  const req = s.chatRequests();
  expect(req).toContain('/api/chat');
  expect(req).toContain('"format"');
  expect(req).toContain('"model":"gemma4"');
});

test('an Ollama without structured output stops setup loudly, with the fix (the official app, not the Homebrew formula)', async () => {
  const s = sandbox({ tags: both, chat: CHAT_501 });
  const out = await s.runFailing({ PROJECTS_DIRS: '~/code' });
  expect(out).toContain('FAIL ollama: structured output does not work');
  expect(out).toContain('structured output is unavailable');
  expect(out).toContain('official Ollama app');
  expect(out).toContain('brew services stop ollama');
  // .env and the mounts were still written: only the model check failed.
  expect(s.value('PROJECTS_DIRS')).toBe(join(s.home, 'code'));
});

test('no structured-output probe when the classifier runs on another provider, or its model is not pulled yet', async () => {
  const other = sandbox({ tags: both, chat: CHAT_501 });
  expect(await other.run({ PROJECTS_DIRS: '~/code', CLASSIFY_LLM: 'claude-cli' })).not.toContain('structured output');
  const missing = sandbox({ tags: '{"models":[{"name":"nomic-embed-text:latest"}]}', chat: CHAT_501 });
  expect(await missing.run({ PROJECTS_DIRS: '~/code' })).not.toContain('FAIL');
  expect(missing.chatRequests()).toBe('');
});

test('--pull-models pulls the missing models without a terminal; --projects is PROJECTS_DIRS', async () => {
  const s = sandbox({ tags: '{"models":[{"name":"nomic-embed-text:latest"}]}' });
  await s.run({}, undefined, ['--projects', '~/code,~/work', '--pull-models']);
  expect(s.ran()).toBe('OLLAMA_HOST=http://localhost:11434 ollama pull gemma4\n');
  expect(s.saved()).toEqual([join(s.home, 'code'), join(s.home, 'work')]);
});

test('--yes answers yes to every question without a terminal: pull, start, connect the agents; nothing is read from stdin', async () => {
  const s = sandbox({ tags: '{"models":[{"name":"nomic-embed-text:latest"}]}', claude: true });
  const out = await s.run({}, undefined, ['--yes', '--projects', '~/code']);
  expect(s.ran()).toBe('OLLAMA_HOST=http://localhost:11434 ollama pull gemma4\ndocker compose -p feedback-graph up -d --build\ninstall-agent \n');
  expect(out).not.toContain('Paste');
  expect(out).toContain('running: http://localhost:8787');
});

test('the --*-file flags put a secret a person wrote into .env, private, and never print it', async () => {
  const s = sandbox({ tags: both });
  const gh = 'g'.repeat(36);
  const lin = 'l'.repeat(40);
  const claude = 'sk-ant-' + 'c'.repeat(20) + '-_.x';
  const out = await s.run({}, undefined, [
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
  await s.run({}, undefined, ['--github-token-file', s.secretFile('gh2', 'h'.repeat(36))]);
  expect(s.value('GITHUB_TOKEN')).toBe('h'.repeat(36));
  expect(s.env().match(/^GITHUB_TOKEN=/gm)).toHaveLength(1);
});

test('a secret file that is missing, empty or holds other characters stops setup, and .env keeps no value from it', async () => {
  const s = sandbox({ tags: both });
  await s.run({ PROJECTS_DIRS: '~/code' });
  expect(await s.runFailing({}, ['--linear-key-file', join(s.home, 'nope')])).toContain('cannot read');
  expect(await s.runFailing({}, ['--linear-key-file', s.secretFile('empty', '\n')])).toContain('is empty');
  const bad = 'x'.repeat(10) + ' $(rm -rf ~)';
  const out = await s.runFailing({}, ['--linear-key-file', s.secretFile('bad', bad)]);
  expect(out).toContain('does not look like a key');
  expect(out).not.toContain(bad);
  expect(s.value('LINEAR_API_KEY')).toBe('');
});

test('an unknown flag, or a flag missing its value, says how to use it', async () => {
  const s = sandbox();
  expect(await s.runFailing({}, ['--frobnicate'])).toContain('usage:');
  expect(await s.runFailing({}, ['--projects'])).toContain('--projects needs a value');
});

test('the operator token is generated only with --yes or a yes answer, never printed, and kept on re-runs', async () => {
  const s = sandbox({ tags: both });
  // No terminal, no --yes: not asked, not made.
  await s.run({ PROJECTS_DIRS: '~/code' });
  expect(s.value('FG_OPERATOR_TOKEN')).toBe('');
  // Asked: no keeps it empty.
  await s.run({}, 'n\nn\nn\n');
  expect(s.value('FG_OPERATOR_TOKEN')).toBe('');
  // Asked: yes makes one (48 hex characters), mentioned but not printed.
  const out = await s.run({}, 'n\nn\ny\nn\n');
  const token = s.value('FG_OPERATOR_TOKEN')!;
  expect(token).toMatch(/^[0-9a-f]{48}$/);
  expect(out).toContain('FG_OPERATOR_TOKEN saved to .env');
  expect(out).not.toContain(token);
  expect(statSync(join(s.repo, '.env')).mode & 0o777).toBe(0o600);
  // Set already: not asked again, and --yes keeps it.
  await s.run({}, undefined, ['--yes']);
  expect(s.value('FG_OPERATOR_TOKEN')).toBe(token);
  const fresh = sandbox({ tags: both });
  await fresh.run({}, undefined, ['--yes', '--projects', '~/code']);
  expect(fresh.value('FG_OPERATOR_TOKEN')).toMatch(/^[0-9a-f]{48}$/);
}, SCRIPT_TEST_TIMEOUT_MS);

test('--yes --enable-auth explicitly upgrades an existing tokenless install non-interactively', async () => {
  const s = sandbox({ tags: both });
  await s.run({ PROJECTS_DIRS: '~/code' });
  expect([s.value('API_TOKEN'), s.value('FG_OWNER_TOKEN'), s.value('FG_OPERATOR_TOKEN')]).toEqual(['', '', '']);
  const out = await s.run({}, undefined, ['--yes', '--enable-auth']);
  for (const key of ['API_TOKEN', 'FG_OWNER_TOKEN', 'FG_OPERATOR_TOKEN']) expect(s.value(key)).toMatch(/^[0-9a-f]{48}$/);
  expect(out).toContain('API_TOKEN saved to .env');
  expect(out).not.toContain(String(s.value('API_TOKEN')));
}, SCRIPT_TEST_TIMEOUT_MS);

test('--enable-auth replaces a token of only blanks, which the api reads as none, so agents get one that works', async () => {
  const s = sandbox({ tags: both });
  await s.run({ PROJECTS_DIRS: '~/code' });
  writeFileSync(join(s.repo, '.env'), s.env().replace(/^API_TOKEN=.*$/m, 'API_TOKEN="   "').replace(/^FG_OWNER_TOKEN=.*$/m, "FG_OWNER_TOKEN=' '"));
  const out = await s.run({}, undefined, ['--yes', '--enable-auth']);
  for (const key of ['API_TOKEN', 'FG_OWNER_TOKEN', 'FG_OPERATOR_TOKEN']) expect(s.value(key)).toMatch(/^[0-9a-f]{48}$/);
  expect(out).toContain('API_TOKEN saved to .env');
}, SCRIPT_TEST_TIMEOUT_MS);

// ── Two installs on one machine ────────────────────────────────────────

const PORTS = '127.0.0.1:8787->8787/tcp, 127.0.0.1:7476->7474/tcp, 127.0.0.1:7689->7687/tcp';

test('another folder\'s install is running: a new .env gets its own instance name and ports, and says why', async () => {
  const s = sandbox({ containers: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph', ports: PORTS }] });
  const out = await s.run({ PROJECTS_DIRS: '~/code' });
  expect(s.value('FG_INSTANCE')).toBe('feedback-graph-repo');
  expect([s.value('API_PORT'), s.value('NEO4J_HTTP_PORT'), s.value('NEO4J_BOLT_PORT'), s.value('POSTGRES_PORT'), s.value('OLLAMA_PORT')]).toEqual(['8797', '7486', '7699', '5444', '11445']);
  expect(out).toContain('/srv/acme/feedback-graph');
  expect(out).toContain('OLLAMA_PORT=11445');
  expect(out).toMatch(/FG_INSTANCE=feedback-graph-repo/);
  expect(out).toMatch(/http:\/\/localhost:8797/);
  // Re-running keeps them.
  await s.run();
  expect(s.value('FG_INSTANCE')).toBe('feedback-graph-repo');
  expect(s.value('API_PORT')).toBe('8797');
});

test('a leftover one-off container (a killed backup\'s, with no folder label) does not hide another folder\'s install', async () => {
  const s = sandbox({ containers: [{ project: 'feedback-graph', dir: '', oneoff: true }, { project: 'feedback-graph', dir: '/srv/acme/feedback-graph', ports: PORTS }] });
  const out = await s.run({ PROJECTS_DIRS: '~/code' });
  expect(s.value('FG_INSTANCE')).toBe('feedback-graph-repo');
  expect(out).toContain('/srv/acme/feedback-graph');
});

test('a port exported in the shell is written to .env, so fg, doctor and install-agent reach what compose started', async () => {
  const s = sandbox({ containers: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph', ports: PORTS }] });
  const out = await s.run({ PROJECTS_DIRS: '~/code', API_PORT: '9320' });
  expect(s.value('API_PORT')).toBe('9320');
  expect(out).toContain('API_PORT=9320 from your shell written to .env (it said 8797)');
  // Unchanged on a re-run with the same shell, and kept after the shell forgets it.
  expect(await s.run({ API_PORT: '9320' })).not.toContain('from your shell');
  await s.run();
  expect(s.value('API_PORT')).toBe('9320');
  expect(await s.runFailing({ API_PORT: '93x0' })).toContain('not a port number');
});

test('--demo: a first run with no history mounts examples/, selects demo-shop, seeds it once started and says what to run', async () => {
  const s = sandbox({ tags: both });
  mkdirSync(join(s.repo, 'examples', 'demo-shop'), { recursive: true });
  // The first seed fails as a cold embedding model's 504 did; the second answers.
  writeFileSync(join(s.repo, 'scripts', 'fg'), `#!/bin/sh\necho "fg $*" >> '${join(s.base, 'calls')}'\n[ -f '${join(s.base, 'seeded')}' ] || { touch '${join(s.base, 'seeded')}'; echo 'fg: POST /api/demo/seed: 504' >&2; exit 1; }\n`);
  chmodSync(join(s.repo, 'scripts', 'fg'), 0o755);
  const out = await s.run({}, undefined, ['--yes', '--demo', '--skip-agents']);
  expect(s.value('PROJECTS_DIRS')).toBe(join(s.repo, 'examples'));
  expect(s.value('INGEST_PROJECTS')).toBe('demo-shop');
  expect(s.saved()).toEqual([join(s.repo, 'examples')]);
  expect(s.ran()).toMatch(/up -d --build\nfg demo seed\nfg demo seed\n$/);
  expect(out).toMatch(/fg demo context[\s\S]*fg demo check[\s\S]*fg activity --project demo-shop/);
  // A re-run keeps the folders and the selection it already had, adding demo-shop once.
  mkdirSync(join(s.home, 'code', 'x'));
  await s.run({ PROJECTS_DIRS: '~/code' }, undefined, ['--select', 'x', '--demo']);
  expect(s.value('PROJECTS_DIRS')).toBe(`${join(s.home, 'code')},${join(s.repo, 'examples')}`);
  expect(s.value('INGEST_PROJECTS')).toBe('demo-shop,x');
});

test('--demo on a tokenless install: a 403 is not asked again, and says the demo needs --enable-auth', async () => {
  const s = sandbox({ tags: both });
  mkdirSync(join(s.repo, 'examples', 'demo-shop'), { recursive: true });
  writeFileSync(join(s.repo, 'scripts', 'fg'), `#!/bin/sh\necho "fg $*" >> '${join(s.base, 'calls')}'\necho 'fg: POST /api/demo/seed: 403 this install has no owner token, so owner actions are read-only' >&2; exit 1\n`);
  chmodSync(join(s.repo, 'scripts', 'fg'), 0o755);
  // It says why, and how to start again, then exits 1: a script running setup must not read the demo as seeded.
  const out = await s.runFailing({}, ['--yes', '--demo', '--skip-agents']);
  expect(s.ran()).toMatch(/up -d --build\nfg demo seed\n$/);
  expect(out).toMatch(/open http:\/\/localhost:\d+: /);
  expect(out).not.toMatch(/asking again/);
  expect(out).toContain('demo: this install has no tokens, so it is read-only and cannot seed the demo; run ./scripts/setup.sh --yes --enable-auth --demo');
  expect(out).not.toMatch(/fg demo context/);
});

test('a setup already running in this folder is waited for, not refused; a lock left by a dead setup is taken over', async () => {
  const s = sandbox();
  const lock = join(s.repo, '.host', 'setup.lock');
  mkdirSync(lock, { recursive: true });
  // A live holder (this test's own process), released only once setup says it is waiting: setup then takes it and finishes.
  writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
  const setup = spawn('bash', [join(s.repo, 'scripts', 'setup.sh')], { env: { PATH: `${join(s.base, 'bin')}:/usr/bin:/bin`, HOME: s.home, PROJECTS_DIRS: '~/code' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let released = false;
  for (const stream of [setup.stdout, setup.stderr]) stream.setEncoding('utf8').on('data', (d: string) => {
    out += d;
    if (released || !out.includes('waiting for another Feedback Graph setup')) return;
    released = true;
    rmSync(lock, { recursive: true });
  });
  const code = await new Promise((resolve) => setup.on('close', resolve));
  expect(code, out).toBe(0);
  expect(out).toContain(`waiting for another Feedback Graph setup (pid ${process.pid})`);
  expect(out).toContain('wrote .env');
  expect(existsSync(lock)).toBe(false);
  // A lock whose pid no longer runs does not block.
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), '999999\n');
  await s.run();
  expect(existsSync(lock)).toBe(false);
});

test('setups of different installs do not block each other, and nothing is kept in TMPDIR', async () => {
  const a = sandbox();
  const b = sandbox();
  // a's lock is held by a live process; b, another folder, still runs at once.
  mkdirSync(join(a.repo, '.host', 'setup.lock'), { recursive: true });
  writeFileSync(join(a.repo, '.host', 'setup.lock', 'pid'), `${process.pid}\n`);
  // So is the machine-wide lock 0.7.5 kept in TMPDIR, which no longer means anything.
  const tmp = join(b.base, 'tmp');
  mkdirSync(join(tmp, `feedback-graph-setup-ports-${process.getuid!()}.lock`), { recursive: true });
  writeFileSync(join(tmp, `feedback-graph-setup-ports-${process.getuid!()}.lock`, 'pid'), `${process.pid}\n`);
  await b.run({ PROJECTS_DIRS: '~/code', TMPDIR: tmp, HOME: a.home });
  expect(b.value('PROJECTS_DIRS')).toBe(join(a.home, 'code'));
  expect(readdirSync(tmp)).toEqual([`feedback-graph-setup-ports-${process.getuid!()}.lock`]);
});

test('a second install avoids the ports a stopped install reserved in its .env: two setups that never start both get their own', async () => {
  const a = sandbox();
  const b = sandbox();
  // Same user (HOME); neither install is running, so Docker publishes nothing.
  await a.run({ PROJECTS_DIRS: '~/code', FG_INSTANCE: 'feedback-graph-a' });
  expect(a.value('API_PORT')).toBe('8797');
  await b.run({ PROJECTS_DIRS: '~/code', FG_INSTANCE: 'feedback-graph-b', HOME: a.home });
  expect([b.value('API_PORT'), b.value('NEO4J_HTTP_PORT'), b.value('NEO4J_BOLT_PORT'), b.value('POSTGRES_PORT'), b.value('OLLAMA_PORT')]).toEqual(['8807', '7496', '7709', '5454', '11455']);
  // A name another install's .env holds is skipped as well.
  const c = sandbox();
  await c.run({ PROJECTS_DIRS: '~/code', HOME: a.home, FG_INSTANCE: 'feedback-graph-a' });
  expect([c.value('FG_INSTANCE'), c.value('API_PORT')]).toEqual(['feedback-graph-a-2', '8817']);
});

test('the install running is this folder\'s own, or none is: the name and ports stay the defaults (existing volumes keep their names)', async () => {
  const own = sandbox();
  writeFileSync(join(own.base, 'containers'), `feedback-graph\t${own.repo}\t${PORTS}\n`);
  await own.run({ PROJECTS_DIRS: '~/code' });
  expect(own.value('FG_INSTANCE')).toBe('');
  expect(own.value('API_PORT')).toBe('8787');
  expect(own.value('OLLAMA_PORT')).toBe('');
  const none = sandbox();
  await none.run({ PROJECTS_DIRS: '~/code' });
  expect(none.value('FG_INSTANCE')).toBe('');
  expect(none.value('POSTGRES_PORT')).toBe('5434');
});

test('a name or ports another install already took are skipped', async () => {
  const s = sandbox({ containers: [
    { project: 'feedback-graph', dir: '/srv/acme/feedback-graph', ports: PORTS },
    { project: 'feedback-graph-repo', dir: '/srv/demo-shop/repo', ports: '127.0.0.1:8797->8787/tcp, 127.0.0.1:5444->5432/tcp' },
  ] });
  await s.run({ PROJECTS_DIRS: '~/code' });
  expect(s.value('FG_INSTANCE')).toBe('feedback-graph-repo-2');
  expect([s.value('API_PORT'), s.value('NEO4J_HTTP_PORT'), s.value('NEO4J_BOLT_PORT'), s.value('POSTGRES_PORT'), s.value('OLLAMA_PORT')]).toEqual(['8807', '7496', '7709', '5454', '11455']);
});

test('the bundled ollama profile is reached on its own host port: OLLAMA_PORT, 11435 when unset', async () => {
  const s = sandbox({ tags: '{"models":[{"name":"nomic-embed-text:latest"}]}' });
  await s.run({ PROJECTS_DIRS: '~/code', OLLAMA_URL: 'http://ollama:11434' }, 'y\nn\nn\n');
  expect(s.ran()).toContain('OLLAMA_HOST=http://localhost:11435 ollama pull gemma4\n');
  const other = sandbox({ tags: '{"models":[{"name":"nomic-embed-text:latest"}]}' });
  await other.run({ PROJECTS_DIRS: '~/code', OLLAMA_URL: 'http://ollama:11434', OLLAMA_PORT: '11445' }, 'y\nn\nn\n');
  expect(other.ran()).toContain('OLLAMA_HOST=http://localhost:11445 ollama pull gemma4\n');
});

test('a port another container publishes for the bundled ollama is skipped too', async () => {
  const s = sandbox({ containers: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph', ports: `${PORTS}, 127.0.0.1:11445->11434/tcp` }] });
  await s.run({ PROJECTS_DIRS: '~/code' });
  expect([s.value('API_PORT'), s.value('OLLAMA_PORT')]).toEqual(['8807', '11455']);
});

test('FG_INSTANCE given is used as it is; an existing .env is never renamed, only told how', async () => {
  const given = sandbox({ containers: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph', ports: PORTS }] });
  await given.run({ PROJECTS_DIRS: '~/code', FG_INSTANCE: 'fg-staging' });
  expect(given.value('FG_INSTANCE')).toBe('fg-staging');
  const old = sandbox({ containers: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph', ports: PORTS }] });
  writeFileSync(join(old.repo, '.env'), `NEO4J_PASSWORD=x\nPROJECTS_DIRS=${join(old.home, 'code')}\n`);
  const said = await old.run();
  expect(old.value('FG_INSTANCE')).toBeUndefined();
  expect(said).toContain('/srv/acme/feedback-graph');
  expect(said).toMatch(/FG_INSTANCE=/);
  const bad = sandbox();
  expect(await bad.runFailing({ PROJECTS_DIRS: '~/code', FG_INSTANCE: 'Has Spaces' })).toMatch(/FG_INSTANCE/);
});

test('--help documents a second install: FG_INSTANCE, the ports it moves (OLLAMA_PORT too) and --select', async () => {
  const s = sandbox();
  const help = await s.run({}, undefined, ['--help']);
  for (const k of ['FG_INSTANCE', 'API_PORT', 'NEO4J_HTTP_PORT', 'NEO4J_BOLT_PORT', 'POSTGRES_PORT', 'OLLAMA_PORT', '--select', 'INGEST_PROJECTS']) expect(help).toContain(k);
});

test('a hand-written .env under the name another folder\'s install runs as is never started, nor are agents connected', async () => {
  const s = sandbox({ containers: [{ project: 'feedback-graph', dir: '/srv/acme/feedback-graph', ports: PORTS }] });
  writeFileSync(join(s.repo, '.env'), `NEO4J_PASSWORD=x\nPROJECTS_DIRS=${join(s.home, 'code')}\n`);
  // --yes would start it and run install-agent.sh: both would take over the other folder's install.
  const out = await s.runFailing({}, ['--yes']);
  expect(s.ran()).not.toContain('docker compose');
  expect(s.ran()).not.toContain('install-agent');
  expect(out).toMatch(/not starting/i);
  expect(out).toContain('/srv/acme/feedback-graph');
  expect(out).toMatch(/FG_INSTANCE=feedback-graph-repo/);
  // Without --yes it says the same instead of the usual "next: docker compose up", and nothing fails.
  const quiet = await s.run();
  expect(quiet).toMatch(/not starting/i);
  expect(quiet).not.toMatch(/next: docker compose up/);
  // Its own folder's containers are no reason to refuse.
  const own = sandbox();
  writeFileSync(join(own.base, 'containers'), `feedback-graph\t${own.repo}\t${PORTS}\n`);
  await own.run({ PROJECTS_DIRS: '~/code' }, undefined, ['--yes']);
  expect(own.ran()).toContain('docker compose -p feedback-graph up -d --build');
}, SCRIPT_TEST_TIMEOUT_MS);

test('--select seeds the projects read until a selection is made: INGEST_PROJECTS in .env, checked against the folders', async () => {
  const s = sandbox();
  for (const d of ['acme', 'demo-shop', '.hidden']) mkdirSync(join(s.home, 'code', d));
  const out = await s.run({}, undefined, ['--projects', '~/code', '--select', 'acme, demo-shop']);
  expect(s.value('INGEST_PROJECTS')).toBe('acme,demo-shop');
  expect(out).toMatch(/INGEST_PROJECTS=acme,demo-shop/);
  expect(out).toMatch(/until a selection is made/i);
  // A re-run (the stack already started once with nothing chosen) sets it the same way.
  await s.run({}, undefined, ['--select', 'demo-shop']);
  expect(s.value('INGEST_PROJECTS')).toBe('demo-shop');
  // A key that is no folder under the project folders is refused, and .env keeps what it had.
  expect(await s.runFailing({}, ['--select', 'nope'])).toMatch(/nope.*not a folder under your project folders/);
  expect(s.value('INGEST_PROJECTS')).toBe('demo-shop');
  expect(await s.runFailing({}, ['--select', 'a b'])).toMatch(/--select/);
  // A nested key (a__b is a/b) whose parts climb out of the project folders, or name a hidden folder, is refused.
  mkdirSync(join(s.home, 'outside'));
  for (const k of ['acme__..__..__outside', '..__outside', 'acme__.hidden', 'acme____demo-shop']) expect(await s.runFailing({}, ['--select', k])).toMatch(/--select/);
  expect(s.value('INGEST_PROJECTS')).toBe('demo-shop');
});

test('a first run in a terminal offers to choose the projects to read from the folders found; Enter leaves it to Settings', async () => {
  const s = sandbox();
  for (const d of ['acme', 'demo-shop']) mkdirSync(join(s.home, 'code', d));
  // Answers: projects to read, operator token (n), start (n).
  const out = await s.run({ PROJECTS_DIRS: '~/code' }, 'demo-shop\nn\nn\n');
  expect(out).toContain('acme');
  expect(s.value('INGEST_PROJECTS')).toBe('demo-shop');
  const later = sandbox();
  mkdirSync(join(later.home, 'code', 'acme'));
  await later.run({ PROJECTS_DIRS: '~/code' }, '\nn\nn\n');
  expect(later.value('INGEST_PROJECTS')).toBe('');
  // Not asked again on a re-run: the selection may already be made, in Settings.
  expect(await later.run({}, 'n\nn\n')).not.toMatch(/Which of these projects/);
});

test('--yes alone never opts in to relaxed runner system paths', async () => {
  const s = sandbox();
  await s.run({}, undefined, ['--yes', '--projects', '~/code']);
  expect(existsSync(join(s.repo, 'docker-compose.runner-procfs.yml'))).toBe(false);
  expect(s.value('COMPOSE_FILE')).toBeUndefined();
});

test('explicit procfs opt-in generates only a separate runner override and preserves existing Compose files', async () => {
  const s = sandbox();
  await s.run({}, undefined, ['--yes', '--projects', '~/code']);
  writeFileSync(join(s.repo, '.env'), `${s.env()}COMPOSE_FILE=docker-compose.yml:custom.yml:docker-compose.override.yml\n`);
  // The shell's Compose settings are never this install's: only .env's count.
  const out = await s.run({ COMPOSE_FILE: 'elsewhere.yml', COMPOSE_PROJECT_NAME: 'another-install' }, undefined, ['--runner-procfs-compat', '--yes']);
  const compatibility = readFileSync(join(s.repo, 'docker-compose.runner-procfs.yml'), 'utf8');
  expect(compatibility).toContain('  codex-runner:');
  expect(compatibility).toContain('systempaths=unconfined');
  expect(compatibility).not.toContain('privileged');
  expect(compatibility).not.toContain('cap_add');
  expect(readFileSync(s.override, 'utf8')).not.toContain('systempaths');
  expect(s.value('COMPOSE_FILE')).toBe('docker-compose.yml:custom.yml:docker-compose.override.yml:docker-compose.runner-procfs.yml');
  expect(out.indexOf('removes an outer Docker filesystem defense')).toBeLessThan(out.indexOf('Saved runner procfs opt-in'));
  await s.run({}, undefined, ['--runner-procfs-compat', '--yes']);
  expect(s.value('COMPOSE_FILE')?.split(':').filter(f => f === 'docker-compose.runner-procfs.yml')).toHaveLength(1);
});

test('explicit procfs flag without confirmation leaves Docker protections unchanged', async () => {
  const s = sandbox();
  const out = await s.run({ PROJECTS_DIRS: '~/code' }, undefined, ['--runner-procfs-compat']);
  expect(out).toContain('Runner procfs compatibility was not enabled.');
  expect(existsSync(join(s.repo, 'docker-compose.runner-procfs.yml'))).toBe(false);
  expect(s.value('COMPOSE_FILE')).toBeUndefined();
});

test('procfs opt-in refuses to overwrite an owner-authored override', async () => {
  const s = sandbox();
  const file = join(s.repo, 'docker-compose.runner-procfs.yml');
  writeFileSync(file, '# owner settings\nservices: {}\n');
  expect(await s.runFailing({ PROJECTS_DIRS: '~/code' }, ['--runner-procfs-compat', '--yes'])).toContain('refusing to overwrite');
  expect(readFileSync(file, 'utf8')).toBe('# owner settings\nservices: {}\n');
  expect(s.value('COMPOSE_FILE')).toBeUndefined();
});


test('isolated setup can skip all agent registration and real transcript/auth mounts', async () => {
  const s = sandbox();
  mkdirSync(join(s.home, '.codex'), { recursive: true });
  writeFileSync(join(s.home, '.codex', 'auth.json'), 'PLANTED_PRIVATE_LOGIN');
  await s.run({}, undefined, ['--yes', '--skip-agents', '--no-transcripts']);
  expect(s.ran()).not.toContain('install-agent');
  expect(s.value('CODEX_AUTH_FILE')).toBe('');
  expect(s.value('CLAUDE_PROJECTS_DIR')).toBe(join(s.repo, '.host/empty-claude'));
  expect(s.value('CODEX_SESSIONS_DIR')).toBe(join(s.repo, '.host/empty-codex'));
  expect(readFileSync(join(s.home, '.codex', 'auth.json'), 'utf8')).toBe('PLANTED_PRIVATE_LOGIN');
});

test('no bind-mount source is in state/, where the worker could swap it for a link to a host folder before a restart', async () => {
  // --no-transcripts before 0.7.6 left the empty folders in state/: a rerun moves them to .host/, which no container writes.
  const s = sandbox();
  await s.run({}, undefined, ['--yes', '--skip-agents', '--no-transcripts']);
  const env = readFileSync(join(s.repo, '.env'), 'utf8');
  writeFileSync(join(s.repo, '.env'), env.replace(/^CLAUDE_PROJECTS_DIR=.*$/m, `CLAUDE_PROJECTS_DIR=${join(s.repo, 'state/empty-claude')}`).replace(/^CODEX_SESSIONS_DIR=.*$/m, `CODEX_SESSIONS_DIR=${join(s.repo, 'state/empty-codex')}`));
  await s.run({}, undefined, ['--yes', '--skip-agents']);
  expect(s.value('CLAUDE_PROJECTS_DIR')).toBe(join(s.repo, '.host/empty-claude'));
  expect(s.value('CODEX_SESSIONS_DIR')).toBe(join(s.repo, '.host/empty-codex'));

  // Any other folder or login file under state/ is refused, through a link or a folder not made yet as well.
  const host = join(s.base, 'host-folder');
  mkdirSync(host);
  symlinkSync(join(s.repo, 'state'), join(s.base, 'state-link'));
  for (const [key, value] of [['CLAUDE_PROJECTS_DIR', join(s.repo, 'state/x')], ['CODEX_SESSIONS_DIR', join(s.base, 'state-link/new/y')], ['CODEX_AUTH_FILE', join(s.repo, 'state/settings/auth.json')]]) {
    const out = await s.runFailing({ [key]: value }, ['--yes', '--skip-agents']);
    expect(out).toContain(`${key}=${value} is inside this install's state/ folder`);
  }
  expect(await s.runFailing({ PROJECTS_DIRS: join(s.repo, 'state', 'settings') }, ['--yes', '--skip-agents'])).toContain("is inside this install's state/ folder");
  // The Codex login placeholder is the one the worker mounts a second time.
  await s.run({ CODEX_AUTH_FILE: join(s.repo, 'state/codex-auth.json') }, undefined, ['--yes', '--skip-agents']);
});

test('an explicit fresh FG_INSTANCE gets separate ports even without a name collision', async () => {
  const s = sandbox();
  await s.run({ FG_INSTANCE: 'feedback-graph-pilot' });
  expect(s.value('FG_INSTANCE')).toBe('feedback-graph-pilot');
  expect(s.value('API_PORT')).toBe('8797');
  expect(s.value('NEO4J_HTTP_PORT')).toBe('7486');
});


test('new installs grant Codex login access only with an explicit provider and explicit file', async () => {
  const local = sandbox();
  await local.run({ CODEX_AUTH_FILE: '/private/explicit-auth.json' });
  expect(local.value('CODEX_AUTH_FILE')).toBe('');
  const codex = sandbox();
  const auth = codex.secretFile('auth.json', 'planted test login');
  await codex.run({ CODEX_AUTH_FILE: auth, COMPOSE_PROFILES: 'codex' });
  expect(codex.value('CODEX_AUTH_FILE')).toBe(auth);
});

test('a codex-cli model for any job, the learning loop\'s included, keeps the Codex login file of a new install', async () => {
  for (const job of ['CLASSIFY_LLM', 'POSTMORTEM_LLM', 'SCAN_LLM', 'DOCS_LLM', 'CHAT_LLM', 'SUMMARY_LLM', 'LOOP_LLM']) {
    const s = sandbox();
    const auth = s.secretFile('auth.json', 'planted test login');
    await s.run({ CODEX_AUTH_FILE: auth, [job]: 'codex-cli' });
    expect(s.value('CODEX_AUTH_FILE'), job).toBe(auth);
  }
});

test('procfs opt-in clears only the procfs reason: a network isolation failure in the same flag stays', async () => {
  const s = sandbox();
  const flag = join(s.repo, 'state', 'runner-control', 'codex-runner-disabled');
  mkdirSync(join(s.repo, 'state', 'runner-control'), { recursive: true });
  writeFileSync(flag, 'procfs: nested sandbox could not mount proc\nnetwork: runner reached a protected host or service endpoint\n');
  const out = await s.run({ PROJECTS_DIRS: '~/code' }, undefined, ['--runner-procfs-compat', '--yes']);
  expect(readFileSync(flag, 'utf8')).toBe('network: runner reached a protected host or service endpoint\n');
  expect(statSync(flag).mode & 0o777).toBe(0o600);
  expect(out).toContain('procfs compatibility does not clear its other isolation failure (network: runner reached');
  // A flag with only the procfs reason is cleared.
  writeFileSync(flag, 'procfs: nested sandbox could not mount proc\n');
  await s.run({}, undefined, ['--runner-procfs-compat', '--yes']);
  expect(existsSync(flag)).toBe(false);
});

test('--yes on an API-token install adds the owner token and says only what is true there', async () => {
  const s = sandbox();
  await s.run({ PROJECTS_DIRS: '~/code' });
  writeFileSync(join(s.repo, '.env'), s.env().replace(/^API_TOKEN=.*$/m, `API_TOKEN=${'a'.repeat(48)}`));
  const out = await s.run({}, undefined, ['--yes']);
  expect(s.value('FG_OWNER_TOKEN')).toMatch(/^[0-9a-f]{48}$/);
  expect(s.value('API_TOKEN')).toBe('a'.repeat(48));
  expect(out).toContain('FG_OWNER_TOKEN saved');
  expect(out).not.toMatch(/tokenless|never opts|rerun \.\/scripts\/install-agent|leaving it alone/);
  expect(out).toContain('no operator token added');
});

test('--yes on a tokenless install adds nothing and names the flag that does; --enable-auth --skip-agents warns about existing agents', async () => {
  const s = sandbox();
  await s.run({ PROJECTS_DIRS: '~/code' });
  const kept = await s.run({}, undefined, ['--yes']);
  expect(kept).toContain('no tokens added: --yes never opts a tokenless install into authentication');
  expect(kept).toContain('--yes --enable-auth');
  expect(kept).not.toContain('interactively');
  const upgraded = await s.run({}, undefined, ['--yes', '--enable-auth', '--skip-agents']);
  expect(upgraded).toMatch(/Agents registered before this have no API token: once the api restarts they get 401/);
  expect(upgraded).toContain('--skip-agents: run it yourself');
});

test('--enable-auth without a terminal or --yes fails and names the command that works', async () => {
  const s = sandbox();
  await s.run({ PROJECTS_DIRS: '~/code' });
  const out = await s.runFailing({}, ['--enable-auth']);
  expect(out).toContain('no terminal here, so nothing was');
  expect(out).toContain('./scripts/setup.sh --yes --enable-auth');
  expect(s.value('API_TOKEN')).toBeFalsy();
});

test('no setup lock is held while models are pulled or the stack is built', async () => {
  const s = sandbox({ tags: '{"models":[{"name":"nomic-embed-text:latest"}]}', claude: true });
  const bin = join(s.base, 'bin');
  // This folder's lock, or (0.7.5) the machine-wide one in TMPDIR.
  const tmp = join(s.base, 'tmp');
  mkdirSync(tmp);
  const locks = [join(s.repo, '.host', 'setup.lock'), join(tmp, `feedback-graph-setup-ports-${process.getuid!()}.lock`)];
  const note = (what: string) => locks.map((l) => `[ -d '${l}' ] && echo "${what} under ${l}" >> '${join(s.base, 'locked')}'`).join('; ');
  writeFileSync(join(bin, 'ollama'), `#!/bin/sh\n${note('pull')}\nexit 0\n`);
  copyFileSync(join(bin, 'docker'), join(bin, 'docker-stand-in'));
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\ncase "$*" in *" up "*) ${note('build')} ;; esac\nexec '${join(bin, 'docker-stand-in')}' "$@"\n`);
  await s.run({ TMPDIR: tmp }, undefined, ['--yes', '--projects', '~/code']);
  expect(s.ran()).toContain('docker compose -p feedback-graph up -d --build');
  expect(existsSync(join(s.base, 'locked')) ? readFileSync(join(s.base, 'locked'), 'utf8') : '').toBe('');
});

test('setup names the MCP server install-agent registers, and its last line says how to sign in', async () => {
  const s = sandbox();
  const out = await s.run({ PROJECTS_DIRS: '~/code', FG_INSTANCE: 'fg075-fresh' }, undefined, ['--yes', '--skip-agents']);
  expect(out).toContain('registers it as the MCP server feedback-graph-fg075-fresh');
  expect(out).toMatch(/running: http:\/\/localhost:8797 \(sign in: \.\/scripts\/fg signin prints a one-time link, or paste FG_OWNER_TOKEN from .*\/\.env; then Settings/);
  const named = sandbox();
  expect(await named.run({ PROJECTS_DIRS: '~/code', FG_INSTANCE: 'feedback-graph-pilot' })).toContain('registers it as the MCP server feedback-graph-pilot ');
});

test('with agents connected (the --yes default), the sign-in is said again on the last line, after install-agent.sh\'s output', async () => {
  const s = sandbox();
  writeFileSync(join(s.repo, 'scripts', 'install-agent.sh'), '#!/bin/sh\necho "Codex: registered feedback-graph"\necho "Codex: guidance up to date"\n');
  const out = await s.run({ PROJECTS_DIRS: '~/code' }, undefined, ['--yes']);
  const lines = out.trimEnd().split('\n');
  expect(lines.at(-1)).toMatch(/^open http:\/\/localhost:8787: sign in: \.\/scripts\/fg signin prints a one-time link/);
  expect(lines.at(-2)).toBe('Codex: guidance up to date');
  // With nothing printed after it, "running:" stays the last line and says it once.
  const skipped = await sandbox().run({ PROJECTS_DIRS: '~/code' }, undefined, ['--yes', '--skip-agents']);
  expect(skipped.trimEnd().split('\n').at(-1)).toMatch(/^running: /);
});

test('without the Compose plugin setup stops before writing .env or any token', async () => {
  const s = sandbox({ tags: both });
  writeFileSync(join(s.base, 'bin', 'docker'), '#!/bin/sh\n[ "$1" = compose ] && { echo "unknown command: docker compose" >&2; exit 1; }\nexit 0\n');
  expect(await s.runFailing({ PROJECTS_DIRS: '~/code' }, ['--yes'])).toContain('missing: docker compose');
  expect(existsSync(join(s.repo, '.env'))).toBe(false);
});

test('a folder suggestion is spelled as on disk (~/Code found by probing ~/code)', async () => {
  const s = sandbox({ tags: both });
  renameSync(join(s.home, 'code'), join(s.home, 'Code'));
  const out = await s.run({}, `\nn\nn\nn\nn\n`);
  const listed = out.split('Suggestions:\n')[1].split('\n').filter((l) => l.startsWith('  ')).map((l) => l.trim());
  expect(listed, out).toContain(join(s.home, 'Code'));
  expect(listed).not.toContain(join(s.home, 'code'));
});

test("the last line points at Settings only for what setup did not just do", async () => {
  const s = sandbox();
  mkdirSync(join(s.home, 'code', 'acme'));
  const chosen = await s.run({}, undefined, ['--yes', '--skip-agents', '--projects', '~/code', '--select', 'acme']);
  expect(chosen).toMatch(/running: http:\/\/localhost:8787 \([^)]*\)\n/);
  expect(chosen).not.toMatch(/running: .*then Settings/);
  const folders = await sandbox().run({}, undefined, ['--yes', '--skip-agents', '--projects', '~/code']);
  expect(folders).toMatch(/running: .*then Settings: choose the projects to read/);
  expect(folders).not.toMatch(/running: .*add project folders/);
});

test('roots in state/settings (the worker writes there) are moved only into a new api settings folder, never mounted later', async () => {
  // An install from before state/api-settings: its roots move there and are mounted.
  const old = sandbox();
  mkdirSync(join(old.repo, 'state', 'settings'), { recursive: true });
  writeFileSync(join(old.repo, 'state', 'settings', 'project-roots.json'), JSON.stringify({ roots: [join(old.home, 'code')] }));
  await old.run();
  expect(old.saved()).toEqual([join(old.home, 'code')]);
  expect(readFileSync(old.override, 'utf8')).toContain(`${join(old.home, 'code')}:/roots/1:ro`);
  expect(existsSync(join(old.repo, 'state', 'settings', 'project-roots.json'))).toBe(false);

  // Once it exists, a roots file left in state/settings is not a setting: the folder it names is not mounted.
  const s = sandbox();
  await s.run();
  const host = join(s.base, 'host-folder');
  mkdirSync(host);
  writeFileSync(join(s.repo, 'state', 'settings', 'project-roots.json'), JSON.stringify({ roots: [host] }));
  const out = await s.run();
  expect(out).not.toContain(host);
  expect(s.saved()).toBeNull();
  expect(readFileSync(s.override, 'utf8')).not.toContain(host);
});
