import { describe, expect, test } from 'vitest';
import { redactSecrets } from './redact.ts';

// Sweep 6, N3: an AWS secret access key is 40 base64 characters, so one in 64 starts with "/" and was read as a path,
// even under its own name.
describe('a base64 key with slashes after a credential name is redacted, a leading slash and all', () => {
  test.each([
    'AWS_SECRET_ACCESS_KEY=/IQFsbrCDAHfD/UJNUdg' + '+tmKSywfFuvDHUOQoj2i',
    'export AWS_SECRET_ACCESS_KEY="/2Rf1xUalXgk85ohPWPj' + 'rTN5hM025JSowqKoRca2"',
    '{"SecretAccessKey":"/nbpdtrV225rZaVb5Ke4ItTNPtwFaUGbnHi/TyI9"}',
    'password: /IQFsbrCDAHfD/UJNUdg+tmKSywfFuvDHUOQoj2i',
    'api_key: "/nbpdtrV225rZaVb5Ke4ItTNPtwFaUGbnHi/TyI9"',
    'aws_secret_access_key = vKGi9SSVtorcIIKKXkEA' + 'EJ4M3AWCIOu/kJqhx/Ve',
    'aws_secret_access_key = CtvFRmLeNg+eYVMU+lBA' + '/tmaZNfUEwClXKMCwASw',
  ])('%s', (text) => {
    const out = redactSecrets(text);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toMatch(/[A-Za-z0-9+/]{20}/);
  });

  test('none of 4000 random keys is kept in the forms the sweep fuzzed', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const forms = [(v: string) => `AWS_SECRET_ACCESS_KEY=${v}`, (v: string) => `aws_secret_access_key = ${v}`, (v: string) => `export AWS_SECRET_ACCESS_KEY="${v}"`, (v: string) => JSON.stringify({ SecretAccessKey: v })];
    const kept: string[] = [];
    for (let i = 0; i < 4000; i++) {
      const v = Array.from({ length: 40 }, () => B64[Math.floor(rnd() * 64)]).join('');
      for (const f of forms) if (redactSecrets(f(v)).includes(v)) kept.push(f(v));
    }
    expect(kept).toEqual([]);
  });

  test('a path after a credential name stays', () => {
    for (const path of ['/var/lib/Data2', '/home/User1/keys/apiKey', '/usr/share/i18n/esdb/ISO646', '/Users/you/Library/Keychains/login', '/run/secrets/DbPassword', '/Volumes/Backup2024/Keys', '/srv/AppData/v2/Tokens']) {
      for (const text of [`password: ${path}`, `AWS_SECRET_ACCESS_KEY=${path}`, `"api_key": "${path}"`, `secret_key = ${path}`]) expect(redactSecrets(text), text).toBe(text);
    }
  });
});
