/** Files that hold credentials. The scanner never reads them and agent CLIs are denied them; one list for both. */
export const SECRET_FILE =
  /(^|\/)(integrations\.json|\.run-key-salt|auth\.json|\.vault_pass|vault\.ya?ml|[^/]*firebase-adminsdk-[^/]*\.json|\.env(\..*)?|\.dev\.vars|[^/]*\.ppk|[^/]*\.tfstate(?:\.[^/]*)?\.backup|pip\.conf|\.yarnrc\.yml|[^/]*\.gpg|appsettings\.(?:Production|Staging|Development)\.json|wp-config\.php|local_settings\.py|\.git-credentials|\.htpasswd|\.my\.cnf|\.s3cfg|\.boto|\.terraformrc|terraform\.rc|\.aws\/(?:config|sso\/cache\/[^/]+\.json)|\.azure\/(?:accessTokens\.json|msal_token_cache[^/]*)|\.config\/gcloud\/(?:application_default_credentials\.json|credentials\.db|access_tokens\.db)|\.config\/gh\/hosts\.ya?ml|\.gem\/credentials|\.bundle\/config|[^/]*\.(?:p8|ovpn|agekey)|\.envrc|\.pgpass|\.vault-token|(?:[^/]*[-_])?kubeconfig(?:\.[^/]*)?|\.kube\/config|\.docker\/config\.json|[^/]*service[-_]account[^/]*\.json|\.mcp\.json|\.npmrc|\.netrc|\.pypirc|\.git\/config|id_[a-z0-9]+|[^/]*\.(pem|key|p12|pfx|tfvars|tfstate|keystore|jks)|[^/]*(secret|credential|password)[^/]*)$/i;

export const isSecretPath = (path: string) => { const normalized = path.replaceAll('\\', '/'); return /(?:^|\/)(?:redaction-archive|redaction-key)(?:\/|$)/i.test(normalized) || /(?:^|\/)backups\/[^/]+\/state\.tgz$/i.test(normalized) || SECRET_FILE.test(normalized); };

/** The same files as SECRET_FILE, as globs for Claude Code's Read() deny rules. */
export const SECRET_GLOBS = [
  '**/integrations.json', '**/.run-key-salt', '**/auth.json', '**/.vault_pass', '**/vault.yml', '**/vault.yaml', '**/*firebase-adminsdk-*.json', '**/backups/*/state.tgz',
  '**/.dev.vars', '**/*.ppk', '**/*.tfstate.backup', '**/*.tfstate.*.backup', '**/pip.conf', '**/.yarnrc.yml', '**/*.gpg', '**/appsettings.Production.json', '**/appsettings.Staging.json', '**/appsettings.Development.json', '**/wp-config.php', '**/local_settings.py',
  '**/.git-credentials', '**/.htpasswd', '**/.my.cnf', '**/.s3cfg', '**/.boto', '**/.terraformrc', '**/terraform.rc',
  '**/.aws/config', '**/.aws/sso/cache/*.json', '**/.azure/accessTokens.json', '**/.azure/msal_token_cache*',
  '**/.config/gcloud/application_default_credentials.json', '**/.config/gcloud/credentials.db', '**/.config/gcloud/access_tokens.db',
  '**/.config/gh/hosts.yml', '**/.config/gh/hosts.yaml', '**/.gem/credentials', '**/.bundle/config', '**/*.p8', '**/*.ovpn', '**/*.agekey',
  '**/.env*', '**/.pgpass', '**/.vault-token', '**/*kubeconfig*', '**/.kube/config', '**/.docker/config.json', '**/*service-account*.json', '**/*service_account*.json', '**/.mcp.json', '**/.npmrc', '**/.netrc', '**/.pypirc', '**/.git/config', '**/id_*',
  '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.tfvars', '**/*.tfstate', '**/*.keystore', '**/*.jks',
  '**/redaction-archive/**', '**/redaction-key/**', '**/*secret*', '**/*credential*', '**/*password*',
];

/** Worker folders an agent must never read: transcripts (Claude Code and Codex), sync state, the Codex login, process environments. */
export const PRIVATE_DIRS = ['/proc/**', '/transcripts/**', '/codex-sessions/**', '/state/**', '/redaction-key/**', '/codex/**'];

/** Heavy or generated folders an agent gains nothing from reading. */
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'out', 'coverage', 'vendor', '.venv', '__pycache__', 'target', '.turbo', '.cache']);
