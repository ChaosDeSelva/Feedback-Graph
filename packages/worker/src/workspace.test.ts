import type { ProjectScope } from '@fb/core';
import { describe, expect, test } from 'vitest';
import type { CandidateBuild } from './projects/candidates.ts';
import { FileState } from './state.ts';
import { Workspace, type WorkspaceDeps } from './workspace.ts';

const scopeOf = (projects: string[]): ProjectScope => ({ projects, project: (k) => projects.includes(k), folder: (k) => projects.includes(k) });
const build = (folderOf: [string, string | string[] | null][]): CandidateBuild =>
  ({ candidates: [], outsideRoots: { claudeSessions: 0, codexSessions: 0 }, folderOf: new Map(folderOf) }) as unknown as CandidateBuild;

function workspace(over: Partial<WorkspaceDeps> = {}) {
  const logs: { msg: string; extra?: Record<string, unknown> }[] = [];
  const saved: unknown[] = [];
  const state = new FileState(':memory:');
  let selected: string[] = [];
  const forgotten = { seq: 0, keys: [] as string[] };
  const d: WorkspaceDeps = {
    selection: { saveCandidates: async (s) => { saved.push(s); }, forgottenReads: async (after) => (after < forgotten.seq ? forgotten : { seq: after, keys: [] }) },
    scopeNow: async () => scopeOf(selected),
    excludeProjects: ['secret'],
    state,
    transcriptsDir: '/transcripts',
    codexSessionsDir: '/codex',
    isDirectory: async () => true,
    listFiles: async () => [{ path: '/transcripts/-H-Vibe-demo/s1.jsonl', size: 1, mtimeMs: 1 }, { path: '/codex/r.jsonl', size: 1, mtimeMs: 1, source: 'codex' }],
    candidates: async () => build([]),
    memoryRoots: async () => [{ host: '/H/Vibe', keys: ['demo', 'other'] }],
    refreshLayout: async () => {},
    log: (msg, extra) => { logs.push({ msg, extra: extra as Record<string, unknown> }); },
    ...over,
  };
  const ws = new Workspace(d, scopeOf([]));
  return { ws, logs, saved, state, select: (keys: string[]) => { selected = keys; }, forget: (seq: number, keys: string[]) => Object.assign(forgotten, { seq, keys }) };
}

describe('refreshScope', () => {
  test('follows the selection, logging only when what is read changes', async () => {
    const f = workspace();
    await f.ws.refreshScope();
    await f.ws.refreshScope();
    f.select(['demo']);
    await f.ws.refreshScope();
    expect(f.ws.scope.projects).toEqual(['demo']);
    await f.ws.refreshScope();
    f.select(['demo', 'other']);
    await f.ws.refreshScope(); // still something to read: no new line
    f.select([]);
    await f.ws.refreshScope();
    expect(f.logs.map((l) => l.msg)).toEqual(['nothing to read', 'reading projects', 'nothing to read']);
    expect(f.logs[1].extra).toEqual({ projects: ['demo'] });
  });
});

describe('refreshLayout', () => {
  test('keeps selected and excluded top-level folders whole', async () => {
    let keepWhole: ((k: string) => boolean) | null = null;
    const f = workspace({ refreshLayout: async (k) => { keepWhole = k; } });
    f.select(['demo']);
    await f.ws.refreshScope();
    await f.ws.refreshLayout();
    expect(['demo', 'secret', 'other'].map((k) => keepWhole!(k))).toEqual([true, true, false]);
  });

  test('a layout that cannot be read is logged and the loop goes on', async () => {
    const f = workspace({ refreshLayout: async () => { throw new Error('EACCES: /vibe'); } });
    await f.ws.refreshLayout();
    expect(f.logs).toEqual([{ msg: 'project layout failed', extra: { error: 'Error: EACCES: /vibe' } }]);
  });
});

describe('refreshCandidates', () => {
  test('saves the candidate list for Settings and keeps each file\'s folder for ingest', async () => {
    let files: unknown;
    const f = workspace({ candidates: async (fs, codex) => { files = [fs, codex]; return build([['/transcripts/-H-Vibe-demo/s1.jsonl', 'demo']]); } });
    await f.ws.refreshCandidates();
    expect(f.ws.folderOf.get('/transcripts/-H-Vibe-demo/s1.jsonl')).toBe('demo');
    expect(f.saved).toEqual([{ candidates: [], outsideRoots: { claudeSessions: 0, codexSessions: 0 } }]);
    // A file listed without a source is a Claude transcript.
    expect(files).toEqual([[
      { path: '/transcripts/-H-Vibe-demo/s1.jsonl', size: 1, mtimeMs: 1, source: 'claude' },
      { path: '/codex/r.jsonl', size: 1, mtimeMs: 1, source: 'codex' },
    ], true]);
  });

  test('a missing Codex folder is logged once, and again if it goes missing after it came back', async () => {
    let found = false;
    let codexFound: boolean | null = null;
    const f = workspace({ isDirectory: async () => found, candidates: async (_fs, c) => { codexFound = c; return build([]); } });
    await f.ws.refreshCandidates();
    await f.ws.refreshCandidates();
    expect(codexFound).toBe(false);
    found = true;
    await f.ws.refreshCandidates();
    found = false;
    await f.ws.refreshCandidates();
    expect(f.logs.filter((l) => l.msg === 'no Codex sessions folder; carrying on without Codex sessions')).toHaveLength(2);
    expect(f.logs[0].extra).toEqual({ dir: '/codex' });
  });

  test('a failed candidate list is logged and the last folders are kept', async () => {
    let fail = false;
    const f = workspace({ candidates: async () => { if (fail) throw new Error('store down'); return build([['/t/a.jsonl', 'demo']]); } });
    await f.ws.refreshCandidates();
    fail = true;
    await f.ws.refreshCandidates();
    expect(f.ws.folderOf.get('/t/a.jsonl')).toBe('demo');
    expect(f.logs).toEqual([{ msg: 'candidate list failed', extra: { error: 'Error: store down' } }]);
  });
});

describe('forgetDeletedReads', () => {
  test('a deleted folder\'s transcripts and memory files are read again, older marks found by their path', async () => {
    const f = workspace({ candidates: async () => build([['/transcripts/-H-Vibe-demo/old.jsonl', 'demo'], ['/transcripts/-H-Vibe-x/codex.jsonl', ['other', 'demo']], ['/transcripts/none.jsonl', null]]) });
    await f.ws.refreshCandidates();
    f.state.markIngested('/transcripts/-H-Vibe-demo/new.jsonl', 1, 1, 1, { keys: ['demo'] });
    f.state.markIngested('/transcripts/-H-Vibe-demo/old.jsonl', 1, 1, 1); // before keys were kept
    f.state.markIngested('/transcripts/-H-Vibe-x/codex.jsonl', 1, 1, 1);
    f.state.markIngested('/transcripts/none.jsonl', 1, 1, 1);
    f.state.markIngested('/transcripts/-H-Vibe-other/s.jsonl', 1, 1, 1, { keys: ['other'] });
    f.state.mark('/transcripts/-H-Vibe-demo/memory/note.md', 1, 1); // a memory file, before keys were kept
    f.state.mark('/transcripts/-H-Vibe-other/memory/note.md', 1, 1);
    f.state.mark('/transcripts/-Elsewhere-x/memory/note.md', 1, 1); // under no project root: whose it is is unknown
    f.forget(3, ['demo']);
    await f.ws.forgetDeletedReads();
    expect(f.logs.at(-1)).toEqual({ msg: 'forgot reads of deleted projects, read again when selected', extra: { files: 4 } });
    expect(f.state.ingestState('/transcripts/-H-Vibe-demo/new.jsonl', 1, 1).changed).toBe(true);
    expect(f.state.ingestState('/transcripts/-H-Vibe-other/s.jsonl', 1, 1).changed).toBe(false);
    expect(f.state.ingestState('/transcripts/none.jsonl', 1, 1).changed).toBe(false);
    expect(f.state.changed('/transcripts/-H-Vibe-demo/memory/note.md', 1, 1)).toBe(true);
    expect(f.state.changed('/transcripts/-H-Vibe-other/memory/note.md', 1, 1)).toBe(false);
    expect(f.state.changed('/transcripts/-Elsewhere-x/memory/note.md', 1, 1)).toBe(false);

    // The same deletion is not applied twice (the cursor moved on); nothing dropped logs nothing.
    f.state.markIngested('/transcripts/-H-Vibe-demo/new.jsonl', 1, 1, 1, { keys: ['demo'] });
    const before = f.logs.length;
    await f.ws.forgetDeletedReads();
    expect(f.state.ingestState('/transcripts/-H-Vibe-demo/new.jsonl', 1, 1).changed).toBe(false);
    expect(f.logs).toHaveLength(before);
  });
});
