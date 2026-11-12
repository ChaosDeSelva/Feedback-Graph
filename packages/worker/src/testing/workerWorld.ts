import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '@fb/core';

/** A project folder with one Claude Code session in it, and the worker's settings over a temporary directory. */
export function world() {
  const base = mkdtempSync(join(tmpdir(), 'fb-worker-int-'));
  const vibe = join(base, 'vibe');
  mkdirSync(join(vibe, 'demo'), { recursive: true });
  const transcripts = join(base, 'transcripts');
  const sessionDir = join(transcripts, join(vibe, 'demo').replaceAll('/', '-'));
  mkdirSync(sessionDir, { recursive: true });
  const line = (o: object) => JSON.stringify({ sessionId: 'w1', cwd: join(vibe, 'demo'), ...o });
  writeFileSync(join(sessionDir, 'w1.jsonl'), [
    line({ type: 'user', uuid: 'u0', timestamp: '2026-11-01T10:00:00Z', message: { content: 'add a search box' } }),
    line({ type: 'assistant', uuid: 'a1', timestamp: '2026-11-01T10:01:00Z', message: { content: [{ type: 'text', text: 'done' }] } }),
    line({ type: 'user', uuid: 'u1', timestamp: '2026-11-01T10:02:00Z', message: { content: 'no, this is still broken' } }),
  ].join('\n') + '\n');
  const env: Record<string, string> = {
    STORE: 'postgres',
    DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
    PROJECT_ROOTS: vibe,
    HOST_PROJECT_ROOTS: vibe,
    TRANSCRIPTS_DIR: transcripts,
    CODEX_SESSIONS_DIR: join(base, 'codex'),
    STATE_DB: join(base, 'state', 'state.db'),
    HEARTBEAT_FILE: join(base, 'heartbeat'),
    INGEST_PROJECTS: 'demo',
    // Nothing listens here: every model is down.
    OLLAMA_URL: 'http://127.0.0.1:9',
    POLL_SECONDS: '1',
  };
  mkdirSync(join(base, 'state'));
  return { base, vibe, env };
}

/** The store as the worker gets it, except that its close is recorded (the suite's store stays open). */
export function keptOpen(store: Store) {
  const s = { closed: false };
  const proxy = new Proxy(store, {
    get(target, key) {
      if (key === 'close') return async () => { s.closed = true; };
      const v = Reflect.get(target, key);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { store: proxy, s };
}

export async function until(cond: () => boolean | Promise<boolean>, what: () => unknown, ms = 30_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out; ${JSON.stringify(what())}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
