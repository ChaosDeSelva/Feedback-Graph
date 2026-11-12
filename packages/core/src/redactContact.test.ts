import { describe, expect, test } from 'vitest';
import { CONTACT_PATTERNS, redactContact, redactIntakeText, redactSecrets, redactStoredIntake } from './redact.ts';

describe('redactContact: e-mail addresses', () => {
  test.each([
    ['mail ana.lopez+sync@example.test about it', 'mail [email] about it'],
    ['<bo_chen@mail.example.co.uk>', '<[email]>'],
    ['Ana (ana@example.test), Bo (bo@example.test).', 'Ana ([email]), Bo ([email]).'],
    ['UPPER.CASE@EXAMPLE.TEST', '[email]'],
  ])('%j', (input, out) => expect(redactContact(input)).toBe(out));

  test.each([
    'user@localhost', '@scope/package', 'ana at example dot test', 'see @ana in the channel', 'a@b', 'version 1.2@3',
  ])('%j is left alone', (input) => expect(redactContact(input)).toBe(input));
});

describe('redactContact: phone numbers', () => {
  test.each([
    ['call +1 (555) 010-0199 today', 'call [phone] today'],
    ['+44 20 7946 0958', '[phone]'],
    ['+4915112345678', '[phone]'],
    ['0049 30 1234567', '[phone]'],
    ['(555) 010-0199', '[phone]'],
    ['555-010-0199', '[phone]'],
    ['555.010.0199', '[phone]'],
    ['1 555 010 0199', '[phone]'],
    ['020 7946 0958', '[phone]'],
    ['07700 900123', '[phone]'],
    ['06 12 34 56 78', '[phone]'],
    ['my mobile is 5550100199', 'my mobile is [phone]'],
    ['call me on 555 0100', 'call me on [phone]'],
    ['WhatsApp: 555-0100', 'WhatsApp: [phone]'],
  ])('%j', (input, out) => expect(redactContact(input)).toBe(out));

  test.each([
    'ship on 2026-11-10', 'the host is 192.168.100.200', 'Node 20.11.1', 'retry after 30000 ms', 'at 00:12:03', '00:00:01,000 --> 00:00:04,000',
    'revenue was 1 200 000 000', 'order 1234567890', 'ticket ABC-12345678', 'v1.2.3.4567', '0.5 0.75 0.9', 'pi is 3.14159265',
    'commit 4f2a9c1', 'between 10 and 20', 'ids 12345678 and 87654321', '1234-5678-9012-3456-7890', '(555) 010-0199-1234567',
    'tel 12', '555-010-0199-0001',
  ])('%j is left alone', (input) => expect(redactContact(input)).toBe(input));
});

describe('redactContact: URL query tokens', () => {
  test.each([
    ['join https://meet.example.test/j/123456?pwd=Zx81abQ9 now', 'join https://meet.example.test/j/123456?[query] now'],
    ['https://example.test/doc?id=8812&usp=sharing#h.2', 'https://example.test/doc?[query]#h.2'],
  ])('%j', (input, out) => expect(redactContact(input)).toBe(out));

  test.each(['https://example.test/list?page=2&sort=asc', 'https://example.test/a?b', 'https://example.test/path'])('%j is left alone', (input) =>
    expect(redactContact(input)).toBe(input));
});

describe('redactIntakeText', () => {
  test('secrets first, then contact details', () => {
    const text = 'Ana: the password is hunter2! mail ana@example.test or call 555-010-0199';
    expect(redactIntakeText(text)).toBe(redactContact(redactSecrets(text)));
    expect(redactIntakeText(text)).toMatch(/^Ana: the password is \[REDACTED\].* mail \[email\] or call \[phone\]$/);
  });

  test('is idempotent', () => {
    const once = redactIntakeText('ana@example.test, +44 20 7946 0958, https://example.test/x?token=abcdef123');
    expect(redactIntakeText(once)).toBe(once);
  });

  test('the secret rules alone leave contact details: those are for intake text only', () => {
    expect(redactSecrets('mail ana@example.test or call 555-010-0199')).toBe('mail ana@example.test or call 555-010-0199');
  });
});

describe('redactStoredIntake', () => {
  test('redacts the named text fields and returns null when nothing changes', () => {
    const row = { id: 'c1', statement: 'Ana will mail bo@example.test', quote: 'mail bo@example.test', speaker: 'ana@example.test', confidence: 0.9 };
    expect(redactStoredIntake(row, ['statement', 'quote'])).toEqual({ ...row, statement: 'Ana will mail [email]', quote: 'mail [email]' });
    expect(redactStoredIntake({ id: 'c2', statement: 'We use Postgres.', quote: null }, ['statement', 'quote'])).toBeNull();
  });
});

describe('contact rules stay linear', () => {
  const SIZE = 100_000;
  const hostile = ['a', '1', '1 ', '1-', '(1', '+1 ', 'a@', 'a.', '@a.', 'a@a.', 'http://a?', 'https://a/?b=', '0 ', '00', '.1'];
  test.each(CONTACT_PATTERNS.map((re) => [re.source.slice(0, 40), re] as const))('%s', (_label, re) => {
    for (const unit of hostile) {
      const text = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
      const start = performance.now();
      text.replace(new RegExp(re.source, re.flags), '');
      expect(performance.now() - start, JSON.stringify(unit)).toBeLessThan(300);
    }
  });
});
