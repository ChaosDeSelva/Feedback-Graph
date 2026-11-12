import { expect, test, vi } from 'vitest';
import { missLinkSnapshot, type Decision } from '@fb/core';
import { decisionsStoreExecutor } from './memoryExecutor.ts';

const decision = (o: Partial<Decision> = {}) => ({
  id: 'dec:1', type: 'link_misses', before: [missLinkSnapshot('miss:b', 'miss:a', false)], after: [missLinkSnapshot('miss:b', 'miss:a', true)], ...o,
}) as Decision;
const store = (o: { applying?: boolean; linked?: boolean } = {}) => ({
  markApplying: vi.fn(async () => o.applying ?? true),
  markApplied: vi.fn(async () => true),
  markStatus: vi.fn(async () => true),
  linkMisses: vi.fn(async () => o.linked ?? true),
  missLinks: vi.fn(async () => (o.linked === false ? [] : [{ from: 'miss:b', to: 'miss:a', decisionId: 'dec:1', createdAt: 't' }])),
  get: vi.fn(async () => ({ ...decision(), status: 'applied' }) as Decision),
});

test('link_misses: applying, the link, then applied with the link as written', async () => {
  const s = store();
  const r = await decisionsStoreExecutor(s).apply(decision(), { by: 'loop:1', syncHoldUntil: null });
  expect(r).toEqual({ status: 'applied', decision: expect.objectContaining({ status: 'applied' }) });
  expect(s.linkMisses).toHaveBeenCalledWith({ from: 'miss:b', to: 'miss:a', decisionId: 'dec:1' });
  expect(s.markApplied).toHaveBeenCalledWith('dec:1', [missLinkSnapshot('miss:b', 'miss:a', true)], { syncHoldUntil: null });
});

test('someone decided it first: lost, nothing written', async () => {
  const s = store({ applying: false });
  expect(await decisionsStoreExecutor(s).apply(decision(), { by: 'loop:1', syncHoldUntil: null })).toEqual({ status: 'lost' });
  expect(s.linkMisses).not.toHaveBeenCalled();
});

test('the link is there already or a miss is gone: overridden', async () => {
  const s = store({ linked: false });
  expect(await decisionsStoreExecutor(s).apply(decision(), { by: 'loop:1', syncHoldUntil: null })).toEqual({ status: 'changed', reason: expect.any(String) });
  expect(s.markStatus).toHaveBeenCalledWith('dec:1', { status: 'overridden', from: ['applying'] });
  expect(s.markApplied).not.toHaveBeenCalled();
});

test('other types are the core executors\'', async () => {
  await expect(decisionsStoreExecutor(store()).apply(decision({ type: 'rank_weight' }), { by: 'loop:1', syncHoldUntil: null })).rejects.toThrow('no executor for rank_weight');
});

test('changed: null while the link the decision made is there, why once it is gone', async () => {
  expect(await decisionsStoreExecutor(store()).changed(decision())).toBeNull();
  expect(await decisionsStoreExecutor(store({ linked: false })).changed(decision())).toBe('the link from miss:b to miss:a is gone');
});
