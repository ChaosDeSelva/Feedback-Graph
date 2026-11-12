import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { runHook } from './run.mjs';

// A stand-in Feedback Graph API: the project lookup and the MCP tools the hooks call, answering as the real one does.
let api, temp, repo, stateDir;
function fakeApi({ tracked = true, task = TASK_MD, module = MODULE_MD, status = 200, sse = true, hang = false, toolDelay = 0 } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, path: req.url, headers: req.headers, tool: call?.params?.name, args: call?.params?.arguments });
    if (hang) return;
    if (status !== 200) { res.writeHead(status); return res.end('nope'); }
    if (req.url.startsWith('/api/agent/project')) return res.end(JSON.stringify(tracked ? { tracked: true, project: 'demo' } : { tracked: false }));
    if (toolDelay) await new Promise(resolve => setTimeout(resolve, toolDelay));
    const text = call.params.name === 'get_task_context' ? task : module;
    const answer = JSON.stringify({ jsonrpc: '2.0', id: 1, result: text === null ? { isError: true, content: [{ type: 'text', text: 'boom' }] } : { content: [{ type: 'text', text }] } });
    res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json' });
    res.end(sse ? `event: message\ndata: ${answer}\n\n` : answer);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}
const start = async (o) => { api = await fakeApi(o); return api; };

const TASK_MD = [
  '# Feedback Graph context for "fix pool" in demo',
  '',
  '## Approved lessons (follow these)',
  '- **Release pool clients**: always release in finally',
  '  - applies when: db work · scope: project · lesson l1 · relevance 0.80',
  '',
  '## Similar past misses in this project',
  '- a Brotli CVE bump (cause: requirement_unstated)',
].join('\n');
const MODULE_MD = '# Module context for src/db/pool.ts\n## Lessons for this file (1)\n- **Release pool clients**: always release in finally';

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'fg-run-hook-'));
  stateDir = join(temp, 'state');
  repo = join(temp, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'start']);
});
afterEach(async () => {
  if (api) await new Promise(resolve => { api.server.closeAllConnections(); api.server.close(resolve); });
  api = undefined;
  rmSync(temp, { recursive: true, force: true });
});

const run = (event, input, env = {}) => runHook(event, async () => (typeof input === 'string' ? input : JSON.stringify(input)), {
  env: { FEEDBACK_GRAPH_URL: api?.url ?? 'http://127.0.0.1:9', ...env }, stateDir,
});
const context = (r) => JSON.parse(r.stdout).hookSpecificOutput;
const headOf = (dir) => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const transcript = (...entries) => { const p = join(temp, 'transcript.jsonl'); writeFileSync(p, entries.map(e => JSON.stringify(e)).join('\n')); return p; };
const edited = (id, path) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: path } }] } });

test('UserPromptSubmit adds the task context once per session and asks with the prompt, its files and the session', async () => {
  await start();
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 's-1', cwd: repo, prompt: 'Fix the leak in src/db/pool.ts so clients are released' };
  const first = await run('prompt', input, { FEEDBACK_GRAPH_TOKEN: 'api-token' });
  expect(context(first)).toEqual({ hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('Release pool clients') });
  expect(context(first).additionalContext).not.toContain('Brotli');
  expect(api.requests[0]).toMatchObject({ method: 'GET', path: `/api/agent/project?cwd=${encodeURIComponent(repo)}`, headers: { authorization: 'Bearer api-token' } });
  expect(api.requests[1]).toMatchObject({ method: 'POST', path: '/mcp', tool: 'get_task_context', args: { cwd: repo, task: input.prompt, files: ['src/db/pool.ts'], session_id: 's-1' } });
  // The same lessons are not repeated on the session's next request.
  expect((await run('prompt', input)).stdout).toBe('');
});

test('UserPromptSubmit says nothing for a pure question, an untracked project or a failed context call', async () => {
  await start();
  expect(await run('prompt', { session_id: 's', cwd: repo, prompt: 'What does the pool module do with idle clients?' })).toEqual({ stdout: '', stderr: '' });
  expect(api.requests).toEqual([]);
  await api.server.close(); api = undefined;

  await start({ tracked: false });
  expect((await run('prompt', { session_id: 's', cwd: repo, prompt: 'Fix the leak in the pool' })).stdout).toBe('');
  expect(api.requests.map(r => r.tool)).toEqual([undefined]);
  api.server.close(); api = undefined;

  await start({ task: null, sse: false });
  expect((await run('prompt', { session_id: 's', cwd: repo, prompt: 'Fix the leak in the pool' })).stdout).toBe('');
  expect(api.requests.map(r => r.tool)).toEqual([undefined, 'get_task_context']);
});

test('PreToolUse adds a file\'s lessons the first time the session edits it, and only files in the project', async () => {
  await start();
  const edit = (file_path, tool_name = 'Edit') => run('edit', { hook_event_name: 'PreToolUse', session_id: 's-2', cwd: repo, tool_name, tool_input: { file_path, old_string: 'a', new_string: 'b' } });
  expect(context(await edit(join(repo, 'src/db/pool.ts')))).toEqual({ hookEventName: 'PreToolUse', additionalContext: MODULE_MD });
  expect(api.requests.at(-1)).toMatchObject({ tool: 'get_module_context', args: { cwd: repo, path: join(repo, 'src/db/pool.ts') } });
  const asked = api.requests.length;
  expect((await edit(join(repo, 'src/db/pool.ts'), 'Write')).stdout).toBe('');
  expect(api.requests.filter(r => r.tool).length).toBe(1);
  expect((await edit('/etc/hosts')).stdout).toBe('');
  expect(api.requests.length).toBe(asked + 1);
  // A notebook edit names its file as notebook_path.
  const nb = await run('edit', { session_id: 's-2', cwd: repo, tool_name: 'NotebookEdit', tool_input: { notebook_path: join(repo, 'a.ipynb'), new_source: 'x' } });
  expect(context(nb).additionalContext).toBe(MODULE_MD);
});

test('PreToolUse stays quiet when the file has no lessons or misses', async () => {
  await start({ module: '# Module context for a.ts\n## Imported by (1)\n- b.ts' });
  expect(await run('edit', { session_id: 's', cwd: repo, tool_name: 'Edit', tool_input: { file_path: 'a.ts' } })).toEqual({ stdout: '', stderr: '' });
  expect(await run('edit', { session_id: 's', cwd: repo, tool_name: 'Edit', tool_input: {} })).toEqual({ stdout: '', stderr: '' });
});

test('Stop asks once for check_before_done, naming the edited files and a diff from the commit the session started at', async () => {
  await start();
  const base = headOf(repo);
  await run('prompt', { session_id: 's-3', cwd: repo, prompt: 'Fix the leak in src/db/pool.ts please' });
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'work']);
  const transcript_path = transcript(edited('e1', join(repo, 'src/db/pool.ts')));
  const out = JSON.parse((await run('stop', { hook_event_name: 'Stop', session_id: 's-3', cwd: repo, transcript_path, stop_hook_active: false })).stdout);
  expect(out.decision).toBe('block');
  expect(out.reason).toContain(join(repo, 'src/db/pool.ts'));
  expect(out.reason).toContain(`git diff ${base}`);
  expect(out.reason).toContain('session_id: "s-3"');
  // Continuing from that block, it lets the session stop.
  expect((await run('stop', { session_id: 's-3', cwd: repo, transcript_path, stop_hook_active: true })).stdout).toBe('');
});

test('Stop says nothing without a transcript, outside a tracked project, or when the transcript is missing', async () => {
  await start({ tracked: false });
  const transcript_path = transcript(edited('e1', join(repo, 'a.ts')));
  expect((await run('stop', { session_id: 's', cwd: repo })).stdout).toBe('');
  expect(api.requests).toEqual([]);
  expect((await run('stop', { session_id: 's', cwd: repo, transcript_path })).stdout).toBe('');
  api.server.close(); api = undefined;
  await start();
  expect(await run('stop', { session_id: 's', cwd: repo, transcript_path: join(temp, 'gone.jsonl') })).toEqual({ stdout: '', stderr: '' });
});

test('Stop remembers a denied check_before_done across a compaction, and says so only once', async () => {
  await start();
  const denied = transcript(
    edited('e1', join(repo, 'a.ts')),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'mcp__plugin_feedback-graph_fg__check_before_done', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: true, content: 'Permission to use mcp__plugin_feedback-graph_fg__check_before_done has been denied.' }] } },
  );
  expect(JSON.parse((await run('stop', { session_id: 's-4', cwd: repo, transcript_path: denied })).stdout).reason).toContain('denied by permission');
  await run('session', { hook_event_name: 'SessionStart', source: 'compact', session_id: 's-4' });
  // After the compaction the transcript no longer shows the refusal; the session's state still does.
  const compacted = transcript(edited('e2', join(repo, 'b.ts')));
  expect((await run('stop', { session_id: 's-4', cwd: repo, transcript_path: compacted })).stdout).toBe('');
});

test('Stop with a failed judge says once that the check did not run, then lets every later stop through', async () => {
  await start();
  const check = (id) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__plugin_feedback-graph_fg__check_before_done', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: '# Not judged: the judge failed (ollama 404)\nNothing was decided about this work.' }] }] } },
  ];
  const entries = [edited('e1', join(repo, 'a.ts')), ...check('c1')];
  const input = { session_id: 's-9', cwd: repo, stop_hook_active: true };
  expect(JSON.parse((await run('stop', { ...input, transcript_path: transcript(...entries) })).stdout).reason).toContain('did not run');
  for (const id of ['c2', 'c3', 'c4']) {
    entries.push(...check(id));
    expect((await run('stop', { ...input, transcript_path: transcript(...entries) })).stdout).toBe('');
  }
});

test('Stop keeps counting queued rounds across a compaction, so a check that stays queued still lets the stop through', async () => {
  await start();
  const entries = [edited('e1', join(repo, 'a.ts'))];
  const input = { session_id: 's-q', cwd: repo };
  let blocks = 0;
  for (let i = 1; i <= 12; i++) {
    const out = (await run('stop', { ...input, stop_hook_active: i > 1, transcript_path: transcript(...entries) })).stdout;
    if (!out || !JSON.parse(out).reason.includes('do not finish while it is queued')) break;
    blocks++;
    entries.push(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: `c${i}`, name: 'mcp__plugin_feedback-graph_fg__check_before_done', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: [{ type: 'text', text: '# Queued: pre-done check has not completed' }] }] } },
    );
    await run('session', { hook_event_name: 'SessionStart', source: 'compact', session_id: 's-q' });
  }
  // The first block asks for the check (no queued answer yet), then QUEUED_ROUNDS retries.
  expect(blocks).toBe(4);
});

test('SessionStart after /clear shows the lessons again but keeps the session\'s start commit', async () => {
  await start();
  const input = { session_id: 's-5', cwd: repo, prompt: 'Fix the leak in src/db/pool.ts please' };
  const base = headOf(repo);
  expect((await run('prompt', input)).stdout).not.toBe('');
  expect((await run('prompt', input)).stdout).toBe('');
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'later']);
  expect(await run('session', { hook_event_name: 'SessionStart', source: 'clear', session_id: 's-5' })).toEqual({ stdout: '', stderr: '' });
  expect(context(await run('prompt', input)).additionalContext).toContain('Release pool clients');
  const out = JSON.parse((await run('stop', { session_id: 's-5', cwd: repo, transcript_path: transcript(edited('e1', 'a.ts')) })).stdout);
  expect(out.reason).toContain(`git diff ${base}`);
  // A session that never ran a hook in a project leaves no state behind.
  await run('session', { session_id: 'fresh' });
  expect(readdirSync(stateDir).some(f => f.startsWith('fresh'))).toBe(false);
});

test('SessionStart warns when an unreachable API cannot register a labelled run', async () => {
  const r = await run('session', { session_id: 's-6' }, { FG_RUN: 'labelled', FG_RUN_KEY: 'PRIVATE_RUN_KEY' });
  expect(r.stderr).toContain('server unavailable or timed out');
  expect(context(r).additionalContext).toContain('This session was not tagged');
  expect(r.stdout + r.stderr).not.toContain('PRIVATE_RUN_KEY');
});

test.each([
  ['malformed JSON', 'prompt', '{"prompt": "Fix the pool'],
  ['a JSON null', 'edit', 'null'],
  ['an array', 'stop', '[1,2]'],
  ['empty input', 'session', ''],
])('%s on stdin says nothing and does not throw', async (_, event, raw) => {
  await start();
  await expect(run(event, raw)).resolves.toEqual({ stdout: '', stderr: '' });
});

test('an unknown event, FEEDBACK_GRAPH_HOOKS=off and an unreadable stdin do nothing', async () => {
  await start();
  const input = { session_id: 's', cwd: repo, prompt: 'Fix the leak in src/db/pool.ts please' };
  let read = false;
  expect(await runHook('constructor', async () => { read = true; return '{}'; }, { env: { FEEDBACK_GRAPH_URL: api.url }, stateDir })).toEqual({ stdout: '', stderr: '' });
  expect(await run('prompt', input, { FEEDBACK_GRAPH_HOOKS: 'off' })).toEqual({ stdout: '', stderr: '' });
  expect(await runHook('prompt', async () => { throw new Error('EPIPE'); }, { env: { FEEDBACK_GRAPH_URL: api.url }, stateDir })).toEqual({ stdout: '', stderr: '' });
  expect(read).toBe(false);
  expect(api.requests).toEqual([]);
});

test.each(['prompt', 'edit', 'stop'])('%s is silent when the API is unreachable or failing', async (event) => {
  const input = { session_id: 's', cwd: repo, prompt: 'Fix the leak in src/db/pool.ts please', tool_input: { file_path: 'a.ts' }, transcript_path: transcript(edited('e1', 'a.ts')) };
  expect(await run(event, input)).toEqual({ stdout: '', stderr: '' });
  await start({ status: 503 });
  expect(await run(event, input)).toEqual({ stdout: '', stderr: '' });
  expect(api.requests.length).toBe(1);
});

test('a hanging API is given up on within the hook\'s budget', async () => {
  await start({ hang: true });
  const began = Date.now();
  expect(await run('edit', { session_id: 's', cwd: repo, tool_input: { file_path: 'a.ts' } })).toEqual({ stdout: '', stderr: '' });
  // The project lookup's 2 s timeout, well inside the 10 s Claude Code gives a PreToolUse hook.
  expect(Date.now() - began).toBeLessThan(5_000);
});

test('a get_task_context that fails slowly (a hanging model) is skipped on the next prompts, so the wait is paid once', async () => {
  await start({ task: null, toolDelay: 3_200 });
  const input = { session_id: 's-slow', cwd: repo, prompt: 'Fix the leak in src/db/pool.ts please' };
  expect((await run('prompt', input)).stdout).toBe('');
  const asked = api.requests.filter(r => r.tool === 'get_task_context').length;
  const began = Date.now();
  expect((await run('prompt', { ...input, session_id: 's-other' })).stdout).toBe('');
  expect(Date.now() - began).toBeLessThan(1_500);
  expect(api.requests.filter(r => r.tool === 'get_task_context').length).toBe(asked);
});

test('a get_task_context that fails fast is asked again on the next prompt', async () => {
  await start({ task: null });
  const input = { session_id: 's-fast', cwd: repo, prompt: 'Fix the leak in src/db/pool.ts please' };
  await run('prompt', input);
  await run('prompt', input);
  expect(api.requests.filter(r => r.tool === 'get_task_context')).toHaveLength(2);
});

// The script Claude Code runs: whatever arrives, it exits 0 and prints nothing that could block the session.
function entry(event, stdin, env = {}, { slowReader = false } = {}) {
  const child = spawn(process.execPath, [new URL('./feedback-graph.mjs', import.meta.url).pathname, event], {
    env: { ...process.env, TMPDIR: temp, FEEDBACK_GRAPH_HOOKS: '', FG_RUN: '', FEEDBACK_GRAPH_URL: 'http://127.0.0.1:9', ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', c => { out += c; });
  // A reader that drains late, so the pipe's buffer fills before the script is done writing.
  if (slowReader) { child.stdout.pause(); setTimeout(() => child.stdout.resume(), 300); }
  child.stderr.on('data', c => { err += c; });
  child.stdin.end(stdin);
  return new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve({ code, out, err })); });
}

test.each([
  ['prompt', 'not json at all'],
  ['edit', JSON.stringify({ session_id: 's', cwd: '/', tool_input: { file_path: '/a.ts' } })],
  ['stop', JSON.stringify({ session_id: 's', cwd: '/', transcript_path: '/nonexistent' })],
  ['nonsense', '{}'],
])('the hook script exits 0 silently on %s with an unreachable API', async (event, stdin) => {
  expect(await entry(event, stdin)).toEqual({ code: 0, out: '', err: '' });
});

test('the hook script prints the context the API returns', async () => {
  await start();
  const r = await entry('prompt', JSON.stringify({ session_id: 's-e', cwd: repo, prompt: 'Fix the leak in src/db/pool.ts please' }), { FEEDBACK_GRAPH_URL: api.url });
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).hookSpecificOutput.additionalContext).toContain('Release pool clients');
});

test('the hook script writes a large answer whole to a pipe that drains late', async () => {
  await start();
  const paths = Array.from({ length: 20 }, (_, i) => join(repo, `${'d'.repeat(4_000)}${i}.ts`));
  const transcript_path = transcript(...paths.map((p, i) => edited(`e${i}`, p)));
  const r = await entry('stop', JSON.stringify({ session_id: 's-big', cwd: repo, transcript_path }), { FEEDBACK_GRAPH_URL: api.url }, { slowReader: true });
  expect(r.code).toBe(0);
  expect(r.out.length).toBeGreaterThan(131_072);
  expect(JSON.parse(r.out).decision).toBe('block');
});

test('PreToolUse cuts a module context past Claude Code\'s 10,000-character limit between lines, and says so', async () => {
  const module = ['# Module context for src/db/pool.ts', '## Lessons for this file (400)', ...Array.from({ length: 400 }, (_, i) => `- **Lesson ${i}**: always release the client in finally`)].join('\n');
  await start({ module });
  const text = context(await run('edit', { session_id: 's-cap', cwd: repo, tool_name: 'Edit', tool_input: { file_path: 'src/db/pool.ts' } })).additionalContext;
  expect(text.length).toBeLessThan(10_000);
  expect(text).toMatch(/\n- \*\*Lesson \d+\*\*: always release the client in finally\n\(truncated: call get_module_context with this path for the rest\)$/);
});

test('Stop and PreToolUse count an edit inside the repository but outside the session\'s cwd', async () => {
  await start();
  const sub = join(repo, 'packages', 'api');
  execFileSync('mkdir', ['-p', sub]);
  const other = join(repo, 'packages', 'core', 'x.ts');
  const out = JSON.parse((await run('stop', { session_id: 's-sub', cwd: sub, transcript_path: transcript(edited('e1', other)) })).stdout);
  expect(out.reason).toContain(other);
  expect(context(await run('edit', { session_id: 's-sub', cwd: sub, tool_name: 'Edit', tool_input: { file_path: other } })).additionalContext).toBe(MODULE_MD);
  expect((await run('edit', { session_id: 's-sub', cwd: sub, tool_name: 'Edit', tool_input: { file_path: join(temp, 'elsewhere.ts') } })).stdout).toBe('');
});

test('outside a git repo the context is still added, and Stop asks for the diff from HEAD', async () => {
  await start();
  const folder = join(temp, 'plain');
  execFileSync('mkdir', [folder]);
  expect(context(await run('prompt', { session_id: 's-7', cwd: folder, prompt: 'Fix the leak in src/db/pool.ts please' })).additionalContext).toContain('Release pool clients');
  const out = JSON.parse((await run('stop', { session_id: 's-7', cwd: folder, transcript_path: transcript(edited('e1', 'a.ts')) })).stdout);
  expect(out.reason).toContain('git diff HEAD');
});

test('SessionStart reports a refused run registration by status only', async () => {
  await start({ status: 409 });
  const r = await run('session', { session_id: 's-8' }, { FG_RUN: 'labelled' });
  expect(r.stderr).toContain('HTTP 409');
  expect(r.stdout + r.stderr).not.toContain('nope');
  expect(api.requests[0]).toMatchObject({ method: 'POST', path: '/api/sessions/s-8/run', headers: { 'x-fg-run': 'labelled' } });
});
