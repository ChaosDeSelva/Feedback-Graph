/**
 * The contract-test harness. A suite written with describeStores() runs once per backend named in TEST_STORES
 * (comma list, default "neo4j"), each against a fresh, wiped store. Test-only: production code never imports this.
 *
 * Neo4j is built in. Other backends register a factory from a vitest setup file (see
 * packages/store-postgres/src/testing/register.ts), so @fb/core never depends on them.
 */
import { afterAll, beforeAll, beforeEach, describe } from 'vitest';
import { STORE_KINDS, type Store, type StoreKind } from '../store.ts';
import { openNeo4jTestStore } from './neo4j.ts';
import type { StoreProbe } from './probe.ts';

export type * from './probe.ts';
export { Neo4jProbe } from './neo4j.ts';

export type TestStore = { store: Store; probe: StoreProbe };
export type TestStoreFactory = () => Promise<TestStore>;

const factories = new Map<StoreKind, TestStoreFactory>([['neo4j', openNeo4jTestStore]]);

export function registerTestStore(kind: StoreKind, factory: TestStoreFactory) {
  factories.set(kind, factory);
}

/** The backends this run tests: TEST_STORES, default neo4j. */
export function testStores(env: Record<string, string | undefined> = process.env): StoreKind[] {
  const kinds = (env.TEST_STORES ?? 'neo4j').split(',').map((s) => s.trim()).filter(Boolean);
  for (const k of kinds) if (!STORE_KINDS.includes(k as StoreKind)) throw new Error(`TEST_STORES: unknown store "${k}" (known: ${STORE_KINDS.join(', ')})`);
  return [...new Set(kinds)] as StoreKind[];
}

export type StoreHarness = { readonly kind: StoreKind; readonly store: Store; readonly probe: StoreProbe };

/**
 * describe(`${name} [backend]`) once per backend under test. The store opens before the suite, is wiped before each
 * test (before the suite's own beforeEach hooks), and closes after. Read h.store / h.probe inside hooks and tests.
 * `only`: a suite about one backend's internals; it shows as skipped for the others.
 */
export function describeStores(name: string, body: (h: StoreHarness) => void, o: { only?: StoreKind[] } = {}) {
  for (const kind of testStores()) {
    const run = !o.only || o.only.includes(kind);
    (run ? describe : describe.skip)(`${name} [${kind}]`, () => {
      let opened: TestStore | null = null;
      const need = () => {
        if (!opened) throw new Error(`the ${kind} test store is not open (use h.store inside hooks and tests, not at collection time)`);
        return opened;
      };
      const h: StoreHarness = {
        kind,
        get store() {
          return need().store;
        },
        get probe() {
          return need().probe;
        },
      };
      if (run) {
        beforeAll(async () => {
          const factory = factories.get(kind);
          if (!factory) throw new Error(`no test store registered for "${kind}"; is its vitest setup file loaded?`);
          opened = await factory();
        });
        afterAll(async () => {
          await opened?.store.close();
          opened = null;
        });
        beforeEach(async () => {
          await need().probe.wipe();
        });
      }
      body(h);
    });
  }
}
