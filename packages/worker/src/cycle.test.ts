import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelTimeoutError, ProviderUnavailableError, type ActivityInput, type Classification, type HumanTurn, type ParsedSession, type Project } from '@fb/core';
import { describe, expect, test } from 'vitest';
import { runCycle, type CycleDeps } from './cycle.ts';
import { FileState } from './state.ts';
import { conversationFingerprint } from './ingest/fingerprint.ts';

const line = (o: object) => JSON.stringify({ sessionId: 's1', cwd: '/H/Vibe/demo', ...o });
const transcript = [
  line({ type: 'user', uuid: 'u0', timestamp: '2026-10-01T10:00:00Z', message: { content: 'build search' } }),
  line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:01:00Z', message: { content: [{ type: 'text', text: 'done' }] } }),
  line({ type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:02:00Z', message: { content: 'this is still broken' } }),
  line({ type: 'assistant', uuid: 'a2', timestamp: '2026-10-01T10:03:00Z', message: { content: [{ type: 'text', text: 'fixed' }] } }),
  line({ type: 'user', uuid: 'u2', timestamp: '2026-10-01T10:04:00Z', message: { content: 'add a footer' } }),
].join('\n');

function fakes(over: Partial<CycleDeps> = {}) {
  const turns = new Map<string, HumanTurn & { projectKey: string; label?: string }>();
  const saved: { uuid: string; c: Classification; cand: boolean }[] = [];
  const reads: string[] = [];
  const classifyCalls: string[] = [];
  const failures = new Map<string, number>();
  const deps: CycleDeps = {
    listFiles: async () => [{ path: '/t/demo/s1.jsonl', size: 100, mtimeMs: 1 }],
    readFile: async (p) => { reads.push(p); return transcript; },
    state: new FileState(':memory:'),
    repo: {
      upsertSession: async (project, s) => { for (const t of s.turns) if (!turns.has(t.uuid)) turns.set(t.uuid, { ...t, projectKey: project.key }); },
      unclassifiedTurns: async (limit) => [...turns.values()].filter((t) => !t.label && t.index > 0).slice(0, limit),
      saveClassification: async (uuid, c, cand) => { saved.push({ uuid, c, cand }); turns.get(uuid)!.label = c.label; return cand ? uuid : null; },
      recordClassifyFailure: async (uuid) => { failures.set(uuid, (failures.get(uuid) ?? 0) + 1); },
    },
    roots: [{ host: '/H/Vibe', container: '/vibe' }],
    commits: async () => [],
    classify: async (t) => { classifyCalls.push(t.uuid); return { label: 'pushback', confidence: 0.8, summary: 's', signals: ['x'] }; },
    classifyBatch: 50,
    ...over,
  };
  return { deps, saved, reads, classifyCalls, turns, failures, state: deps.state };
}

test('ingests, sends only prefilter hits to the model, and flags candidates', async () => {
  const f = fakes();
  const r = await runCycle(f.deps);
  expect(r).toEqual({ filesIngested: 1, turnsClassified: 2, candidates: 1 });
  expect(f.classifyCalls).toEqual(['u1']);
  expect(f.saved.find((s) => s.uuid === 'u1')?.cand).toBe(true);
  expect(f.saved.find((s) => s.uuid === 'u2')).toMatchObject({ cand: false, c: { label: 'neutral', confidence: 0 } });
});

test("the agent's final reply reaches the store with the session but is never classified, so it never becomes an Inbox item", async () => {
  const upserted: ParsedSession[] = [];
  const withReply = transcript + '\n' + line({ type: 'assistant', uuid: 'a3', timestamp: '2026-10-01T10:05:00Z', message: { content: [{ type: 'text', text: 'No, this is still broken: I could not add the footer.' }] } });
  const f = fakes({ readFile: async () => withReply });
  const upsert = f.deps.repo.upsertSession;
  f.deps.repo.upsertSession = async (p, s, c) => { upserted.push(s); return upsert(p, s, c); };
  const r = await runCycle(f.deps);
  expect(upserted[0].finalReply).toEqual({ text: 'No, this is still broken: I could not add the footer.', ts: '2026-10-01T10:05:00Z' });
  expect(upserted[0].turns).toHaveLength(3);
  expect(r).toEqual({ filesIngested: 1, turnsClassified: 2, candidates: 1 });
  expect(f.classifyCalls).toEqual(['u1']);
});

test('the candidate_flagged activity points at the Inbox item the turn was filed under (a merged agent report keeps its id)', async () => {
  const recorded: ActivityInput[] = [];
  const f = fakes({ activity: { record: async (a) => { recorded.push(a); } } });
  f.deps.repo.saveClassification = async (uuid, c, cand) => { f.saved.push({ uuid, c, cand }); f.turns.get(uuid)!.label = c.label; return cand ? 'manual:r1' : null; };
  await runCycle(f.deps);
  const flagged = recorded.filter((a) => a.kind === 'candidate_flagged');
  expect(flagged).toHaveLength(1);
  expect(flagged[0].targets).toEqual(['manual:r1']);
  expect(flagged[0].details).toMatchObject({ turnUuid: 'u1' });
});

test('an unchanged file is not re-read on the next cycle', async () => {
  const f = fakes();
  await runCycle(f.deps);
  await runCycle(f.deps);
  expect(f.reads).toHaveLength(1);
});

test('a null classification leaves the turn for the next cycle', async () => {
  const f = fakes({ classify: async () => null });
  const r = await runCycle(f.deps);
  expect(r.candidates).toBe(0);
  expect([...f.turns.values()].find((t) => t.uuid === 'u1')?.label).toBeUndefined();
});

test('one unreadable file does not stop the others', async () => {
  const f = fakes({
    listFiles: async () => [
      { path: '/t/bad.jsonl', size: 1, mtimeMs: 1 },
      { path: '/t/demo/s1.jsonl', size: 100, mtimeMs: 1 },
    ],
  });
  const base = f.deps.readFile;
  f.deps.readFile = async (p) => { if (p.includes('bad')) throw new Error('EACCES'); return base(p); };
  const r = await runCycle(f.deps);
  expect(r.filesIngested).toBe(1);
});

test('sessions outside every project root are skipped', async () => {
  const f = fakes({ roots: [{ host: '/elsewhere', container: '/x' }] });
  const r = await runCycle(f.deps);
  expect(r.filesIngested).toBe(0);
  expect(f.turns.size).toBe(0);
});

test('prefilter misses do not use up the model batch', async () => {
  const f = fakes({ classifyBatch: 1 });
  const r = await runCycle(f.deps);
  // u2 is a prefilter miss (neutral, no model); u1 is the one model call allowed.
  expect(r.turnsClassified).toBe(2);
  expect(f.classifyCalls).toEqual(['u1']);
});

test('each flagged candidate is logged with the classifier, its reasoning and the turn', async () => {
  const activity: ActivityInput[] = [];
  const f = fakes({
    classifierId: 'ollama:gemma4',
    classify: async () => ({ label: 'pushback', confidence: 0.8, summary: 'says the work is still broken', signals: ['still broken'] }),
    activity: { record: async (a) => { activity.push(a); } },
  });
  await runCycle(f.deps);
  expect(activity).toEqual([{
    kind: 'candidate_flagged', actor: 'ollama:gemma4', projectKey: 'demo',
    subject: 'flagged as pushback: "this is still broken"',
    why: 'says the work is still broken',
    details: { label: 'pushback', confidence: 0.8, signals: ['still broken'], sessionId: 's1', turnUuid: 'u1', prefilter: expect.any(String) },
    targets: ['u1'],
  }]);
});

test('sessions from projects outside the allowlist are not ingested', async () => {
  const f = fakes({ includeProject: (key) => key === 'other' });
  const r = await runCycle(f.deps);
  expect(r.filesIngested).toBe(0);
  expect(f.turns.size).toBe(0);
  expect(f.classifyCalls).toEqual([]);
});

test('a failed classification is counted against the turn', async () => {
  const f = fakes({ classify: async () => null });
  await runCycle(f.deps);
  expect(f.failures.get('u1')).toBe(1);
});

test('a model that keeps failing stops the cycle after 3 failures in a row', async () => {
  const many = Array.from({ length: 10 }, (_, i) => [
    line({ type: 'assistant', uuid: `a${i}`, timestamp: `2026-10-01T11:0${i}:00Z`, message: { content: [{ type: 'text', text: 'done' }] } }),
    line({ type: 'user', uuid: `p${i}`, timestamp: `2026-10-01T11:0${i}:30Z`, message: { content: 'this is still broken' } }),
  ]).flat();
  const f = fakes({ classify: async (t) => { f.classifyCalls.push(t.uuid); return null; } });
  f.deps.readFile = async () => [transcript, ...many].join('\n');
  await runCycle(f.deps);
  expect(f.classifyCalls).toHaveLength(3);
});

test('an unavailable model stops classifying for the cycle without charging any turn, and says why', async () => {
  const many = Array.from({ length: 5 }, (_, i) => [
    line({ type: 'assistant', uuid: `a${i}`, timestamp: `2026-10-01T11:0${i}:00Z`, message: { content: [{ type: 'text', text: 'done' }] } }),
    line({ type: 'user', uuid: `p${i}`, timestamp: `2026-10-01T11:0${i}:30Z`, message: { content: 'this is still broken' } }),
  ]).flat();
  const f = fakes({ classify: async (t) => { f.classifyCalls.push(t.uuid); throw new ProviderUnavailableError('cannot reach the model (ECONNREFUSED)'); } });
  f.deps.readFile = async () => [transcript, ...many].join('\n');
  const r = await runCycle(f.deps);
  expect(f.classifyCalls).toHaveLength(1);
  expect(f.failures.size).toBe(0);
  expect(r.classifierUnavailable).toBe('cannot reach the model (ECONNREFUSED)');
  // Prefilter misses need no model, so they are still labelled neutral.
  expect(f.saved.find((s) => s.uuid === 'u2')).toMatchObject({ c: { label: 'neutral' } });
  expect(f.saved.some((s) => s.uuid.startsWith('p') || s.uuid === 'u1')).toBe(false);
});

test('a classification that timed out is charged to that turn and the batch goes on, so one turn cannot stall the queue', async () => {
  const many = Array.from({ length: 3 }, (_, i) => [
    line({ type: 'assistant', uuid: `a${i}`, timestamp: `2026-10-01T11:0${i}:00Z`, message: { content: [{ type: 'text', text: 'done' }] } }),
    line({ type: 'user', uuid: `p${i}`, timestamp: `2026-10-01T11:0${i}:30Z`, message: { content: 'this is still broken' } }),
  ]).flat();
  const logged: [string, object | undefined][] = [];
  const f = fakes({
    log: (m, x) => { logged.push([m, x]); },
    classify: async (t) => {
      f.classifyCalls.push(t.uuid);
      if (t.uuid === 'u1') throw new ModelTimeoutError('Ollama (gemma4) did not answer within 120 s');
      return { label: 'pushback', confidence: 0.8, summary: 's', signals: [] };
    },
  });
  f.deps.readFile = async () => [transcript, ...many].join('\n');
  const r = await runCycle(f.deps);
  expect(f.failures.get('u1')).toBe(1);
  expect(f.classifyCalls).toEqual(['u1', 'p0', 'p1', 'p2']);
  expect(r.classifierUnavailable).toBeUndefined();
  expect(r.candidates).toBe(3);
  expect(logged.find(([m]) => m === 'classification failed')?.[1]).toMatchObject({ turn: 'u1', error: expect.stringMatching(/did not answer within 120 s/) });
});

test('while a scan holds the model, a classification that timed out charges nothing and classifying waits for the next cycle', async () => {
  const f = fakes({
    modelBusy: () => true,
    classify: async (t) => {
      f.classifyCalls.push(t.uuid);
      throw new ModelTimeoutError('Ollama (gemma4) did not answer within 120 s');
    },
  });
  const r = await runCycle(f.deps);
  expect(f.failures.size).toBe(0);
  expect(f.classifyCalls).toEqual(['u1']);
  expect(r.classifierUnavailable).toMatch(/busy with a scan.*did not answer/);
});

test('a file that fails to ingest is retried when it changes, not every cycle', async () => {
  const f = fakes();
  let reads = 0;
  f.deps.readFile = async () => { reads++; throw new Error('EACCES'); };
  await runCycle(f.deps);
  await runCycle(f.deps);
  expect(reads).toBe(1);
  f.deps.listFiles = async () => [{ path: '/t/demo/s1.jsonl', size: 200, mtimeMs: 2 }];
  await runCycle(f.deps);
  expect(reads).toBe(2);
});

test('a session skipped as out of scope is not lost: its file is read again once that folder is selected', async () => {
  let selected = false;
  const f = fakes({ includeProject: (k) => selected && k === 'demo' });
  await runCycle(f.deps);
  await runCycle(f.deps);
  expect(f.reads).toHaveLength(1);
  expect(f.turns.size).toBe(0);
  selected = true;
  expect((await runCycle(f.deps)).filesIngested).toBe(1);
  expect(f.reads).toHaveLength(2);
  expect(f.turns.size).toBe(3);
  await runCycle(f.deps);
  expect(f.reads).toHaveLength(2);
});

test('a transcript is written inside the exclusive section, against the selection as it is then', async () => {
  const sections: string[] = [];
  let deselected = false;
  const f = fakes({
    includeProject: () => true, // the scope the cycle started with
    exclusive: async (fn) => { sections.push('in'); deselected = true; try { return await fn(); } finally { sections.push('out'); } },
    // Read inside the section: the owner deselected demo (and cleaned it up) while the file was being parsed.
    scopeNow: async () => ({ folder: (k) => !deselected && k === 'demo', projects: deselected ? [] : ['demo'] }),
  });
  expect((await runCycle(f.deps)).filesIngested).toBe(0);
  expect(sections).toEqual(['in', 'out']);
  expect(f.turns.size).toBe(0);
  expect(f.state.ingestState('/t/demo/s1.jsonl', 100, 1)).toMatchObject({ changed: false, skipped: ['demo'] });
});

test('a graph outage during ingest leaves the file to be tried again next cycle', async () => {
  const f = fakes();
  let fail = true;
  const upsert = f.deps.repo.upsertSession;
  f.deps.repo.upsertSession = async (...a) => { if (fail) throw new Error('ServiceUnavailable'); return upsert(...a); };
  expect((await runCycle(f.deps)).filesIngested).toBe(0);
  fail = false;
  expect((await runCycle(f.deps)).filesIngested).toBe(1);
});

/** An in-memory stand-in for the graph's project table, with GraphRepo's aliasing rule. */
function projectTable(rows: Project[]) {
  const projects = new Map(rows.map((p) => [p.key, { ...p, aliases: [] as string[] }]));
  const repo: NonNullable<CycleDeps['projects']> = {
    canonicalProject: async (folder, o) => {
      const alias = [...projects.values()].find((p) => p.aliases.includes(folder.key));
      if (alias) return { project: alias, aliasedNow: false };
      if (projects.has(folder.key) || !folder.remote) return { project: folder, aliasedNow: false };
      const other = [...projects.values()].find((p) => p.remote === folder.remote);
      if (!other) return { project: folder, aliasedNow: false };
      if (o?.dryRun) return { project: other, aliasedNow: false };
      other.aliases.push(folder.key);
      return { project: other, aliasedNow: true };
    },
    projectsMissingFolder: async () => [...projects.values()].filter((p) => !p.remote || !p.repoPath),
    fillProjectFolder: async (key, f) => {
      const p = projects.get(key)!;
      if (!p.repoPath) p.repoPath = f.repoPath;
      if (!p.remote && f.remote) p.remote = f.remote;
    },
  };
  return { projects, repo };
}

describe('projects identified by git remote', () => {
  const main: Project = { key: 'demo-main', name: 'demo-main', repoPath: '/vibe/demo-main', remote: 'github.com/org/demo' };

  test('a second clone in another folder is recorded under the existing project, and the alias is logged once', async () => {
    const table = projectTable([main]);
    const activity: ActivityInput[] = [];
    const upserted: Project[] = [];
    const commitPaths: string[] = [];
    const f = fakes({
      remote: async (p) => (p === '/vibe/demo' ? 'github.com/org/demo' : null),
      projects: table.repo,
      activity: { record: async (a) => { activity.push(a); } },
      commits: async (p) => { commitPaths.push(p); return []; },
    });
    const base = f.deps.repo.upsertSession;
    f.deps.repo.upsertSession = async (project, s, c) => { upserted.push(project); return base(project, s, c); };
    await runCycle(f.deps);
    expect(upserted.map((p) => p.key)).toEqual(['demo-main']);
    expect(commitPaths).toEqual(['/vibe/demo']); // commits come from the clone the session ran in
    expect([...f.turns.values()].every((t) => t.projectKey === 'demo-main')).toBe(true);
    expect(table.projects.get('demo-main')!.aliases).toEqual(['demo']);
    const aliased = activity.filter((a) => a.kind === 'project_aliased');
    expect(aliased).toEqual([expect.objectContaining({ projectKey: 'demo-main', actor: 'deterministic', details: { folder: 'demo', remote: 'github.com/org/demo' } })]);

    f.deps.listFiles = async () => [{ path: '/t/demo/s1.jsonl', size: 200, mtimeMs: 2 }];
    await runCycle(f.deps);
    expect(upserted.map((p) => p.key)).toEqual(['demo-main', 'demo-main']);
    expect(activity.filter((a) => a.kind === 'project_aliased')).toHaveLength(1);
  });

  test('a folder with no remote is its own project, exactly as before', async () => {
    const upserted: Project[] = [];
    const f = fakes({ remote: async () => null, projects: projectTable([main]).repo });
    const base = f.deps.repo.upsertSession;
    f.deps.repo.upsertSession = async (project, s, c) => { upserted.push(project); return base(project, s, c); };
    await runCycle(f.deps);
    expect(upserted).toEqual([{ key: 'demo', name: 'demo', repoPath: '/vibe/demo', remote: null }]);
  });

  test('a folder whose own project exists keeps its key and gets its remote recorded', async () => {
    const upserted: Project[] = [];
    const f = fakes({ remote: async () => 'github.com/org/demo', projects: projectTable([main, { key: 'demo', name: 'demo', repoPath: '/vibe/demo' }]).repo });
    const base = f.deps.repo.upsertSession;
    f.deps.repo.upsertSession = async (project, s, c) => { upserted.push(project); return base(project, s, c); };
    await runCycle(f.deps);
    expect(upserted).toEqual([{ key: 'demo', name: 'demo', repoPath: '/vibe/demo', remote: 'github.com/org/demo' }]);
  });

  test('a clone of an excluded project is not ingested under it', async () => {
    const f = fakes({ remote: async () => 'github.com/org/demo', projects: projectTable([main]).repo, includeProject: (k) => k === 'demo' });
    const r = await runCycle(f.deps);
    expect(r.filesIngested).toBe(0);
    expect(f.turns.size).toBe(0);
  });

  test('a ticked clone of a project that is not selected is not made its alias, and is read once that project is selected', async () => {
    const table = projectTable([main]);
    let mainSelected = false;
    const f = fakes({
      remote: async () => 'github.com/org/demo',
      projects: table.repo,
      includeProject: (k) => k === 'demo' || (mainSelected && k === 'demo-main'),
    });
    expect((await runCycle(f.deps)).filesIngested).toBe(0);
    expect(table.projects.get('demo-main')!.aliases).toEqual([]);
    expect(f.state.ingestState('/t/demo/s1.jsonl', 100, 1).skipped).toEqual(['demo-main']);
    await runCycle(f.deps);
    expect(f.reads).toHaveLength(1); // not read again while nothing changed

    mainSelected = true;
    expect((await runCycle(f.deps)).filesIngested).toBe(1);
    expect(f.reads).toHaveLength(2);
    expect(table.projects.get('demo-main')!.aliases).toEqual(['demo']);
    expect([...f.turns.values()].every((t) => t.projectKey === 'demo-main')).toBe(true);
  });

  test('existing projects get their remote filled without re-reading any transcript', async () => {
    const table = projectTable([
      { key: 'old', name: 'old', repoPath: '/vibe/old' },
      { key: 'local-only', name: 'local-only', repoPath: '/vibe/local-only' },
    ]);
    const f = fakes({ listFiles: async () => [], remote: async (p) => (p === '/vibe/old' ? 'local/old' : null), projects: table.repo });
    await runCycle(f.deps);
    expect(table.projects.get('old')!.remote).toBe('local/old');
    expect(table.projects.get('local-only')!.remote).toBeUndefined();
    expect(f.reads).toEqual([]);
  });

  test('records made by a scan or a code map (no folder path) get the selected folder\'s path and remote', async () => {
    const table = projectTable([
      { key: 'mapped', name: 'mapped', repoPath: '' },
      { key: 'kept', name: 'kept', repoPath: '/vibe/kept', remote: 'github.com/org/kept' },
      { key: 'gone', name: 'gone', repoPath: '' },
    ]);
    const asked: string[] = [];
    const f = fakes({
      listFiles: async () => [],
      remote: async (p) => { asked.push(p); return p === '/vibe/mapped' ? 'github.com/org/mapped' : null; },
      projects: table.repo,
      folders: async () => [{ key: 'mapped', repoPath: '/vibe/mapped' }, { key: 'kept', repoPath: '/vibe/elsewhere' }],
    });
    await runCycle(f.deps);
    expect(table.projects.get('mapped')).toMatchObject({ repoPath: '/vibe/mapped', remote: 'github.com/org/mapped' });
    // A complete record is never rewritten, and a record with no folder anywhere is left alone.
    expect(table.projects.get('kept')).toMatchObject({ repoPath: '/vibe/kept', remote: 'github.com/org/kept' });
    expect(table.projects.get('gone')).toMatchObject({ repoPath: '' });
    expect(asked).toEqual(['/vibe/mapped']);
  });
});

describe('Codex sessions', () => {
  const rollout = readFileSync(join(import.meta.dirname, '../../../fixtures/codex/normal.jsonl'), 'utf8');
  const codexFile = { path: '/codex-sessions/2026/10/01/rollout-a.jsonl', size: rollout.length, mtimeMs: 1, source: 'codex' as const };

  function codexFakes(text = rollout, over: Partial<CycleDeps> = {}) {
    const sessions: ParsedSession[] = [];
    const streamed: string[] = [];
    const f = fakes({
      roots: [{ host: '/work', container: '/vibe' }],
      listFiles: async () => [codexFile],
      readFile: async () => { throw new Error('a Codex file is streamed, never read whole'); },
      readLines: async function* (p) { streamed.push(p); yield* text.split('\n'); },
      ...over,
    });
    const base = f.deps.repo.upsertSession;
    f.deps.repo.upsertSession = async (project, s, c) => { sessions.push(s); return base(project, s, c); };
    return { ...f, sessions, streamed };
  }

  test('a Codex rollout is streamed line by line into the same pipeline, its sessions marked as Codex', async () => {
    const f = codexFakes();
    const r = await runCycle(f.deps);
    expect(f.streamed).toEqual([codexFile.path]);
    expect(r.filesIngested).toBe(1);
    expect(f.sessions.map((s) => s.source)).toEqual(['codex']);
    expect([...f.turns.values()].every((t) => t.projectKey === 'demo-shop')).toBe(true);
    expect(f.turns.size).toBeGreaterThan(1);
    expect(f.saved.length).toBeGreaterThan(0); // classified like any Claude Code turn
  });

  test('a Codex copy of a conversation already read from Claude Code (an import) is skipped; its own conversations are not', async () => {
    const { parseCodexSession } = await import('./ingest/codex.ts');
    const [codexSession] = parseCodexSession(rollout, codexFile.path);
    // The same conversation as Claude Code wrote it: same human turns, its own ids and layout.
    const claude = codexSession.turns.map((t, i) => line({ type: 'user', uuid: `cc${i}`, cwd: '/work/demo-shop', timestamp: t.ts, message: { content: t.text } })).join('\n');
    const logs: string[] = [];
    const f = codexFakes(rollout, {
      listFiles: async () => [{ path: '/t/demo-shop/cc.jsonl', size: 10, mtimeMs: 1, source: 'claude' as const }, codexFile],
      readFile: async () => claude,
      log: (msg) => void logs.push(msg),
    });
    await runCycle(f.deps);
    expect(f.sessions.map((s) => s.source)).toEqual(['claude']);
    expect(logs).toContain('codex session skipped: a copy of a Claude Code conversation');

    // A conversation only Codex has is ingested as before.
    const g = codexFakes();
    await runCycle(g.deps);
    expect(g.sessions.map((s) => s.source)).toEqual(['codex']);
  });

  /** A live Codex session as the worker first saw it (its first human turn only), the whole of it, and a Claude Code file with the same opening. */
  async function liveCodexSession() {
    const { parseCodexSession } = await import('./ingest/codex.ts');
    const [full] = parseCodexSession(rollout, codexFile.path);
    const lines = rollout.split('\n');
    let cut = 0;
    for (let n = 1; n <= lines.length; n++) if (parseCodexSession(lines.slice(0, n).join('\n'), codexFile.path)[0]?.turns.length === 1) cut = n;
    const early = lines.slice(0, cut).join('\n');
    const claude = full.turns.map((t, i) => line({ type: 'user', uuid: `cc${i}`, cwd: '/work/demo-shop', timestamp: t.ts, message: { content: t.text } })).join('\n');
    const claudeFile = { path: '/t/demo-shop/cc.jsonl', size: 10, mtimeMs: 1, source: 'claude' as const };
    return { full, early, claude, claudeFile };
  }

  test('a live Codex session first read at one turn keeps being read as it grows, though its opening matches a Claude Code conversation', async () => {
    const { full, early, claude, claudeFile } = await liveCodexSession();
    expect(full.turns.length).toBeGreaterThanOrEqual(2);
    let text = early;
    const f = codexFakes(early, {
      listFiles: async () => [claudeFile, { ...codexFile, size: text.length }],
      readFile: async () => claude,
      readLines: async function* () { yield* text.split('\n'); },
    });
    const stored = () => [...f.turns.values()].filter((t) => t.sessionId === full.sessionId).length;
    await runCycle(f.deps);
    expect(stored()).toBe(1); // one turn: too short to tell apart, so it is Codex's own
    // The developer goes on in Codex; the file grows and now opens like the Claude Code conversation.
    text = rollout;
    await runCycle(f.deps);
    expect(stored()).toBe(full.turns.length);
  });

  test('the copy rule change re-reads Codex files once at start and resumes a session the old rule froze, logged in Activity', async () => {
    const { full, claude, claudeFile } = await liveCodexSession();
    const activity: ActivityInput[] = [];
    const f = codexFakes(rollout, {
      listFiles: async () => [claudeFile, codexFile],
      readFile: async () => claude,
      activity: { record: async (a) => void activity.push(a) },
      // The graph holds the session as the old rule left it: its first turn.
      storedTurns: async (id) => (id === full.sessionId ? 1 : null),
    });
    // The worker as the old rule left it: both files read at the current ingest version, no verdict on the Codex session.
    f.state.markIngested(claudeFile.path, claudeFile.size, claudeFile.mtimeMs, 1);
    f.state.rememberConversation(conversationFingerprint(full)!, 's1');
    f.state.markIngested(codexFile.path, codexFile.size, codexFile.mtimeMs, 1);
    await runCycle(f.deps);
    expect(f.sessions).toEqual([]); // nothing changed on disk: nothing read

    expect(f.state.migrateCodexCopyRule('/codex-sessions')).toBe(1); // only the Codex file is read again
    expect(f.state.migrateCodexCopyRule('/codex-sessions')).toBe(0); // once
    await runCycle(f.deps);
    expect(f.sessions.map((s) => [s.source, s.turns.length])).toEqual([['codex', full.turns.length]]);
    expect(activity.filter((a) => a.kind === 'session_resumed')).toEqual([
      expect.objectContaining({ actor: 'deterministic', projectKey: 'demo-shop', details: expect.objectContaining({ sessionId: full.sessionId, storedTurns: 1, turns: full.turns.length }) }),
    ]);

    // From now on it is Codex's own: read as it grows, and not logged again.
    f.state.markIngested(codexFile.path, 0, 0, 1);
    await runCycle(f.deps);
    expect(f.sessions).toHaveLength(2);
    expect(activity.filter((a) => a.kind === 'session_resumed')).toHaveLength(1);
  });

  test('a Codex session of a project not selected is neither judged nor logged', async () => {
    const { full, claude, claudeFile } = await liveCodexSession();
    const activity: ActivityInput[] = [];
    const f = codexFakes(rollout, {
      listFiles: async () => [claudeFile, codexFile],
      readFile: async () => claude,
      includeProject: () => false,
      activity: { record: async (a) => void activity.push(a) },
      storedTurns: async () => 1,
    });
    f.state.rememberConversation(conversationFingerprint(full)!, 's1');
    await runCycle(f.deps);
    expect(activity).toEqual([]);
    expect(f.state.codexVerdict(full.sessionId)).toBeUndefined();
  });

  test('the copy rule migration refuses an empty or root folder', () => {
    const f = codexFakes();
    f.state.markIngested('/t/demo/s1.jsonl', 1, 1, 1);
    expect(f.state.migrateCodexCopyRule('')).toBe(0);
    expect(f.state.migrateCodexCopyRule('/')).toBe(0);
    expect(f.state.ingestState('/t/demo/s1.jsonl', 1, 1).changed).toBe(false);
  });

  test('a real Codex copy (never stored) stays skipped after the rule change', async () => {
    const { full, claude, claudeFile } = await liveCodexSession();
    const f = codexFakes(rollout, { listFiles: async () => [claudeFile, codexFile], readFile: async () => claude, storedTurns: async () => null });
    await runCycle(f.deps);
    expect(f.sessions.map((s) => s.source)).toEqual(['claude']);
    f.state.migrateCodexCopyRule('/codex-sessions');
    await runCycle(f.deps);
    expect(f.sessions.filter((s) => s.sessionId === full.sessionId)).toEqual([]);
  });

  test('a Claude Code transcript is recorded with source claude', async () => {
    const sessions: ParsedSession[] = [];
    const f = fakes({ listFiles: async () => [{ path: '/t/demo/s1.jsonl', size: 100, mtimeMs: 1, source: 'claude' }] });
    const base = f.deps.repo.upsertSession;
    f.deps.repo.upsertSession = async (p, s, c) => { sessions.push(s); return base(p, s, c); };
    await runCycle(f.deps);
    expect(sessions.map((s) => s.source)).toEqual(['claude']);
  });

  test('a secret typed into a Codex session is redacted before it is stored', async () => {
    const secret = 'ghp_0123456789abcdefghijABCDEFGHIJ0123';
    const text = rollout.replace('No, the filter must run on the server.', `No, the filter must run on the server. token ${secret}`);
    expect(text).toContain(secret);
    const f = codexFakes(text);
    await runCycle(f.deps);
    const stored = JSON.stringify([...f.turns.values()]);
    expect(stored).not.toContain(secret);
  });

  test('an unchanged Codex file is not streamed again', async () => {
    const f = codexFakes();
    await runCycle(f.deps);
    await runCycle(f.deps);
    expect(f.streamed).toHaveLength(1);
  });

  test('a large file that keeps growing is re-read at most every few minutes', async () => {
    let now = 1_000_000;
    let size = 100;
    const f = codexFakes(rollout, { now: () => now, largeFileBytes: 50, largeFileMinIntervalMs: 600_000 });
    f.deps.listFiles = async () => [{ ...codexFile, size, mtimeMs: size }];
    await runCycle(f.deps);
    size = 200;
    now += 60_000;
    await runCycle(f.deps);
    expect(f.streamed).toHaveLength(1);
    now += 600_000;
    await runCycle(f.deps);
    expect(f.streamed).toHaveLength(2);
  });
});

describe('project selection', () => {
  test('a file whose folder is not selected is neither read nor marked, so selecting it later reads it', async () => {
    let selected = false;
    const f = fakes({ folderOf: () => 'demo', includeProject: (k) => selected && k === 'demo' });
    await runCycle(f.deps);
    expect(f.reads).toEqual([]);
    selected = true;
    await runCycle(f.deps);
    expect(f.reads).toEqual(['/t/demo/s1.jsonl']);
  });

  test('a Codex file that moved between folders is read when any of them is selected', async () => {
    const f = fakes({ folderOf: () => ['scratch', 'demo'], includeProject: (k) => k === 'demo' });
    await runCycle(f.deps);
    expect(f.reads).toEqual(['/t/demo/s1.jsonl']);
    const g = fakes({ folderOf: () => ['scratch', 'other'], includeProject: (k) => k === 'demo' });
    await runCycle(g.deps);
    expect(g.reads).toEqual([]);
  });

  test('a file with nothing to ingest (outside every root, or an agent-only session) is skipped unread', async () => {
    const f = fakes({ folderOf: () => null });
    await runCycle(f.deps);
    expect(f.reads).toEqual([]);
  });

  test('with nothing selected no turn already in the graph is classified', async () => {
    const f = fakes({ includeProject: () => false, onlyProjects: [] });
    f.turns.set('old', { uuid: 'old', sessionId: 's0', ts: 't', index: 1, text: 'this is still broken', precedingAssistantText: '', precedingToolCalls: [], projectKey: 'demo' });
    const keys: (string[] | undefined)[] = [];
    const base = f.deps.repo.unclassifiedTurns;
    f.deps.repo.unclassifiedTurns = async (limit, only, ex) => { keys.push(only); return only && !only.length ? [] : base(limit, only, ex); };
    const r = await runCycle(f.deps);
    expect(keys).toEqual([[]]);
    expect(r.turnsClassified).toBe(0);
  });
});

test('each ingested session records the repo files it read and edited, relative to its project folder', async () => {
  const withTools = [
    line({ type: 'user', uuid: 'u0', timestamp: '2026-10-01T10:00:00Z', message: { content: 'build search' } }),
    line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T10:01:00Z', message: { content: [
      { type: 'tool_use', name: 'Read', input: { file_path: '/H/Vibe/demo/src/a.ts' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/H/Vibe/demo/src/b.ts' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/H/Vibe/other/x.ts' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/etc/passwd' } },
    ] } }),
    line({ type: 'user', uuid: 'u1', timestamp: '2026-10-01T10:02:00Z', message: { content: 'ok' } }),
  ].join('\n');
  const recorded: { sessionId: string; files: unknown[] }[] = [];
  const f = fakes({
    readFile: async () => withTools,
    codegraph: { recordSessionFiles: async (sessionId, files) => { recorded.push({ sessionId, files }); } },
  });
  await runCycle(f.deps);
  expect(recorded).toEqual([{
    sessionId: 's1',
    files: [
      { path: 'src/a.ts', read: true, edited: false, firstEditAt: null, lastEditAt: null },
      { path: 'src/b.ts', read: false, edited: true, firstEditAt: '2026-10-01T10:01:00.000Z', lastEditAt: '2026-10-01T10:01:00.000Z' },
    ],
  }]);
});

test('a failure recording touched files does not stop ingest', async () => {
  const logged: string[] = [];
  const f = fakes({ codegraph: { recordSessionFiles: async () => { throw new Error('db down'); } }, log: (m) => logged.push(m) });
  const r = await runCycle(f.deps);
  expect(r.filesIngested).toBe(1);
  expect(logged).toContain('session files not recorded');
});

describe('an instruction about git is not pushback until the agent does what it forbids', () => {
  const ORDER = 'this should be on its own branch based on main, do not merge back to main, dont push a PR yet';
  const bashUse = (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
  const session = (o: { before?: string[]; after?: string[]; then?: string }) => [
    line({ type: 'user', uuid: 'u0', timestamp: '2026-10-25T10:00:00Z', message: { content: 'fix the chart embeds in the legacy thread view' } }),
    line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-25T10:01:00Z', message: { content: [{ type: 'text', text: 'Fixed in pipeline.ts, tests pass.' }, ...(o.before ?? []).map((c, i) => bashUse(`b${i}`, c))] } }),
    line({ type: 'user', uuid: 'u1', timestamp: '2026-10-25T10:02:00Z', message: { content: ORDER } }),
    line({ type: 'assistant', uuid: 'a2', timestamp: '2026-10-25T10:03:00Z', message: { content: [{ type: 'text', text: 'On a new branch.' }, ...(o.after ?? []).map((c, i) => bashUse(`c${i}`, c))] } }),
    ...(o.then ? [line({ type: 'user', uuid: 'u2', timestamp: '2026-10-25T10:04:00Z', message: { content: o.then } })] : []),
  ].join('\n');
  /** The fake store's callsAfter, from what upsertSession received (later turns' calls, then the trailing ones). */
  function withCalls(text: string, now = Date.parse('2026-10-25T12:00:00Z')) {
    const f = fakes({ readFile: async () => text, now: () => now });
    let s: ParsedSession | null = null;
    const upsert = f.deps.repo.upsertSession;
    f.deps.repo.upsertSession = async (p, x, c) => { s = x; return upsert(p, x, c); };
    f.deps.repo.callsAfter = async (uuid) => {
      const turn = s!.turns.find((t) => t.uuid === uuid)!;
      const later = s!.turns.filter((t) => t.index > turn.index);
      const trailing = s!.toolCalls.filter((c) => c.ts > s!.turns.at(-1)!.ts);
      return { calls: [...later.flatMap((t) => t.precedingToolCalls), ...trailing], laterTurns: later.length, endedAt: s!.endedAt };
    };
    return f;
  }

  test('nothing pushed, merged or opened after it: neutral, never sent to the model, never an Inbox item', async () => {
    const f = withCalls(session({ before: ['git status'], after: ['git checkout -b fix/chart-embeds', 'git commit -m "fix: chart embeds"'], then: 'thanks, looks right' }));
    await runCycle(f.deps);
    expect(f.classifyCalls).toEqual([]);
    expect(f.saved.find((x) => x.uuid === 'u1')).toMatchObject({ cand: false, c: { label: 'neutral', signals: ['instruction'] } });
  });

  test('a push after it (even in the calls after the last message) sends it to the model with that evidence', async () => {
    const seen: HumanTurn[] = [];
    const f = withCalls(session({ after: ['git checkout -b fix/chart-embeds', 'git push -u origin fix/chart-embeds'] }));
    f.deps.classify = async (t) => { seen.push(t); return { label: 'correction', confidence: 0.9, summary: 'pushed after being told not to', signals: [] }; };
    await runCycle(f.deps);
    expect(seen.map((t) => t.uuid)).toEqual(['u1']);
    expect(seen[0].followingToolCalls?.map((c) => c.command)).toEqual(['git push -u origin fix/chart-embeds']);
  });

  test('the same words after the agent had already pushed are about what happened: the model decides', async () => {
    const f = withCalls(session({ before: ['git push origin HEAD'], then: 'ok' }));
    await runCycle(f.deps);
    expect(f.classifyCalls).toEqual(['u1']);
  });

  test('a true correction ("you pushed to main, I said not to") is always sent to the model', async () => {
    const f = withCalls(session({ then: 'you pushed to main, I said not to' }));
    await runCycle(f.deps);
    expect(f.classifyCalls).toContain('u2');
  });

  test('the last message of a live session waits for what the agent does next', async () => {
    const f = withCalls(session({}), Date.parse('2026-10-25T10:05:00Z'));
    await runCycle(f.deps);
    expect(f.classifyCalls).toEqual([]);
    expect(f.saved.find((x) => x.uuid === 'u1')).toBeUndefined();
  });

  test('a later message does not clear it while the session is live: the push that follows still makes it a miss', async () => {
    // "on its own branch, don't push yet", "looks good", then the agent pushes: classified before the push, it would be cleared for good.
    const transcript = (o: { push: boolean }) => [
      line({ type: 'user', uuid: 'u0', timestamp: '2026-10-25T10:00:00Z', message: { content: 'fix the chart embeds' } }),
      line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-25T10:01:00Z', message: { content: [{ type: 'text', text: 'Fixed, committed.' }, bashUse('b0', 'git commit -am "fix: chart embeds"')] } }),
      line({ type: 'user', uuid: 'u1', timestamp: '2026-10-25T10:02:00Z', message: { content: "this should be on its own branch, don't push yet" } }),
      line({ type: 'assistant', uuid: 'a2', timestamp: '2026-10-25T10:03:00Z', message: { content: [{ type: 'text', text: 'Holding off.' }] } }),
      line({ type: 'user', uuid: 'u2', timestamp: '2026-10-25T10:04:00Z', message: { content: 'looks good' } }),
      line({ type: 'assistant', uuid: 'a3', timestamp: '2026-10-25T10:05:00Z', message: { content: [{ type: 'text', text: 'Pushing.' }, ...(o.push ? [bashUse('c0', 'git push -u origin fix/chart-embeds')] : [])] } }),
    ].join('\n');
    const live = withCalls(transcript({ push: false }), Date.parse('2026-10-25T10:06:00Z'));
    await runCycle(live.deps);
    expect(live.saved.find((x) => x.uuid === 'u1')).toBeUndefined();

    const seen: HumanTurn[] = [];
    const later = withCalls(transcript({ push: true }), Date.parse('2026-10-25T12:00:00Z'));
    later.deps.classify = async (t) => { seen.push(t); return { label: 'correction', confidence: 0.9, summary: 'pushed after being told not to', signals: [] }; };
    await runCycle(later.deps);
    expect(seen.map((t) => t.uuid)).toEqual(['u1']);
    expect(seen[0].followingToolCalls?.map((c) => c.command)).toEqual(['git push -u origin fix/chart-embeds']);
  });
});
