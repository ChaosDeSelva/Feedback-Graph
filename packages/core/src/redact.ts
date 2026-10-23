const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bnpm_[A-Za-z0-9]{36,}/g,
  /\blin_api_[A-Za-z0-9]{32,}/g,
  // Feedback Graph Cloud personal access tokens: fgc_pat_<16 hex lookup id>_<secret>.
  /\bfgc_pat_[0-9a-f]{16}_[A-Za-z0-9_-]{20,}/g,
  // user:password@ in a URL; the user name stays.
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi,
  // Env-style assignments whose name says secret: KEY=value, export KEY="value". A $VAR reference is not a secret.
  /^(\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*\s*=\s*)(?!["']?\$)["']?[^\s"']{6,}["']?/gm,
  // Quoted config values: "password": "…", api_token: '…'. Unquoted values are usually code (password: z.string()).
  /(["']?\b[\w-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*:\s*)["'][^"'\s]{6,}["']/gi,
];

/** Strip credentials before anything is stored or sent to a model. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) {
    // A pattern's first group, when it has one, is the part that stays (Bearer, KEY=, user:).
    out = out.replace(re, (_m, keep?: string) => (typeof keep === 'string' ? `${keep}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}

const SECRET_KEY = /^(.*[_-])?(secret|token|password|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)$|(Secret|Token|Password|ApiKey|AccessKey|PrivateKey|Credentials?)$/i;

/** Redact every string inside a value (objects, arrays); numbers such as embeddings pass through untouched. */
export function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redactSecrets(v) as T;
  if (Array.isArray(v)) return (typeof v[0] === 'number' ? v : v.map(redactDeep)) as T;
  if (v && typeof v === 'object') {
    // A key that names a secret means its value is one, whatever it looks like.
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) && typeof x === 'string' && x ? '[REDACTED]' : redactDeep(x)])) as T;
  }
  return v;
}
