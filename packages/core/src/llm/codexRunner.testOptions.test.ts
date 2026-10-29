import { expect, test } from 'vitest';
import { runnerTestSystemPaths } from './codexRunner.testOptions.ts';

test('runner test compatibility requires explicit opt-in; unset keeps masked defaults', () => {
  for (const value of [undefined, '', '0']) expect(runnerTestSystemPaths(value)).toEqual([]);
  expect(runnerTestSystemPaths('1')).toEqual(['--security-opt', 'systempaths=unconfined']);
  expect(() => runnerTestSystemPaths('true')).toThrow(/must be 0 or 1/);
});
