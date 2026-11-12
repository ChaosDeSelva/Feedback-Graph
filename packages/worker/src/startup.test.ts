import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigError, type Store } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { embedMismatch, fatalError, openWorkerStore, runStartupPasses, type StartupPassDeps } from './startup.ts';

const config = { ollama: { url: 'http://ollama:11434', model: 'qwen', embedModel: 'nomic-embed-text' }, stateDb: join(mkdtempSync(join(tmpdir(), 'fg-startup-')), 'worker.sqlite') } as Parameters<typeof openWorkerStore>[0];

function store(o: { schema?: () => Promise<void>; stored?: string } = {}) {
  const calls: string[] = [];
  const s = {
    kind: 'neo4j',
    ensureSchema: async () => { calls.push('schema'); await o.schema?.(); },
    embeddings: { check: async (model: string) => { calls.push(`check ${model}`); return { ok: !o.stored || o.stored === model, stored: o.stored ?? model }; } },
    facts: { requeueStaleScans: async () => { calls.push('requeue scans'); } },
    docs: { requeueStaleDocs: async () => { calls.push('requeue docs'); } },
  } as unknown as Store;
  return { s, calls };
}

describe('openWorkerStore', () => {
  test('makes sure of the schema and the embedding model, then puts work a dead worker left mid-way back in the queue', async () => {
    const f = store();
    const logs: unknown[] = [];
    expect(await openWorkerStore(config, async () => f.s, (msg, extra) => logs.push([msg, extra]))).toBe(f.s);
    expect(f.calls).toEqual(['schema', 'check nomic-embed-text', 'requeue scans', 'requeue docs']);
    expect(logs).toEqual([['store', { store: 'neo4j' }]]);
  });

  test('a restore cut short while replacing the store and state/ stops the start before the store is opened', async () => {
    const marker = join(dirname(config.stateDb), '.restore-incomplete');
    writeFileSync(marker, 'a restore from backups/b1 did not finish: run ./scripts/restore.sh backups/b1\n');
    try {
      const f = store();
      await expect(openWorkerStore(config, async () => f.s, () => {})).rejects.toThrow('a restore from backups/b1 did not finish: run ./scripts/restore.sh backups/b1');
      expect(f.calls).toEqual([]);
    } finally {
      rmSync(marker);
    }
  });

  test('vectors made with another model stop the start with what to do, before anything is requeued', async () => {
    const f = store({ stored: 'mxbai-embed-large' });
    const err = await openWorkerStore(config, async () => f.s, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain(embedMismatch('mxbai-embed-large', 'nomic-embed-text'));
    expect(f.calls).not.toContain('requeue scans');
  });

  test('a store that cannot be reached, or a schema statement that fails (a Neo4j deadlock), fails the start', async () => {
    await expect(openWorkerStore(config, async () => { throw new Error('ServiceUnavailable: connect ECONNREFUSED'); }, () => {})).rejects.toThrow('ECONNREFUSED');
    const f = store({ schema: async () => { throw new Error('Neo.TransientError.Transaction.DeadlockDetected'); } });
    await expect(openWorkerStore(config, async () => f.s, () => {})).rejects.toThrow('DeadlockDetected');
    expect(f.calls).toEqual(['schema']);
  });
});

test('embedMismatch names both models and both ways out', () => {
  expect(embedMismatch('a', 'b')).toBe('OLLAMA_EMBED_MODEL is b but the stored vectors were embedded with a. Set it back to a, or re-embed: docker compose run --rm worker node src/reembed.ts');
});

test('a fatal error logs a ConfigError as written, anything else with secrets removed', () => {
  expect(fatalError(new ConfigError(['STORE=postgres needs DATABASE_URL']))).toBe(new ConfigError(['STORE=postgres needs DATABASE_URL']).message);
  const msg = fatalError(new Error('could not connect: postgres://fg:s3cr3tpassw0rd@db:5432/fg'));
  expect(msg).toContain('could not connect');
  expect(msg).not.toContain('s3cr3tpassw0rd');
});

describe('runStartupPasses', () => {
  function passes(over: Partial<StartupPassDeps> = {}) {
    const calls: string[] = [];
    const logs: { msg: string; extra?: object }[] = [];
    const d: StartupPassDeps = {
      log: (msg, extra) => logs.push({ msg, extra }),
      redactStored: async () => { calls.push('redact'); },
      startChats: async () => { calls.push('chats'); },
      skipPending: async () => { calls.push('skips'); return null; },
      sortOldMisses: async () => { calls.push('misses'); return null; },
      migrateDeciders: async () => { calls.push('deciders'); },
      backfillProposedAs: async () => { calls.push('proposedAs'); },
      repairs: async () => { calls.push('repairs'); },
      evidence: { load: async () => { calls.push('evidence load'); }, atStart: async () => { calls.push('evidence atStart'); } },
      reconcileDecisions: async () => { calls.push('decisions'); return { applied: 0, proposed: 0, overridden: 0 }; },
      ...over,
    };
    return { d, calls, logs };
  }

  test('run in order: the redaction pass before Ask answers start, the evidence gate last', async () => {
    const f = passes();
    await runStartupPasses(f.d);
    expect(f.calls).toEqual(['decisions', 'redact', 'chats', 'skips', 'misses', 'deciders', 'proposedAs', 'repairs', 'evidence load', 'evidence atStart']);
    expect(f.logs).toEqual([]);
  });

  test('a pass that ran says what it changed', async () => {
    const f = passes({ skipPending: async () => 4, sortOldMisses: async () => ({ marked: 2, restored: 0 }), reconcileDecisions: async () => ({ applied: 1, proposed: 0, overridden: 2 }) });
    await runStartupPasses(f.d);
    expect(f.logs).toEqual([
      { msg: 'learning loop decisions left applying settled', extra: { applied: 1, proposed: 0, overridden: 2 } },
      { msg: 'skip rules applied to pending Inbox items', extra: { skipped: 4 } },
      { msg: 'process-miss rule applied to past misses', extra: { marked: 2, restored: 0 } },
    ]);
  });

  test('each failing pass is logged without secrets and the rest still run (it is tried again next start)', async () => {
    const boom = (what: string) => async () => { throw new Error(`${what} failed: Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123456789`); };
    const f = passes({ reconcileDecisions: boom('decisions'), redactStored: boom('redact'), skipPending: boom('skip'), sortOldMisses: boom('miss'), migrateDeciders: boom('decider'), backfillProposedAs: boom('draft'), repairs: boom('repairs') });
    await runStartupPasses(f.d);
    expect(f.calls).toEqual(['chats', 'evidence load', 'evidence atStart']);
    expect(f.logs.map((l) => l.msg)).toEqual([
      'settling learning loop decisions left applying failed',
      'redaction over stored data failed',
      'skip rules over pending Inbox items failed',
      'process-miss rule over past misses failed',
      'lesson decider rule failed',
      "writer's draft backfill failed",
      'one-off repairs failed',
    ]);
    for (const l of f.logs) expect(JSON.stringify(l)).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123456789');
  });

  test('Ask answers failing to start fails the start', async () => {
    const f = passes({ startChats: async () => { throw new Error('chat store down'); } });
    await expect(runStartupPasses(f.d)).rejects.toThrow('chat store down');
    expect(f.calls).toEqual(['decisions', 'redact']);
  });
});
