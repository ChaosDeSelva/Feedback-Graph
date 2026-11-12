import { beforeAll, expect, test } from 'vitest';
import { missLinkSnapshot } from '../loop/snapshots.ts';
import type { Store } from '../store.ts';
import { describeStores } from '../testing/index.ts';

/** forTarget's cost: the engine asks once per call it makes, so it must not grow with the decisions on record. */
describeStores('DecisionsStore at scale', (h) => {
  let s: Store;
  beforeAll(() => { s = h.store; });

  const seed = async (from: number, to: number) => {
    for (let i = from; i < to; i += 25) {
      await Promise.all(Array.from({ length: Math.min(25, to - i) }, (_, j) => {
        const a = `miss:f${i + j}`, b = `miss:t${i + j}`;
        return s.decisions.propose({
          type: 'link_misses', projectKey: 'demo', targets: [{ kind: 'miss', id: a, role: 'primary' }, { kind: 'miss', id: b, role: 'keeper' }],
          before: [missLinkSnapshot(a, b, false)], after: [missLinkSnapshot(a, b, true)], evidence: [{ kind: 'miss', id: b, role: 'repeat of', weight: 1, observedAt: 't' }],
          features: {}, score: 0.9, confidence: { p: 0.8, lower: 0.56, n: 0, band: 4 }, tier: 'H', mode: 'observe', rationale: 'r', model: 'deterministic', policyVersion: 1, status: 'observed',
        });
      }));
    }
  };
  /** The database work of 41 forTarget and dependents calls on targets spread over what is stored (StoreProbe.work). */
  const work = (n: number) => h.probe.work(async () => {
    for (let i = 0; i < 41; i++) {
      await s.decisions.forTarget(`miss:f${(i * 37) % n}`);
      await s.decisions.dependents(`dec:none${i}`);
    }
  });

  test('forTarget and dependents do about the same work with ten times the decisions', async () => {
    await seed(0, 300);
    const small = await work(300);
    await seed(300, 3000);
    const large = await work(3000);
    // An index lookup, not a scan: a deeper index costs a few more hits per call, never ten times as many.
    expect(large, `${small} at 300, ${large} at 3000`).toBeLessThan(1.5 * small + 41 * 4);
  }, 300_000);
});
