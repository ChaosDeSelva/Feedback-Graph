import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { withMarkdown, type Store } from '@fb/core';
import { describeStores } from '@fb/core/testing';
import { afterEach, expect, test, vi } from 'vitest';
import { FileState } from './state.ts';
import { keptOpen, until, world } from './testing/workerWorld.ts';
import { runWorker } from './worker.ts';

type Line = { msg: string; extra?: Record<string, unknown> };
const vec = (axis: number) => Array.from({ length: 768 }, (_, i) => (i === axis ? 1 : 0));
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((s) => new Promise((ok) => { s.closeAllConnections(); s.close(ok); })));
});

/** A stand-in on 127.0.0.1 answering `answer(path)` (status and JSON body), recording the paths and bodies asked. */
async function standIn(answer: (path: string) => [number, unknown]) {
  const paths: string[] = [];
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    paths.push(req.url ?? '');
    bodies.push(body);
    const [status, json] = answer(req.url ?? '');
    if (req.url === '/api/embed') {
      const n = (JSON.parse(body) as { input: string[] }).input.length;
      return res.end(JSON.stringify({ embeddings: Array.from({ length: n }, (_, i) => vec(i)) }));
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const address = server.address();
  return { url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, paths, bodies };
}

/**
 * Requests the worker makes in-process: only the stand-ins on 127.0.0.1, `github` (answering for api.github.com) and
 * `linear` (for api.linear.app) are reached, anything else is refused and kept.
 */
function loopbackOnly(github?: (path: string) => unknown, linear?: (query: string) => unknown) {
  const refused: string[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (github && url.origin === 'https://api.github.com') {
      const body = github(`${url.pathname}${url.search}`);
      return Promise.resolve(body === undefined ? new Response('{"message":"Not Found"}', { status: 404 }) : Response.json(body));
    }
    if (linear && url.origin === 'https://api.linear.app') return Promise.resolve(Response.json(linear(String(init?.body))));
    if (url.hostname !== '127.0.0.1') {
      refused.push(url.origin);
      return Promise.reject(new Error(`refused ${url.origin}`));
    }
    return real(input, init);
  });
  return refused;
}

/** How long a run may take to reach what a test waits for: Neo4j's first cycle on a loaded machine takes tens of seconds. */
const RUN_BUDGET_MS = 90_000;

/** Runs the worker on `store` until `done` holds, then sends SIGTERM and waits for it to stop. */
async function runUntil(env: Record<string, string>, store: Store, done: (logs: Line[]) => boolean | Promise<boolean>) {
  const signals = new EventEmitter();
  const exits: number[] = [];
  const logs: Line[] = [];
  const kept = keptOpen(store);
  const run = runWorker({ env, openStore: async () => kept.store, log: (msg, extra) => { logs.push({ msg, extra: extra as Record<string, unknown> }); }, signals: signals as unknown as NodeJS.Process, exit: (c) => exits.push(c) });
  await until(() => done(logs), () => [...new Set(logs.map((l) => l.msg))], RUN_BUDGET_MS);
  signals.emit('SIGTERM');
  await run;
  expect(exits).toEqual([0]);
  expect(kept.s.closed).toBe(true);
  return logs;
}
const logged = (logs: Line[], msg: string) => logs.filter((l) => l.msg === msg).map((l) => l.extra);

describeStores('worker wiring', (h) => {
  test('models that cannot be built, summaries off, Cloud, the Codex runner, saved integrations and an earlier selection', async () => {
    const w = world();
    const refused = loopbackOnly();
    const cloud = await standIn(() => [503, { error: 'down' }]);
    // A Codex session read under the old copy rule: it is read again.
    const codex = w.env.CODEX_SESSIONS_DIR;
    mkdirSync(codex, { recursive: true });
    const state = new FileState(w.env.STATE_DB);
    state.markIngested(join(codex, 'rollout-1.jsonl'), 10, 1, 1);
    state.close();
    // The owner already chose the projects to read: INGEST_PROJECTS no longer seeds them.
    await h.store.selection.setTracked(['demo']);
    // A scan asked of codex-cli, whose runner is down: the provider is parked, and no repository is copied.
    writeFileSync(join(w.vibe, 'demo', 'a.ts'), 'export const a = 1;\n');
    await h.store.facts.requestScan({ key: 'demo', name: 'demo', repoPath: join(w.vibe, 'demo') }, 'codex-cli');
    const env = {
      ...w.env,
      INGEST_PROJECTS: 'demo,other',
      EXCLUDE_PROJECTS: 'scratch',
      // A Claude token: post-mortems (and Ask) default to claude-cli. No OpenAI key: these three cannot be built.
      CLAUDE_CODE_OAUTH_TOKEN: 'not-a-real-token',
      CLASSIFY_LLM: 'openai:gpt-test',
      SCAN_LLM: 'openai:gpt-test',
      DOCS_LLM: 'openai:gpt-test',
      SUMMARY_LLM: 'off',
      INTEGRATIONS_FILE: join(w.base, 'integrations.json'),
      LINEAR_API_KEY: 'lin_api_test_not_real',
      CODEX_RUNNER_URL: 'http://127.0.0.1:9',
      CLOUD_URL: cloud.url,
      CLOUD_TOKEN: `fgc_pat_0123456789abcdef_${'a'.repeat(43)}`,
      SYNC_INTERVAL_MINUTES: '60',
    };
    writeFileSync(env.INTEGRATIONS_FILE, JSON.stringify({ github: { token: 'ghp_saved_in_settings', savedAt: '2026-11-01T00:00:00Z' } }));
    const logs = await runUntil(env, h.store, async (l) => l.some((x) => x.msg === 'cycle') && !!(await h.store.graph.workerStatus())?.lastError && cloud.paths.length > 0 && l.some((x) => x.msg.startsWith('scan provider parked')));

    expect(logged(logs, 'codex copy rule changed: Codex sessions are read again')).toEqual([{ files: 1, rule: 1 }]);
    expect(logged(logs, 'INGEST_PROJECTS only seeds a selection not made yet; the projects read are the ones chosen in Settings')).toEqual([{ ingestProjects: ['demo', 'other'] }]);
    expect(logged(logs, 'session summaries')).toEqual([{ enabled: false }]);
    expect(logged(logs, 'cloud sync')[0]).toMatchObject({ enabled: true, host: new URL(cloud.url).host });
    // The GitHub token saved in Settings wins; Linear's is from the environment.
    expect(logged(logs, 'integrations')[0]).toMatchObject({ github: 'app', linear: 'env' });
    expect(logs.find((l) => l.msg.startsWith('scan provider parked'))?.extra).toMatchObject({ provider: 'codex-cli' });
    const status = await h.store.graph.workerStatus();
    expect(status?.providers).toMatchObject({ classify: null, postmortem: 'claude-cli', scan: 'openai:gpt-test', summary: null, docs: null });
    expect(status?.off).toEqual(['summary']);
    expect(status?.cloudSync).toMatchObject({ host: new URL(cloud.url).host });
    // With no classifier the flagged turn waits for one, and /api/status says why.
    expect(status?.lastError).toBe('classifier unavailable: no classifier could be built (see the provider log line at startup)');
    expect(refused).toEqual([]);
  }, 4 * RUN_BUDGET_MS);

  test('a post-mortem model that cannot be built falls back to the local one; start-up passes over stored facts; a failing pass is logged redacted', async () => {
    const w = world();
    const refused = loopbackOnly();
    // Ollama answers embeddings only: every model call is refused as a bad request (a failure, not an outage).
    const ollama = await standIn((path) => (path === '/api/tags' ? [200, { models: [] }] : [400, { error: 'bad request' }]));
    writeFileSync(join(w.vibe, 'demo', 'a.ts'), 'export const a = 1;\n');
    // An older scan's facts: one about a.ts (checked by an older rule, no relevance yet), and 200 files of logs.
    const logFiles = Array.from({ length: 200 }, (_, i) => ({ path: `logs/run-${i}.txt`, hash: `h${i}` }));
    await h.store.facts.replaceProjectFacts('demo', [{ path: 'a.ts', lines: '1', kind: 'convention', statement: 'a is a constant', why: 'w', confidence: 1, embedding: vec(1) }], 'ollama:gemma4', [{ path: 'a.ts', hash: 'ha' }, ...logFiles]);
    // A scan the owner cancels just as the worker picks it up: it is not run.
    writeFileSync(join(w.vibe, 'demo', 'b.ts'), 'export const b = 2;\n');
    const scan = await h.store.facts.requestScan({ key: 'demo', name: 'demo', repoPath: join(w.vibe, 'demo') }, null);
    let claimed: boolean | null = null;
    // The instruction rule's read of pending Inbox items fails with a secret in its message.
    const store = new Proxy(h.store, {
      get(target, key) {
        if (key === 'facts') {
          return new Proxy(target.facts, {
            get(f, k) {
              if (k === 'claimQueuedScan') return async (id: string) => { await f.cancelQueuedScan(id); claimed = await f.claimQueuedScan(id); return claimed; };
              const v = Reflect.get(f, k);
              return typeof v === 'function' ? v.bind(f) : v;
            },
          });
        }
        if (key === 'graph') {
          return new Proxy(target.graph, {
            get(g, k) {
              if (k === 'pendingSessionItems') return async () => { throw new Error('connect failed: password=Sup3rS3cretValue!9'); };
              const v = Reflect.get(g, k);
              return typeof v === 'function' ? v.bind(g) : v;
            },
          });
        }
        const v = Reflect.get(target, key);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const heartbeat = '/tmp/fg-heartbeat';
    const before = existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : null;
    const env: Record<string, string> = { ...w.env, OLLAMA_URL: ollama.url, POSTMORTEM_LLM: 'openai:gpt-test' };
    // No HEARTBEAT_FILE: the beat goes where the image's health check reads it.
    delete env.HEARTBEAT_FILE;
    const started = Date.now();
    let logs: Line[];
    try {
      logs = await runUntil(env, store, (l) => claimed !== null && ['relevance scoring failed', 'instruction rule after ingest failed', 'facts rechecked', 'data files forgotten'].every((m) => l.some((x) => x.msg === m)));
      expect(Date.parse(readFileSync(heartbeat, 'utf8'))).toBeGreaterThanOrEqual(started - 1000);
    } finally {
      if (before === null) rmSync(heartbeat, { force: true });
      else writeFileSync(heartbeat, before);
    }
    expect(logs.filter((l) => l.msg === 'provider').map((l) => l.extra)).toContainEqual({ job: 'postmortem (fallback)', provider: `ollama:${'gemma4'}` });
    expect(logged(logs, 'data files forgotten').at(-1)).toMatchObject({ files: 200, projects: 1 });
    expect(claimed).toBe(false);
    expect(logged(logs, 'scan started')).toEqual([]);
    expect(await h.store.facts.scanJob(scan.id)).toMatchObject({ status: 'failed', error: 'Cancelled by you before the scan started' });
    expect(logged(logs, 'facts rechecked')[0]).toMatchObject({ checked: 1 });
    const failed = logged(logs, 'instruction rule after ingest failed')[0];
    expect(String(failed?.error)).toContain('connect failed: password=');
    expect(String(failed?.error)).not.toContain('Sup3rS3cretValue');
    expect(refused).toEqual([]);
  }, 4 * RUN_BUDGET_MS);

  test('a GitHub comment to post-mortem, a queued scan, an Ask question and a Codex session, a Linear key saved later, and no summary model', async () => {
    const w = world();
    const demo = join(w.vibe, 'demo');
    writeFileSync(join(demo, 'a.ts'), 'export const a = 1;\n');
    const git = (...args: string[]) => execFileSync('git', ['-C', demo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args]);
    git('init', '-q'); git('add', '.'); git('commit', '-qm', 'start'); git('remote', 'add', 'origin', 'https://github.com/acme/demo.git');
    // One open PR with one review comment, made just now.
    const now = new Date().toISOString();
    const pr = { number: 1, title: 'Scope the query', html_url: 'https://github.com/acme/demo/pull/1', user: { login: 'owner' }, state: 'open', updated_at: now, body: 'scoped', head: { ref: 'feature' } };
    const comment = { id: 11, in_reply_to_id: null, pull_request_review_id: null, diff_hunk: '@@ -1 +1 @@', user: { login: 'reviewer' }, body: 'This drops the tenant check: every query must stay scoped to the tenant.', path: 'a.ts', line: 1, original_line: 1, html_url: 'https://github.com/acme/demo/pull/1#discussion_r11', created_at: now };
    const asked: string[] = [];
    const linearAsked: string[] = [];
    const refused = loopbackOnly((path) => {
      asked.push(path);
      if (path.startsWith('/repos/acme/demo/pulls?')) return [pr];
      if (path === '/repos/acme/demo/pulls/1') return pr;
      if (path.startsWith('/repos/acme/demo/pulls/1/comments')) return [comment];
      if (path.startsWith('/repos/acme/demo/issues/1/comments') || path.startsWith('/repos/acme/demo/pulls/1/reviews') || path.startsWith('/repos/acme/demo/pulls/1/files')) return [];
      return undefined;
    }, (query) => {
      linearAsked.push(query);
      return { data: { searchIssues: { nodes: [] } } };
    });
    // Ollama answers every model call with a pushback classification: the comment reaches the Inbox, and the
    // post-mortem, which gets that instead of its own answer, fails.
    const pushback = { label: 'pushback', confidence: 0.95, summary: 'the reviewer says the tenant check is gone', signals: ['tenant check'] };
    const ollama = await standIn((path) => (path === '/api/tags' ? [200, { models: [] }] : [200, { message: { content: JSON.stringify(pushback) }, done: true }]));
    // The session that did the PR's work: on its branch, it edited a.ts before the review.
    const sessions = join(w.env.TRANSCRIPTS_DIR, demo.replaceAll('/', '-'));
    const line = (o: object) => JSON.stringify({ sessionId: 'w2', cwd: demo, gitBranch: 'feature', ...o });
    writeFileSync(join(sessions, 'w2.jsonl'), [
      line({ type: 'user', uuid: 'v0', timestamp: '2026-11-01T08:00:00Z', message: { content: 'scope the customer query' } }),
      line({ type: 'assistant', uuid: 'v1', timestamp: '2026-11-01T08:01:00Z', message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: join(demo, 'a.ts'), old_string: '1', new_string: '2' } }] } }),
      line({ type: 'user', uuid: 'v2', timestamp: '2026-11-01T08:02:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] } }),
    ].join('\n') + '\n');
    // A Codex session in the project.
    const day = join(w.env.CODEX_SESSIONS_DIR, '2026', '11', '01');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-2026-11-01-c1.jsonl'), [
      { timestamp: '2026-11-01T09:00:00Z', type: 'session_meta', payload: { id: 'c1', timestamp: '2026-11-01T09:00:00Z', cwd: demo } },
      { timestamp: '2026-11-01T09:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list the routes' }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    await h.store.facts.requestScan({ key: 'demo', name: 'demo', repoPath: demo }, null);
    const chat = await h.store.chats.createConversation({ projectKey: 'demo', title: 'routes', provider: null });
    await h.store.chats.addUserTurn(chat.id, 'Which routes are there?', { context: '', sources: [] });
    // A chat that picked Claude, with no Claude token here: its turn fails, and the default model's health is untouched.
    const claude = await h.store.chats.createConversation({ projectKey: 'demo', title: 'claude', provider: 'claude' });
    await h.store.chats.addUserTurn(claude.id, 'Which routes are there?', { context: '', sources: [] });
    const integrationsFile = join(w.base, 'integrations.json');
    const env = { ...w.env, OLLAMA_URL: ollama.url, GITHUB_TOKEN: 'ghp_test_not_real', SUMMARY_LLM: 'openai:gpt-test', INTEGRATIONS_FILE: integrationsFile };

    // The owner confirms the PR comment: its post-mortem runs with no Linear key. Then a Linear key is saved in
    // Settings and the session's pushback is confirmed: that post-mortem searches Linear too.
    let step = 0;
    const answered = async (id: string) => (await h.store.chats.conversation(id))?.turns.find((t) => t.role === 'assistant' && (t.status === 'failed' || t.status === 'done'));
    const logs = await runUntil(env, h.store, async (l) => {
      const failed = l.filter((x) => x.msg === 'postmortem failed').length;
      if (step === 0 && l.some((x) => x.msg === 'comments synced')) {
        const [item] = await h.store.graph.pendingExternalItems({ limit: 10 });
        if (item) { await h.store.graph.decide(item.id, 'confirmed', null); step = 1; }
      } else if (step === 1 && failed === 1) {
        expect(linearAsked).toEqual([]);
        writeFileSync(integrationsFile, JSON.stringify({ linear: { token: 'lin_api_saved_not_real', savedAt: now } }));
        // The pushback's session has a summary by now: the post-mortem reads it.
        await h.store.sessions.save('w1', { summary: withMarkdown({ goal: 'add a search box', done: ['built it'], decisions: [], openThreads: [], filesTouched: ['a.ts'], pushback: ['still broken'], outcome: 'broken' }), prevVersion: 0, rebuild: false, from: null, to: { index: 2, ts: '2026-11-01T10:02:00Z' }, deltaTurns: 3, model: 'fake', state: 'idle' });
        const [item] = await h.store.graph.pendingSessionItems({ limit: 10 });
        if (item) { await h.store.graph.decide(item.id, 'confirmed', null); step = 2; }
      }
      return step === 2 && failed === 2 && l.some((x) => x.msg === 'github synced') && l.some((x) => x.msg === 'scan failed' || x.msg === 'scan done') && !!(await answered(chat.id)) && !!(await answered(claude.id));
    });

    expect(logged(logs, 'integrations')[0]).toMatchObject({ github: 'env', linear: 'none' });
    expect(linearAsked.length).toBeGreaterThan(0);
    expect((await answered(claude.id))?.status).toBe('failed');
    expect(logged(logs, 'comments synced')[0]).toMatchObject({ github: 1 });
    expect(logged(logs, 'github synced')[0]).toMatchObject({ prs: 1 });
    expect(asked).toContain('/repos/acme/demo/pulls/1/comments?per_page=100');
    expect(logged(logs, 'postmortem failed')[0]).toMatchObject({ feedbackId: expect.any(String) });
    expect(logged(logs, 'provider unavailable')).toContainEqual({ job: 'summary', spec: 'openai:gpt-test', error: 'Error: OPENAI_API_KEY is not set' });
    // The two Claude Code sessions, the Codex one and the PR's thread.
    expect(await h.probe.count('Session')).toBe(4);
    expect(refused).toEqual([]);
  }, 4 * RUN_BUDGET_MS);

  test('a confirmed miss in a project whose folder no root holds any more still gets its post-mortem, with the folder\'s own instructions', async () => {
    const w = world();
    const refused = loopbackOnly();
    const demo = join(w.vibe, 'demo');
    writeFileSync(join(demo, 'CLAUDE.md'), 'Always scope queries to the tenant.\n');
    const pushback = { label: 'pushback', confidence: 0.95, summary: 'the search box is still broken', signals: ['still broken'] };
    const ollama = await standIn((path) => (path === '/api/tags' ? [200, { models: [] }] : [200, { message: { content: JSON.stringify(pushback) }, done: true }]));
    const env = { ...w.env, OLLAMA_URL: ollama.url };
    // First the folder is under the roots: its session is read and the pushback reaches the Inbox.
    await runUntil(env, h.store, async () => (await h.store.graph.pendingSessionItems({ limit: 10 })).length > 0);
    const [item] = await h.store.graph.pendingSessionItems({ limit: 10 });
    await h.store.graph.decide(item.id, 'confirmed', null);
    // Then the roots change: the folder is under none of them.
    const elsewhere = join(w.base, 'elsewhere');
    mkdirSync(elsewhere);
    ollama.bodies.length = 0;
    const logs = await runUntil({ ...env, PROJECT_ROOTS: elsewhere, HOST_PROJECT_ROOTS: elsewhere }, h.store, (l) => l.some((x) => x.msg === 'postmortem failed'));
    expect(logged(logs, 'postmortem failed')[0]).toMatchObject({ feedbackId: expect.any(String) });
    // The post-mortem's prompt holds the project's own CLAUDE.md, read from its folder.
    expect(ollama.bodies.some((b) => b.includes('Always scope queries to the tenant.'))).toBe(true);
    expect(refused).toEqual([]);
  }, 4 * RUN_BUDGET_MS);
});
