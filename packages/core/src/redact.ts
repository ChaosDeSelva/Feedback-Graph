/**
 * The version of the rules below. Raise it whenever a pattern is added, widened or narrowed: at start the worker runs
 * the rules once over the facts, document chunks and lessons stored under an older version (worker redactStored.ts).
 * 1: tokens, NAME=value and quoted name: "value". 2: code assignments, unquoted values, flags, prose credentials.
 * 3: narrowed. Prose needs a credential word (bare "key" never counts) and a value that looks like a secret, not an
 * identifier, path, version or word; code rules leave identifiers, URLs, calls, YAML tags and type names alone.
 */
export const REDACTION_VERSION = 3;
/** Rows a store reads per page when it redacts stored text again under new rules. */
export const REDACT_PAGE = 1000;

/**
 * The end of a name that holds a secret, in any casing and with any separators: DB_PASSWORD, apiKey, client-secret,
 * AWS_SECRET_ACCESS_KEY, secret_key_base. The name must END with it, so TOKEN_URL, tokenizer and passwordHash do not.
 */
const SECRET_NAME = String.raw`(?:secret|token|password|passwd|passphrase|pass[_-]?code|api[_-]?key|apikey|private[_-]?key|access[_-]?key|signing[_-]?key|encryption[_-]?key|credentials?)(?:[_-]?key(?:[_-]?base)?)?`;
/** Where a name may start: not inside another identifier, a member chain or a $VAR. */
const NAME_START = String.raw`(?<![\w$.-])[\w$.-]*?`;
/**
 * A candidate unquoted value: one token of 6+ characters with a digit or a symbol in it, not a $VAR, a {{template}}, a
 * <placeholder>, a path, a YAML tag (!vault), anchor (&pw) or alias (*pw), a call or a hash name (string, z.string(),
 * os.environ[...], sha256 and the like stay). Ends at a space, the end of the line or a closing quote or full stop.
 * looksLikeSecret then decides.
 */
const UNQUOTED_SECRET = String.raw`(?![$<{%/~.\-!&*])(?!(?:sha|md|utf|base|bcrypt|argon|aes|rsa)\d)(?=[^\s"'\x60“”,;()<>{}\[\]]*[0-9!@#%^&*])[^\s"'\x60“”,;()<>{}\[\]]{5,}[^\s"'\x60“”,;()<>{}\[\].!?:](?=["'”]?(?:$|\s|[.,;:!?)](?:\s|$)))`;

/** snake_case, kebab-case, dotted or namespaced identifiers: user_id2, refresh_token_v2, item.id2, session:v3:user_id. */
const IDENT = /^[A-Za-z]+\d*(?:[_.:-][A-Za-z]+\d*)+$/;
/** camelCase and PascalCase identifiers: authToken2, tenantId42, JwtV2 (one capitalised word such as Summer2026 is not). */
const CAMEL = /^(?:[a-z]+|[A-Z][a-z]+)(?:[A-Z][a-z]*\d*)+$/;
/** Algorithm, encoding and format names: sha256, argon2id, base64url, ed25519, x509, oauth2, v2. */
const ALGO = /^(?:sha|md|utf|base|bcrypt|argon|aes|rsa|hs|rs|es|ps|ed|x|oauth|http|ipv|u?int|float|crc|blake|scrypt|pbkdf|jwt|v)\d+[a-z]*$/i;
const URL_START = /^[a-z][a-z0-9+.-]*:\/\//i;
const SECRET_WORD = /secret|token|password|passwd|key|auth|credential/i;
/** Values that name a type or stand in for a secret rather than hold one. */
const TYPE_WORD = /^(?:string|number|integer|boolean|object|undefined|null|none|redacted)$/i;

/**
 * An unquoted value in prose, a flag or a config line is a secret only when it looks like one: 6+ characters mixing
 * letters and digits, or with a symbol in it, and not an identifier, a path or URL, a version, a duration, a number,
 * a file name or an algorithm. "hunter2" counts; user_id2, config/app2.yml, v1.2.3, 40-char and sha256 do not.
 */
export function looksLikeSecret(v: string): boolean {
  if (v.length < 6 || IDENT.test(v) || CAMEL.test(v) || ALGO.test(v)) return false;
  if (URL_START.test(v) || /[/\\]/.test(v)) return false;
  if (/^v?\d+(?:\.\d+)+/i.test(v) || /^\d+(?:ms|[smhdw])?$/.test(v) || /^\d+-[a-z]+$/i.test(v)) return false;
  if (/^[\w-]+\.[a-z][a-z0-9]{0,4}$/i.test(v)) return false;
  const letters = /[a-z]/i.test(v), digits = /\d/.test(v), symbols = /[^a-z0-9]/i.test(v);
  return (letters && digits) || (symbols && (letters || digits));
}

/**
 * A value assigned to a secret name (quoted in code, or NAME=value) is taken as a secret unless it plainly is not one:
 * a URL, a path, a number or duration, a type name, an algorithm, or an identifier that names a secret ("access_token",
 * "refresh_token_v2", "acme.token"). The name is the signal here, so a plain word such as a passphrase still counts.
 */
function assignedSecret(v: string): boolean {
  if (URL_START.test(v) || /^\.{0,2}[/~]/.test(v) || /\$[({\w]/.test(v)) return false;
  if (/^(?:change[-_.]?me|your[-_]|example|placeholder|x{3,}|\*+$)/i.test(v)) return false;
  if (/^\d+(?:ms|[smhdw])?$/.test(v) || TYPE_WORD.test(v) || ALGO.test(v)) return false;
  return !((IDENT.test(v) || /^[A-Za-z]+$/.test(v)) && SECRET_WORD.test(v));
}

/** Known token shapes and URL credentials: a secret wherever they appear, whoever wrote the text. */
const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
  /\bshp(?:at|ss|ca|pa)_[0-9a-fA-F]{32}\b/g,
  /\bdop_v1_[0-9a-f]{64}\b/g,
  /\bya29\.[0-9A-Za-z_-]{30,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bnpm_[A-Za-z0-9]{36,}/g,
  /\blin_api_[A-Za-z0-9]{32,}/g,
  // Feedback Graph Cloud personal access tokens: fgc_pat_<16 hex lookup id>_<secret>.
  /\bfgc_pat_[0-9a-f]{16}_[A-Za-z0-9_-]{20,}/g,
  // user:password@ in a URL; the user name stays. A ${VAR} in its place is a reference, not a secret.
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)(?!\$\{)[^\s@/]+(?=@)/gi,
];

/**
 * Rules that read a secret from its context. Each has a <keep> group (what stays, the name and any opening quote) and
 * a <v> group (the value), and a check the value must pass; text the check refuses is left exactly as it was.
 */
const CONTEXT_RULES: { re: RegExp; check: (v: string) => boolean }[] = [
  // Env-style assignments whose name ends in a secret word: KEY=value, export KEY="value". A $VAR reference, a call
  // (os.environ.get(...)) or a value that is a URL or names a secret is not a secret.
  {
    re: /^(?<keep>\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|SIGNING_KEY|CREDENTIALS?)(?:_KEY(?:_BASE)?)?\s*=\s*(?<q>["']?))(?!\$)(?<v>[^\s"']{6,})\k<q>(?=\s|$)/gm,
    check: assignedSecret,
  },
  // A quoted literal given to a secret name in any language: const API_KEY = "…", apiToken := "…", self.password = '…',
  // api_key: str = "…", "client_secret": "…", Password: "…", connect(password="…"). The quotes stay. A value that only
  // names a secret ("access_token"), refers to one ("${VAR}", "$VAR", "<your token>") or is a type ("string") stays.
  // A quote after the name needs one before it ("api_key": …), so 'Replace token' : 'Connect' in a ternary stays.
  {
    re: new RegExp(String.raw`(?<keep>(?<nq>["']?)${NAME_START}${SECRET_NAME}\k<nq>\s*(?::\s*[A-Za-z_][\w.<>\[\]|? ]*?\s*)?(?::=|=(?![=>~])|:)\s*(?<q>["'\x60]))(?![$<{%])(?<v>[^\s"'\x60]{6,})(?=\k<q>)`, 'gi'),
    check: assignedSecret,
  },
  // An unquoted value given to a secret name: password: hunter2x (YAML), secret = … (ini), -e DB_PASSWORD=…,
  // --password=…, X-Api-Key: …, pw: … . Only values that look like secrets, so types and identifiers stay.
  { re: new RegExp(String.raw`(?<keep>(?<nq>["']?)${NAME_START}(?:${SECRET_NAME}|pwd?)\k<nq>\s*(?::=|:|=(?![=>~]))\s*)(?<v>${UNQUOTED_SECRET})`, 'gi'), check: looksLikeSecret },
  // A command-line flag and its value: --token …, -password … .
  { re: new RegExp(String.raw`(?<keep>(?:^|\s)--?[\w-]*?(?:${SECRET_NAME}|pwd?)\s+)(?<v>${UNQUOTED_SECRET})`, 'gi'), check: looksLikeSecret },
  // Prose: "the admin password is hunter2", "the api key was 'x9...'", "token = …". Only a credential word counts: a
  // bare "key" (primary, cache, sort, map, config key) never does, and the value must look like a secret.
  {
    re: new RegExp(String.raw`(?<keep>\b(?:password|passwd|passphrase|pwd|pw|secret|token|credentials?|(?:api|access|private|secret)[ _-]?key)\s+(?:is|was|are|=)\s+(?:set\s+to\s+|now\s+)?["'“]?)(?<v>${UNQUOTED_SECRET})`, 'gi'),
    check: looksLikeSecret,
  },
];

const replaceTokens = (text: string) =>
  // A pattern's first group, when it has one, is the part that stays (Bearer, user:).
  TOKEN_PATTERNS.reduce((out, re) => out.replace(re, (_m, keep?: string) => (typeof keep === 'string' ? `${keep}[REDACTED]` : '[REDACTED]')), text);

/** Known token shapes and URL credentials only: what is redacted from text the owner wrote themselves. */
export function redactTokens(text: string): string {
  return replaceTokens(text);
}

/** Strip credentials before anything is stored or sent to a model. */
export function redactSecrets(text: string): string {
  let out = replaceTokens(text);
  for (const { re, check } of CONTEXT_RULES) {
    out = out.replace(re, (...args) => {
      const m = args[0] as string;
      const g = args[args.length - 1] as { keep: string; v: string };
      return check(g.v) ? `${g.keep}[REDACTED]${m.slice(g.keep.length + g.v.length)}` : m;
    });
  }
  return out;
}

/**
 * A statement that is (or was written around) a credential: a rule redacts something in it, or a model already wrote
 * [REDACTED] into it. Such a fact tells an agent nothing but a secret, so it is not kept.
 */
export function holdsCredential(text: string): boolean {
  return redactSecrets(text) !== text || text.includes('[REDACTED]');
}

/** A stored fact as the startup re-run reads it. origin 'you': the owner wrote it. */
export type StoredFactText = { statement: string; why: string | null; current: boolean; origin?: string | null };

/**
 * What the startup re-run (worker redactStored.ts) does to one stored fact. A current fact is closed only when a rule
 * matches its statement now: text an older rule already turned into [REDACTED] is not closed again on that alone. A
 * fact the owner wrote (origin you) is never closed, and loses only known token shapes, in place.
 */
export function redactStoredFact(f: StoredFactText): { statement: string; why: string | null; close: boolean } {
  if (f.origin === 'you') return { statement: redactTokens(f.statement), why: f.why === null ? null : redactTokens(f.why), close: false };
  const statement = redactSecrets(f.statement);
  return { statement, why: f.why === null ? null : redactSecrets(f.why), close: f.current && statement !== f.statement };
}

/**
 * A stored row under the current rules, for the startup re-run: the whole row with its `text` fields redacted and its
 * `json` fields (an object, or JSON text as Neo4j keeps it) run through redactDeep in the form they were stored in.
 * Null when nothing changes, so a store writes only rows that do.
 */
export function redactStoredRow<T extends Record<string, unknown>>(row: T, text: readonly (keyof T)[], json: readonly (keyof T)[] = []): T | null {
  const out: Record<string, unknown> = { ...row };
  let changed = false;
  const set = (k: keyof T, now: unknown, same: boolean) => {
    if (!same) { out[k as string] = now; changed = true; }
  };
  for (const k of text) {
    const v = row[k];
    if (typeof v === 'string') { const r = redactSecrets(v); set(k, r, r === v); }
  }
  for (const k of json) {
    const v = row[k];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string') {
      const r = redactDeep(v);
      set(k, r, JSON.stringify(r) === JSON.stringify(v));
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      const r = redactSecrets(v); // not JSON after all: redact it as text
      set(k, r, r === v);
      continue;
    }
    const before = JSON.stringify(parsed);
    const r = JSON.stringify(redactDeep(parsed));
    set(k, r, r === before);
  }
  return changed ? (out as T) : null;
}

const SECRET_KEY =/^(.*[_-])?(secret|token|password|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)$|(Secret|Token|Password|ApiKey|AccessKey|PrivateKey|Credentials?)$/i;

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
