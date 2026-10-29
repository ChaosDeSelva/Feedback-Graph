import { expect, test } from 'vitest';
import { redactSecrets } from './redact.ts';
import { isSecretPath } from './secrets.ts';

test.each([
  "awk '{ print $1$2 }'", "perl -e 'print $1$2'", 'cache key-' + 'a1'.repeat(16),
  'package.subpackage.module_name.long_module_name.handlers.method_name',
  'PuTTY-User-Key-File-3: is a header mentioned here. Later Private-MAC: abcd is documented.',
  'file.go:12:3:vet: missing field', 'file.cc:12:3:Werror: unused variable', 'test.py:12:3:AssertionError: expected true',
])('0.6.9 keeps benign text intact: %s', value => expect(redactSecrets(value)).toBe(value));

test.each([
  "define('AUTH_KEY', 'Very Long Random Value 123!');", 'SECURE_AUTH_SALT="random-auth-salt-12345!"',
  'Password=StrongPassword123!;Server=db;',
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$' + 'YWJjZGVm'.repeat(4),
  '-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: OpenPGP\n\nYWJjZGVmMTIzYWJjZGVm',
  'Twilio API key SK' + 'a1'.repeat(16),
  'mailgun api key: ' + 'a1'.repeat(16) + '-12345678-abcdef12',
  'mailgun key-' + 'a1'.repeat(16),
  Buffer.from('123456789012345678').toString('base64url') + '.Ab12cd.' + 'Ab12'.repeat(8),
])('0.6.9 masks the reported credential: %s', value => {
  expect(redactSecrets(value)).toContain('[REDACTED]');
  expect(redactSecrets(redactSecrets(value))).toBe(redactSecrets(value));
});

test.each(['appsettings.Staging.json', 'config/appsettings.Development.json', 'app.20261029.tfstate.backup', 'app.tfstate.20261029.backup', 'state/settings/redaction-archive/abc.enc', 'redaction-key/private.pem'])('credential and archive files are excluded: %s', value => expect(isSecretPath(value)).toBe(true));
