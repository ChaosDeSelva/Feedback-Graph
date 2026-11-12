import { describe, expect, test } from 'vitest';
import { redactSecrets } from './redact.ts';
import { BENIGN, POSITIVE } from './redact076.corpus.ts';

const hidden = (text: string, secret: string) => {
  const out = redactSecrets(text);
  expect(out).toContain('[REDACTED]');
  expect(out).not.toContain(secret);
  expect(redactSecrets(out)).toBe(out);
};

describe('0.7.6 minisign keys', () => {
  test.each([
    'untrusted comment: minisign encrypted secret key',
    'untrusted comment: minisign secret key',
  ])('%s is redacted with its body', (comment) => {
    const body = 'RWRTY0Iy' + 'aB3cD4eF5gH6iJ7k'.repeat(8);
    hidden(`${comment}\n${body}\n`, body);
  });
});

describe('0.7.6 held-out corpus', () => {
  test.each(BENIGN)('ordinary code or prose comes through untouched: %s', (line) => expect(redactSecrets(line)).toBe(line));
  test.each(POSITIVE)('credential form is redacted: %s', (text, secret) => hidden(text, secret));
});

describe('0.7.6 Mailchimp keys', () => {
  const key = '0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d';
  test.each([`mailchimp api key ${key}-us6`, `Mailchimp: ${key}-us21`, `MAILCHIMP_KEY=${key}-us6`, `apikey: ${key}-us6`, `"mc_api_key": "${key}-us12"`])(
    'a named or labelled key is redacted: %s', (text) => hidden(text, key));
  test.each([`d41d8cd98f00b204e9${'800998ecf8427e-us1'}`, `cache entry 9e107d9d372bb6826b${'d81d3542a419d6-us12'} expired`, `etag "${key}-us6"`])(
    'an md5 with a region suffix stays: %s', (text) => expect(redactSecrets(text)).toBe(text));
  test.each([`curl -u "anystring:${key}-us6" https://us6.api.mailchimp.com/3.0/ping`, `curl --user anystring:${key}-us6 $URL`, `-H "Authorization: apikey ${key}-us6"`, `${key}-us6 (Mailchimp)`, `export KEY=${key}-us6 # from the mailchimp dashboard`])(
    'a key with Mailchimp after it, the apikey scheme or as a curl password is redacted: %s', (text) => hidden(text, key));
});

test('0.7.6 a Dynatrace token is redacted through its secret part', () => {
  const secret = 'G3DFPBEJYMODIDAEX454M7YWBUVEFOWKPRVMWFASS64NFH52PX6BNDVFFM572RZM';
  hidden(`DT_API_TOKEN dt0c01.ST2EY72KQINMH574WMNVI7YN.${secret} for the tenant`, secret);
  hidden(`dt0c01.ST2EY72KQINMH574WMNVI7YN.${secret}`, secret);
});
