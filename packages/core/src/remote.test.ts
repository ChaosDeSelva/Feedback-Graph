import { expect, test } from 'vitest';
import { normalizeRemote } from './remote.ts';

test('scp and https forms of one GitHub repo give the same id', () => {
  expect(normalizeRemote('git@github.com:Org/Repo.git')).toBe('github.com/org/repo');
  expect(normalizeRemote('https://github.com/Org/Repo.git')).toBe('github.com/org/repo');
  expect(normalizeRemote('https://github.com/Org/Repo')).toBe('github.com/org/repo');
  expect(normalizeRemote('https://github.com/Org/Repo/')).toBe('github.com/org/repo');
  expect(normalizeRemote('https://GitHub.COM/Org/Repo.git/')).toBe('github.com/org/repo');
  expect(normalizeRemote('  git@github.com:Org/Repo.git\n')).toBe('github.com/org/repo');
});

test('credentials, scheme and port are stripped', () => {
  expect(normalizeRemote('https://user:token@github.com/Org/Repo.git')).toBe('github.com/org/repo');
  expect(normalizeRemote('ssh://git@host:22/a/b.git')).toBe('host/a/b');
  expect(normalizeRemote('git+ssh://git@host.example/a/b')).toBe('host.example/a/b');
  expect(normalizeRemote('http://host:8080/scm/a/b.git')).toBe('host/scm/a/b');
  expect(normalizeRemote('git://host/a/b.git')).toBe('host/a/b');
  expect(normalizeRemote('host.example:/srv/git/b.git')).toBe('host.example/srv/git/b');
});

test('no credential survives, in any form', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  for (const url of [
    `https://x-access-token:${secret}@github.com/Org/Repo.git`,
    `https://${secret}@github.com/Org/Repo.git`,
    `https://${secret}:x-oauth-basic@github.com/Org/Repo`,
    `ssh://${secret}@github.com/Org/Repo.git`,
    `${secret}@github.com:Org/Repo.git`,
    `https://github.com/Org/Repo.git?access_token=${secret}`,
    `https://github.com/Org/Repo.git#${secret}`,
    `https://user:pa@ss@github.com/Org/Repo.git`,
  ]) {
    const id = normalizeRemote(url);
    expect(id).toBe('github.com/org/repo');
    expect(id).not.toContain(secret.toLowerCase());
  }
});

test('local bare repos are identified by their name', () => {
  expect(normalizeRemote('/Users/x/repos/foo.git')).toBe('local/foo');
  expect(normalizeRemote('/Users/x/repos/Foo.git/')).toBe('local/foo');
  expect(normalizeRemote('file:///Users/x/repos/foo.git')).toBe('local/foo');
  expect(normalizeRemote('../foo.git')).toBe('local/foo');
  expect(normalizeRemote('./foo')).toBe('local/foo');
  expect(normalizeRemote('~/repos/foo.git')).toBe('local/foo');
});

test('garbage and empty values give null', () => {
  for (const url of ['', '   ', 'not a url', 'https://', 'https:///a/b', 'git@github.com:', 'ssh://host', '/', 'file:///', '.git', 'https://host/a/../b', 'foo', 'https://ho st/a', '~', 'https://host/~/-']) {
    expect(normalizeRemote(url), url).toBeNull();
  }
});
