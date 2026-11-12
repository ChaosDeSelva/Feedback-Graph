import { expect, test } from 'vitest';
import { isSecretPath, SECRET_GLOBS } from './secrets.ts';

test.each(['.envrc', '.pgpass', '.vault-token', '.kube/config', 'config/kubeconfig', '.docker/config.json', 'deploy/service-account.json', '.env', 'app/.env.local', '.mcp.json', 'deploy/key.pem', 'ssh/id_rsa', 'aws/credentials', 'config/db-password.txt', 'infra/terraform.tfstate', 'android/release.keystore', 'certs/a.p12', '.pypirc', '.git/config'])('%s is a secret file', (p) => {
  expect(isSecretPath(p)).toBe(true);
});

test.each(['src/env.ts', 'README.md', 'src/keyboard.ts', 'docs/identity.md', 'src/passwordStrength.test.ts.snap'])('%s is not', (p) => {
  expect(isSecretPath(p)).toBe(false);
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

test.each([
  ['.config/glab-cli/config.yml', '**/.config/glab-cli/**'],
  ['.config/linode-cli/config', '**/.config/linode-cli/**'],
  ['.fly/config.yml', '**/.fly/config.yml'], ['.op/config', '**/.op/config'], ['.circleci/cli.yml', '**/.circleci/cli.yml'],
  ['.supabase/access-token', '**/.supabase/access-token'], ['.railway/config.json', '**/.railway/config.json'],
  ['Library/Application Support/1Password/settings.json', '**/Library/Application Support/1Password/**'],
  ['Library/Application Support/ngrok/ngrok.yml', '**/Library/Application Support/ngrok/**'],
])('0.7.5 scanner and Claude deny the same credential store: %s', (path, glob) => {
  expect(isSecretPath(path)).toBe(true);
  expect(SECRET_GLOBS).toContain(glob);
});

test.each(['.circleci/config.yml', 'repo/.circleci/config.yml', '.circleci/orbs/deploy.yml', '.fly/launch.toml', '.supabase/seed.sql', '.railway/railway.toml', '.op/README.md'])(
  '0.7.6 a repository folder named like a CLI home folder is not a credential store: %s', (path) => {
    expect(isSecretPath(path)).toBe(false);
    expect(SECRET_GLOBS.filter((g) => /\/\.(?:circleci|fly|op|supabase|railway)\/\*\*$/.test(g))).toEqual([]);
  },
);

test.each([
  ['.config/linode-cli', '**/.config/linode-cli'], ['_netrc', '**/_netrc'],
  ['.netlify/config.json', '**/.netlify/config.json'], ['.config/netlify/config.json', '**/.config/netlify/config.json'],
  ['Library/Preferences/netlify/config.json', '**/Library/Preferences/netlify/config.json'],
  ['.wrangler/config/default.toml', '**/.wrangler/config/*.toml'], ['.config/.wrangler/config/default.toml', '**/.config/.wrangler/config/*.toml'],
  ['Library/Preferences/.wrangler/config/default.toml', '**/Library/Preferences/.wrangler/config/*.toml'],
  ['.oci/config', '**/.oci/config'], ['.oci/sessions/DEFAULT/token', '**/.oci/sessions/**'], ['.twilio-cli/config.json', '**/.twilio-cli/config.json'],
  ['.cloudflared/0b7a.json', '**/.cloudflared/*.json'], ['.config/scw/config.yaml', '**/.config/scw/config.yaml'],
])('0.7.6 CLI credential store is denied to the scanner and Claude: %s', (path, glob) => {
  expect(isSecretPath(path)).toBe(true);
  expect(isSecretPath(`home/me/${path}`)).toBe(true);
  expect(SECRET_GLOBS).toContain(glob);
});

test.each(['secrets.py', 'app/password_reset.ts', 'src/credentials/manager.go', 'lib/secret_store.rb', 'src/credentialProvider.ts', 'docs/rotating-secrets.md', 'cmd/secrets/main.go'])(
  '0.7.6 source about secrets is code, not a credential file: %s', (path) => expect(isSecretPath(path)).toBe(false),
);

test.each([
  ['client_secret.json', '**/*secret*.json'], ['config/secrets.prod.yaml', '**/*secret*.yaml'], ['config/db-password.txt', '**/*password*.txt'],
  ['aws/credentials', '**/*credentials'], ['.secrets', '**/*secrets'], ['vault/credentials.db', '**/*credential*.db'], ['backup/passwords.kdbx', '**/*password*.kdbx'],
])('0.7.6 a data file named for secrets is still a credential file: %s', (path, glob) => {
  expect(isSecretPath(path)).toBe(true);
  expect(SECRET_GLOBS).toContain(glob);
});

test.each([
  ['config/prod.env', '**/*.env'], ['deploy/staging.env', '**/*.env'], ['prod.env.sh', '**/*.env.sh'],
  ['secrets.sh', '**/secrets.sh'], ['scripts/secrets.ps1', '**/secrets.ps1'], ['.secrets.zsh', '**/.secrets.zsh'],
  ['ci/credentials.bat', '**/credentials.bat'], ['passwords.cmd', '**/passwords.cmd'],
  ['.ngrok2/ngrok.yml', '**/.ngrok2/ngrok.yml'], ['home/me/.ngrok2/ngrok.yaml', '**/.ngrok2/ngrok.yaml'],
])('0.7.6 an env file in any folder, a script named for its secrets and the ngrok v2 config are credential files: %s', (path, glob) => {
  expect(isSecretPath(path)).toBe(true);
  expect(SECRET_GLOBS).toContain(glob);
});

test.each(['scripts/rotate-secrets.sh', 'bin/load-credentials.ps1', 'src/vite-env.d.ts', 'src/process.env.ts', 'scripts/env.sh', 'docs/ngrok.yml'])(
  '0.7.6 a script that acts on secrets and source named for env stay readable: %s', (path) => expect(isSecretPath(path)).toBe(false),
);
