import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { OwnerSessions, sessionCookie } from './auth.ts';

const DAY = 86_400_000;
const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'fg-owner-sessions-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) { chmodSync(d, 0o700); rmSync(d, { recursive: true, force: true }); } });

test('a revocation file that cannot be read or replaced refuses earlier sessions and says it could not be written', () => {
  const dir = scratch();
  const state = join(dir, 'sessions');
  mkdirSync(state);
  const s = new OwnerSessions('k'.repeat(32), state, 1000);
  expect(s.stateProblem).toMatch(/is unreadable or corrupt: every earlier owner browser session is refused; sign in again and could not be written \(/);
});

test.skipIf(process.getuid?.() === 0)('a missing revocation file in a folder the API cannot write is named as missing', () => {
  const dir = scratch();
  chmodSync(dir, 0o500);
  const s = new OwnerSessions('k'.repeat(32), join(dir, 'sessions'), 1000);
  expect(s.stateProblem).toMatch(/sessions is missing and could not be written \(EACCES/);
});

test.each([['null', 'null'], ['a list', '[]'], ['a fractional cut-off', '{"notBefore":1.5,"revoked":{}}'], ['a key that is not a digest', '{"notBefore":0,"revoked":{"nope":5}}']])(
  'a revocation file holding %s is corrupt: the cut-off moves to now and the file is rewritten', (_what, text) => {
    const dir = scratch();
    const file = join(dir, 'sessions');
    writeFileSync(file, text);
    const s = new OwnerSessions('k'.repeat(32), file, 5000);
    expect(s.stateProblem).toMatch(/unreadable or corrupt/);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ notBefore: 5000, revoked: {} });
  });

test('without a signing key a session is a server-side random value; no cookie is no session', () => {
  const s = new OwnerSessions();
  const v = s.create(1000);
  expect(v.split('.')).toHaveLength(2);
  expect(s.has(v, 2000)).toBe(true);
  expect(s.has(undefined)).toBe(false);
});

test('signing out an expired or made-up session forgets it without writing a revocation', () => {
  const dir = scratch();
  const file = join(dir, 'sessions');
  const s = new OwnerSessions('k'.repeat(32), file, 1000);
  const before = readFileSync(file, 'utf8');
  const v = s.create(2000);
  s.remove(v, 2000 + 31 * DAY);
  s.remove('not-a-session', 3000);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(s.has(v, 2000 + 31 * DAY)).toBe(false);
});

test('expired sessions and revocations are dropped from what is kept when the next session is made', () => {
  const dir = scratch();
  const file = join(dir, 'sessions');
  const s = new OwnerSessions('k'.repeat(32), file, 1000);
  const old = s.create(2000);
  s.remove(s.create(2000), 2000);
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).revoked)).toHaveLength(1);
  s.create(2000 + 31 * DAY);
  s.remove(s.create(2000 + 31 * DAY), 2000 + 31 * DAY);
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).revoked)).toHaveLength(1);
  expect(s.has(old, 2000 + 31 * DAY)).toBe(false);
});

test('a session cookie is Secure only over https', () => {
  expect(sessionCookie('v', true)).toBe('fg_session=v; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure');
  expect(sessionCookie('v', false, true, 'fg_session_8080')).toBe('fg_session_8080=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
});
