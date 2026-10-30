import { expect, test } from 'vitest';
import { redactSecrets } from './redact.ts';

test.each([
  'Password=<your-password>;', 'Password=true;', 'Password = os.environ["DB_PASSWORD"];',
  'AUTH_KEY = os.environ["AUTH_KEY"]', 'AUTH_KEY: str', 'sk' + 'a1'.repeat(16),
  'localhost:5432:*:*:*', 'api key format is ABCD-1234',
  "define('AUTH_KEY', 'put your unique phrase here');",
])('0.7.0 preserves a reference, identifier or placeholder: %s', value => expect(redactSecrets(value)).toBe(value));

test.each([
  'The integration returned wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY in its message.',
  '-----BEGIN PRIVATE KEY-----\n' + 'YWJjZGVm'.repeat(8),
  'Connection failed with Password=x; after retry.',
  'Server=db;Password = StrongPassword123!;User=alice;',
])('0.7.0 masks the credential in prose or truncated output: %s', value => {
  expect(redactSecrets(value)).toContain('[REDACTED]');
  expect(redactSecrets(redactSecrets(value))).toBe(redactSecrets(value));
});
