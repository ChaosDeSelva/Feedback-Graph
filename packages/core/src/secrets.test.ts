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

test.each(['worker.sqlite', 'project-roots.json', 'neo4j.dump', 'rclone.conf', '.config/hub', '.m2/settings.xml', 'gradle.properties', 'codex-auth.json'])(
  '0.7.1 install/credential path excluded from scans: %s', path => expect(isSecretPath(path)).toBe(true),
);

test.each([
  'worker.sqlite-wal', 'worker.sqlite-shm', 'worker.sqlite-journal', 'backups/snapshot.dump',
  'backups/2026/11/state.tgz', '.dockercfg', '.yarnrc', 'sops/age/keys.txt', '.sentryclirc', '.databrickscfg',
])('0.7.2 adjacent state/credential path excluded from scans: %s', path => {
  expect(isSecretPath(path)).toBe(true);
  expect(isSecretPath(`nested/${path}`)).toBe(true);
});

test.each([
  '.config/fly/config.yml', '.config/stripe/config.toml', '.config/ngrok/ngrok.yml', '.config/circleci/cli.yml',
  '.config/glab-cli/config.yml', '.config/supabase/access-token', '.config/railway/config.json',
  '.config/hcloud/cli.toml', '.config/linode-cli', '.config/gcloud/legacy_credentials/me/adc.json',
  'Library/Application Support/doctl/config.yaml',
])('0.7.4 default credential-store path excluded: %s', path => expect(isSecretPath(path)).toBe(true));
