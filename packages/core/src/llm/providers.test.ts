import { expect, test } from 'vitest';
import { makeProvider, makeProviderOr, strictSchema, type Exec } from './providers.ts';

const schema = { type: 'object', properties: { answer: { type: 'string' }, n: { type: 'number' } }, required: ['answer'] };
const task = { system: 'S', user: 'U', schema };
const CODEX_OK = { ALLOW_UNCONFINED_CODEX: '1' };

test('strictSchema closes objects and requires every property, recursively', () => {
  const s = strictSchema({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } }, c: { type: 'array', items: { type: 'object', properties: { d: { type: 'number' } } } } } });
  expect(s).toEqual({
    type: 'object', additionalProperties: false, required: ['a', 'c'],
    properties: {
      a: { type: 'object', additionalProperties: false, required: ['b'], properties: { b: { type: 'string' } } },
      c: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['d'], properties: { d: { type: 'number' } } } },
    },
  });
});

test('ollama provider posts to /api/chat with the schema', async () => {
  let url = '';
  const fetchImpl = (async (u: string, init: RequestInit) => {
    url = u;
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'gemma4', format: schema });
    return Response.json({ message: { content: '{"answer":"hi"}' } });
  }) as unknown as typeof fetch;
  const p = makeProvider('ollama:gemma4', { OLLAMA_URL: 'http://o' }, { fetchImpl });
  expect(p.id).toBe('ollama:gemma4');
  expect(p.agentic).toBe(false);
  expect(await p.json(task)).toEqual({ answer: 'hi' });
  expect(url).toBe('http://o/api/chat');
});

test('openai-compatible BYOK provider uses chat/completions with a strict json_schema', async () => {
  let req: { url: string; headers: Record<string, string>; body: any } | null = null;
  const fetchImpl = (async (u: string, init: RequestInit) => {
    req = { url: u, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
    return Response.json({ choices: [{ message: { content: '{"answer":"ok","n":1}' } }] });
  }) as unknown as typeof fetch;
  const p = makeProvider('openrouter:qwen/qwen3-coder', { OPENROUTER_API_KEY: 'k' }, { fetchImpl });
  expect(await p.json(task)).toEqual({ answer: 'ok', n: 1 });
  expect(req!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
  expect(req!.headers.authorization).toBe('Bearer k');
  expect(req!.body.model).toBe('qwen/qwen3-coder');
  expect(req!.body.response_format.json_schema.schema.additionalProperties).toBe(false);
});

test('openai provider honours OPENAI_BASE_URL for LM Studio / vLLM', async () => {
  let url = '';
  const fetchImpl = (async (u: string) => { url = u; return Response.json({ choices: [{ message: { content: '{"answer":"x"}' } }] }); }) as unknown as typeof fetch;
  await makeProvider('openai:local-model', { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'http://host:1234/v1' }, { fetchImpl }).json(task);
  expect(url).toBe('http://host:1234/v1/chat/completions');
});

test('anthropic BYOK provider forces a tool call with the schema', async () => {
  let body: any;
  let headers: Record<string, string> = {};
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    headers = init.headers as Record<string, string>;
    return Response.json({ content: [{ type: 'tool_use', name: 'respond', input: { answer: 'a' } }] });
  }) as unknown as typeof fetch;
  const p = makeProvider('anthropic:claude-sonnet-5-5', { ANTHROPIC_API_KEY: 'k' }, { fetchImpl });
  expect(await p.json(task)).toEqual({ answer: 'a' });
  expect(headers['x-api-key']).toBe('k');
  expect(body.tool_choice).toEqual({ type: 'tool', name: 'respond' });
  expect(body.tools[0].input_schema).toEqual(schema);
  expect(body.system).toBe('S');
});

test('claude-cli provider runs claude -p read-only in the given cwd', async () => {
  const calls: { cmd: string; args: string[]; cwd: string; stdin: string; env: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (cmd, args, o) => { calls.push({ cmd, args, ...o }); return { code: 0, stdout: JSON.stringify({ structured_output: { answer: 'c' } }), stderr: '' }; };
  const p = makeProvider('claude-cli:opus', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec });
  expect(p.agentic).toBe(true);
  expect(await p.json({ ...task, cwd: '/vibe/demo' })).toEqual({ answer: 'c' });
  expect(calls[0].cmd).toBe('claude');
  expect(calls[0].cwd).toBe('/vibe/demo');
  expect(calls[0].args).toEqual(expect.arrayContaining(['-p', '--model', 'opus', '--tools', 'Read,Grep,Glob']));
  expect(calls[0].stdin).toContain('S');
  expect(calls[0].stdin).toContain('U');
  expect(calls[0].env.ANTHROPIC_API_KEY).toBeUndefined();
});

test('codex-cli provider runs codex exec read-only with a strict output schema', async () => {
  const calls: { cmd: string; args: string[]; cwd: string }[] = [];
  const exec: Exec = async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd });
    const out = args[args.indexOf('-o') + 1];
    const { writeFile } = await import('node:fs/promises');
    await writeFile(out, '{"answer":"x"}');
    return { code: 0, stdout: '', stderr: '' };
  };
  const p = makeProvider('codex-cli', CODEX_OK, { exec });
  expect(await p.json({ ...task, cwd: '/vibe/demo' })).toEqual({ answer: 'x' });
  const a = calls[0].args;
  expect(calls[0].cmd).toBe('codex');
  expect(a.slice(0, 1)).toEqual(['exec']);
  expect(a).toEqual(expect.arrayContaining(['-s', 'read-only', '-C', '--skip-git-repo-check', '--ephemeral', '--output-schema']));
});

test('CLI providers get only the env they need, never other keys or the graph password', async () => {
  const envs: NodeJS.ProcessEnv[] = [];
  const argsSeen: string[][] = [];
  const exec: Exec = async (_c, args, o) => {
    envs.push(o.env); argsSeen.push(args);
    const out = args.indexOf('-o') >= 0 ? args[args.indexOf('-o') + 1] : null;
    if (out) await (await import('node:fs/promises')).writeFile(out, '{"answer":"x"}');
    return { code: 0, stdout: JSON.stringify({ structured_output: { answer: 'c' } }), stderr: '' };
  };
  const saved = { ...process.env };
  Object.assign(process.env, { GITHUB_TOKEN: 'gh', NEO4J_PASSWORD: 'pw', OPENAI_API_KEY: 'sk', LINEAR_API_KEY: 'lin', CLOUD_TOKEN: 'fgc_pat_x', CODEX_HOME: '/codex', PATH: '/usr/bin', HOME: '/root' });
  try {
    await makeProvider('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec }).json(task);
    await makeProvider('codex-cli', CODEX_OK, { exec }).json(task);
  } finally {
    process.env = saved;
  }
  for (const env of envs) {
    for (const k of ['GITHUB_TOKEN', 'NEO4J_PASSWORD', 'OPENAI_API_KEY', 'LINEAR_API_KEY', 'ANTHROPIC_API_KEY', 'CLOUD_TOKEN']) expect(env[k]).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  }
  expect(envs[0].CLAUDE_CODE_OAUTH_TOKEN).toBe('t');
  expect(envs[1].CODEX_HOME).toBe('/codex');
  // claude may not read secret files even with Read allowed
  const disallowed = argsSeen[0][argsSeen[0].indexOf('--disallowedTools') + 1];
  expect(disallowed).toContain('Read(**/.env*)');
  expect(disallowed).toContain('Read(//proc/**)');
});

test('a CLI provider given no folder runs in a fresh empty one, never the process folder, removed afterwards', async () => {
  const { readdir, stat, writeFile } = await import('node:fs/promises');
  const seen: { cwd: string; files: string[] }[] = [];
  const exec: Exec = async (_c, args, o) => {
    seen.push({ cwd: o.cwd, files: await readdir(o.cwd) });
    const out = args.indexOf('-o') >= 0 ? args[args.indexOf('-o') + 1] : null;
    if (out) await writeFile(out, '{"answer":"x"}');
    return { code: 0, stdout: JSON.stringify({ structured_output: { answer: 'c' } }), stderr: '' };
  };
  await makeProvider('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec }).json(task);
  await makeProvider('codex-cli', CODEX_OK, { exec }).json(task);
  expect(seen).toHaveLength(2);
  for (const { cwd, files } of seen) {
    expect(cwd).not.toBe(process.cwd());
    expect(files).toEqual([]);
    await expect(stat(cwd)).rejects.toThrow();
  }
});

test('unknown providers and missing keys fail loudly', () => {
  expect(() => makeProvider('magic:x', {})).toThrow(/unknown provider/);
  expect(() => makeProvider('openai:gpt', {})).toThrow(/OPENAI_API_KEY/);
  expect(() => makeProvider('anthropic:m', {})).toThrow(/ANTHROPIC_API_KEY/);
  expect(() => makeProvider('claude-cli', {})).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
});

const classifySchema = {
  type: 'object',
  properties: { label: { type: 'string', enum: ['pushback', 'neutral'] }, confidence: { type: 'number' }, summary: { type: 'string' } },
  required: ['label', 'confidence', 'summary'],
};

test('jev provider turns enum fields into Choice questions and fills confidence from Jev', async () => {
  let req: { url: string; headers: Record<string, string>; body: { state: string; model: string; questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }> } } | null = null;
  const fetchImpl = (async (u: string, init: RequestInit) => {
    req = { url: u, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
    return Response.json({ model: 'jev-1.13.0', answers: { label: { type: 'choice', choice: 'pushback', confidence: 0.83, probabilities: { pushback: 0.9, neutral: 0.1 } } }, usage: {} });
  }) as unknown as typeof fetch;
  const p = makeProvider('jev', { TYPESAFE_API_KEY: 'tk' }, { fetchImpl });
  expect(p).toMatchObject({ id: 'jev', agentic: false });
  expect(await p.json({ system: 'Label the message.', user: 'this is broken', schema: classifySchema })).toEqual({ label: 'pushback', confidence: 0.83, summary: '' });
  expect(req!.url).toBe('https://api.typesafe.ai/v1/systemone');
  expect(req!.headers.authorization).toBe('Bearer tk');
  expect(req!.body).toEqual({
    state: 'this is broken', model: 'jev-latest',
    questions: { label: { type: 'choice', instructions: 'Label the message.', criteria: { pushback: 'pushback', neutral: 'neutral' } } },
  });
});

test('jev provider refuses schemas it cannot answer (lists of facts, nested objects)', async () => {
  const p = makeProvider('jev:jev-1.13.0', { TYPESAFE_API_KEY: 'tk' }, { fetchImpl: (async () => Response.json({})) as unknown as typeof fetch });
  const facts = { type: 'object', properties: { facts: { type: 'array', items: { type: 'object' } } }, required: ['facts'] };
  await expect(p.json({ system: 's', user: 'u', schema: facts })).rejects.toThrow(/jev only answers choice-style/);
  expect(() => makeProvider('jev', {})).toThrow(/TYPESAFE_API_KEY/);
});

test('makeProviderOr falls back, and says why, when the preferred provider cannot be built', () => {
  const ok = makeProviderOr('openai:gpt-5.1', 'ollama:gemma4', { OPENAI_API_KEY: 'k' });
  expect(ok).toMatchObject({ provider: { id: 'openai:gpt-5.1' }, fellBack: null });
  const fb = makeProviderOr('claude-cli', 'ollama:gemma4', {});
  expect(fb.provider.id).toBe('ollama:gemma4');
  expect(fb.fellBack).toMatch(/CLAUDE_CODE_OAUTH_TOKEN is not set/);
});

test('a CLI that ignores SIGTERM is killed after the grace period and reported as timed out', async () => {
  const { execCommand } = await import('./providers.ts');
  const started = Date.now();
  const r = await execCommand('sh', ['-c', 'trap "" TERM; sleep 30'], { cwd: '/', stdin: '', env: { PATH: process.env.PATH }, timeoutMs: 100, killGraceMs: 200 });
  expect(Date.now() - started).toBeLessThan(5000);
  expect(r.code).not.toBe(0);
  expect(r.stderr).toMatch(/timed out after 100ms/);
});

test('codex explores a mirror of the repo that has no secret files, removed afterwards', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'fb-repo-'));
  for (const [f, c] of [['src/a.ts', 'export const a = 1'], ['.env', 'K=v'], ['config/credentials.json', '{}'], ['keys/id_ed25519', 'k'], ['node_modules/x/index.js', 'x'], ['.git/config', '[remote] url=https://t@x']]) {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), c);
  }
  const { symlinkSync } = await import('node:fs');
  symlinkSync(join(repo, '.env'), join(repo, 'src/notes.txt'));
  symlinkSync('/etc/passwd', join(repo, 'src/passwd-link.ts'));
  // Tracked in git, so the mirror lists them via ls-files (the walk fallback never follows links anyway).
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'add', '-A', '-f']);
  let seen: Record<string, boolean> = {};
  let mirror = '';
  const exec: Exec = async (_c, args) => {
    mirror = args[args.indexOf('-C') + 1];
    seen = Object.fromEntries(['src/a.ts', '.env', 'config/credentials.json', 'keys/id_ed25519', 'node_modules/x/index.js', '.git/config', 'src/notes.txt', 'src/passwd-link.ts'].map((f) => [f, existsSync(join(mirror, f))]));
    await (await import('node:fs/promises')).writeFile(args[args.indexOf('-o') + 1], '{"answer":"x"}');
    return { code: 0, stdout: '', stderr: '' };
  };
  await makeProvider('codex-cli', CODEX_OK, { exec }).json({ ...task, cwd: repo });
  expect(mirror).not.toBe(repo);
  expect(seen).toEqual({ 'src/a.ts': true, '.env': false, 'config/credentials.json': false, 'keys/id_ed25519': false, 'node_modules/x/index.js': false, '.git/config': false, 'src/notes.txt': false, 'src/passwd-link.ts': false });
  expect(existsSync(mirror)).toBe(false);
});

test('claude-cli is confined to the repo: only the read tools, --restricted, nothing pre-approved outside the cwd', async () => {
  let args: string[] = [];
  const exec: Exec = async (_c, a) => { args = a; return { code: 0, stdout: JSON.stringify({ structured_output: { answer: 'c' } }), stderr: '' }; };
  await makeProvider('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec }).json(task);
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  expect(after('--tools')).toBe('Read,Grep,Glob');
  expect(args).toContain('--restricted');
  expect(after('--permission-mode')).toBe('dontAsk');
  // No bare Read allow: that one pre-approves reads anywhere on the filesystem.
  expect(after('--allowedTools')).toBe('Read(./**)');
});

test('claude-cli may not read any secret file or the worker\'s own private folders, in the repo or anywhere else', async () => {
  let args: string[] = [];
  const exec: Exec = async (_c, a) => { args = a; return { code: 0, stdout: JSON.stringify({ structured_output: { answer: 'c' } }), stderr: '' }; };
  await makeProvider('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec }).json(task);
  const denied = args[args.indexOf('--disallowedTools') + 1].split(',');
  // Under the cwd (gitignore-style, relative) ...
  for (const p of ['**/.env*', '**/.git/config', '**/*credential*', '**/id_*', '**/*.p12', '**/*.tfstate', '**/.pypirc']) expect(denied).toContain(`Read(${p})`);
  // ... and anywhere on the filesystem: an absolute path in a permission rule needs `//` (a single `/` is the project root).
  for (const p of ['//**/.env*', '//**/.git/config', '//**/*credential*', '//**/id_*', '//codex/**', '//state/**', '//transcripts/**', '//codex-sessions/**', '//proc/**']) {
    expect(denied).toContain(`Read(${p})`);
  }
  expect(denied.filter((r) => /^Read\(\/[^/]/.test(r))).toEqual([]);
});

test('codex-cli refuses to run unless the owner accepts that it can read everything the worker can', async () => {
  expect(() => makeProvider('codex-cli', {})).toThrow(/ALLOW_UNCONFINED_CODEX=1/);
  expect(() => makeProvider('codex-cli', { ALLOW_UNCONFINED_CODEX: 'yes' })).toThrow(/ALLOW_UNCONFINED_CODEX=1/);
  expect(() => makeProvider('codex-cli:gpt-5', {})).toThrow(/\/transcripts/);
  expect(makeProvider('codex-cli', CODEX_OK).id).toBe('codex-cli');
});
