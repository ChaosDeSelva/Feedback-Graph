import { expect, test } from 'vitest';
import { saysNoMiss } from './noMiss.ts';
test('a disputed claim found false never becomes a miss', () => {
  expect(saysNoMiss({ missed: 'The feedback was incorrect; the code already handled this.', causeExplanation: 'The agent correctly disputed the claim.' })).not.toBeNull();
  expect(saysNoMiss({ missed: 'The correct implementation still missed an authorization check.', causeExplanation: 'Missing tenant scope.' })).toBeNull();
});
