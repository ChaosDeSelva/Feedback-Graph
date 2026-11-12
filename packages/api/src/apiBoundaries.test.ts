import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityInput } from '@fb/core';
import { expect, test, vi } from 'vitest';
import { createEventHub } from './events.ts';
import { asActor, runVia } from './operator.ts';
import { localPeers } from './peer.ts';
import { normalizeRoots, rootsFile } from './roots.ts';
import { loadRunKeySalt } from './runKeySalt.ts';
import { mcpDiscoveryOnly } from './storeWriteGuard.ts';

test('a salt file that is not 64 hex characters stops the start instead of salting run keys with it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fg-run-salt-'));
  try {
    const path = join(dir, 'salt');
    await writeFile(path, 'not-a-salt\n');
    await expect(loadRunKeySalt(path)).rejects.toThrow('invalid private run-key salt file');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.skipIf(process.getuid?.() === 0)('a settings folder the API cannot write fails the start with the file error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fg-run-salt-'));
  try {
    await chmod(dir, 0o500);
    await expect(loadRunKeySalt(join(dir, 'salt'))).rejects.toMatchObject({ code: 'EACCES' });
  } finally { await chmod(dir, 0o700); await rm(dir, { recursive: true, force: true }); }
});

test('an MCP message without a method is not discovery, so it keeps the write guard', () => {
  expect(mcpDiscoveryOnly({ jsonrpc: '2.0', id: 1 })).toBe(false);
  expect(mcpDiscoveryOnly([{ method: 'ping' }, { id: 2 }])).toBe(false);
  expect(mcpDiscoveryOnly({ method: 'ping' })).toBe(true);
});

test('a tokenless API answers a peer on one of its own IPv6 networks, and nobody without an address', () => {
  const local = localPeers({ eth0: [{ address: 'fd00::2', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: 'fd00::2/64', scopeid: 0 }] });
  expect(local('fd00::9')).toBe(true);
  expect(local('fd01::9')).toBe(false);
  expect(local(undefined)).toBe(false);
});

test('blank lines in the roots list are skipped and an over-long path is refused', () => {
  expect(normalizeRoots(['', '  ', '/a'], null)).toEqual({ roots: ['/a'] });
  expect(normalizeRoots(['/' + 'x'.repeat(1100)], null)).toEqual({ error: expect.stringMatching(/^\/x{39}\.\.\.: path too long$/) });
});

test('a roots file written without a time reads back with an empty updatedAt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fg-roots-'));
  try {
    await writeFile(join(dir, 'r.json'), JSON.stringify({ roots: ['/a'] }));
    expect(await rootsFile(join(dir, 'r.json')).read()).toEqual({ roots: ['/a'], updatedAt: '' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('one event stream that throws does not stop the others getting the event', async () => {
  const hub = createEventHub({ stage: async () => ({ stage: null, progress: null, workerHealthy: true }) }, { tickMs: 60_000 });
  const got: string[] = [];
  const offA = hub.subscribe(() => { throw new Error('closed socket'); });
  const offB = hub.subscribe((e) => got.push(e.event));
  await vi.waitFor(() => expect(got).toContain('stage'));
  offA(); offB();
});

test('an API client\'s write whose wording does not start with "you" keeps its wording and is labelled an API client', async () => {
  const seen: ActivityInput[] = [];
  const a = asActor({ record: async (e: ActivityInput) => { seen.push(e); return e as never; } });
  await runVia('api', () => a.record({ kind: 'project_pinned', actor: 'you', projectKey: null, subject: 's', why: 'pinned by request', details: {}, targets: [] }));
  expect(seen[0]).toMatchObject({ actor: 'api client', why: 'pinned by request', details: { via: 'api' } });
});

test('an API client\'s write worded for the owner ("you ...") is reworded to name the API client', async () => {
  const seen: { actor: string; why: string }[] = [];
  const a = asActor({ record: async (e: { actor: string; why: string }) => { seen.push(e); return e as never; } } as never) as { record: (e: object) => Promise<unknown> };
  await runVia('api', () => a.record({ kind: 'project_pinned', actor: 'you', projectKey: null, subject: 's', why: 'you pinned it', details: {}, targets: [] }));
  expect(seen[0]).toMatchObject({ actor: 'api client', why: 'an API client pinned it' });
});
