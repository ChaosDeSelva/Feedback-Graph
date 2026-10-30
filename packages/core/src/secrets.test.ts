import { expect, test } from 'vitest';
import { isSecretPath } from './secrets.ts';

test.each(['.envrc', '.pgpass', '.vault-token', '.kube/config', 'config/kubeconfig', '.docker/config.json', 'deploy/service-account.json', '.env', 'app/.env.local', '.mcp.json', 'deploy/key.pem', 'ssh/id_rsa', 'aws/credentials', 'config/db-password.txt', 'infra/terraform.tfstate', 'android/release.keystore', 'certs/a.p12', '.pypirc', '.git/config'])('%s is a secret file', (p) => {
  expect(isSecretPath(p)).toBe(true);
});

test.each(['src/env.ts', 'README.md', 'src/keyboard.ts', 'docs/identity.md', 'src/passwordStrength.test.ts.snap'])('%s is not', (p) => {
  // A file *named* for passwords is skipped on purpose (it often holds them); code that merely mentions them is not.
  expect(isSecretPath(p)).toBe(p.includes('password'));
});


test.each([
  '.git-credentials', '.htpasswd', '.my.cnf', '.s3cfg', '.boto', '.terraformrc', 'terraform.rc',
  '.aws/config', '.aws/sso/cache/account.json', '.azure/accessTokens.json', '.azure/msal_token_cache.json',
  '.config/gcloud/application_default_credentials.json', '.config/gcloud/credentials.db', '.config/gcloud/access_tokens.db',
  '.config/gh/hosts.yml', '.gem/credentials', '.bundle/config', 'deploy/signing.p8', 'vpn/client.ovpn', 'vault/master.agekey',
])('credential file is excluded: %s', path => expect(isSecretPath(path)).toBe(true));


test.each(['.dev.vars', 'login.ppk', 'terraform.tfstate.backup', 'pip.conf', '.yarnrc.yml', 'private.gpg', 'appsettings.Production.json', 'wp-config.php', 'local_settings.py'])(
  '0.6.6 never scans credential file %s', path => { expect(isSecretPath(path)).toBe(true); expect(isSecretPath(`nested/${path}`)).toBe(true); },
);


test.each(['state/settings/integrations.json', '.run-key-salt', '.codex/auth.json', '.vault_pass', 'deploy/vault.yml', 'firebase-adminsdk-test.json', 'backups/2026-10-30/state.tgz'])('0.7.0 credential path excluded from scans: %s', path => expect(isSecretPath(path)).toBe(true));
