import { describe, expect, test, vi } from 'vitest';
import { makeProvider, makeProviderOr, purgeAgentMirrors, strictSchema, type Exec } from './providers.ts';
import { ModelOutputError } from './json.ts';
import { ProviderUnavailableError, withHealth } from './unavailable.ts';
import { SCRIPT_TEST_TIMEOUT_MS } from '../testing/exec.ts';

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

test('answers wrapped in prose or fences are read with the shared extractor; none at all is a ModelOutputError with the tail', async () => {
  const codexWrites = (text: string): Exec => async (_cmd, args) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(args[args.indexOf('-o') + 1], text);
    return { code: 0, stdout: '', stderr: '' };
  };
  // What a codex scan wrote around its object, with a stray brace in the prose after it.
  const prose = 'I explored the repo. Draft {"answer":"old"} replaced by:\n{"answer":"x","n":2}\nand first literal } marker and';
  expect(await makeProvider('codex-cli', CODEX_OK, { exec: codexWrites(prose) }).json({ ...task, cwd: '/vibe/demo' })).toEqual({ answer: 'x', n: 2 });
  const err = await makeProvider('codex-cli', CODEX_OK, { exec: codexWrites('I could not decide, marker and') }).json({ ...task, cwd: '/vibe/demo' }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ModelOutputError);
  expect((err as Error).message).toMatch(/marker and/);

  const fetchImpl = (async () => Response.json({ choices: [{ message: { content: 'Sure!\n```json\n{"answer":"ok"}\n```' } }] })) as unknown as typeof fetch;
  expect(await makeProvider('openai:gpt', { OPENAI_API_KEY: 'k' }, { fetchImpl }).json(task)).toEqual({ answer: 'ok' });

  const claude = (stdout: string): Exec => async () => ({ code: 0, stdout, stderr: '' });
  expect(await makeProvider('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec: claude(JSON.stringify({ result: 'Here it is: {"answer":"c"}' })) }).json(task)).toEqual({ answer: 'c' });
  const noEnvelope = await makeProvider('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec: claude('warning: something odd') }).json(task).catch((e: unknown) => e);
  expect(noEnvelope).toBeInstanceOf(ModelOutputError);
  expect((noEnvelope as Error).message).toMatch(/something odd/);
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
  const { existsSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { setTimeout: sleep } = await import('node:timers/promises');
  const ready = join(mkdtempSync(join(tmpdir(), 'fb-grace-')), 'ready');
  // The timeout and the grace period run on fake timers, so SIGTERM comes only once the CLI ignores it, however slowly
  // a loaded machine starts it; without the SIGKILL that follows, the call would wait out the 30 s sleep.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let r: Awaited<ReturnType<typeof execCommand>>;
  try {
    const pending = execCommand('sh', ['-c', `trap "" TERM; : > '${ready}'; sleep 30`], { cwd: '/', stdin: '', env: { PATH: process.env.PATH }, timeoutMs: 100, killGraceMs: 200 });
    while (!existsSync(ready)) await sleep(10);
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(200);
    r = await pending;
  } finally {
    vi.useRealTimers();
  }
  expect(r.code).not.toBe(0);
  expect(r.stderr).toMatch(/timed out after 100ms/);
}, SCRIPT_TEST_TIMEOUT_MS);

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

test('codex can mirror a repo once for many jobs: a job in a mirror it made is not copied again; any other folder still is', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const repo = mkdtempSync(join(tmpdir(), 'fb-repo-'));
  for (const [f, c] of [['src/a.ts', 'export const a = 1'], ['.env', 'K=v']]) {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), c);
  }
  const dirs: string[] = [];
  const exec: Exec = async (_c, args) => {
    dirs.push(args[args.indexOf('-C') + 1]);
    await (await import('node:fs/promises')).writeFile(args[args.indexOf('-o') + 1], '{"answer":"x"}');
    return { code: 0, stdout: '', stderr: '' };
  };
  const p = withHealth(makeProvider('codex-cli', CODEX_OK, { exec }), () => {});
  const m = await p.mirror!(repo);
  expect(existsSync(join(m.dir, 'src/a.ts'))).toBe(true);
  expect(existsSync(join(m.dir, '.env'))).toBe(false);
  await p.json({ ...task, cwd: m.dir });
  await p.json({ ...task, cwd: m.dir });
  expect(dirs).toEqual([m.dir, m.dir]);
  // The repo itself (or any folder it did not make) is still mirrored per job.
  await p.json({ ...task, cwd: repo });
  expect(dirs[2]).not.toBe(repo);
  expect(dirs[2]).not.toBe(m.dir);
  await m.dispose();
  expect(existsSync(m.dir)).toBe(false);
  // Disposed: no longer trusted as a mirror.
  mkdirSync(m.dir, { recursive: true });
  writeFileSync(join(m.dir, '.env'), 'K=v');
  await p.json({ ...task, cwd: m.dir });
  expect(dirs[3]).not.toBe(m.dir);
  // A provider that needs no mirror has none.
  expect(makeProvider('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }).mirror).toBeUndefined();
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
  for (const p of ['**/.env*', '**/.git/config', '**/*credentials', '**/*credential*.json', '**/.ssh/id_*', '**/[iI][dD]_[rR][sS][aA]', '**/*.p12', '**/*.tfstate', '**/.pypirc']) expect(denied).toContain(`Read(${p})`);
  // ... and anywhere on the filesystem: an absolute path in a permission rule needs `//` (a single `/` is the project root).
  for (const p of ['//**/.env*', '//**/.git/config', '//**/*credentials', '//**/*credential*.json', '//**/.ssh/id_*', '//codex/**', '//state/**', '//transcripts/**', '//codex-sessions/**', '//proc/**']) {
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

const image = { mediaType: 'image/png' as const, data: Buffer.from('fake png bytes').toString('base64') };
const seeTask = { ...task, images: [image] };

test('vision: ollama sends the images with the user message', async () => {
  let body: any;
  const fetchImpl = (async (_u: string, init: RequestInit) => { body = JSON.parse(init.body as string); return Response.json({ message: { content: '{"answer":"a"}' } }); }) as unknown as typeof fetch;
  const p = makeProvider('ollama:gemma4', { OLLAMA_URL: 'http://o' }, { fetchImpl });
  expect(p.vision).toBe(true);
  await p.json(seeTask);
  expect(body.messages[1]).toEqual({ role: 'user', content: 'U', images: [image.data] });
});

test('vision: openai-compatible sends a data URL image part, anthropic an image block', async () => {
  let body: any;
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    body = JSON.parse(init.body as string);
    return body.messages?.[0]?.role === 'system' ? Response.json({ choices: [{ message: { content: '{"answer":"x"}' } }] }) : Response.json({ content: [{ type: 'tool_use', input: { answer: 'x' } }] });
  }) as unknown as typeof fetch;
  await makeProvider('openai:gpt-5.1', { OPENAI_API_KEY: 'k' }, { fetchImpl }).json(seeTask);
  expect(body.messages[1].content).toEqual([{ type: 'text', text: 'U' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image.data}` } }]);
  await makeProvider('anthropic:claude-sonnet-5-5', { ANTHROPIC_API_KEY: 'k' }, { fetchImpl }).json(seeTask);
  expect(body.messages[0].content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } }, { type: 'text', text: 'U' }]);
});

test('vision: claude-cli reads the image from a fresh folder holding only it, never the given cwd, removed afterwards', async () => {
  const { readdirSync, readFileSync, existsSync } = await import('node:fs');
  let seen: { cwd: string; files: string[]; bytes: string; stdin: string } | null = null;
  const exec: Exec = async (_cmd, _args, o) => {
    seen = { cwd: o.cwd!, files: readdirSync(o.cwd!), bytes: readFileSync(`${o.cwd}/image-1.png`, 'utf8'), stdin: o.stdin ?? '' };
    return { code: 0, stdout: JSON.stringify({ structured_output: { answer: 'a' } }), stderr: '' };
  };
  const p = makeProvider('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec });
  expect(p.vision).toBe(true);
  await p.json({ ...seeTask, cwd: '/vibe/some-repo' });
  expect(seen!.cwd).not.toBe('/vibe/some-repo');
  expect(seen!.files).toEqual(['image-1.png']);
  expect(seen!.bytes).toBe('fake png bytes');
  expect(seen!.stdin).toMatch(/image-1\.png/);
  expect(existsSync(seen!.cwd)).toBe(false);
});

test('vision: providers that cannot read images say so instead of answering without them', async () => {
  const exec: Exec = async () => ({ code: 0, stdout: '{}', stderr: '' });
  for (const spec of ['codex-cli', 'jev']) {
    const p = makeProvider(spec, { ...CODEX_OK, TYPESAFE_API_KEY: 'k' }, { exec });
    expect(p.vision).toBe(false);
    await expect(p.json(seeTask)).rejects.toThrow(/cannot read images/);
  }
});

test('the HTTP providers cancel their request when the task signal fires (a check that gave up)', async () => {
  // A server that never answers until the request is aborted.
  const hang = (async (_u: string, init: RequestInit) => new Promise((_r, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  })) as unknown as typeof fetch;
  const specs: [string, Record<string, string>][] = [
    ['ollama:gemma4', { OLLAMA_URL: 'http://o' }],
    ['openai:gpt', { OPENAI_API_KEY: 'k' }],
    ['anthropic:claude-sonnet-5-5', { ANTHROPIC_API_KEY: 'k' }],
  ];
  for (const [spec, env] of specs) {
    const c = new AbortController();
    const p = makeProvider(spec, env, { fetchImpl: hang }).json({ ...task, timeoutMs: 600_000, signal: c.signal });
    setTimeout(() => c.abort(new Error('the check gave up')), 10);
    // The stand-in only ever settles by its request being aborted: rejecting at all is the cancellation.
    await expect(p).rejects.toThrow(/gave up/);
  }
});

test('openrouter and groq without a model say which spec to write, not an internal key name', () => {
  expect(() => makeProvider('openrouter', { OPENROUTER_API_KEY: 'k' })).toThrow('openrouter needs a model: openrouter:<model>');
  expect(() => makeProvider('groq:', { GROQ_API_KEY: 'k' })).toThrow('groq needs a model: groq:<model>');
});

const replies = (status: number, body: unknown) =>
  (async () => (typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status }))) as unknown as typeof fetch;

test('an HTTP provider that refuses the request throws its id, status and the start of what it said', async () => {
  const long = `bad ${'x'.repeat(600)}`;
  await expect(makeProvider('openai:gpt', { OPENAI_API_KEY: 'k' }, { fetchImpl: replies(400, long) }).json(task)).rejects.toThrow(new RegExp(`^openai:gpt 400: bad x{496}$`));
  await expect(makeProvider('anthropic:m', { ANTHROPIC_API_KEY: 'k' }, { fetchImpl: replies(529, 'overloaded') }).json(task)).rejects.toThrow('anthropic:m 529: overloaded');
  await expect(makeProvider('jev', { TYPESAFE_API_KEY: 'k' }, { fetchImpl: replies(401, 'no') }).json({ ...task, schema: classifySchema })).rejects.toThrow('jev 401: no');
});

test('a malformed provider answer is an unusable answer, never a crash: no choices, no tool call', async () => {
  await expect(makeProvider('groq:llama', { GROQ_API_KEY: 'k' }, { fetchImpl: replies(200, {}) }).json(task)).rejects.toBeInstanceOf(ModelOutputError);
  await expect(makeProvider('openai:gpt', { OPENAI_API_KEY: 'k' }, { fetchImpl: replies(200, { choices: [{ message: {} }] }) }).json(task)).rejects.toThrow(/the answer was empty/);
  await expect(makeProvider('anthropic:m', { ANTHROPIC_API_KEY: 'k' }, { fetchImpl: replies(200, { content: [{ type: 'text', text: 'sure!' }] }) }).json(task)).rejects.toThrow('anthropic:m: no tool_use in response');
  await expect(makeProvider('anthropic:m', { ANTHROPIC_API_KEY: 'k' }, { fetchImpl: replies(200, {}) }).json(task)).rejects.toThrow(/no tool_use/);
});

test('claude-cli: what the CLI reported decides the error, and a plain result is read when there is no structured output', async () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 't' };
  const run = (r: { code: number; stdout: string; stderr?: string }) => makeProvider('claude-cli', env, { exec: async () => ({ stderr: '', ...r }) }).json(task);
  // exit 1 with nothing on stderr: the is_error result is what it said
  await expect(run({ code: 1, stdout: JSON.stringify({ is_error: true, result: 'Credit balance is too low' }) })).rejects.toMatchObject({ name: 'CliRunError', exit: 1, said: 'Credit balance is too low' });
  await expect(run({ code: 1, stdout: JSON.stringify({ is_error: true }) })).rejects.toMatchObject({ said: '' });
  await expect(run({ code: 2, stdout: 'null' })).rejects.toMatchObject({ said: '' });
  // exit 0 but the run reported an error
  await expect(run({ code: 0, stdout: JSON.stringify({ is_error: true, result: 'Reached max turns' }) })).rejects.toMatchObject({ exit: null, said: 'Reached max turns' });
  await expect(run({ code: 0, stdout: 'Done!' })).rejects.toThrow(/^claude printed no JSON result; the answer ended: Done!/);
  expect(await run({ code: 0, stdout: JSON.stringify({ result: 'Here it is: {"answer":"r"}' }) })).toEqual({ answer: 'r' });
  await expect(run({ code: 0, stdout: '{}' })).rejects.toThrow(/the answer was empty/);
});

test('a CLI job without its own limit gets 15 minutes', async () => {
  const limits: number[] = [];
  const exec: Exec = async (_c, args, o) => {
    limits.push(o.timeoutMs);
    if (args.includes('-o')) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(args[args.indexOf('-o') + 1], '{"answer":"x"}');
    }
    return { code: 0, stdout: JSON.stringify({ structured_output: {} }), stderr: '' };
  };
  await makeProvider('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec }).json(task);
  await makeProvider('codex-cli', CODEX_OK, { exec }).json(task);
  await makeProvider('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec }).json({ ...task, timeoutMs: 5000 });
  expect(limits).toEqual([900_000, 900_000, 5000]);
});

test('codex-cli in the worker reports a failed run with its exit status and stderr', async () => {
  const exec: Exec = async () => ({ code: 3, stdout: 'transcript', stderr: 'boom' });
  await expect(makeProvider('codex-cli', CODEX_OK, { exec }).json(task)).rejects.toMatchObject({ name: 'CliRunError', tool: 'codex', exit: 3, said: 'boom' });
});

test('vision: claude-cli names every image file when there are several', async () => {
  let prompt = '';
  const exec: Exec = async (_c, _a, o) => { prompt = o.stdin; return { code: 0, stdout: JSON.stringify({ structured_output: {} }), stderr: '' }; };
  const images = [{ mediaType: 'image/png' as const, data: 'AA==' }, { mediaType: 'image/webp' as const, data: 'AA==' }];
  await makeProvider('claude-cli', { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { exec }).json({ ...task, images });
  expect(prompt).toMatch(/The images are image-1\.png, image-2\.webp in your current directory: open each with the Read tool/);
});

describe('codex-cli on the runner', () => {
  const healthy = (run: (body: { mirror: string }) => Response) =>
    (async (u: string, init?: RequestInit) => (String(u).endsWith('/health') ? Response.json({ ok: true }) : run(JSON.parse(String(init!.body))))) as unknown as typeof fetch;
  async function scratchDir() {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'fb-prov-'));
    await mkdir(join(root, 'scratch'));
    await mkdir(join(root, 'repo'));
    await writeFile(join(root, 'repo', 'a.ts'), 'export {}');
    await writeFile(join(root, 'scratch', '.runner-token'), 'tok');
    return { scratch: join(root, 'scratch'), repo: join(root, 'repo') };
  }
  const provider = (scratch: string, fetchImpl: typeof fetch) => makeProvider('codex-cli', { CODEX_RUNNER_URL: 'http://runner', CODEX_RUNNER_SCRATCH: scratch }, { fetchImpl });

  test('a failed run, a run that wrote no answer and an unreachable runner each say so', async () => {
    const { scratch, repo } = await scratchDir();
    await expect(provider(scratch, healthy(() => Response.json({ code: 2, stdout: '', stderr: 'stream disconnected', output: null }))).json({ ...task, cwd: repo }))
      .rejects.toMatchObject({ name: 'CliRunError', exit: 2, said: 'stream disconnected' });
    await expect(provider(scratch, healthy(() => Response.json({ code: 0, stdout: '', stderr: '', output: null }))).json({ ...task, cwd: repo }))
      .rejects.toThrow('codex exit 0: it wrote no answer');
    const gone = (async (u: string) => {
      if (String(u).endsWith('/health')) return Response.json({ ok: true });
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    // the runner going away mid-way is unavailability: the stage waits instead of failing the item
    await expect(provider(scratch, gone).json({ ...task, cwd: repo })).rejects.toBeInstanceOf(ProviderUnavailableError);
    // a runner error that is not about reaching it stays the item's failure
    await expect(provider(scratch, healthy(() => new Response('<html>', { status: 502 }))).json({ ...task, cwd: repo })).rejects.toThrow('codex runner 502: <html>');
    // every job's mirror is removed after it
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(scratch)).filter((n) => n.startsWith('fb-mirror-'))).toEqual([]);
  });

  test('the runner gets the mirror by its name in the volume and answers from its output', async () => {
    const { scratch, repo } = await scratchDir();
    let mirror = '';
    const p = provider(scratch, healthy((body) => { mirror = body.mirror; return Response.json({ code: 0, stdout: '', stderr: '', output: '{"answer":"ran"}' }); }));
    const made = await p.mirror!(repo);
    expect(await p.json({ ...task, cwd: made.dir })).toEqual({ answer: 'ran' });
    expect(mirror).toMatch(/^fb-mirror-[A-Za-z0-9]+$/);
    expect(made.dir.endsWith(`/${mirror}`)).toBe(true);
    await made.dispose();
  });
});

test('specs without a model take each provider\'s default', async () => {
  const bodies: { model: string }[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return Response.json({ message: { content: '{}' }, choices: [{ message: { content: '{}' } }], content: [{ type: 'tool_use', input: {} }] });
  }) as unknown as typeof fetch;
  await makeProvider('ollama', {}, { fetchImpl }).json(task);
  await makeProvider('openai:', { OPENAI_API_KEY: 'k' }, { fetchImpl }).json(task);
  await makeProvider('anthropic', { ANTHROPIC_API_KEY: 'k' }, { fetchImpl }).json(task);
  expect(bodies.map((b) => b.model)).toEqual(['gemma4', 'gpt-5.1', 'claude-sonnet-5-5']);
});

test('jev answers what it was not asked as empty, and a missing answer as no choice with zero confidence', async () => {
  const p = makeProvider('jev', { TYPESAFE_API_KEY: 'k' }, { fetchImpl: replies(200, {}) });
  const s = { type: 'object', properties: { ...classifySchema.properties, score: { type: 'number' } } };
  expect(await p.json({ system: 's', user: 'u', schema: s })).toEqual({ label: undefined, confidence: 0, summary: '', score: 0 });
  await expect(p.json({ system: 's', user: 'u', schema: { type: 'object' } })).rejects.toThrow(/cannot fill a schema without enums/);
});

test('purgeAgentMirrors sweeps abandoned mirrors in the runner scratch volume at startup and keeps other files', async () => {
  const { mkdtemp, mkdir, readdir, utimes, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const scratch = await mkdtemp(join(tmpdir(), 'fb-purge-'));
  const old = new Date(Date.now() - 10 * 60_000);
  await mkdir(join(scratch, 'fb-mirror-abandoned'));
  await utimes(join(scratch, 'fb-mirror-abandoned'), old, old);
  await mkdir(join(scratch, 'fb-mirror-fresh'));
  await writeFile(join(scratch, '.runner-token'), 't');
  await purgeAgentMirrors({ CODEX_RUNNER_SCRATCH: scratch });
  expect((await readdir(scratch)).sort()).toEqual(['.runner-token', 'fb-mirror-fresh']);
});
