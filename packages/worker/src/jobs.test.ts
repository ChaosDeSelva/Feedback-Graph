import { ProviderUnavailableError, RUNNER_READINESS_CURSOR, type Candidate, type LlmProvider, type ScanJob } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldersWithRemotes, githubDocTargets, isAgenticSpec, providerFactory, readDocsRound, RetentionPacer, reviewedPaths, RunnerReport, runnerDisabledFlag, runScanJob, Sometimes, type ScanJobDeps } from './jobs.ts';
import type { ScanResult } from './scan/scan.ts';

type Logged = { msg: string; extra?: Record<string, unknown> };
const logger = () => {
  const logs: Logged[] = [];
  return { logs, log: (msg: string, extra?: object) => { logs.push({ msg, extra: extra as Record<string, unknown> }); } };
};
const llm = (id: string) => ({ id }) as LlmProvider;
const SECRET = 'ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789';

describe('providerFactory', () => {
  test('logs the provider built for a job', () => {
    const l = logger();
    const p = providerFactory((spec) => llm(spec), l.log)('scan', 'ollama:qwen');
    expect(p?.id).toBe('ollama:qwen');
    expect(l.logs).toEqual([{ msg: 'provider', extra: { job: 'scan', provider: 'ollama:qwen' } }]);
  });

  test('one that cannot be built is null, logged, and its reason passed on', () => {
    const l = logger();
    let why = '';
    const make = providerFactory(() => { throw new Error('ANTHROPIC_API_KEY is not set'); }, l.log);
    expect(make('chat', 'anthropic:claude', (r) => (why = r))).toBeNull();
    expect(why).toBe('ANTHROPIC_API_KEY is not set');
    expect(l.logs[0]).toEqual({ msg: 'provider unavailable', extra: { job: 'chat', spec: 'anthropic:claude', error: 'Error: ANTHROPIC_API_KEY is not set' } });
    // A non-Error throw still gives a reason; no `why` is fine.
    expect(providerFactory(() => { throw 'bad spec'; }, l.log)('x', 'y', (r) => (why = r))).toBeNull();
    expect(why).toBe('bad spec');
    expect(providerFactory(() => { throw 'bad'; }, l.log)('x', 'y')).toBeNull();
  });
});

test('CLI agents that explore the repo themselves are agentic; API and local models are not', () => {
  expect(['claude-cli', 'codex-cli', 'claude-cli:opus', 'codex-cli:gpt-5'].every(isAgenticSpec)).toBe(true);
  expect(['ollama:qwen', 'anthropic:claude', 'claude-clix', 'openai:codex-cli'].some(isAgenticSpec)).toBe(false);
});

describe('readDocsRound', () => {
  test('stops at the first upload read', async () => {
    const results = [{ read: false }, { read: true }, { read: true }];
    let calls = 0;
    expect(await readDocsRound(async () => results[calls++], () => {})).toBe(true);
    expect(calls).toBe(2);
  });

  test('passes over a few skipped uploads at most', async () => {
    let calls = 0;
    expect(await readDocsRound(async () => { calls++; return { read: false }; }, () => {})).toBe(false);
    expect(calls).toBe(5);
  });

  test('nothing to read, the model down, or an error ends the round', async () => {
    let calls = 0;
    expect(await readDocsRound(async () => { calls++; return null; }, () => {})).toBe(false);
    expect(await readDocsRound(async () => { calls++; return { read: false, unavailable: 'ollama down' }; }, () => {})).toBe(false);
    const l = logger();
    expect(await readDocsRound(async () => { calls++; throw new Error(`fetch ${SECRET}`); }, l.log)).toBe(false);
    expect(calls).toBe(3);
    expect(l.logs[0].msg).toBe('document reading failed');
    expect(JSON.stringify(l.logs)).not.toContain(SECRET);
  });
});

test('reviewedPaths: the files GitHub review comments are on, once each', async () => {
  const asked: unknown[] = [];
  const repo = {
    listCandidates: async (f?: unknown) => {
      asked.push(f);
      return [{ external: { path: 'src/a.ts' } }, { external: { path: 'src/b.ts' } }, { external: { path: 'src/a.ts' } }, { external: {} }, {}] as Candidate[];
    },
  };
  expect(await reviewedPaths(repo, 'demo')).toEqual(['src/a.ts', 'src/b.ts']);
  expect(asked).toEqual([{ projectKey: 'demo', source: 'github', limit: 500 }]);
});

describe('runScanJob', () => {
  const job = (o: Partial<ScanJob> = {}) => ({ id: 'j1', projectKey: 'demo', repoPath: '/vibe/demo', provider: null, ...o }) as ScanJob;
  const done: ScanResult = { filesScanned: 3, factsAdded: 2, failed: 0, remaining: 0 };

  function deps(over: Partial<ScanJobDeps> = {}) {
    const l = logger();
    const updates: unknown[] = [];
    const calls: string[] = [];
    const d: ScanJobDeps = {
      inScope: () => true,
      facts: { updateScanJob: async (id, patch) => { updates.push([id, patch]); } },
      provider: (spec) => llm(spec),
      defaultSpec: 'ollama:qwen',
      mapProject: async (p) => { calls.push(`map ${p.key}`); },
      scan: async (_j, m) => { calls.push(`scan ${m.id}`); return done; },
      log: l.log,
      ...over,
    };
    return { d, updates, calls, logs: l.logs };
  }

  test('maps the project first, scans with the job\'s model (else the default), and logs the result', async () => {
    const f = deps();
    expect(await runScanJob(job({ provider: 'codex-cli' }), f.d)).toBe(true);
    expect(f.calls).toEqual(['map demo', 'scan codex-cli']);
    expect(f.logs.map((l) => l.msg)).toEqual(['scan started', 'scan done']);
    expect(f.logs[1].extra).toEqual({ project: 'demo', ...done });
    await runScanJob(job(), f.d);
    expect(f.calls.at(-1)).toBe('scan ollama:qwen');
  });

  test('a sharded scan going on after giving way is not mapped again, and its turn is passed on', async () => {
    let gotTurn: unknown;
    const f = deps({ scan: async (_j, _m, turn) => { gotTurn = turn; return { ...done, paused: true }; } });
    const turn = { waiting: async () => false };
    expect(await runScanJob(job({ shards: { total: 4, rescanned: 0, failed: 0, done: 2, processed: ['a', 'b'] } }), f.d, turn)).toBe(true);
    expect(f.calls).toEqual([]);
    expect(gotTurn).toBe(turn);
    // Paused, not done: the scan's counts so far are not logged as its result.
    expect(f.logs.map((l) => l.msg)).toEqual(['scan started']);
  });

  test('a project selected after the held scope was read is scanned: the selection is awaited, not assumed', async () => {
    const f = deps({ inScope: async () => true });
    expect(await runScanJob(job(), f.d)).toBe(true);
    expect(JSON.stringify(f.updates)).not.toContain('not selected');
  });

  test('a project no longer selected (or excluded) fails the job without a model', async () => {
    const f = deps({ inScope: () => false });
    expect(await runScanJob(job(), f.d)).toBe(true);
    expect(f.updates).toEqual([['j1', { status: 'failed', error: 'project is not selected in Settings, or is in EXCLUDE_PROJECTS' }]]);
    expect(f.calls).toEqual([]);
  });

  test('a model that cannot be built fails the job and says why', async () => {
    const f = deps({ provider: (_spec, why) => { why('OPENAI_API_KEY is not set'); return null; } });
    expect(await runScanJob(job({ provider: 'openai:gpt' }), f.d)).toBe(true);
    expect(f.updates).toEqual([['j1', { status: 'failed', error: 'provider unavailable: openai:gpt: OPENAI_API_KEY is not set' }]]);
    const g = deps({ provider: () => null });
    await runScanJob(job(), g.d);
    expect(g.updates).toEqual([['j1', { status: 'failed', error: 'provider unavailable: ollama:qwen' }]]);
  });

  test('a model that does not answer leaves the scan queued; it is not progress, so the loop sleeps', async () => {
    const f = deps({ scan: async () => { throw new ProviderUnavailableError('ollama: connection refused'); } });
    expect(await runScanJob(job(), f.d)).toBe(false);
    expect(f.logs.at(-1)).toEqual({ msg: 'scan model unavailable, the scan stays queued', extra: { project: 'demo', reason: 'ollama: connection refused' } });
    expect(f.updates).toEqual([]);
  });

  test('a scan that fails otherwise is logged without secrets', async () => {
    const f = deps({ scan: async () => { throw new Error(`git clone https://x:${SECRET}@github.com failed`); } });
    expect(await runScanJob(job(), f.d)).toBe(false);
    expect(f.logs.at(-1)?.msg).toBe('scan failed');
    expect(JSON.stringify(f.logs)).not.toContain(SECRET);
  });
});

describe('RetentionPacer', () => {
  const day = 86_400_000;

  test('removes old turn text at most every six hours, keeping unsummarized turns while summaries are on', async () => {
    const pruned: { before: string; keep: boolean }[] = [];
    const l = logger();
    const r = new RetentionPacer({ days: 30, keepUnsummarized: true, prune: async (before, o) => { pruned.push({ before: before.toISOString(), keep: o.keepUnsummarized }); return 4; }, log: l.log });
    const t0 = Date.parse('2026-11-10T00:00:00Z');
    await r.tick(t0);
    await r.tick(t0 + 6 * 3600_000 - 1);
    await r.tick(t0 + 6 * 3600_000);
    expect(pruned).toEqual([
      { before: new Date(t0 - 30 * day).toISOString(), keep: true },
      { before: new Date(t0 + 6 * 3600_000 - 30 * day).toISOString(), keep: true },
    ]);
    expect(l.logs[0]).toEqual({ msg: 'retention: removed text of old unflagged turns', extra: { pruned: 4, days: 30 } });
  });

  test('off (no TURN_RETENTION_DAYS) prunes nothing; nothing pruned logs nothing', async () => {
    let calls = 0;
    const l = logger();
    await new RetentionPacer({ days: 0, keepUnsummarized: false, prune: async () => { calls++; return 1; }, log: l.log }).tick();
    expect(calls).toBe(0);
    await new RetentionPacer({ days: 7, keepUnsummarized: false, prune: async () => { calls++; return 0; }, log: l.log }).tick();
    expect(calls).toBe(1);
    expect(l.logs).toEqual([]);
  });
});

describe('Sometimes', () => {
  test('runs when due, never two rounds at once, and again once due after a failure (logged, redacted)', async () => {
    const l = logger();
    let runs = 0;
    let release: () => void = () => {};
    const s = new Sometimes({
      everyMs: 60_000, what: 'link detection', log: l.log,
      run: () => { runs++; return runs === 1 ? new Promise<void>((res) => { release = res; }) : Promise.reject(new Error(`boom ${SECRET}`)); },
    });
    const first = s.tick(1_000_000);
    expect(s.tick(1_000_000 + 120_000)).toBeUndefined(); // still running
    release();
    await first;
    expect(s.tick(1_000_000 + 59_999)).toBeUndefined(); // not due
    await s.tick(1_000_000 + 60_000);
    expect(runs).toBe(2);
    expect(l.logs[0].msg).toBe('link detection failed');
    expect(JSON.stringify(l.logs)).not.toContain(SECRET);
    await s.tick(1_000_000 + 120_000);
    expect(runs).toBe(3);
  });
});

test('foldersWithRemotes: the stored remote, else the folder\'s own', async () => {
  const asked: string[] = [];
  const r = await foldersWithRemotes(
    [{ key: 'a', remote: 'git@github.com:o/a.git' }, { key: 'b', remote: null }],
    [{ key: 'a', repoPath: '/vibe/a' }, { key: 'b', repoPath: '/vibe/b' }, { key: 'c', repoPath: '/vibe/c' }],
    async (p) => { asked.push(p); return p === '/vibe/b' ? 'git@github.com:o/b.git' : null; },
  );
  expect(r).toEqual([
    { key: 'a', repoPath: '/vibe/a', remote: 'git@github.com:o/a.git' },
    { key: 'b', repoPath: '/vibe/b', remote: 'git@github.com:o/b.git' },
    { key: 'c', repoPath: '/vibe/c', remote: null },
  ]);
  expect(asked).toEqual(['/vibe/b', '/vibe/c']);
});

describe('RunnerReport', () => {
  test('no CODEX_RUNNER_URL: nothing is asked or written', async () => {
    const writes: unknown[] = [];
    const r = new RunnerReport({ url: undefined, readiness: async () => { throw new Error('asked'); }, cursors: { setCursor: async (...a) => { writes.push(a); } }, log: () => {} });
    await r.report();
    expect(writes).toEqual([]);
    expect(r.pending()).toBeUndefined();
  });

  test('publishes the readiness with its reason redacted; reports at once share one ask', async () => {
    const writes: [string, string][] = [];
    let asks = 0;
    const r = new RunnerReport({
      url: 'http://runner:8080',
      readiness: async () => { asks++; return { ok: false, reason: `codex login expired for token ${SECRET}` }; },
      cursors: { setCursor: async (k, v) => { writes.push([k, v]); } },
      log: () => {},
      now: () => 42,
    });
    const a = r.report();
    expect(r.report()).toBe(a);
    expect(r.pending()).toBe(a);
    await a;
    expect(asks).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(RUNNER_READINESS_CURSOR);
    const v = JSON.parse(writes[0][1]);
    expect(v).toMatchObject({ ok: false, at: 42 });
    expect(v.reason).toContain('codex login expired');
    expect(v.reason).not.toContain(SECRET);
    expect(r.pending()).toBeUndefined();
    await r.report();
    expect(asks).toBe(2);
  });

  test('a ready runner is published with no reason; a failed report is logged and the next one tries again', async () => {
    const writes: string[] = [];
    const l = logger();
    let fail = true;
    const r = new RunnerReport({
      url: 'http://runner:8080',
      readiness: async () => { if (fail) throw new Error('ECONNREFUSED'); return { ok: true, reason: null }; },
      cursors: { setCursor: async (_k, v) => { writes.push(v); } },
      log: l.log,
    });
    await r.report();
    expect(l.logs).toEqual([{ msg: 'runner readiness report failed', extra: { error: 'Error: ECONNREFUSED' } }]);
    fail = false;
    await r.report();
    expect(JSON.parse(writes[0])).toMatchObject({ ok: true, reason: null });
  });
});

describe('runner safety flag', () => {
  test('a flag on disk is reported as the runner turned off, with its reasons, and the runner is not asked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fg-flag-'));
    const flag = join(dir, 'codex-runner-disabled');
    expect(await runnerDisabledFlag(flag)).toBeNull();
    writeFileSync(flag, 'procfs: nested sandbox could not mount proc\nsandbox: nested sandbox startup failed\x07\n\n');
    expect(await runnerDisabledFlag(flag)).toBe('procfs: nested sandbox could not mount proc; sandbox: nested sandbox startup failed');
    writeFileSync(flag, '');
    expect(await runnerDisabledFlag(flag)).toBe('no reason recorded');
    const writes: string[] = [];
    let asks = 0;
    const r = new RunnerReport({ url: 'http://runner:8790', readiness: async () => { asks++; return { ok: true, reason: null }; }, disabled: () => runnerDisabledFlag(flag), cursors: { setCursor: async (_k, v) => { writes.push(v); } }, log: () => {} });
    await r.report();
    expect(asks).toBe(0);
    expect(JSON.parse(writes[0])).toMatchObject({ ok: false, disabled: true, reason: 'no reason recorded' });
    rmSync(dir, { recursive: true });
    await r.report();
    expect(asks).toBe(1);
    expect(JSON.parse(writes[1])).toMatchObject({ ok: true, reason: null });
    expect(JSON.parse(writes[1]).disabled).toBeUndefined();
  });
});

test('githubDocTargets: linked projects read their remote\'s repository (or the override), authors where set', async () => {
  const links: Record<string, { github: boolean; githubAuthor?: string | null }> = {
    a: { github: true, githubAuthor: 'alex' },
    b: { github: true },
    c: { github: false, githubAuthor: 'someone' },
    d: { github: true },
  };
  const r = await githubDocTargets(
    [
      { key: 'a', name: 'a', repoPath: '/vibe/a', remote: 'github.com/o/a' },
      { key: 'b', name: 'b', repoPath: '/vibe/b', remote: 'gitlab.com/o/b' },
      { key: 'c', name: 'c', repoPath: '/vibe/c', remote: 'github.com/o/c' },
      { key: 'd', name: 'd', repoPath: '/vibe/d', remote: null },
    ],
    async (key) => links[key],
    new Map([['d', 'o/d-override']]),
  );
  expect([...r.repos]).toEqual([['a', 'o/a'], ['d', 'o/d-override']]);
  expect([...r.authors]).toEqual([['a', 'alex'], ['c', 'someone']]);
});
