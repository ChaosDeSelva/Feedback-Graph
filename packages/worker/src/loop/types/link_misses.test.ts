import { describe, expect, test } from 'vitest';
import { missLinkSnapshot, type Decision } from '@fb/core';
import { activity, axis, fakeContext, loopMiss } from '../testing/context.ts';
import { linkCandidate, linkMisses } from './link_misses.ts';
import { score } from '../policy.ts';

const done = (...missIds: string[]) => activity('postmortem_done', { targets: missIds.flatMap((m) => [m.replace('miss:', ''), m]) });
const older = (id: string, o = {}) => loopMiss(id, { createdAt: '2026-10-01T00:00:00.000Z', ...o });
/** A link_misses decision recorded observed, from -> to. */
const observedLink = (from: string, to: string): Decision => ({
  ...linkCandidate(loopMiss(from), older(to))!, id: `dec:${from}`, type: 'link_misses', status: 'observed', mode: 'observe', tier: 'H',
  score: 0.9, confidence: { p: 0.9, lower: 0.8, n: 0, band: 4 }, model: 'deterministic', policyVersion: 1, dependsOn: [], createdAt: 't',
  appliedAt: null, decidedAt: null, decidedBy: null, supersededBy: null, rollback: null, ratifiedAt: null, ratifiedBy: null, syncHoldUntil: null,
});

describe('linkCandidate: the floors', () => {
  const m = loopMiss('miss:new', { embedding: axis(0, 0.2) });
  test('cosine ≥ .9 and a shared edited file: a call, with both ends, snapshots and features', () => {
    const c = linkCandidate(m, older('miss:old', { cause: 'context_missing' }))!;
    expect(c.targets).toEqual([{ kind: 'miss', id: 'miss:new', role: 'primary' }, { kind: 'miss', id: 'miss:old', role: 'keeper' }]);
    expect(c.before).toEqual([missLinkSnapshot('miss:new', 'miss:old', false)]);
    expect(c.after).toEqual([missLinkSnapshot('miss:new', 'miss:old', true)]);
    expect(c.features).toEqual({ cosine: 0.981, cosineAbove: 0.806, sharedFiles: 1 / 3, sameCause: 0 });
    expect(c.evidence.map((e) => `${e.kind}:${e.id}:${e.role}`)).toEqual(['miss:miss:old:repeated miss', 'miss:miss:new:repeat', 'miss:miss:new:edited src/a.ts']);
    expect(c.rationale).toContain('both sessions edited src/a.ts');
    expect(c.rationale).not.toContain('same cause');
    expect(c.projectKey).toBe('demo');
  });
  test('the same cause stands in for a shared file', () => {
    const c = linkCandidate(m, older('miss:old', { editedFiles: ['src/b.ts'] }))!;
    expect(c.features.sharedFiles).toBe(0);
    expect(c.features.sameCause).toBe(1);
    expect(c.rationale).toContain('same cause (verification_gap)');
  });
  test('neither a shared file nor the same cause, or a cosine under .9, or no embedding: no call', () => {
    expect(linkCandidate(m, older('miss:old', { editedFiles: [], cause: 'context_missing' }))).toBeNull();
    expect(linkCandidate(m, older('miss:old', { embedding: axis(0, 1.5) }))).toBeNull();
    expect(linkCandidate(m, older('miss:old', { embedding: null }))).toBeNull();
  });
  test('many shared files: the feature caps at 3 and the rationale names three', () => {
    const files = ['a', 'b', 'c', 'd', 'e'];
    const c = linkCandidate(loopMiss('miss:n', { editedFiles: files }), older('miss:o', { editedFiles: files }))!;
    expect(c.features.sharedFiles).toBe(1);
    expect(c.rationale).toContain('a, b, c and 2 more');
  });
  test('a closer repeat with more evidence scores higher', () => {
    const weak = linkCandidate(m, older('miss:o', { editedFiles: [] }))!;
    const strong = linkCandidate(loopMiss('miss:n'), older('miss:o'))!;
    expect(score(linkMisses, strong.features)).toBeGreaterThan(score(linkMisses, weak.features));
  });
});

describe('linkMisses.candidates', () => {
  test('a new miss from a post-mortem is linked to each earlier repeat; later misses and itself are not', async () => {
    const ctx = fakeContext({
      entries: [done('miss:new'), activity('context_served', { targets: ['miss:old'] })],
      misses: [loopMiss('miss:new'), older('miss:old'), loopMiss('miss:later', { createdAt: '2026-11-05T00:00:00.000Z' }), older('miss:far', { embedding: axis(3) })],
    });
    const r = await linkMisses.candidates(ctx);
    expect(r.candidates.map((c) => c.targets.map((t) => t.id))).toEqual([['miss:new', 'miss:old']]);
    expect(r.scanned).toBe(2);
    expect(r.skipped).toEqual({ not_a_repeat: 1 });
  });
  test('the same time: the lower id is the earlier', async () => {
    const ctx = fakeContext({ entries: [done('miss:b')], misses: [loopMiss('miss:a'), loopMiss('miss:b'), loopMiss('miss:c')] });
    expect((await linkMisses.candidates(ctx)).candidates.map((c) => c.targets[1].id)).toEqual(['miss:a']);
  });
  test('never: the demo, a run or sandbox miss at either end, a project out of scope, a link already there, a miss with no embedding', async () => {
    const misses = [
      loopMiss('miss:demo:demo:1'), loopMiss('miss:run', { run: 'r1' }), loopMiss('miss:other', { projectKey: 'other' }), loopMiss('miss:flat', { embedding: null }),
      loopMiss('miss:new'), older('miss:sandboxed', { sandbox: true }), older('miss:linked'),
    ];
    const ctx = fakeContext({
      entries: [done('miss:demo:demo:1', 'miss:run', 'miss:other', 'miss:flat', 'miss:new', 'miss:gone')],
      misses,
      links: [{ from: 'miss:new', to: 'miss:linked', decisionId: 'dec:x', createdAt: 't' }],
      inScope: (k) => k === 'demo',
    });
    const r = await linkMisses.candidates(ctx);
    expect(r.candidates).toEqual([]);
    // Of miss:new's neighbours, the demo and sandbox misses are never targets and miss:flat has nothing to compare.
    expect(r.skipped).toEqual({ never_target: 4, out_of_scope: 1, below_floor: 2, already_decided: 1 });
  });
  test('recheck: each pair it only observed measured again, in order: still a repeat, the call; else why not', async () => {
    const observed = [
      observedLink('miss:a', 'miss:old'), observedLink('miss:b', 'miss:old'), observedLink('miss:gone', 'miss:old'),
      observedLink('miss:c', 'miss:old'), observedLink('miss:d', 'miss:old'),
    ];
    const misses = [
      loopMiss('miss:a'), loopMiss('miss:b', { editedFiles: ['src/z.ts'], cause: 'context_missing' }), loopMiss('miss:c'),
      loopMiss('miss:d', { projectKey: 'other' }), older('miss:old'),
    ];
    const r = await linkMisses.recheck!(fakeContext({ misses, inScope: (k) => k === 'demo', links: [{ from: 'miss:c', to: 'miss:old', decisionId: 'dec:owner', createdAt: 't' }] }), observed);
    expect(r.map((x) => (typeof x === 'string' ? x : x.targets.map((t) => t.id)))).toEqual([
      ['miss:a', 'miss:old'], 'no_longer_a_repeat', 'no_longer_a_repeat', 'already_decided', 'out_of_scope',
    ]);
  });
  test('nothing new: nothing read', async () => {
    expect(await linkMisses.candidates(fakeContext({ misses: [loopMiss('miss:a')] }))).toEqual({ candidates: [], scanned: 0, skipped: {} });
  });
});
