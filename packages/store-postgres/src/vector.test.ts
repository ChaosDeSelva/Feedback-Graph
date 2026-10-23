import { expect, test } from 'vitest';
import { pgvectorProblem } from './vector.ts';

test('pgvector 0.8.0 and newer serve the searches; older versions and a missing extension are refused with why', () => {
  for (const ok of ['0.8.0', '0.8.7', '0.9.0', '0.10.1', '1.0.0']) expect(pgvectorProblem(ok)).toBeNull();
  for (const old of ['0.5.1', '0.7.4', '0.7.10']) expect(pgvectorProblem(old)).toMatch(new RegExp(`pgvector 0\\.8\\.0 or newer, found ${old.replaceAll('.', '\\.')}`));
  expect(pgvectorProblem(null)).toMatch(/not installed/);
});
