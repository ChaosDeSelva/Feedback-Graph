/**
 * Vitest setup file for the integration project (vitest.config.ts): makes "postgres" a backend the contract suites
 * can run on. Loaded for every run; it only connects when TEST_STORES names postgres.
 */
import { registerTestStore } from '@fb/core/testing';

registerTestStore('postgres', async () => (await import('./harness.ts')).openPostgresTestStore());
