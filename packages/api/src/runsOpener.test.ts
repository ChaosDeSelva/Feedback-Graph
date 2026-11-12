import type { RunOwner } from '@fb/core';
import { expect, test } from 'vitest';
import { openerOf } from './runs.ts';

const owner = (o: Partial<RunOwner>): RunOwner => ({ run: 'r1', principal: 'browser', actor: null, firstSeen: '2026-11-01T00:00:00Z', ...o });

test('a run opener is named in words, and one another release stored is named as stored', () => {
  expect(openerOf(owner({ principal: 'browser' }))).toBe('the browser');
  expect(openerOf(owner({ principal: 'operator', actor: 'ci' }))).toBe('the operator token as ci');
  expect(openerOf(owner({ principal: 'service' as never }))).toBe('the service credential');
});
