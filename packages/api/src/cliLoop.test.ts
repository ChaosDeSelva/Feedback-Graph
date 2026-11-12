import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { Decision, LoopRound, OperatorVerb } from '@fb/core';
import { writeLoopRound } from '@fb/core';
import { createApp, type ApiRepo } from './app.ts';
import { helpFor, run, type CliIO } from './cli.ts';
import { decision, fakeLoop, snap } from './testing/loop.ts';

const OP = 'o'.repeat(32);
const repo = { listCandidates: async () => [], candidateDetail: async () => null, decide: async () => {}, stats: async () => [] } as unknown as ApiRepo;

const proposed = decision('dec:p', { type: 'approve_lesson', tier: 'A', mode: 'propose', status: 'proposed', appliedAt: null, decidedAt: null, decidedBy: null, createdAt: '2026-11-11T11:00:00.000Z', model: null });
const applied = decision('dec:a', { createdAt: '2026-11-11T10:00:00.000Z', appliedAt: '2026-11-11T10:00:01.000Z' });
const later = decision('dec:later', { type: 'rank_weight', dependsOn: ['dec:a'], createdAt: '2026-11-11T10:30:00.000Z', appliedAt: '2026-11-11T10:30:01.000Z', projectKey: null, targets: [] });
const old = decision('dec:old', { createdAt: '2026-10-01T00:00:00.000Z', appliedAt: '2026-10-01T00:00:01.000Z' });

// fg reads --since against the clock; the fake loop's clock is this.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-11T12:00:00.000Z'));
});
afterAll(() => vi.useRealTimers());

/** fg against the real routes, in-process, over the in-memory loop. */
function setup(o: { decisions?: Decision[]; allow?: OperatorVerb[] } = {}) {
  const loop = fakeLoop({ decisions: o.decisions ?? [proposed, applied, later, old] });
  const app = createApp(repo, { loop: loop.deps, auth: { ownerToken: 'x'.repeat(30), operator: { token: OP, allow: o.allow ?? ['loop_decide', 'loop_settings'] } } });
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    env: { FG_OPERATOR_TOKEN: OP, FG_OPERATOR_NAME: 'codex' }, out: (s) => out.push(s), err: (s) => err.push(s), sleep: async () => {},
    fetch: ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch,
  };
  return { ...loop, io, out, err, text: () => out.join('\n'), fg: (...argv: string[]) => run(argv, io) };
}

describe('fg loop', () => {
  test('status: the mode as set and as it runs, counts, budget, the round, and a row per type', async () => {
    const s = setup();
    const round: LoopRound = { id: 'round:7', startedAt: '2026-11-11T11:59:00.000Z', finishedAt: null, phase: 'scoring', signalsIngested: 1, targetsScored: 3, targetsTotal: 9, decisions: { observed: 1, proposed: 0, applied: 0, skipped: 2 }, skipped: [], llmCalls: 0, error: null };
    await writeLoopRound(s.deps.cursors, round);
    s.cursors.set('loop-breaker:link_misses', JSON.stringify({ tripped: true, at: 't', reason: '2 rollbacks in 7 days' }));
    s.cursors.set('loop-breaker:rank_weight', JSON.stringify({ tripped: true, at: 't' }));
    expect(await s.fg('loop', 'status')).toBe(0);
    const t = s.text();
    expect(t).toMatch(/^mode: auto, runs as auto; policy v1$/m);
    expect(t).toMatch(/waiting for you: 1 proposal; this week 0 observed, 1 proposed, 2 applied, 0 rolled back; rollbacks \(30 days\): 0 of 2/);
    expect(t).toMatch(/budget today: 0 of 40 model calls, 0 of 5 agent-facing changes applied on their own \(2 per project\)/);
    expect(t).toMatch(/round round:7: scoring since 2026-11-11 11:59:00, 3 of 9 scored, 1 observed, 0 proposed, 0 applied, 2 skipped/);
    expect(t).toMatch(/^TYPE +TIER +MODE +RUNS AS +TAU +P +LOWER +REVIEWS +ROLLBACKS +BREAKER$/m);
    expect(t).toMatch(/^link_misses +H +global +propose +0\.50 +0\.80 +\d\.\d\d +0 +none yet +tripped: 2 rollbacks in 7 days$/m);
    expect(t).toMatch(/^retire_lesson +H +global +auto .* 0 of 2 *$/m);
    expect(t).toMatch(/^rank_weight +H .* tripped$/m);
  });

  test('a finished round, an aborted one, none yet; --json is the API body; and why the mode is capped', async () => {
    const s = setup();
    expect(await s.fg('loop')).toBe(0);
    expect(s.text()).toMatch(/no round yet/);
    await writeLoopRound(s.deps.cursors, { id: 'r', startedAt: 't', finishedAt: '2026-11-11T12:00:00.000Z', phase: 'aborted', signalsIngested: 0, targetsScored: 0, targetsTotal: null, decisions: { observed: 0, proposed: 0, applied: 0, skipped: 0 }, skipped: [], llmCalls: 0, error: 'store down' });
    s.out.length = 0;
    await s.fg('loop', 'pause');
    expect(s.text()).toMatch(/^mode: auto, runs as off \(paused by operator:codex at 2026-11-11 12:00:00\)/m);
    expect(s.text()).toMatch(/round r: aborted at 2026-11-11 12:00:00, 0 scored, .*\(store down\)/);
    s.out.length = 0;
    await s.fg('loop', 'resume', '--json');
    expect(JSON.parse(s.text())).toMatchObject({ mode: 'auto', paused: null });
    const disabled = fakeLoop({ config: { disabled: true } });
    const tokenless = fakeLoop({});
    for (const [loop, want] of [[disabled, /runs as off \(LOOP_DISABLED=1\)/], [tokenless, /runs as observe \(no owner token: observe at most\)/]] as const) {
      const app = createApp(repo, { loop: loop.deps, auth: { operator: { token: OP, allow: [] }, ...(loop === disabled && { ownerToken: 'x'.repeat(30) }) } });
      const out: string[] = [];
      await run(['loop', 'status'], { env: { FG_OPERATOR_TOKEN: OP }, out: (l) => out.push(l), err: () => {}, sleep: async () => {}, fetch: ((u: string, i?: RequestInit) => app.request(u, i)) as typeof fetch });
      expect(out.join('\n')).toMatch(want);
    }
  });

  test('mode sets the mode, and per type a mode or global; bad modes are usage mistakes; without loop_settings the API refuses', async () => {
    const s = setup();
    expect(await s.fg('loop', 'mode', 'propose', '--type', 'merge_duplicates=auto, approve_lesson=global')).toBe(0);
    expect(s.text()).toMatch(/^mode: propose, runs as propose/m);
    expect(s.entries.at(-1)).toMatchObject({ kind: 'loop_settings_changed', actor: 'operator:codex', subject: 'learning loop: mode auto → propose, merge_duplicates mode global → auto' });
    expect(await s.fg('loop', 'mode', '--type', 'retire_lesson=observe')).toBe(0);
    expect(s.entries.at(-1)!.subject).toBe('learning loop: retire_lesson mode global → observe');
    expect(await s.fg('loop', 'mode', 'yolo')).toBe(2);
    expect(await s.fg('loop', 'mode')).toBe(2);
    expect(await s.fg('loop', 'mode', 'auto', '--type', 'retire_lesson')).toBe(2);
    expect(await s.fg('loop', 'mode', 'auto', '--type', 'retire_lesson=sometimes')).toBe(2);
    expect(await s.fg('loop', 'frobnicate')).toBe(2);
    expect(s.err.join('\n')).toMatch(/fg loop mode takes off, observe, propose, auto \(got yolo\)/);
    const refused = setup({ allow: [] });
    expect(await refused.fg('loop', 'pause')).toBe(1);
    expect(refused.err.join('\n')).toMatch(/403 .*loop_settings/);
  });
});

describe('fg decisions', () => {
  test('list and the --since preview print whole ids, and show, note and the verdicts take a unique prefix', async () => {
    const full = `dec:03903f${'a'.repeat(52)}16355b`;
    const twin = `dec:03903f${'b'.repeat(52)}16355b`;
    const s = setup({ decisions: [decision(full, { createdAt: '2026-11-11T11:30:00.000Z', appliedAt: '2026-11-11T11:30:01.000Z', rationale: 'r'.repeat(90) }), decision(twin, { createdAt: '2026-11-11T11:20:00.000Z', appliedAt: '2026-11-11T11:20:01.000Z' }), proposed] });
    expect(await s.fg('decisions', 'list')).toBe(0);
    expect(s.text().split('\n').slice(1).map((l) => l.split(/\s+/)[0])).toEqual([full, twin, 'dec:p']);
    expect(s.text()).toContain(`${'r'.repeat(59)}…`);
    s.out.length = 0;
    expect(await s.fg('decisions', 'rollback', '--since', '24h')).toBe(0);
    expect(s.text()).toMatch(new RegExp(`^${full} `, 'm'));
    s.out.length = 0;
    expect(await s.fg('decisions', 'show', 'dec:03903faaaa')).toBe(0);
    expect(s.out[0]).toMatch(new RegExp(`^${full}: `));
    expect(await s.fg('decisions', 'keep', '03903fbbb')).toBe(0);
    expect(s.text()).toContain(`${twin}: applied (kept)`);
    expect(await s.fg('decisions', 'note', '03903fa', 'looks right')).toBe(0);
    expect(s.notes.map((n) => n.decisionId)).toEqual([full]);
    expect(await s.fg('decisions', 'show', 'dec:03903f')).toBe(1);
    expect(s.err.join('\n')).toMatch(/dec:03903f starts 2 decision ids .*: give more of it/);
    expect(await s.fg('decisions', 'show', 'dec:ffff')).toBe(1);
    expect(s.err.join('\n')).toMatch(/no decision dec:ffff, and no decision id starts with it/);
  });

  test('a prefix is looked up with one bounded query per spelling, however many decisions are stored', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => decision(`dec:${String(i).padStart(4, '0')}${'c'.repeat(60)}`, { createdAt: '2026-11-11T11:00:00.000Z' }));
    const s = setup({ decisions: many });
    const fetch = s.io.fetch;
    const asked: string[] = [];
    s.io.fetch = ((url: string, init?: RequestInit) => { asked.push(String(url)); return fetch(url, init); }) as typeof globalThis.fetch;
    expect(await s.fg('decisions', 'show', '0777')).toBe(0);
    expect(s.out[0]).toMatch(/^dec:0777c+: /);
    const lists = asked.filter((u) => new URL(u, 'http://x').pathname === '/api/decisions');
    expect(lists.map((u) => Object.fromEntries(new URL(u, 'http://x').searchParams))).toEqual([{ idPrefix: '0777', limit: '4' }, { idPrefix: 'dec:0777', limit: '4' }]);
  });

  test('list: newest first, filtered, --since as a span or an ISO time', async () => {
    const s = setup();
    expect(await s.fg('decisions', 'list')).toBe(0);
    expect(s.out[0]).toMatch(/^ID +TYPE +STATUS +MODE +PROJECT +TARGET +P +CREATED +RATIONALE$/m);
    expect(s.text().split('\n').slice(1).map((l) => l.split(/\s+/)[0])).toEqual(['dec:p', 'dec:later', 'dec:a', 'dec:old']);
    expect(s.text()).toMatch(/^dec:later +rank_weight +applied +auto +global +0\.93/m);
    s.out.length = 0;
    await s.fg('decisions', 'list', '--since', '24h', '--status', 'applied');
    expect(s.text().split('\n').slice(1).map((l) => l.split(/\s+/)[0])).toEqual(['dec:later', 'dec:a']);
    s.out.length = 0;
    await s.fg('decisions', 'list', '--since', '2026-11-11T10:15:00Z', '--json');
    expect(JSON.parse(s.text()).map((d: { id: string }) => d.id)).toEqual(['dec:p', 'dec:later']);
    s.out.length = 0;
    await s.fg('decisions', 'list', '--since', '90m', '--type', 'link_misses');
    expect(s.text()).toBe('no decisions');
    expect(await s.fg('decisions', 'list', '--since', '7d', '--q', 'never', '--project', 'shop', '--limit', '1')).toBe(0);
    expect(await s.fg('decisions', 'list', '--since', 'last tuesday')).toBe(2);
    expect(s.err.join('\n')).toMatch(/--since needs a span like 24h, 7d or 90m, or an ISO time \(got last tuesday\)/);
  });

  test('show: the decision, the field diff with a now column, evidence, dependencies and notes', async () => {
    const d = decision('dec:a', {
      createdAt: '2026-11-11T10:00:00.000Z', dependsOn: ['dec:p'],
      evidence: [{ kind: 'lesson', id: 'lesson:gone', role: 'target', weight: 1, observedAt: 't' }, { kind: 'check', id: 'c', role: 'judge', weight: 0.5, observedAt: 't' }],
      rollback: { at: '2026-11-11T11:00:00.000Z', by: 'you', reason: 'too_broad', note: 'still useful', cascade: [] }, status: 'rolled_back',
    });
    const s = setup({ decisions: [d, proposed, later] });
    s.snapshots.set('lesson:lesson:1', snap('lesson:1', { title: 'Validate totals (edited)', status: 'revoked' }));
    s.notes.push({ id: 'n1', decisionId: 'dec:a', ts: '2026-11-11T11:00:00.000Z', by: 'you', text: 'too wide', verdict: 'disagree', reason: 'too_broad' }, { id: 'n2', decisionId: 'dec:a', ts: '2026-11-11T11:01:00.000Z', by: 'you', text: 'fine', verdict: null, reason: null });
    expect(await s.fg('decisions', 'show', 'dec:a')).toBe(0);
    const t = s.text();
    expect(t).toMatch(/^dec:a: retire lesson \(tier H, auto\) is rolled back, decided by loop:1$/m);
    expect(t).toMatch(/^project shop; targets lesson:1 \(primary\)$/m);
    expect(t).toMatch(/^confidence p 0\.93 \(lower 0\.90\), from 34 of your reviews; model deterministic, policy v1$/m);
    expect(t).toMatch(/^rolled back by you at 2026-11-11 11:00:00 \(too broad\): still useful$/m);
    expect(t).toMatch(/^lesson:1 +status +"approved" +"revoked" +"revoked"$/m);
    expect(t).toMatch(/^lesson:1 +title +"Validate totals" +"Validate totals" +"Validate totals \(edited\)"$/m);
    expect(t).toMatch(/^lesson +lesson:gone +target +1 +target \(gone\)$/m);
    expect(t).toMatch(/^check +c +judge +0\.5 +judge$/m);
    expect(t).toMatch(/depends on:\nID +TYPE +STATUS +WHAT\ndec:p +approve_lesson +proposed +approve lesson · lesson:1/);
    expect(t).toMatch(/depended on by:\nID +TYPE +STATUS +WHAT\ndec:later +rank_weight +applied +rank weight · dec:later/);
    expect(t).toMatch(/^you +2026-11-11 11:00:00 +disagree: too broad +too wide$/m);
    expect(t).toMatch(/^you +2026-11-11 11:01:00 +fine$/m);
  });

  test('show of a bare decision: no targets, no evidence, nothing around it; --json is the API body; no id is a usage mistake', async () => {
    const s = setup({ decisions: [proposed, decision('dec:later', { targets: [], evidence: [], projectKey: null })] });
    await s.fg('decisions', 'show', 'dec:p');
    expect(s.text()).toMatch(/^dec:p: approve lesson \(tier A, propose\) is proposed$/m);
    expect(s.text()).toMatch(/model none/);
    s.out.length = 0;
    await s.fg('decisions', 'show', 'dec:later');
    expect(s.text()).toMatch(/^project global; targets none$/m);
    expect(s.text()).not.toMatch(/depends on|EVIDENCE|NOTE BY|BEFORE/);
    s.out.length = 0;
    await s.fg('decisions', 'show', 'dec:p', '--json');
    expect(JSON.parse(s.text())).toMatchObject({ decision: { id: 'dec:p' } });
    // Rolled back with no reason or note; a field the snapshot after does not carry.
    const plain = setup({ decisions: [decision('dec:r', { status: 'rolled_back', rollback: { at: '2026-11-11T11:00:00.000Z', by: 'you', reason: null, note: null, cascade: [] }, before: [snap('lesson:1', { title: 'T', paths: ['a.ts'] })], after: [snap('lesson:1', { title: 'T' })] })] });
    await plain.fg('decisions', 'show', 'dec:r');
    expect(plain.text()).toMatch(/^rolled back by you at 2026-11-11 11:00:00$/m);
    expect(plain.text()).toMatch(/^lesson:1 +paths +\["a\.ts"\] +null +null$/m);
    expect(await s.fg('decisions', 'show')).toBe(2);
    expect(await s.fg('decisions', 'show', 'dec:none')).toBe(1);
    expect(await s.fg('decisions', 'frobnicate')).toBe(2);
  });

  test('approve, reject and keep send the status they read, as the operator', async () => {
    const s = setup();
    expect(await s.fg('decisions', 'approve', 'dec:p', '--note', 'yes')).toBe(0);
    expect(s.out.at(-1)).toBe('dec:p: applied');
    expect(s.decisions.get('dec:p')!.decidedBy).toBe('operator:codex');
    expect(await s.fg('decisions', 'keep', 'dec:a')).toBe(0);
    expect(s.out.at(-1)).toBe('dec:a: applied (kept)');
    expect(await s.fg('decisions', 'keep', 'dec:a', '--json')).toBe(0);
    expect(JSON.parse(s.out.at(-1)!)).toMatchObject({ ratifiedBy: 'operator:codex' });
    expect(await s.fg('decisions', 'reject', 'dec:p')).toBe(1);
    expect(s.err.at(-1)).toMatch(/409 a decision that is applied cannot be rejected/);
    expect(await s.fg('decisions', 'reject', 'dec:p', '--reason', 'because')).toBe(2);
    expect(await s.fg('decisions', 'approve')).toBe(2);
    const refused = setup({ allow: [] });
    expect(await refused.fg('decisions', 'reject', 'dec:p', '--reason', 'not_now')).toBe(1);
    expect(refused.err.join('\n')).toMatch(/403 .*loop_decide/);
  });

  test('rollback previews without --apply (what else it undoes, what blocks it), then rolls back', async () => {
    const s = setup();
    expect(await s.fg('decisions', 'rollback', 'dec:a', '--reason', 'too_broad')).toBe(0);
    expect(s.text()).toMatch(/^dec:a: a preview, nothing rolled back yet; it also rolls back \(newest first\):\nID +TYPE +STATUS +WHAT\ndec:later +rank_weight +applied/m);
    expect(s.text()).toMatch(/fg decisions rollback dec:a --apply rolls it back/);
    expect(s.decisions.get('dec:a')!.status).toBe('applied');
    s.out.length = 0;
    expect(await s.fg('decisions', 'rollback', 'dec:a', '--apply', '--note', 'too wide')).toBe(0);
    expect(s.text()).toBe('dec:a: rolled back with dec:later');
    expect(s.calls.rollback.at(-1)).toEqual(['dec:a', { by: 'operator:codex', cascade: 'apply', note: 'too wide' }]);
    s.out.length = 0;
    const alone = setup({ decisions: [old] });
    await alone.fg('decisions', 'rollback', 'dec:old', '--json');
    expect(JSON.parse(alone.text())).toEqual({ cascade: [], blocked: [] });
    alone.out.length = 0;
    await alone.fg('decisions', 'rollback', 'dec:old');
    expect(alone.text()).toMatch(/nothing else depends on it/);
    alone.out.length = 0;
    await alone.fg('decisions', 'rollback', 'dec:old', '--apply');
    expect(alone.text()).toBe('dec:old: rolled back');
  });

  test('a blocked preview exits 1; --restore-anyway goes to the API for an overridden decision', async () => {
    const blocked = decision('dec:blk', { status: 'overridden', dependsOn: ['dec:a'] });
    const s = setup({ decisions: [applied, blocked] });
    expect(await s.fg('decisions', 'rollback', 'dec:a')).toBe(1);
    expect(s.text()).toMatch(/blocked:\nID +WHY\ndec:blk +you changed its target since/);
    expect(await s.fg('decisions', 'rollback', 'dec:blk', '--restore-anyway')).toBe(0);
    expect(s.calls.rollback.at(-1)).toEqual(['dec:blk', { by: 'operator:codex', cascade: 'preview', restoreAnyway: true }]);
    expect(await s.fg('decisions', 'rollback', 'dec:blk', '--apply', '--restore-anyway', '--json')).toBe(0);
    expect(JSON.parse(s.out.at(-1)!)).toMatchObject({ id: 'dec:blk', status: 'rolled_back' });
    expect(await s.fg('decisions', 'rollback')).toBe(2);
    expect(s.err.at(-1)).toMatch(/fg decisions rollback <id> \(or --since 24h\)/);
    // An answer without a rollback record: just the status.
    s.deps.exec!.rollback = async (d) => ({ ...d, status: 'rolled_back' });
    s.decisions.get('dec:blk')!.status = 'overridden';
    await s.fg('decisions', 'rollback', 'dec:blk', '--apply', '--restore-anyway');
    expect(s.out.at(-1)).toBe('dec:blk: rolled back');
  });

  test('rollback --since goes by when a decision was applied: a call observed days ago and applied today is in, one made today and applied before is not', async () => {
    const observedThenApplied = decision('dec:obs', { createdAt: '2026-11-08T00:00:00.000Z', appliedAt: '2026-11-11T11:00:00.000Z' });
    const s = setup({ decisions: [observedThenApplied, old] });
    await s.fg('decisions', 'rollback', '--since', '24h', '--json');
    expect(JSON.parse(s.text()).decisions.map((d: { id: string }) => d.id)).toEqual(['dec:obs']);
  });

  test('rollback --since: every decision applied since then, newest first; a preview unless --apply, which skips what a cascade already undid', async () => {
    const s = setup();
    expect(await s.fg('decisions', 'rollback', '--since', '24h')).toBe(0);
    expect(s.text()).toMatch(/^2 decisions applied since .* \(a preview, nothing rolled back yet; each also rolls back what depends on it\):/);
    expect(s.text()).toMatch(/fg decisions rollback --since 24h --apply rolls them back, newest first/);
    expect(s.calls.rollback).toEqual([]);
    s.out.length = 0;
    await s.fg('decisions', 'rollback', '--since', '24h', '--type', 'rank_weight', '--json');
    expect(JSON.parse(s.text())).toMatchObject({ apply: false, decisions: [{ id: 'dec:later' }] });
    s.out.length = 0;
    await s.fg('decisions', 'rollback', '--since', '24h', '--type', 'rank_weight');
    expect(s.text()).toMatch(/--since 24h --type rank_weight --apply/);
    // dec:later first (newest); then dec:a. The fake's cascade does not move dec:later, so make it look undone.
    s.out.length = 0;
    s.deps.exec!.rollback = async (d, o) => {
      for (const id of [d.id, ...(d.id === 'dec:a' ? ['dec:later'] : [])]) Object.assign(s.decisions.get(id)!, { status: 'rolled_back' });
      return { ...s.decisions.get(d.id)!, rollback: { at: 't', by: o.by, reason: null, note: null, cascade: [] } };
    };
    s.decisions.get('dec:later')!.appliedAt = '2026-11-11T09:00:00.000Z';
    expect(await s.fg('decisions', 'rollback', '--since', '24h', '--apply', '--reason', 'wrong_evidence', '--note', 'bad day')).toBe(0);
    expect(s.text()).toMatch(/^dec:a +rolled back\ndec:later +rolled back$/m);
    s.out.length = 0;
    expect(await s.fg('decisions', 'rollback', '--since', '24h', '--apply', '--json')).toBe(0);
    expect(JSON.parse(s.text())).toEqual({ since: expect.any(String), apply: true, results: [] });
    s.out.length = 0;
    await s.fg('decisions', 'rollback', '--since', '24h');
    expect(s.text()).toMatch(/^no decision applied since /);
  });

  test('rollback --since --apply reports each one that failed and exits 1; more than a page is read whole', async () => {
    const many = Array.from({ length: 501 }, (_, i) => decision(`dec:${String(i).padStart(3, '0')}`, { createdAt: '2026-11-11T11:30:00.000Z', appliedAt: '2026-11-11T11:30:01.000Z' }));
    const s = setup({ decisions: many });
    s.deps.exec!.rollback = async (d) => {
      if (d.id === 'dec:500') throw new Error('kaput');
      Object.assign(s.decisions.get(d.id)!, { status: 'rolled_back' });
      return s.decisions.get(d.id)!;
    };
    const code = await s.fg('decisions', 'rollback', '--since', '24h', '--apply', '--json');
    const r = JSON.parse(s.text());
    expect(code, JSON.stringify(r).slice(0, 300) + s.err.join()).toBe(1);
    expect(r.results).toHaveLength(501);
    expect(r.results[0]).toEqual({ id: 'dec:500', ok: false, error: expect.stringMatching(/503 the store did not answer: kaput/) });
    expect(r.results.filter((x: { ok: boolean }) => x.ok)).toHaveLength(500);
    s.out.length = 0;
    await s.fg('decisions', 'rollback', '--since', '24h', '--apply');
    expect(s.text()).toMatch(/^dec:500 +FAILED: POST/m);
  });

  test('rollback --since --apply: an API that cannot be reached fails each one', async () => {
    const s = setup({ decisions: [applied] });
    const io: CliIO = { ...s.io, fetch: (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new TypeError('socket closed');
      return s.io.fetch(url, init);
    }) as typeof fetch };
    const out: string[] = [];
    expect(await run(['decisions', 'rollback', '--since', '24h', '--apply'], { ...io, out: (l) => out.push(l) })).toBe(1);
    expect(out.join('\n')).toMatch(/^dec:a +FAILED: cannot reach Feedback Graph/m);
  });

  test('note adds your note with a verdict and reason; bad ones are usage mistakes', async () => {
    const s = setup();
    expect(await s.fg('decisions', 'note', 'dec:a', 'too', 'wide', '--verdict', 'disagree', '--reason', 'too_broad')).toBe(0);
    expect(s.out.at(-1)).toBe('noted on dec:a (disagree)');
    expect(s.notes.at(-1)).toMatchObject({ text: 'too wide', by: 'operator:codex', verdict: 'disagree', reason: 'too_broad' });
    expect(await s.fg('decisions', 'note', 'dec:a', 'ok')).toBe(0);
    expect(s.out.at(-1)).toBe('noted on dec:a');
    expect(await s.fg('decisions', 'note', 'dec:a', 'ok', '--json')).toBe(0);
    expect(JSON.parse(s.out.at(-1)!)).toMatchObject({ text: 'ok', verdict: null });
    expect(await s.fg('decisions', 'note', 'dec:a')).toBe(2);
    expect(await s.fg('decisions', 'note', 'dec:a', 'x', '--verdict', 'meh')).toBe(2);
  });

  test('fg help loop and fg help decisions print their lines', () => {
    expect(helpFor('loop')).toMatch(/fg loop pause\|resume/);
    expect(helpFor('decisions')).toMatch(/fg decisions rollback --since 24h/);
    expect(helpFor('decisions')).not.toMatch(/fg loop/);
  });
});
