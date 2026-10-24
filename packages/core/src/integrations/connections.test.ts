import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { credentialFile, Integrations, tokenFingerprint } from './connections.ts';

function kv() {
  const m = new Map<string, string>();
  return { m, getCursor: async (k: string) => m.get(k) ?? null, setCursor: async (k: string, v: string) => void m.set(k, v) };
}
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'fg-int-')), 'settings', 'integrations.json');

describe('Integrations', () => {
  test('a pasted token is kept in a mode-600 file, never in the store; .env wins over it', async () => {
    const store = kv();
    const path = tmpFile();
    const app = new Integrations(store, {}, credentialFile(path));
    await app.saveCredential('github', 'from-app');
    expect(await app.credential('github')).toEqual({ token: 'from-app', source: 'app', fingerprint: tokenFingerprint('from-app') });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).github.token).toBe('from-app');
    expect([...store.m.values()].join()).not.toContain('from-app');

    const env = new Integrations(store, { GITHUB_TOKEN: ' from-env ' }, credentialFile(path));
    expect(env.envSet('github')).toBe(true);
    expect(await env.credential('github')).toMatchObject({ token: 'from-env', source: 'env' });
    expect(await env.savedInApp('github')).toBe(true);
  });

  test('without a file, tokens come only from .env and saving says why not', async () => {
    const app = new Integrations(kv(), {});
    expect(app.canSave).toBe(false);
    expect(await app.credential('linear')).toBeNull();
    await expect(app.saveCredential('linear', 'k')).rejects.toThrow(/INTEGRATIONS_FILE/);
  });

  test('disconnecting forgets that token and its check, and keeps the other service', async () => {
    const app = new Integrations(kv(), {}, credentialFile(tmpFile()));
    await app.saveCredential('linear', 'k');
    await app.saveCredential('github', 'g');
    await app.saveCheck('linear', { ok: true, account: 'Pat', error: null, errorKind: null, at: 'now', source: 'app', fingerprint: 'f' });
    await app.removeCredential('linear');
    expect(await app.credential('linear')).toBeNull();
    expect(await app.check('linear')).toBeNull();
    expect(await app.credential('github')).toMatchObject({ token: 'g' });
  });

  test('project links default to GitHub on and no Linear team; keys never end in :<project>', async () => {
    const store = kv();
    const app = new Integrations(store, {});
    expect(await app.link('shop')).toEqual({ github: true, linearTeamId: null, linearTeamName: null });
    await app.setLink('shop', { linearTeamId: 't1', linearTeamName: 'Web' });
    await app.setLink('shop', { github: false });
    expect(await app.link('shop')).toEqual({ github: false, linearTeamId: 't1', linearTeamName: 'Web' });
    await app.saveSync('github', await app.sync('github'));
    for (const k of store.m.keys()) expect(k).not.toMatch(/:[^/]*$/);
  });

  test('sync state starts empty', async () => {
    expect(await new Integrations(kv(), {}).sync('github')).toEqual({ lastSyncAt: null, lastError: null, errorKind: null, rateLimitedUntil: null, authFailedFor: null, projects: {} });
  });
});
