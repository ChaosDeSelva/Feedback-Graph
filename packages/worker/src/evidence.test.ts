import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { EVIDENCE_CURSOR, SessionEvidenceGate } from './evidence.ts';

/** A worker start in miniature: what main.ts runs, in order, against a gate. */
function world(cursor: string | null, o: { failRecheck?: boolean } = {}) {
  const calls: string[] = [];
  const cursors = new Map<string, string>(cursor ? [[EVIDENCE_CURSOR, cursor]] : []);
  const logs: [string, object | undefined][] = [];
  const gate = new SessionEvidenceGate({
    ingestVersion: 5,
    cursors: { getCursor: async (k) => cursors.get(k) ?? null, setCursor: async (k, v) => void cursors.set(k, v) },
    instructions: async () => void calls.push('instructions'),
    requestLessonRecheck: async () => { calls.push('request-recheck'); return 3; },
    recheck: async () => { calls.push('recheck'); if (o.failRecheck) throw new Error('store down'); },
    rematch: async () => void calls.push('rematch'),
    log: (m, x) => logs.push([m, x]),
  });
  /** The loop: the per-round lesson re-check (only once the evidence is current), then a cycle that reads transcripts. */
  const round = async (ingested = true) => {
    if (gate.ready()) await gate.recheck();
    calls.push('ingest');
    if (ingested) await gate.afterIngest();
  };
  return { gate, calls, cursors, logs, round };
}

test('after an ingest version bump, the lesson re-check and the instruction pass wait for the re-read, then run once in order', async () => {
  // 0.6.2 stamped the lessons with checks v4 at start, before ingest v5 recorded the instruction files each session had.
  const w = world('ingest v4');
  await w.gate.load();
  // At start: nothing that reads session evidence runs yet.
  expect(w.gate.ready()).toBe(false);
  await w.gate.atStart();
  expect(w.calls).toEqual([]);
  // Nor post-mortems, which read the same evidence (and would be re-matched by the rule they were made under).
  expect(w.gate.settled()).toBe(false);
  await w.round();
  expect(w.gate.settled()).toBe(true);
  // The re-check is asked for again (the lessons were stamped on the old evidence), after the instruction pass.
  expect(w.calls).toEqual(['ingest', 'instructions', 'request-recheck', 'recheck', 'rematch']);
  expect(w.cursors.get(EVIDENCE_CURSOR)).toBe('ingest v5');
  expect(w.logs).toContainEqual(['session evidence is current: lessons re-checked against it', { ingestVersion: 5, requeued: 3 }]);
  // Later rounds: the per-round re-check runs, the one-off passes do not.
  await w.round();
  expect(w.calls.slice(5)).toEqual(['recheck', 'ingest']);
});

test('evidence already current at start: the start re-check runs before the loop, the passes after the first ingest, no re-check asked for', async () => {
  const w = world('ingest v5');
  await w.gate.load();
  expect(w.gate.ready()).toBe(true);
  await w.gate.atStart();
  expect(w.calls).toEqual(['recheck']);
  expect(w.gate.settled()).toBe(false);
  await w.round();
  // The passes still wait for the first ingest of this start: a session that ended since the last start is read first.
  expect(w.calls).toEqual(['recheck', 'recheck', 'ingest', 'instructions', 'rematch']);
});

test('a cycle that did not finish reading transcripts keeps the gate closed; a failed re-check leaves the version for the next try', async () => {
  const w = world(null, { failRecheck: true });
  await w.gate.load();
  await w.round(false);
  expect(w.calls).toEqual(['ingest']);
  await w.round();
  expect(w.calls).toEqual(['ingest', 'ingest', 'instructions', 'request-recheck', 'recheck', 'rematch']);
  expect(w.cursors.get(EVIDENCE_CURSOR)).toBeUndefined();
  expect(w.logs.map(([m]) => m)).toContain('lesson re-check after ingest failed');
  // Tried again after the next ingest; the one-off passes are not repeated.
  await w.round();
  expect(w.calls.slice(6)).toEqual(['recheck', 'ingest', 'request-recheck', 'recheck']);
});

test("the worker's start-up goes through the gate: nothing that reads session evidence runs before the loop's first ingest", () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const gate = main.slice(main.indexOf('new SessionEvidenceGate('), main.indexOf('\n  });', main.indexOf('new SessionEvidenceGate(')));
  for (const pass of ['resolvePendingInstructions(', 'rematchOnRuleChange(']) {
    // Called once, inside the gate's passes.
    expect(main.split(pass).length - 1, pass).toBe(1);
    expect(gate, pass).toContain(pass);
  }
  // The lesson re-check only through the gate, and post-mortems only once it has settled; afterIngest after runCycle.
  expect(main).not.toMatch(/await recheckOld\(\)/);
  expect(main).toMatch(/pmDeps && !settling \? await runPostmortems\(pmDeps\)/);
  expect(main.indexOf('await evidence.afterIngest()')).toBeGreaterThan(main.indexOf('await runCycle(cycleDeps)'));
});
