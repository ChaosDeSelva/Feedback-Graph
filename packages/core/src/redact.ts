/**
 * The version of the rules below. Raise it whenever a pattern is added, widened or narrowed: at start the worker runs
 * the rules once over the facts, document chunks and lessons stored under an older version (worker redactStored.ts).
 * 1: tokens, NAME=value and quoted name: "value". 2: code assignments, unquoted values, flags, prose credentials.
 * 3: narrowed. Prose needs a credential word (bare "key" never counts) and a value that looks like a secret, not an
 * identifier, path, version or word; code rules leave identifiers, URLs, calls, YAML tags and type names alone.
 * 4: webhook URLs and secrets in a URL's query; slashed values after a secret name; a flag's whole value; prose with
 * words between the credential and "is"; JSON keys such as nextPageToken keep values that are not secrets.
 * 6: additional provider tokens, Basic auth, Azure AccountKey, Docker auth and pgpass records.
 * 5: an instruction in an upload is one addressed to the reader-as-AI, not a project convention (facts v4 closed as
 * instructions are reopened); the head of a token an older Activity subject cut at its cap is redacted.
 * 16: encrypted minisign keys; every rule bounded to linear time; a labelled value must look like a secret; Mailchimp keys;
 * whole Dynatrace tokens; more vendor tokens and command-line passwords, fewer vendor and command false positives;
 * a random run of letters (no digit) after a credential label; Notion, Tailscale, Alibaba, FCM and DSN keys, htpasswd -b,
 * mongo shells, net user and "use token X" prose.
 * 17: rules by family rather than by instance: any header named for a credential and Authorization with any scheme,
 * cookies; names ending in pass, pwd, pw, auth, pat or a named key in any syntax (Gradle, subscripts, calls, XML);
 * password arguments of the commands that take one; PowerShell and Windows forms; more vendor shapes; a token a few
 * words after a credential word; short random passwords after a password label.
 * 18: values of any length after a credential name; base64 Sentry/Grafana tokens whole; config directives (requirepass),
 * YAML anchors and nested keys, name/value env pairs, SQL role passwords, Terraform defaults, Makefile ?=, escaped
 * JSON, OpenVPN auth blocks, recovery phrases, JWTs with blanks in their JSON, bare session cookies and cookie files,
 * 0x signing keys, Adyen, Algolia, Terraform Cloud and RubyGems keys.
 * 19: paths with acronym segments stay; redactDeep reads a value under its key as the pair reads in text; setter and
 * builder calls, Gradle passwords after { or ;, Digest responses, SendGrid keys ending in -, Fly, PlanetScale tkn and
 * bare Mailgun keys; a URL query secret stops at a bracket.
 * 20: a base64 key starting with or holding "/" after a credential name (an AWS secret access key), quoted or not.
 */
export const REDACTION_VERSION = 20;
/** Rows a store reads per page when it redacts stored text again under new rules. */
export const REDACT_PAGE = 1000;

/**
 * The end of a name that may hold a secret, in any casing and with any separators: DB_PASSWORD, apiKey, client-secret,
 * AWS_SECRET_ACCESS_KEY, secret_key_base, SMTP_PASS, ORACLE_PWD, NEO4J_AUTH, AZURE_DEVOPS_PAT, client-key-data. The name
 * must END with it, so TOKEN_URL, tokenizer and passwordHash do not. A rule captures the whole name as <name> and
 * secretName decides: the regex only finds candidates, so it stays a short alternation tried at each name.
 */
const NAME_END = String.raw`(?:secret|token|pass(?:word|wd|phrase|[_-]?code)?|pwd|pw|auth|pat|credentials?|key(?:[_-]?(?:base|data|id))?)`;
/** A name NAME_END ends, captured as <name>, starting where a name may start: not inside an identifier, member chain or $VAR. */
const ANY_NAME = String.raw`(?<![\w$.-])(?<name>[\w$.-]*?${NAME_END})`;
/** Names that end in a word that always names a secret, whatever comes before it. */
const STRONG_END = /(?:secret|token|password|passwd|passphrase|pass[_-]?code|credentials?)(?:[_-]?key(?:[_-]?base)?)?$|private[_-]?key[_-]?id$/i;
/** A key is a credential only when the word before it says so: api_key, SECRET_KEY, masterKey, client-key-data; not cache_key or monkey. */
const SECRET_KEY_END = /(?:api|private|access|signing|encryption|run|app|master|hmac|pass|session|cookie|license|consumer|shared|account|storage|admin|webhook|jwt|write|deploy|service|client|subscription|sas|auth|secret|token)[_-]?key(?:[_-]?base|[_-]?data)?$/i;
/**
 * A short credential word ends the name as a part of its own (db_pass, db.pass, dbPass, DB_PASS), not bypass, oauth or
 * spat, or glued to the word before it in a config directive (redis requirepass, masterauth; rpcpass, dbpass).
 */
const secretName = (name: string) => STRONG_END.test(name) || SECRET_KEY_END.test(name) || /apikey$/i.test(name)
  || /(?:^|[_.-])(?:pass|pwd|pw|auth|pat)$/i.test(name) || /[a-z0-9](?:Pass|Pwd|Pw|Auth|Pat)$/.test(name)
  || /(?:^|[_.-])(?:require|master|admin|root|db|rpc|sasl|bind|proxy|smtp|ftp|mail|user)(?:pass|auth)$/i.test(name);
/**
 * Names that hold a secret often but not always (auth, a PAT, a storage or session key): a value given to one must also
 * look like a secret, where a password or token name takes any value that is not plainly something else.
 */
const LOOSE_NAME = /(?:auth|pat|(?:app|master|hmac|session|cookie|license|consumer|shared|account|storage|admin|webhook|jwt|write|deploy|service|client|subscription|sas|auth)[_-]?key(?:[_-]?data)?)$|^pass$/i;
/**
 * A value assigned to a name ANY_NAME read: assignedSecret, and for a LOOSE_NAME a token (strongSecret) or slashed key.
 * Any other snake or kebab name ending in key (MISTRAL_KEY, mistral_key) takes a token too, unless plainKey says what it
 * keys; a camelCase one (RecordKey, userKey) is a code field holding an id.
 */
const assignedTo = (v: string, g: Groups) => assignedSecret(v) && (secretName(g.name!)
  ? !LOOSE_NAME.test(g.name!) || strongSecret(v) || slashedSecret(v)
  : !/[a-z][A-Z]/.test(g.name!) && !plainKey(g.name!) && strongSecret(v));
/** Names whose "token" is a place in a list or a sync, not a credential: nextPageToken, continuation_token, syncToken. */
const CURSOR = String.raw`(?:next|prev(?:ious)?|page|next[_-]?page|prev[_-]?page|continuation|sync|cursor|resume|start|end|change|delta|marker|pagination)[_-]?token`;
/** A JSON key that is such a name. */
const CURSOR_KEY = new RegExp(`^${CURSOR}$`, 'i');
/** The kept part of a context rule's match (name, separator, opening quote) when the name is such a name. */
const CURSOR_NAMED = new RegExp(String.raw`(?<![A-Za-z])${CURSOR}\\*["']?\s*(?::=|=|:)?\s*\\*["'\x60]?$`, 'i');
/**
 * A candidate unquoted value: one token of 6+ characters with a digit or a symbol in it (or 16+ letters, or letters in
 * parts), not a $VAR, a {{template}}, a
 * <placeholder>, a path, a YAML tag (!vault), anchor (&pw) or alias (*pw), a call or a hash name (string, z.string(),
 * os.environ[...], sha256 and the like stay). Ends at a space, the end of the line or a closing quote or full stop.
 * looksLikeSecret then decides. A run longer than the lookaheads read (an STS session token is 400-1,000+ characters)
 * is taken whole up to its trailing punctuation: one class and nothing after it to fail, so it stays linear.
 */
const UNQUOTED_SECRET = String.raw`(?![$<{%/~.:])(?![-!&*]+[\w.-]{0,255}(?=[\s"'\x60“”,;()<>{}\[\]]|$))(?!(?:sha|md|utf|base|bcrypt|argon|aes|rsa)[-_]?\d)(?:(?=[^\s"'\x60“”,;()<>{}\[\]]{0,255}[0-9!@#%^&*]|[A-Za-z]{16}|[A-Za-z]{1,64}[_.-][A-Za-z])[^\s"'\x60“”,;()<>{}\[\]]{5,255}[^\s"'\x60“”,;()<>{}\[\].!?:](?=["'”]?(?:$|\s|[.,;:!?)](?:\s|$)))|[^\s"'\x60“”,;()<>{}\[\]]{256,}[^\s"'\x60“”,;()<>{}\[\].!?:])`;

/** snake_case, kebab-case, dotted or namespaced identifiers: user_id2, refresh_token_v2, item.id2, session:v3:user_id. */
const IDENT = /^[A-Za-z]+\d*(?:[_.:-][A-Za-z]+\d*)+$/;
/** SCREAMING_SNAKE constants: D3D10_SB_RESOURCE_RETURN_TYPE, HTTP2_MAX_FRAME. */
const CONSTANT = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
/** Words joined with short numbers: scram-sha-256, us-east-1, tls-1.3 (one word and a number, hunter-22, is not). */
const WORDS_AND_NUMBERS = /^[a-z]+(?:[-_.:][a-z]+)+(?:[-_.:]\d{1,4})+$|^[a-z]+(?:[-_.:]\d{1,4})+(?:[-_.:][a-z]+)+$/;
/** camelCase and PascalCase identifiers: authToken2, tenantId42, JwtV2 (one capitalised word such as Summer2026 is not). */
const CAMEL = /^(?:[a-z]+|[A-Z][a-z]+)(?:[A-Z][a-z]*\d*)+$/;
/** Algorithm, encoding and format names: sha256, argon2id, base64url, ed25519, x509, oauth2, v2. */
const ALGO = /^(?:(?:sha|utf|base|bcrypt|argon|aes|rsa|oauth|http|ipv|u?int|float|crc|blake|scrypt|pbkdf|jwt)[-_]?\d+[a-z]*|(?:md|hs|rs|es|ps|ed|x|v)[-_]?\d+[a-z]{0,3})$/i;
const URL_START = /^[a-z][a-z0-9+.-]*:\/\//i;
const SECRET_WORD = /secret|token|password|passwd|key|auth|credential/i;
/** Values that name a type or stand in for a secret rather than hold one. */
const TYPE_WORD = /^(?:string|number|integer|boolean|object|undefined|null|none|redacted|true|false)$/i;

/**
 * An unquoted value in prose, a flag or a config line is a secret only when it looks like one: 6+ characters mixing
 * letters and digits, or with a symbol in it, and not an identifier, a path or URL, a version, a duration, a number,
 * a file name or an algorithm. "hunter2" counts; user_id2, config/app2.yml, v1.2.3, 40-char and sha256 do not.
 */
export function looksLikeSecret(v: string): boolean {
  if (v.length < 6 || IDENT.test(v) || CAMEL.test(v) || ALGO.test(v) || CONSTANT.test(v) || WORDS_AND_NUMBERS.test(v)) return false;
  if (URL_START.test(v) || /[/\\]/.test(v)) return false;
  if (/^v?\d+(?:\.\d+)+/i.test(v) || /^\d+(?:ms|[smhdw])?$/.test(v) || /^\d+-[a-z]+$/i.test(v) || /^\d+(?:[_,]\d+)+$/.test(v)) return false;
  if (/^[\w-]+\.[a-z][a-z0-9]{0,4}$/i.test(v)) return false;
  const letters = /[a-z]/i.test(v), digits = /\d/.test(v), symbols = /[^a-z0-9]/i.test(v);
  return (letters && digits) || (symbols && (letters || digits));
}

/**
 * How likely each letter is after another in English words and identifiers: log2 of P(next | previous) over 1/27, in
 * quarter bits from -11.5 (A) to +4.25 (_) in the base64url alphabet. Row 26 is a word start, rows 0-25 the letters a-z;
 * each row has 27 columns, a-z and then a word end. Counted from /usr/share/dict/words (its words under 16 letters) and
 * this repository's Markdown docs.
 */
const LETTER_PAIRS =
  'XvxtrkthrZn1u2buZ0w1qnjimix2rik2cZf1hT4gd0fOzqkydaApMp2LoR0QI1xAvuTc2ZYwiyvATAsS0zkbp4fmh3dTtjoybLvnZsfhDqR5' +
  'vluxqnngnacwt0psf3zwnmkpiZ4zZVX1xkZ3PSzYY2UCyft0IaCrNw0eUc3bsu0KUznuxZA0mewUfAtQ22gZb4fWa2KVqln2cLvfssSiAzKz' +
  'yp1wrrrbdUmws3ysbr1zmsUfSrn4TNa6NNcwWTWWa2aTdqT4TWNdNszlde6lcp2ZhvmsthEnulqVnErO31hko3hib2Ihzlj0lIalqujcE0Q1' +
  '4udc3dSX2QRhtn1xGZiXuWZAtJ1ykwx1ozjzdmmjpymdlv1okhVmd2oqvummuhrhlyy3sxa1xwyrqlgfr0cZX2ba2zOWxei1sF1svtHcFqAu' +
  'dNNNXNNNaNNkNNXNUUNN_NNNNNh2nrr2jom2Wmnsq1oVrsuslhHuU0vcvZzcZwzSmpumvuid02vVkGpK4zclW3faz3QRohfzdJzprtSiEtY1' +
  'tuttskpXtVg0y4kuR03xUfQfZcl2DPK9DKD4DNTRRyDDcUDoWDDhPk4ldn2icz3Ljrjv2fOtrjhLgFkXx0hwbyhZo3JSjgayzaZk1rSgSyQ3' +
  'sjtqqfofoKZwtttwMtvtfThgNf-3cac8SZZzJWpYW3UJZZbmSbJutqyvzvutsuvkmswtuziv0xxorchgA';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PAIR_BITS = Float64Array.from(LETTER_PAIRS, (ch) => BASE64URL.indexOf(ch) / 4 - 11.5);
/**
 * Case changes in an identifier, in bits over a fair coin: a capital starts a word, so it follows a lowercase letter
 * about 1 time in 10; after a capital (an acronym) another is about as likely as not. Random mixed case changes at will.
 */
const CASE_BITS = { lowerToUpper: Math.log2(0.1 / 0.5), lowerToLower: Math.log2(0.9 / 0.5), upperToUpper: Math.log2(0.6 / 0.5), upperToLower: Math.log2(0.4 / 0.5) };

/**
 * A 16+ character run of letters and digits that no word structure explains, read only after an explicit credential
 * label. Its words (split as an identifier is: at a capital after a lowercase letter, before the last capital of an
 * acronym, at digits) are scored by how English each letter pair is (LETTER_PAIRS), and in mixed case by how its case
 * changes (CASE_BITS): random letters average about -2.7 bits a letter, identifiers and words +1.1, and a run below
 * -0.1 is random. Measured on 20k random keys per length and on 20k identifiers and dictionary words of 16+ letters:
 * kept are 1 in 225-465 keys of 16 (mixed case worst), 1 in 667-2500 of 20 and 1 in 1800+ of 24; about 1 in 2000
 * identifiers is redacted.
 */
export function randomRun(v: string): boolean {
  return v.length >= 16 && v.length <= 255 && /^[A-Za-z0-9]+$/.test(v) && new Set(v).size >= 8 && wordBits(v) < -0.1;
}

/** How English a run of letters and digits reads, in bits a letter: below zero is random (see randomRun). */
export function wordBits(v: string): number {
  const words = v.replace(/([a-z])(?=[A-Z])|([A-Z])(?=[A-Z][a-z])/g, '$1$2 ').toLowerCase().match(/[a-z]+/g);
  if (!words) return 0;
  let bits = 0, pairs = 0;
  for (const w of words) {
    let prev = 26;
    for (let i = 0; i < w.length; i++) {
      const c = w.charCodeAt(i) - 97;
      bits += PAIR_BITS[prev * 27 + c];
      prev = c;
    }
    bits += PAIR_BITS[prev * 27 + 26];
    pairs += w.length + 1;
  }
  const letters = v.replace(/\d+/g, '');
  let caseBits = 0;
  if (/[a-z]/.test(letters) && /[A-Z]/.test(letters)) {
    for (let i = 1; i < letters.length; i++) {
      const upper = letters[i] <= 'Z';
      caseBits += letters[i - 1] <= 'Z'
        ? (upper ? CASE_BITS.upperToUpper : CASE_BITS.upperToLower)
        : (upper ? CASE_BITS.lowerToUpper : CASE_BITS.lowerToLower);
    }
  }
  return bits / pairs + (3 * caseBits) / letters.length;
}

/**
 * A short password of letters only (8-15) after an explicit password label: random letters read well below English
 * (wordBits), and a run of few distinct letters (xxxxxxxx, AAAAAAAA) is a placeholder. Measured on 2,000 random
 * values of each length and case, and on /usr/share/dict/words and 11k identifiers of 8-15 letters: after a label
 * about 10% of random 8-letter values are kept (1% at 14), 0.08% of words and 0.5% of identifiers are redacted.
 */
export function shortRandom(v: string): boolean {
  return v.length >= 8 && v.length <= 15 && /^[A-Za-z]+$/.test(v) && new Set(v.toLowerCase()).size >= 6 && wordBits(v) < -0.3;
}

/**
 * A value with slashes after a secret name: base64 secrets hold "/" and "+" (an AWS secret access key does). It is one
 * when it mixes upper and lower case and digits, is 16+ characters, and is not a path: no leading / . ~, no file
 * extension, and not made of plain words (src/Components/Button2, secrets/prod/db-password2 stay), acronyms among them
 * when the whole reads as words (Win32/AI/MachineLearning, AWSClients/S3Uploader).
 */
function slashedSecret(v: string): boolean {
  if (!/[/\\]/.test(v) || URL_START.test(v) || /^[./~\\]/.test(v) || /\.[a-z][a-z0-9]{0,4}$/i.test(v)) return false;
  if (v.length < 16 || !/[A-Z]/.test(v) || !/[a-z]/.test(v) || !/\d/.test(v)) return false;
  // An acronym segment counts only when the whole reads as words: random base64 splits into such segments too.
  const words = wordBits(v.replace(/[^A-Za-z]/g, '')) > 0;
  return !v.split(/[/\\]/).every((seg) => /^\d+$|^[A-Za-z][a-z]*\d*$/.test(seg) || IDENT.test(seg) || CAMEL.test(seg)
    || (words && /^[A-Z]{2,5}\d*$|^[A-Z]{1,5}\d{0,2}(?:[A-Z][a-z]+\d*)+$/.test(seg)));
}

/**
 * A base64 key with a slash after a credential name, as an AWS secret access key is: one in 64 starts with "/", which
 * slashedSecret and every unquoted rule read as a path, and a mostly upper-case segment reads as CamelCase there. It
 * mixes case, and its letters and digits, read without the slashes, are a randomRun: /var/lib/Data2,
 * /usr/share/i18n/esdb/ISO646 and /home/User1/keys/apiKey stay.
 */
function slashKey(v: string): boolean {
  if (!/^[A-Za-z0-9+/]{16,}={0,2}$/.test(v) || !v.includes('/') || !/[A-Z]/.test(v) || !/[a-z]/.test(v)) return false;
  return randomRun(v.replace(/[+/=]/g, ''));
}

/**
 * An unquoted value after a secret name: one that looks like a secret, slashes and all; not a bundler's renamed binding
 * (Token$1) or a SQL or Razor variable (@password).
 */
const namedSecret = (v: string) => !/^[A-Za-z_][\w]*\$\d+$|^@[A-Za-z_]+[;,.)]*$/.test(v) && (looksLikeSecret(v) || slashedSecret(v) || randomRun(v));

/**
 * A value assigned to a secret name (quoted in code, or NAME=value) is taken as a secret unless it plainly is not one:
 * a URL, a path, a number or duration, a type name, an algorithm, or an identifier that names a secret ("access_token",
 * "refresh_token_v2", "acme.token"). The name is the signal here, so a plain word such as a passphrase still counts.
 */
function assignedSecret(v: string): boolean {
  if (/^(?:password|passwd|secret|token|api[_-]?key)$/i.test(v)) return false;
  if (URL_START.test(v) || /^\.{0,2}[/~]/.test(v) || /\$[({\w]|#\{|^%[A-Za-z_]\w*%$/.test(v)) return false;
  if (/^(?:<[^>]+>|\{\{[^}]+\}\})$/.test(v) || /^[A-Za-z_][\w.]*\s*(?:\(|\[)/.test(v)) return false;
  if (/^(?:change[-_.]?me|replace[-_.]?me|your[-_]|example|placeholder|x{3,}|\*+$|\*SENSITIVE\*DATA\*DELETED\*$)/i.test(v)) return false;
  if (/^put your unique phrase here$/i.test(v)) return false;
  if (/^\d+(?:ms|[smhdw])?$/.test(v) || TYPE_WORD.test(v) || ALGO.test(v)) return false;
  return !((IDENT.test(v) || /^[A-Za-z]+$/.test(v)) && SECRET_WORD.test(v));
}

/** A dotted or namespaced code reference: cfg.Password, process.env.API_TOKEN, std::env::var, Acme.ai. */
const CODE_REF = /^[A-Za-z_$][\w$]*(?:(?:\?\.|\.|::|->)[A-Za-z_$][\w$]*)+$/;

/**
 * An unquoted value after a credential label (password: …, --token …). Code puts types (Option<String>), struct
 * literals, identifiers, calls, member chains and destructuring targets there, and prose puts `inline code` or the word that ends the sentence, so
 * without its trailing punctuation the value must look like a secret, or keep a symbol and a digit the way a
 * password does (StrongPassword123!).
 */
function labelledSecret(value: string): boolean {
  const v = value.replace(/[:;,.)}\]|!?{(]+$/, '');
  if (!v || /^[$<{%~&*!/.`_[(:]|^--?[A-Za-z]/.test(v) || /[/\\`<>([]/.test(v) || CODE_REF.test(v) || !assignedSecret(v)) return false;
  return looksLikeSecret(v) || randomRun(v) || (/[!@#$%^&*+=~]/.test(value) && /\d/.test(v));
}

/**
 * A value given on a command line (rabbitmqctl, xfreerdp /p:, openssl pass:, psk=): not a placeholder, reference,
 * member chain (config.wifi.psk) or call, and not one lowercase word, which in prose is the next word of the sentence
 * ("the az login -p flag"). After a command that prompts for its password the next word may be shell punctuation
 * (| && > # --) or a quote and a comma, which are not one either, nor is the next flag (--quiet) after a space
 * (replaceTokens checks that).
 */
const commandSecret = (v: string) => assignedSecret(v) && !CODE_REF.test(v) && !/^[[<({`]|^%[A-Za-z_]\w*%/.test(v) && !/^[A-Z_]+$/.test(v) && !/^[a-z]+$/.test(v)
  && /[A-Za-z0-9]/.test(v);

/** A label that asks for a password (password:, --pass, pwd=, pw:), after which a short run of random letters is one. */
const PASSWORD_LABEL = /(?:pass(?:word|wd|phrase)?|pwd|pw)\W*$/i;

/**
 * A token with no label of its own, read after a credential word in prose ("my bearer is …", "the access key … (don't
 * share)", "private key 0x…"): a UUID, or a part (between . _ ~ -) that is a random run, 16+ hex, or 12+ letters and digits with many
 * distinct characters that do not read as words (OAuth2Tokens, D3D10Device and sha256Digest do; see wordBits).
 */
function strongSecret(value: string): boolean {
  const v = value.replace(/^(?:base64:|0x)/, '');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
  // A password: letters, digits and a symbol, not an e-mail address or a word with a trailing !.
  if (/[!#$%^&*@]/.test(v.slice(0, -1)) && /\d/.test(v) && /[a-z]/i.test(v) && !/@[\w-]+\./.test(v) && !/^[*&]|[A-Za-z_]\.[A-Za-z_]/.test(v)
    && /^[\w!@#$%^&*+=~.-]{10,}$/.test(v)) return true;
  if (/[!@#$%^&*]/.test(v)) return false;
  return v.split(/[._~-]/).some((part) => randomRun(part) || (/^[0-9a-f]{16,}$/i.test(part) && /\d/.test(part) && /[a-f]/i.test(part))
    || (part.length >= 12 && /^[A-Za-z0-9+/=]+$/.test(part) && (!part.includes('/') || slashedSecret(part)) && /\d/.test(part) && /[A-Za-z]/.test(part)
      && new Set(part).size >= 10 && !CAMEL.test(part) && !CONSTANT.test(part) && wordBits(part) < 0.5));
}

/**
 * A header value or a value in a key/value list (cookie, Authorization) is a secret when a label would take it one, or
 * when it is a long run of one token alphabet (32 hex, a UUID, base64), however it reads.
 */
/** labelledSecret, or a short run of random letters after a password label. */
const labelOrShort = (v: string, g: Groups) => labelledSecret(v) || (PASSWORD_LABEL.test(g.keep) && shortRandom(v.replace(/[:;,.)}\]|!?{(]+$/, '')));
/**
 * namedSecret, or after a password name (SMTP_PASS, db_password) a short run of random letters, whole or in parts
 * joined by _ . or - (lVqgjkIfyGT_qHRt; a name such as db_password_prod reads as words and stays).
 */
const nameOrShort = (v: string, g: Groups) => namedSecret(v) || (PASSWORD_LABEL.test(g.name!) && (shortRandom(v)
  || (/^[A-Za-z]+(?:[_.-][A-Za-z]+)+$/.test(v) && !CONSTANT.test(v) && (shortRandom(v.replace(/[_.-]/g, '')) || randomRun(v.replace(/[_.-]/g, ''))))));
/**
 * A name ending in key that is not a credential's: its value indexes, sorts, caches, deduplicates or names something,
 * or is public (CACHE_KEY, Idempotency-Key, Sec-WebSocket-Key, sortKey, PUBLISHABLE_KEY, KMS_KEY), or it is no part
 * of its own (monkey). Read in any case style: the name is split into words first.
 */
function plainKey(name: string): boolean {
  const words = name.replace(/([a-z0-9])(?=[A-Z])/g, '$1_').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return !/(?:^|_)key$/.test(words) || /(?:^|_)(?:idempotency|cache|sort|partition|primary|foreign|routing|lookup|index|hash|row|map|object|bucket|s3|file|path|public|publishable|host|site|dedup(?:e|lication)?|prefix|kms|gpg|pgp|ssh|group|shard|queue|topic|stream|table|column|field|id|name|type|label|lock|request|correlation|trace|message|event|web_?socket|i18n|translation|react|range|unique|composite|record|user|entity|parent|child|customer|org|tenant|item|node|edge|resource|doc|document|opportunity|contact|lead)_key$/.test(words) || words === 'key';
}

const headerSecret = (v: string) => labelledSecret(v) || slashedSecret(v) || (assignedSecret(v) && /^[A-Za-z0-9+=_.%~-]{16,}$/.test(v) && /\d/.test(v) && !IDENT.test(v) && !CODE_REF.test(v));

/** Known token shapes and URL credentials: a secret wherever they appear, whoever wrote the text. */
/** Multi-line key blocks run before token fragments: replacing one body line first would break the block match. */
const BLOCK_PATTERNS: RegExp[] = [
  /-----BEGIN PGP PRIVATE KEY BLOCK-----(?:(?!-----BEGIN )[\s\S])*?-----END PGP PRIVATE KEY BLOCK-----/g,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----\r?\n(?:(?:Version|Comment):[^\r\n]*\r?\n|[ \t]*\r?\n|[A-Za-z0-9+/=]{8,}(?:\r?\n|$))+/g,
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S])*?-----END (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
  /(?:^[ \t-]*(?:[\w.][\w.-]*:[ \t]*[>|][+-]?[ \t]*\r?\n)?^[ \t-]*)-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\r?\n(?:(?:[ \t]*(?:Proc-Type|DEK-Info):[^\r\n]*\r?\n)|[ \t]*\r?\n|[ \t]*[A-Za-z0-9+/=]{8,}(?:\r?\n|$))+/gim,
  // Unterminated keys pasted after prose or a field name. Keep this unanchored fallback after the structured
  // line-start rule: a paste such as `key: -----BEGIN ...` is just as sensitive as a block on its own line.
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\r?\n(?:(?:[ \t]*(?:Proc-Type|DEK-Info):[^\r\n]*\r?\n)|[ \t]*\r?\n|[ \t]*[A-Za-z0-9+/=]{8,}(?:\r?\n|$))+/gi,
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\\n(?:(?:(?:Proc-Type|DEK-Info):[^\\]*(?:\\n|$))|[A-Za-z0-9+/=]{8,}(?:\\n|$))+/g,
  /(?:^|\n)[ \t]*(?:[#>][ \t]*)?-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[ \t]*\r?\n(?:(?:[ \t]*(?:[#>][ \t]*)?(?:Proc-Type|DEK-Info):[^\r\n]*|[ \t]*(?:[#>][ \t]*)?[A-Za-z0-9+/=]{8,}[ \t]*)\r?(?:\n|$))+/gim,
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[ \t]+[A-Za-z0-9+/=]{16,}(?:[ \t]+[A-Za-z0-9+/=]{8,})*/gi,
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[ \t]*(?:\r?\n|\\n)(?:(?:[ \t]*(?:(?:\/\/|\*|;|#|>(?:[ \t]*>)*)[ \t]*)?[A-Za-z0-9+/=]{8,}[ \t]*(?:\r?\n|\\n|$)))+/gi,
  /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\\\\n(?:[#>][ \t]*)?[A-Za-z0-9+/=]{8,}(?:(?:\\\\n|[ \t]+)(?:[#>][ \t]*)?[A-Za-z0-9+/=]{8,})*/gi,
  new RegExp('(?:^|\\n)[ \\t]*(?:(?:\\/\\/|\\*|;|#(?:[ \\t]+key:)?|>(?:[ \\t]*>)*))[ \\t]*-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[ \\t]*(?:\\r?\\n|\\\\n)(?:(?:[ \\t]*(?:(?:\\/\\/|\\*|;|#|>(?:[ \\t]*>)*)[ \\t]*)?[A-Za-z0-9+/=]{8,}[ \\t]*(?:\\r?\\n|\\\\n|$)))+', 'gim'),
  /^PuTTY-User-Key-File-[23]: (?:ssh-|ecdsa-)[^\r\n]+\r?\n(?:(?!^PuTTY-User-Key-File-)[\s\S])*?^Private-Lines: \d+\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+Private-MAC:[ \t]*[a-f0-9]+/gim,
  /-----BEGIN OpenVPN Static key V1-----\s+(?:[0-9a-f]{16,}\s+)+-----END OpenVPN Static key V1-----/gi,
  /^[ \t]*untrusted comment: minisign (?:encrypted )?secret key[^\r\n]{0,200}\r?\n[ \t]*[A-Za-z0-9+/=]{32,}/gim,
];

/*
 * Vendor tokens below skip a body of lowercase words joined by _ or - (sk-learn-compatible-estimator,
 * xoxe-refresh-token, fw_update_firmware_check): an identifier or fixture name, never a random key.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /\b(run-key:)[a-f0-9]{64}\b/gi,
  /(\bAWS[ \t]+secret(?:[ \t]+access)?[ \t]+key(?:[ \t]+(?:is|was)[ \t]+|[ \t]*[:=][ \t]*|[ \t]+)["']?)[A-Za-z0-9/+]{40}={0,2}(?=$|[\s"',.;])/gi,
  /(\bTwilio[ \t]+(?:auth(?:entication)?(?:[ \t]+(?:token|secret))?|token|secret)(?:[ \t]+(?:is|was)[ \t]+|[ \t]*[:=][ \t]*|[ \t]+)["']?)[a-f0-9]{32}\b/gi,
  /\b(AccountKey\s*=\s*)(?![<${])[^;\s"']{16,}/gi,
  /(\bmailgun(?:[ \t]+(?:api[ \t]+)?key)?[ \t]*(?:is[ \t]+|[:=][ \t]*)?)["']?(?:key-)?[a-f0-9]{32}(?:-[a-f0-9]{8,32}){0,3}\b/gi,
  /\bSK[a-fA-F0-9]{32}\b/g,
  // A Mailchimp key is 32 hex and a datacenter (-us6). An md5 with a region suffix looks the same (no case, datacenter
  // or entropy test tells them apart), so the key needs context: Mailchimp named with a key word or a label before it
  // ("mailchimp api key", "Mailchimp:", MAILCHIMP_KEY=; "mailchimp etag" is not), Mailchimp named after it on its
  // line, a credential label, the `apikey` Authorization scheme or the password of curl's -u/--user.
  /(\b(?:mailchimp|mandrill)(?:[^\r\n]{0,60}?(?:key|token|secret|password)|["']?[ \t]*[:=])[^\r\n]{0,40}?|\bmc[_-]?(?:api[_-]?)?key[^\r\n]{0,40}?|\b(?:api[_-]?key|apikey|api[_-]?token|access[_-]?token|secret)["']?\s*[:=]\s*["']?|\bapikey[ \t]+|(?:^|[\s"'])(?:-u|--user)(?:[ \t]+|=)["']?[^\s:"']{0,64}:)\b[0-9a-f]{32}-us\d{1,2}\b/gi,
  /\b[0-9a-f]{32}-us\d{1,2}\b(?=[^\r\n]{0,120}\b(?:mailchimp|mandrill))/gi,
  /\bAGE-SECRET-KEY-1[A-Z0-9]{40,}\b/g,
  /\b(?:dckr_pat_|pscale_(?:pw|tkn|oauth)_|nvapi-|r8_)(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9_-]{16,}\b/g,
  // xAI and Perplexity keys are opaque values; model/resource ids contain internal hyphens.
  /\b(?:pplx-|xai-)(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9_]{16,}\b/g,
  /\b(?:pul-|1\/\/0|EAAB)(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9_-]{20,}\b/g,
  /\bmfa\.[A-Za-z0-9_-]{40,}\b/g,
  // Fly.io macaroon tokens: FlyV1 fm2_…, a comma list of them, in base64 with + / =.
  /\b(FlyV1[ \t]+)?fm[12][a-z]?_(?=[A-Za-z0-9+/=_-]{0,200}\d)[A-Za-z0-9+/=_-]{32,}(?:,fm[12][a-z]?_[A-Za-z0-9+/=_-]{16,})*/g,
  /\$(?:2[aby]\$\d{2}\$[./A-Za-z0-9]{53}|(?:apr1|1)\$[./A-Za-z0-9]{1,8}\$[./A-Za-z0-9]{22}|5\$(?:rounds=\d+\$)?[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{43}|6\$(?:rounds=\d+\$)?[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{86}|argon2(?:id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*)|\{SHA\}[A-Za-z0-9+/]{27}=/g,
  /\bsk-(?:proj-|ant-[a-z0-9]+-)?(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9_-]{20,}/g,
  /\b[sr]k_(?:live|test)_(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abceprs]-(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9-]{10,}/g,
  // A Slack browser cookie (d=) is URL-encoded.
  /\bxoxd-(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9%+/=_-]{20,}/g,
  /\b(?:tvly-|pat-na1-|fw_|pnu_)(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9_-]{16,}/g,
  /\baccess-(?:sandbox|development|production)-(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9_-]{16,}/g,
  /\bv1\.0-[A-Fa-f0-9]{20,}-[A-Fa-f0-9]{40,}/g,
  // Dynatrace: dt0c01.<public id>.<secret>; the secret part is the one that must go.
  /\bdt0c01\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{20,})?/g,
  /\b00D[A-Za-z0-9]{12,}!AQ[A-Za-z0-9._-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43,}/g,
  /\bshp(?:at|ss|ca|pa)_[0-9a-fA-F]{32}\b/g,
  /\bdop_v1_[0-9a-f]{64}\b/g,
  /(?<![\w$.])dp\.(?:st|pt)(?:\.[a-z][a-z0-9_-]{1,15})?\.(?=[A-Za-z0-9_-]{20,}\b)(?=[A-Za-z0-9_-]*[0-9A-Z])[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:NRAK|NRAA)-(?!X{8,}\b)(?=[A-Za-z0-9]{20,}\b)(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{20,}\b/g,
  /\bya29\.[0-9A-Za-z_-]{30,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g,
  /\bglpat-(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9_-]{20,}/g,
  /\bhf_(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9]{30,}/g,
  /\bnpm_(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9]{36,}/g,
  /\blin_api_(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9]{32,}/g,
  /\bdapi[a-f0-9]{32,}\b/gi,
  /\b(?:sq0csp-|ATATT|ATCTT|figd_|ntn_|glsa_|phx_)(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9_-]{16,}\b/g,
  // Square access tokens (EAAA…), Dropbox short-lived tokens (sl.…), HashiCorp Vault tokens (hvs./hvb./hvr. and the
  // legacy s. with 24 characters).
  /\bEAAA(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9_-]{56,}/g,
  /\bsl\.(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9_-]{80,}/g,
  /\bhv[sbr]\.(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9_-]{24,}/g,
  // The legacy s. token is 24 random characters; a member named in words with digits at the end (s.AbCdEf…Uv12) is code.
  /(?<![\w$./-])s\.(?=[A-Za-z0-9]{0,23}\d)(?=[A-Za-z0-9]{0,23}[A-Z])(?=[A-Za-z0-9]{0,23}[a-z])(?![a-z]*(?:[A-Z][a-z]+)+\d*(?![A-Za-z0-9]))[A-Za-z0-9]{24}(?![\w.(-])/g,
  /\bPMAK-(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9_-]{16,}\b/g,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/g,
  /\b(?:bot\s+|telegram(?:[ _-]?(?:token|url))?[^\r\n]{0,20})\d{7,12}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/gi,
  /\b(SSWS[ \t]+)[A-Za-z0-9_-]{16,}\b/gi,
  // Notion internal integration secrets (secret_ and 43 characters), Tailscale keys, Alibaba Cloud AccessKey ids and
  // Firebase Cloud Messaging legacy server keys (AAAA…:APA91b…).
  /\bsecret_(?=[A-Za-z0-9]{0,42}\d)(?=[A-Za-z0-9]{0,42}[A-Z])[A-Za-z0-9]{43}\b/g,
  /\btskey-(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))[A-Za-z0-9_-]{20,}/g,
  /\bLTAI[A-Za-z0-9]{12,20}\b/g,
  /\bAAAA[A-Za-z0-9_-]{7,}:APA91b[A-Za-z0-9_-]{50,}/g,
  // Asana PATs (1/<user>:<32 hex>, 2/<user>/<app>:<32 hex>), Airtable PATs, Resend and LaunchDarkly keys, NATS nkey
  // seeds, Twitch chat tokens, and keys that carry a vendor prefix of their own.
  /\b[12]\/\d{10,20}(?:\/\d{10,20})?:[a-f0-9]{32}\b/g,
  /\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b/g,
  /\bre_(?=[A-Za-z0-9_]{0,60}\d)(?=[A-Za-z0-9_]{0,60}[A-Z])[A-Za-z0-9]{6,12}_[A-Za-z0-9]{16,40}\b/g,
  /\b(?:sdk|mob|api)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
  /\bS[UAONCX]A[A-Z2-7]{50,60}\b/g,
  /\boauth:[a-z0-9]{30}\b/g,
  /\b(?:nf[pcob]_|rnd_|fo1_|sbp_|HRKU-|do[or]_v1_|xkeysib-|xsmtpsib-|vck_|shpss_)(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{16,}/g,
  // Sentry org, Grafana Cloud and 1Password service account tokens carry standard base64 (+ / and = padding), and
  // RubyGems keys 48 hex; Terraform Cloud tokens are <14>.atlasv1.<60+>.
  /\b(?:sntry[su]_|glc_|ops_ey)(?![a-z]{1,32}(?:[_-][a-z]{1,32}){1,12}(?![\w-]))(?=[A-Za-z0-9_+/-]{0,200}\d)[A-Za-z0-9_+/-]{16,}={0,2}/g,
  /\brubygems_[0-9a-f]{48}\b/g,
  // OpenVPN's inline credentials: the line after the user name.
  /(<(auth-user-pass|http-proxy-user-pass)>[ \t]*\r?\n[^\r\n<]*\r?\n)[^\r\n<]+(?=\r?\n[ \t]*<\/\2>)/g,
  // An Ethereum-style private key (0x and 64 hex) after a name for a signing key; a hash, topic or storage slot has
  // the same shape, so the name must say whose key it is.
  /((?<![\w.-])[\w.-]*?(?:priv(?:ate)?|signer|signing|deployer|wallet|owner|operator|validator|relayer|sender|eth|evm)[ _.-]?(?:key|pk)["']?[ \t]*(?:(?::|=>|=|\bis\b)[ \t]*)?["'\x60]?|(?<![\w.-])(?:pk|privkey)["']?[ \t]*(?::|=>|=)[ \t]*["'\x60]?)0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/gi,
  // Adyen API keys: AQE, base64, then two or three -separated parts.
  /\bAQE[A-Za-z0-9+/]{30,}={0,2}-[A-Za-z0-9+/]{20,}={0,2}(?:-[^\s"'\x60,]{1,64})?/g,
  // An Algolia client made with an application id (10 capitals and digits) and its 32-hex key, in any language.
  /(\([ \t]*["'][A-Z0-9]{10}["'][ \t]*,[ \t]*["'])[a-f0-9]{32}(?=["'])/g,
  /\b[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_-]{60,}/g,
  // Feedback Graph Cloud personal access tokens: fgc_pat_<16 hex lookup id>_<secret>.
  /\bfgc_pat_[0-9a-f]{16}_[A-Za-z0-9_-]{20,}/g,
  // The head of a token cut at a length cap (an Activity subject before v5 was cut before it was redacted): a known
  // token prefix running into the cut's ellipsis at the end of the text. The ellipsis stays.
  /\b(?:(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|hf|npm|lin_api|fgc_pat|[sr]k_(?:live|test))_|sk-|xox[abprs]-|AKIA|ASIA|ya29\.|AIza|eyJ)[A-Za-z0-9_.-]{4,}(?=…$)/g,
  // user:password@ in a URL; the user name stays. A ${VAR} in its place is a reference, not a secret.
  /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]*:)(?!\$\{)[^\s@/]+(?=@)/gi,
  // A DSN (Sentry) carries its key as the URL's user name: 32 hex.
  /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[0-9a-f]{32}(?=[:@])/gi,
  /(\bmysql(?:dump)?(?=\s)(?:(?!\bmysql)[^\r\n])*?\s--password=)(?!\s|\$)[^\s'"]+/gi,
  /(\bmysql(?:dump)?(?=\s)(?:(?!\bmysql)[^\r\n])*?\s-p["']?)(?![\s$,;)])[^\s'"]+/gi,
  /(\bmysqladmin\b(?:(?!\bmysqladmin\b)[^\r\n])*?\s-p["']?)(?![\s$,;)])[^\s'"]+/gi,
  /(\bSharedAccessKey\s*=\s*)(?![<\${]|YOUR[_-]|process\.env\.)[^;\s"']{12,}/gi,
  /(\brequests\.[a-z]+\((?:(?!\brequests\.)[^\r\n])*?\bauth\s*=\s*\(\s*["'][^"']+["']\s*,\s*["'])([^"']+)(?=["']\s*\))/gi,
  /(<password(?:\s[^<>]*)?>)((?!\$\{|\{\{|<)[^<\r\n]+)(?=<\/password>)/gi,
  // A webhook URL is its own secret: the host and kind stay, the path that grants access goes.
  /\b(https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9_/-]{8,}/g,
  /\b(https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/)\d+\/[A-Za-z0-9_-]{20,}/g,
  /\b(https?:\/\/(?:[\w-]+\.webhook\.office\.com\/webhookb2|outlook\.office(?:365)?\.com\/webhook)\/)[^\s"'<>]{20,}/g,
  /\b(https?:\/\/(?:api\.)?telegram\.org\/bot)\d{7,12}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/gi,
  /(^|\n)(\/\/[^\s:]+\/:_auth\s*=\s*)(?![$<{])[A-Za-z0-9+/]{12,}={0,2}(?=\s|$)/g,
  // A secret in a URL's query or fragment: ?token=, &api_key=, &sig=, #access_token=. Only values of 8+ characters with
  // a digit, a capital or an escape in them; a ${VAR}, {{template}} or <placeholder> stays, and so does ?key=name.
  /([?&#](?:[\w-]*[_-])?(?:token|api_?key|key|appid|sig|signature|secret|password|passwd|pwd|X-Amz-Signature|X-Amz-Credential|X-Goog-Signature)=)(?![$<{])(?=[^\s&#"'<>\x60()\[\]{}]*[0-9A-Z%])[^\s&#"'<>\x60()\[\]{}]{8,}/gi,
];

/** Values given on a command line or in a config line: (keep)(value), redacted when the value passes commandSecret. */
const COMMAND_RULES: RegExp[] = [
  /(\bssh-keygen\b(?:(?!\bssh-keygen\b)[^\r\n])*?\s-[NP][ \t]*["']?)([^\s"']+)/g,
  /(\becho\s+(?:-e\s+)?["']?[\w.@-]+:)([^\s"':|]+)(?=["']?\s*\|\s*(?:sudo\s+)?chpasswd\b)/g,
  /(\bsigntool(?:\.exe)?\b(?:(?!\bsigntool\b)[^\r\n])*?\s\/p\s+["']?)([^\s"']+)/gi,
  // .netrc, one line or one field per line.
  /(\bmachine[ \t]+\S+(?:\s+(?:login|account|port)[ \t]+\S+){0,3}\s+password[ \t]+)([^\s"']+)/g,
  /(\brabbitmqctl\s+(?:add_user|change_password)\s+\S+\s+)(?!\$)([^\s'"]+)/gi,
  /(\bxfreerdp\b(?:(?!\bxfreerdp\b)[^\r\n])*?\/p:)(?!\s|\$)([^\s'"]+)/gi,
  /(\bpsk\s*=\s*["']?)(?!\$|\{|<)([^\s'"]{8,})/gi,
  // htpasswd -b [flags] file user password (-b, -bc, -cB…; the first flag run holds no b before the one that counts).
  /(\b(?:htpasswd|mosquitto_passwd)\b(?:(?!\b(?:htpasswd|mosquitto_passwd)\b)[^\r\n])*?\s-[ac-zA-Z]*b[a-zA-Z]*(?:[ \t]+-[A-Za-z]+(?:[ \t]+\d+)?)*[ \t]+\S+[ \t]+\S+[ \t]+["']?)([^\s"']+)/g,
  // net user name password [/add]; a * asks for it and a /flag is no password.
  /(\bnet[ \t]+user[ \t]+(?:"[^"\r\n]*"|[^\s"/]+)[ \t]+["']?)(?![*/])([^\s"']+)/gi,
];

/** A flag's value, spaced or after =, quoted or not: (keep)(value). */
const FLAG_VALUE = String.raw`(?:=|[ \t]+|(?=["']))["']?(?:pass:)?)([^\s"']+)`;
/**
 * Commands that take a password on their command line, and how: [the command, its password arguments]. Each argument
 * pattern is read over the rest of the command's line, every occurrence (snmpwalk -A … -X …, keytool -srcstorepass …
 * -deststorepass …), and its value must pass commandSecret. A short flag is a password only for the commands that
 * define it so: -p is a port for ssh, docker run, psql and redis-cli, and -P one for mysql and scp.
 */
const COMMAND_LINES: [RegExp, RegExp[]][] = ([
  [String.raw`cqlsh|psexec(?:64)?|paexec|altool|ncftp(?:get|put)?|useradd|usermod|mongo(?:sh|dump|restore|export|import|stat|top|files)?|rabbitmqadmin|vpnc|(?:docker|podman|buildah|nerdctl|oras|crane|skopeo|helm[ \t]+registry)[ \t]+login|az[ \t]+login`, [String.raw`(\s(?:-p|--password)${FLAG_VALUE}`]],
  [String.raw`mosquitto_(?:pub|sub|rr)|sqlcmd|bcp|osql|isql|ipmitool|zip|zipcloak|unzip`, [String.raw`(\s-P${FLAG_VALUE}`]],
  [String.raw`snmp[a-z]*`, [String.raw`(\s-[AX]${FLAG_VALUE}`]],
  [String.raw`sshpass`, [String.raw`(\s-p(?:=|[ \t]+)?["']?)([^\s"'-][^\s"']*)`]],
  // Positional passwords: nmcli … password X, wpa_passphrase SSID X, rclone config create name type key X.
  [String.raw`nmcli`, [String.raw`(\s(?:password|wifi-sec\.psk|802-1x\.password)[ \t]+["']?)([^\s"']+)`]],
  [String.raw`wpa_passphrase`, [String.raw`(^\S+[ \t]+(?:"[^"\r\n]*"|\S+)[ \t]+["']?)([^\s"']+)`]],
  [String.raw`rclone[ \t]+config[ \t]+(?:create|update)`, [String.raw`(\s(?:pass|password|key|secret_access_key|account_key|client_secret|token|bearer_token)[ \t=]+["']?)([^\s"']+)`]],
  [String.raw`plink|pscp|psftp`, [String.raw`(\s-pw${FLAG_VALUE}`]],
  [String.raw`ldap[a-z]+`, [String.raw`(\s-w${FLAG_VALUE}`]],
  [String.raw`redis-cli`, [String.raw`(\s(?:-a|--pass)${FLAG_VALUE}`]],
  [String.raw`codecov`, [String.raw`(\s-t${FLAG_VALUE}`]],
  [String.raw`schtasks`, [String.raw`(\s(?i:/r?p)${FLAG_VALUE}`]],
  [String.raw`cmdkey`, [String.raw`(\s(?i:/pass):["']?)([^\s"']+)`]],
  [String.raw`7z[az]?|rar|unrar`, [String.raw`(\s-p["']?)([^\s"'-][^\s"']*)`]],
  [String.raw`keytool|jarsigner|apksigner`, [String.raw`(\s--?(?:src|dest|new)?(?:storepass|keypass|ks-pass|key-pass)(?::plain)?${FLAG_VALUE}`]],
  [String.raw`openssl`, [String.raw`(\spass:)([^\s"']+)`, String.raw`(\s-k${FLAG_VALUE}`]],
  [String.raw`curl`, [String.raw`(\s(?:-u|--user|-U|--proxy-user)(?:=|[ \t]*)["']?[^\s:"']*:["']?)([^\s"']+)`]],
  [String.raw`https?|httpie|xhs?`, [String.raw`(\s(?:-a|--auth)(?:=|[ \t]+)["']?[^\s:"']*:["']?)([^\s"']+)`]],
  [String.raw`lftp`, [String.raw`(\s-u[ \t]+["']?[^\s,"']+,)([^\s"']+)`]],
  [String.raw`smbclient|rpcclient|smbmap|smbcacls|net[ \t]+rpc`, [String.raw`(\s(?:-U|--user)(?:=|[ \t]+)["']?[^\s%"'=]+%)([^\s"']+)`]],
  [String.raw`sqlplus|sqlldr|expdp|impdp|rman|dgmgrl`, [String.raw`(\s["']?[\w$#.]+/)([^\s@"'/]+)(?=@|["']?(?:\s|$))`]],
  [String.raw`net[ \t]+use`, [String.raw`((?<!\S)\\\\[^\s"']+[ \t]+["']?)(?![/*])([^\s"']+)`, String.raw`(\s(?i:/user):\S+[ \t]+["']?)(?![/*])([^\s"']+)`]],
  [String.raw`sc(?:\.exe)?[ \t]+(?:config|create)`, [String.raw`(\s(?i:password)=[ \t]*["']?)([^\s"']+)`]],
  [String.raw`b2[ \t]+authorize[-_]account`, [String.raw`(^\S+[ \t]+\S+(?:[ \t]+--?\S+)*[ \t]+\S+[ \t]+["']?)([^\s"']+)`]],
  [String.raw`aws[ \t]+(?:ssm[ \t]+put-parameter|secretsmanager)`, [String.raw`(\s--(?:value|secret-string)${FLAG_VALUE}`]],
  // Every value set in a secret store, whatever its name: fly secrets set K=V, heroku config:set K=V, gh secret set K -b V.
  [String.raw`secrets?[ \t]+(?:set|import)|config:set`, [String.raw`(\s[A-Za-z_]\w*=["']?)([^\s"']+)`, String.raw`(\s(?:-b|--body)${FLAG_VALUE}`]],
  // aws configure set aws_secret_access_key V, npm config set //registry/:_authToken V.
  [String.raw`configure[ \t]+set|config[ \t]+set`, [String.raw`(\s[\w./:@-]*(?:secret|token|password|passwd|auth|key)[ \t]+["']?)([^\s"']+)`]],
  // The plain text ConvertTo-SecureString turns into a SecureString: its first literal.
  [String.raw`ConvertTo-SecureString`, [String.raw`(^\S+(?:[ \t]+-(?i:String|AsPlainText|Force))*[ \t]+["'])([^"'\r\n$]+)(?=["'])`]],
] as [string, string[]][]).map(([tools, args]) => [new RegExp(String.raw`(?<![\w-])(?:${tools})(?:\.exe)?(?=[ \t])[^\r\n]*`, 'gi'), args.map((a) => new RegExp(a, 'g'))]);

/**
 * A password piped or here-stringed into a command that reads it from stdin: echo pw | sudo -S, | passwd --stdin,
 * | docker login --password-stdin, | podman login …; az devops login <<< pat, vncpasswd -f <<< pw.
 */
const STDIN_SECRET = /(\becho[ \t]+(?:-[neE]+[ \t]+)?["']?)([^\s"'|;&]+)(?=["']?[ \t]*\|[ \t]*(?:sudo\b[^|\r\n]*?[ \t]-S\b|passwd[ \t]+--stdin\b|[\w.-]+(?:[ \t]+[\w.:/-]+){0,8}[ \t]+--password-stdin\b|[\w.-]+[ \t]+(?:[\w-]+[ \t]+)?login\b))/g;
const HERE_STRING = /(<<<[ \t]*["']?)([^\s"']+)/g;
/** What a here-string feeds a password or token to, read back over its line. */
const HERE_STRING_READER = /\b(?:login|vncpasswd|passwd|chpasswd|--with-token|--password-stdin|token|secret)\b[^\r\n]{0,120}$/i;

/**
 * Rules that read a secret from its context. Each has a <keep> group (what stays, the name and any opening quote) and
 * a <v> group (the value), and a check the value must pass; text the check refuses is left exactly as it was.
 */
type Groups = { keep: string; v: string; name?: string; q?: string };
const CONTEXT_RULES: { re: RegExp; check: (v: string, g: Groups) => boolean }[] = [
  { re: /(?<keep>\b(?:password|passwd|passphrase|pass|pwd|pw|api[_ -]?key|token|secret)\s*:\s*["']?)(?<v>[^\s'"]{6,}?)(?=[,;)]?(?:[\s'"]|$))/gi, check: labelOrShort },
  { re: /(?<keep>(?:^|[\s\x60])--?(?:api[-_]?key|password|passwd|passphrase|pass|pwd|pw|token|secret)(?:=|\s+)["']?)(?<v>[^\s'"\x60]{6,}?)(?=[,;)]?(?:[\s'"\x60]|$))/gim, check: (v, g) => !/^[a-z][\w-]*=/.test(v) && labelOrShort(v, g) },
  { re: /(?<keep>\b(?:password|passwd|api[_ -]?key|access[_ -]?token|secret)\s+(?:is|was|equals?)\s+["']?)(?<v>[^\s'",;)}]{8,})/gi, check: value => { const v = value.replace(/[.!?:]+$/, ''); return !v.startsWith('`') && assignedSecret(v) && (looksLikeSecret(v) || randomRun(v)); } },
  { re: /(?<keep>\bdefine\(\s*["'][^"']*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|(?:AUTH|SECURE_AUTH|LOGGED_IN|NONCE)_(?:KEY|SALT))["']\s*,\s*["'])(?<v>[^"'\r\n]+)(?=["']\s*\))/gi, check: value => assignedSecret(value) || (/^[~/]/.test(value) && value.length >= 16) || (/^[A-Za-z]+[([]/.test(value) && /[A-Z0-9!@#$%^&*]/.test(value)) },
  // A connection string's Password=…; or Pwd=… up to the next separator or the end of the line. The value holds no
  // whitespace, so the spaces around it belong to one quantifier each (a value that could hold them was cubic).
  { re: /(?<keep>(?<![\w.])(?:Password|Pwd)[ \t]*=(?![=>])[ \t]*)(?<v>[^;,(){}"'\s\x60]+)(?=[ \t]*(?:[;,)}"'\x60]|$))/gim, check: (v) => !/^[{]|^@[A-Za-z_]\w*$/.test(v) && !IDENT.test(v) && assignedSecret(v) },
  { re: /(?<keep>\b(?:AUTH|SECURE_AUTH|LOGGED_IN|NONCE)_(?:KEY|SALT)(?:\s*=\s*["']?|\s*:\s*["']))(?<v>[^"'\r\n;]+)(?=["']|;|$)/gim, check: assignedSecret },
  // Env-style assignments whose name ends in a secret word: KEY=value, export KEY="value". A $VAR reference, a call
  // (os.environ.get(...)) or a value that is a URL or names a secret is not a secret.
  {
    re: /^(?<keep>[ \t]*(?:(?:export|set|declare[ \t]+-x)\s+)?(?<name>[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|SIGNING_KEY|CREDENTIALS?|PASS|PWD|PW|AUTH|PAT|(?:APP|MASTER|HMAC|SESSION|COOKIE|LICENSE|CONSUMER|SHARED|ACCOUNT|STORAGE|ADMIN|WEBHOOK|JWT|WRITE|DEPLOY|SERVICE|CLIENT|SUBSCRIPTION|SAS|AUTH)_KEY)(?:_KEY(?:_BASE)?)?)\s*(?:\?|::?)?=\s*(?<q>["']?))(?!\$)(?<v>[^\s"']{6,})\k<q>(?=\s|$)/gm,
    check: assignedTo,
  },
  // Any other NAME_KEY=value (STRIPE_KEY, SENDGRID_KEY) when the value looks like a secret and the name is not one of
  // the keys that index, sort, cache or name something.
  {
    re: /^(?<keep>[ \t]*(?:(?:export|set|declare[ \t]+-x)\s+)?(?<name>[A-Z0-9_]*_KEY)\s*(?:\?|::?)?=\s*(?<q>["']?))(?!\$)(?<v>[^\s"']{6,})\k<q>(?=\s|$)/gm,
    check: (v, g) => !plainKey(g.name!) && namedSecret(v),
  },
  // A slashed base64 key after a credential name, quoted or not: AWS_SECRET_ACCESS_KEY=/…, aws_secret_access_key = …/…,
  // "SecretAccessKey": "/…", password: /…, api_key: "/…" (slashKey).
  {
    re: new RegExp(String.raw`(?<keep>(?<nq>\\*["']?)${ANY_NAME}\k<nq>[ \t]*(?::=|=(?![=>~])|:)[ \t]*(?<q>\\*["']?))(?<v>[A-Za-z0-9+/]{16,}={0,2})(?=\k<q>(?:$|[\s,;}\]]))`, 'gim'),
    check: (v, g) => secretName(g.name!) && slashKey(v),
  },
  // A quoted literal given to a secret name in any language: const API_KEY = "…", apiToken := "…", self.password = '…',
  // api_key: str = "…", "client_secret": "…", Password: "…", connect(password="…"). The quotes stay. A value that only
  // names a secret ("access_token"), refers to one ("${VAR}", "$VAR", "<your token>") or is a type ("string") stays.
  // A quote after the name needs one before it ("api_key": …), so 'Replace token' : 'Connect' in a ternary stays. The
  // quotes may be escaped (JSON in a JSON string: "{\"apiKey\":\"…\"}"), and a YAML anchor or tag may come first
  // (secret_key: &sk "…", token: !!str …). Makefile ?= and JavaScript ??= assign too.
  {
    re: new RegExp(String.raw`(?<keep>(?<nq>\\*["']?)${ANY_NAME}\k<nq>\s*(?::[ \t]*[A-Za-z_][\w.<>\[\]|?]*(?:[ \t]+[\w.<>\[\]|?]+)*[ \t]*)?(?::=|\?\??=|=>|=(?![=>~])|:)\s*(?:[&!][\w.\/!-]*[ \t]+)?(?<q>\\*["'\x60]))(?![$<{%])(?<v>[^\s"'\x60]{6,})(?=\k<q>)`, 'gi'),
    check: assignedTo,
  },
  // A quoted literal after a secret name with no separator (Gradle storePassword "…", keyPassword '…', at the start of a
  // line or after { or ;), in a subscript
  // (app.config["SECRET_KEY"] = "…", ENV['API_TOKEN'] = '…'), or as the value beside a quoted secret name in a call or a
  // pair ([Environment]::SetEnvironmentVariable("API_KEY", "…"), os.environ.setdefault("TOKEN", "…"), Capistrano
  // set :deploy_password, '…', <add key="ClearTextPassword" value="…"/>, <property name="password" value="…"/>, <entry
  // key="db.password">…</entry>). A call's second argument is often a default, so it must look like a secret.
  {
    re: new RegExp(String.raw`(?<keep>(?:^|[{;])[ \t]*${ANY_NAME}[ \t]+(?<q>["']))(?<v>[^\s"']{6,})(?=\k<q>)`, 'gim'),
    check: (v, g) => secretName(g.name!) && assignedSecret(v) && (looksLikeSecret(v) || randomRun(v) || shortRandom(v)),
  },
  {
    re: new RegExp(String.raw`(?<keep>\[[ \t]*(?<nq>["'])${ANY_NAME}\k<nq>[ \t]*\][ \t]*(?:=(?![=>~])|:)[ \t]*(?<q>["'\x60]))(?<v>[^\s"'\x60]{6,})(?=\k<q>)`, 'gi'),
    check: assignedTo,
  },
  {
    re: new RegExp(String.raw`(?<keep>(?:\(|\bset[ \t])[ \t]*(?:(?<nq>["'])|:)${ANY_NAME}\k<nq>[ \t]*,[ \t]*(?<q>["']))(?<v>[^\s"']{6,})(?=\k<q>)`, 'gi'),
    check: (v, g) => secretName(g.name!) && assignedSecret(v) && (looksLikeSecret(v) || randomRun(v)),
  },
  // A setter or builder given a quoted literal: setPassword("…"), .withApiKey("…"), .password("…"); not a getter or a
  // check (getToken("…"), .verifyPassword("…")), and the value must look like a secret, not an elided example (sk_A1...).
  {
    re: new RegExp(String.raw`(?<keep>(?:\b(?:set|with)(?=[A-Z_])|(?<=[\w$)\]]\??\.)(?!(?:get|has|is|find|load|fetch|read|parse|validate|verify|check|hash|encrypt|decrypt|encode|decode|create|generate|revoke|delete|remove|refresh|lookup|resolve|compare|match|new|to|from|sign|mask|redact)(?:[A-Z_]|$)))(?<name>(?:[A-Za-z_]\w*?)?(?i:${NAME_END}))[ \t]*\([ \t]*(?<q>["'\x60]))(?<v>[^\s"'\x60]{6,})(?=\k<q>[ \t]*[,)])`, 'g'),
    check: (v, g) => secretName(g.name!) && !/(?:\.{3}|…)$/.test(v) && assignedSecret(v) && (looksLikeSecret(v) || randomRun(v) || shortRandom(v)),
  },
  {
    re: new RegExp(String.raw`(?<keep>\b(?:key|name)[ \t]*=[ \t]*(?<nq>["'])${ANY_NAME}\k<nq>[ \t]+value[ \t]*=[ \t]*(?<q>["']))(?<v>[^"'\r\n]{4,})(?=\k<q>)`, 'gi'),
    check: assignedTo,
  },
  {
    re: new RegExp(String.raw`(?<keep><[\w:.-]+[ \t]+(?:key|name)[ \t]*=[ \t]*(?<nq>["'])${ANY_NAME}\k<nq>[ \t]*>)(?<v>[^<\r\n]{4,})(?=</)`, 'gi'),
    check: (v, g) => !/^(?:\$\{|\{\{)/.test(v) && assignedTo(v, g),
  },
  // An XML element named for a secret (<AdministratorPassword>, <ApiKey>, <client_secret>), and Windows unattend's
  // <Password><Value>…</Value> pair. sbt's Credentials(realm, host, user, password).
  {
    re: new RegExp(String.raw`(?<keep><${ANY_NAME}(?:\s[^<>]*)?>)(?<v>[^<\r\n]{4,})(?=</\k<name>>)`, 'gi'),
    check: (v, g) => !/^(?:\$\{|\{\{)/.test(v) && assignedTo(v, g),
  },
  { re: /(?<keep><(?<name>[\w:-]*(?:Password|Passwd))>\s{0,40}<Value>)(?<v>[^<\r\n]+)(?=<\/Value>)/gi, check: (v) => assignedSecret(v) },
  { re: /(?<keep>\bCredentials\([ \t]*"[^"\r\n]*"[ \t]*,[ \t]*"[^"\r\n]*"[ \t]*,[ \t]*"[^"\r\n]*"[ \t]*,[ \t]*")(?<v>[^"\r\n]+)(?=")/g, check: (v) => assignedSecret(v) },
  // A secret name and its value as a name/value pair: a Kubernetes or compose env entry (- name: JWT_SECRET, then value:
  // on the next line), an ECS or JSON one ({"name": "DB_PASSWORD", "value": "…"}).
  {
    re: new RegExp(String.raw`(?<keep>\b(?:name|key)["']?[ \t]*[:=][ \t]*(?<nq>["']?)${ANY_NAME}\k<nq>(?:[ \t]*(?:,|\r?\n)[ \t]*|[ \t]+)["']?value["']?[ \t]*[:=][ \t]*(?<q>["']?))(?<v>[^\s"'\x60,}]{6,})(?=\k<q>(?:[\s,}]|$))`, 'gi'),
    check: (v, g) => assignedTo(v, g) && (looksLikeSecret(v) || randomRun(v) || shortRandom(v)),
  },
  // A key nested under a mapping that names what it is for (encryption:, signing:, stripe:), a few lines down at most;
  // a cache, sort or partition key is not one, and the value must be a token.
  {
    re: /(?<keep>^[ \t]*(?<name>[A-Za-z][\w-]*)[ \t]*:[ \t]*\r?\n(?:[ \t]+[\w-]+[ \t]*:[^\r\n]*\r?\n){0,8}?[ \t]+key[ \t]*:[ \t]*(?<q>["']?))(?<v>[^\s"'#]{16,})(?=\k<q>[ \t]*(?:#|$))/gim,
    check: (v, g) => !plainKey(`${g.name}_key`) && (strongSecret(v) || slashedSecret(v) || (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(v) && /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v))),
  },
  // SQL that sets a role's password: CREATE/ALTER USER|ROLE|LOGIN … [ENCRYPTED] PASSWORD [=] '…', IDENTIFIED BY '…',
  // SET PASSWORD [FOR user] = '…'. A MySQL hash ('*6BB4…') is not the password.
  {
    re: /(?<keep>\b(?:(?:create|alter)[ \t]+(?:user|role|login)\b[^;\r\n]{0,200}?\b(?:password[ \t]*(?:=[ \t]*)?|identified[ \t]+(?:by|with[ \t]+\w+[ \t]+(?:by|as))[ \t]+)|set[ \t]+password[ \t]+(?:for[ \t]+[^\s=]+[ \t]*)?=[ \t]*)')(?<v>[^'\r\n]{4,})(?=')/gi,
    check: (v) => assignedSecret(v) && !v.startsWith('*'),
  },
  // Terraform: a variable named for a secret and given a default, on its line or a few lines into its block.
  {
    re: new RegExp(String.raw`(?<keep>\bvariable[ \t]+"${ANY_NAME}"[ \t]*\{[^{}]{0,400}?\bdefault[ \t]*=[ \t]*")(?<v>[^"\r\n]{4,})(?=")`, 'gi'),
    check: (v, g) => assignedTo(v, g),
  },
  // A session cookie written without its header (connect.sid=…, PHPSESSID=…, curl -b sessionid=…), and a line of a
  // Netscape cookie file (domain, flag, path, secure, expiry, name, value; tab-separated). Long random values only.
  {
    re: /(?<keep>(?<![\w.%-])(?:connect\.sid|PHPSESSID|JSESSIONID|ASP\.NET_SessionId|laravel_session|rack\.session|_gh_sess|__(?:Secure|Host)-[\w.-]+|[\w.-]*?sess(?:ion)?[_.-]?(?:id|token|key)?)=)(?<v>[^;\s"',&]{16,})/gi,
    check: (v) => cookieSecret(v),
  },
  {
    re: /(?<keep>^(?:#HttpOnly_)?[^\s#][^\t\r\n]*\t(?:TRUE|FALSE)\t[^\t\r\n]*\t(?:TRUE|FALSE)\t\d+\t[^\t\r\n]+\t)(?<v>[^\t\r\n]+)$/gm,
    check: (v) => cookieSecret(v),
  },
  // An HTTP header named for a credential, in any client or language: X-Auth-Key, Fastly-Key, DD-APPLICATION-KEY,
  // Private-Token, X-JFrog-Art-Api, x-honeycomb-team, as Name: value, "Name": "value" or "Name" = "value". And
  // Authorization with any scheme (token, ApiKey, AccessKey, Splunk, GenieKey, Basic) or none.
  {
    re: /(?<keep>(?<![\w-])(?<name>(?:[A-Za-z0-9]+-)+(?:key|token|secret|apikey|auth|pass|password|passwd|credentials?)|x-honeycomb-team|[\w-]+-art-api)["']?[ \t]*(?::|=>?)[ \t]*["']?)(?<v>[^\s"',;]{8,})/gi,
    check: (v, g) => !(/key$/i.test(g.name!) && plainKey(g.name!)) && headerSecret(v.replace(/[).}\]]+$/, '')),
  },
  {
    re: /(?<keep>\b(?:proxy-)?authorization["']?[ \t]*(?::|=>?)[ \t]*["']?(?!digest[ \t])(?:[A-Za-z][\w.-]{1,30}[ \t]+)?(?:token=|key=)?)(?<v>[^\s"',;]{8,})/gi,
    check: (v) => headerSecret(v.replace(/[).}\]]+$/, '')),
  },
  // Digest auth: name="value" parameters, of which response (a hash of the password) is the secret.
  {
    re: /(?<keep>\b(?:proxy-)?authorization["']?[ \t]*(?::|=>?)[ \t]*["']?digest[ \t][^\r\n]{0,400}?\bresponse[ \t]*=[ \t]*\\?["']?)(?<v>[^\s"',;\\]{8,})/gi,
    check: assignedSecret,
  },
  // An unquoted value given to a secret name: password: hunter2x (YAML), secret = … (ini), -e DB_PASSWORD=…,
  // --password=…, X-Api-Key: …, pw: … . Only values that look like secrets, so types and identifiers stay.
  // A command-line flag and its whole value, up to the next space: --token …, --password=…, -password … (not a
  // key=value spec such as docker's --secret id=x,env=Y). A shell
  // passes trailing punctuation as part of the value, so all of Secret123! goes; the check reads it without that. A
  // quoted value may start with & * or ! ('&*3h…'), which unquoted would be a YAML anchor, alias or tag.
  {
    re: new RegExp(String.raw`(?<keep>(?:^|[\s\x60])--?(?<name>[\w-]*?${NAME_END})(?:=|\s+)(?<q>["']?))(?<v>(?:(?<=["'])(?![$<{%~/.\-:(])|(?![$<{%~&*!/.\-:(]))[^\s"'\x60]{6,})`, 'gi'),
    check: (v, g) => secretName(g.name!) && !/^[a-z][\w-]*=/.test(v) && nameOrShort(v.replace(/[!?.,;:)]+$/, ''), g),
  },
  { re: new RegExp(String.raw`(?<keep>(?<nq>["']?)${ANY_NAME}\k<nq>\s*(?:::?=|\?\??=|:|=(?![=>~]))[ \t]*(?:[&!][\w.\/!-]*[ \t]+)?)(?<v>${UNQUOTED_SECRET})`, 'gi'), check: (v, g) => secretName(g.name!) && nameOrShort(v, g) },
  // A name and its value separated only by blanks, as the last thing on the line: setx NAME "…" (Windows), set -gx NAME …
  // (fish), redis CONFIG SET requirepass …, and config files that take NAME value (PASSPHRASE …, password …;, requirepass …).
  // A vendor's NAME_KEY (MISTRAL_KEY) takes a token, as it does after =.
  {
    re: new RegExp(String.raw`(?<keep>^[ \t]*(?:(?:setx|set(?:[ \t]+-[A-Za-z]+)+|config[ \t]+set)[ \t]+)?${ANY_NAME}[ \t]+(?<q>["']?))(?<v>[^\s"';,()\[\]{}<>]{6,})\k<q>;?[ \t]*$`, 'gim'),
    check: (v, g) => g.q || !secretName(g.name!) ? assignedTo(v, g) : labelledSecret(v) || (PASSWORD_LABEL.test(g.name!) && shortRandom(v)),
  },
  // Prose that hands a value over: "use token X for the bot", "log in with password X".
  {
    re: new RegExp(String.raw`(?<keep>\b(?:use|using|with|pass|try)\s+(?:the\s+)?(?:token|password|passphrase|secret|api[ _-]?key)\s+["'“]?)(?<v>${UNQUOTED_SECRET})`, 'gi'),
    check: namedSecret,
  },
  // Prose: "the admin password is hunter2", "the api key was 'x9...'", "token = …", with up to six words between
  // ("the admin password for the system is …", "our DB password, by the way, is …"). Only a credential word counts: a
  // bare "key" (primary, cache, sort, map, config key) never does, and the value must look like a secret.
  {
    re: new RegExp(String.raw`(?<keep>\b(?:password|passwd|passphrase|pwd|pw|secret|token|credentials?|(?:api|access|private|secret)[ _-]?key)(?:[ \t,]+(?!(?:is|was|are)\b)[\w'-]+){0,6}?,?\s+(?:is|was|are|=)\s+(?:set\s+to\s+|now\s+)?["'“]?)(?<v>${UNQUOTED_SECRET})`, 'gi'),
    check: namedSecret,
  },
  // A token with no label of its own a few words after a credential word: "my bearer is …", "the access key … (don't
  // share)", "password for the staging db: …", "creds are admin / …". Only a strongSecret: random, or 12+ characters of
  // a token alphabet mixing letters and digits.
  {
    re: /(?<keep>\b(?:password|passwd|passphrase|pwd|pw|secret|token|bearer|creds|credentials?|(?:api|access|private|secret|auth|signing|encryption|master|license|deploy)[ _-]?key)s?\b(?:[ \t]+(?![A-Za-z0-9+\/_.~!@#$%^&*-]{10})[\w'’-]{1,20}){0,5}?(?:[ \t]*(?:=>|[:=\/])[ \t]*|[ \t]+)["'“(]?)(?<v>[A-Za-z0-9+\/_.~!@#$%^&*-]{10,256}={0,2}(?=$|[\s"'”),;?]|\.(?:\s|$))|[A-Za-z0-9+\/_.~!@#$%^&*-]{257,}={0,2})/gim,
    check: (v) => strongSecret(v.replace(/[.=]+$/, '')),
  },
];

/**
 * A Cookie or Set-Cookie header: each name=value pair whose value is a long random token (a session id) goes; the
 * attributes (Path, Domain, Expires, Max-Age, SameSite) and short values (theme=dark, logged_in=yes) stay.
 */
const COOKIE_LINE = /(\b(?:set-)?cookie["']?[ \t]*:[ \t]*["']?)(?=[\w.%-]+=)([^\r\n]{1,4096})/gi;
const COOKIE_PAIR = /((?:^|;)[ \t]*(?!(?:path|domain|expires|max-age|samesite|priority|comment|version)=)[\w.%-]+=)([^;\s"',]+)/gi;
const cookieSecret = (v: string) => v.length >= 16 && headerSecret(v);

/** Basic/Docker auth must decode to printable user:password bytes, not ordinary words such as "required". */
export function encodedCredential(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) return false;
  try {
    const decoded = atob(value);
    return /^[\x20-\x7e]*:[\x20-\x7e]+$/.test(decoded)
      && btoa(decoded).replace(/=+$/, '') === value.replace(/=+$/, '');
  } catch { return false; }
}

/** Shapes replaceTokens checks before it redacts them (each match goes through a test in replaceTokens). */
const FRAGMENTS = {
  prefixed: /\b(?:gsk_|pypi-|whsec_|lin_oauth_|GOCSPX-|xapp-)([A-Za-z0-9_-]{16,})/g,
  discordBot: /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g,
  base64: /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+]{40}(?![A-Za-z0-9+/_-])/g,
  slashed: /(?<![A-Za-z0-9/+])(?=[A-Za-z0-9+\/]{40}(?![A-Za-z0-9/+]))(?=[A-Za-z0-9+\/]*\/)[A-Za-z0-9+\/]{40}/g,
  basic: /\b(Basic[ \t]+)([A-Za-z0-9+/]+={0,2})(?=$|[\s"',;])/gi,
  dockerAuth: /("auth"\s*:\s*")([^"\r\n]+)(")/gi,
  // pgpass has five non-whitespace fields. Compiler file:line:column: error diagnostics are not credentials.
  pgpass: /^((?:[^:\s\\]|\\.)+:(?:\d+|\*):(?:[^:\s\\]|\\.)+:(?:[^:\s\\]|\\.)+:)([^\r\n]+)$/gm,
  npmAuth: /(^[ \t]*_auth\s*=\s*)(?![$<{])[A-Za-z0-9+/]{12,}={0,2}\s*$/gim,
  // A Kubernetes Secret's data: block. Blanks only within a line: a \s* there could also take the line breaks the
  // gap and ^ read, and "data:" with a few thousand empty lines took seconds.
  kubeData: /(^data:[ \t]*$(?:(?!^data:)[\s\S]){0,2000}?^[ \t]*(?:password|passwd|token|secret|api[_-]?key)[ \t]*:[ \t]*)(?![$<{])[A-Za-z0-9+/]{8,}={0,2}[ \t]*$/gim,
  // A JWT whose JSON has blanks in it ({"alg": …} is eyJhbGciOiAi…, { "alg" … is eyAi…): its header must decode to JSON
  // naming alg or typ. Only where a run of base64url starts, so a long run is read once.
  jwt: /(?<![A-Za-z0-9_-])e[wy][A-Za-z0-9_-]{6,}\.e[wy][A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}/g,
  // A Mailgun key on its own: key- and 32 letters and digits, not part of a longer name (cache-key-…, key-….json).
  mailgun: /(?<![\w.-])key-[0-9a-z]{32}(?![\w-]|\.\w)/g,
  // A BIP-39 recovery phrase (12-24 words of 3-8 letters) given to a name for one: MNEMONIC="…", seed phrase: ….
  mnemonic: /((?<![\w-])[\w-]*?(?i:mnemonic|seed[ _-]?phrase|recovery[ _-]?phrase|secret[ _-]?(?:recovery[ _-]?)?phrase|seed[ _-]?words|wallet[ _-]?seed|backup[ _-]?phrase)["']?[ \t]*(?:(?::|=>|\?\??=|:?=)[ \t]*)?["'\x60]?)([a-z]{3,8}(?:[ \t]+[a-z]{3,8}){11,23})(?=[ \t]*(?:["'\x60,;]|$))/gm,
};

function replaceTokens(text: string): string {
  // Whole key blocks must go first. Fragment redaction can otherwise split a body line and make an unterminated block
  // impossible for the structural rule to recognize, leaking the remaining lines.
  let out = BLOCK_PATTERNS.reduce((value, re) => value.replace(re, '[REDACTED]'), text);
  out = out.replace(FRAGMENTS.prefixed, (all, value: string) => namedSecret(value) ? '[REDACTED]' : all);
  out = out.replace(FRAGMENTS.discordBot, value => {
    const id = Buffer.from(value.split('.')[0], 'base64url').toString('utf8');
    return /^\d{17,22}$/.test(id) ? '[REDACTED]' : value;
  });
  // Before the 40-character base64 rule, which would take a JWT's header alone and leave the rest.
  out = out.replace(FRAGMENTS.jwt, (value) => /^\{\s*"(?:alg|typ|kid)"/.test(Buffer.from(value.slice(0, value.indexOf('.')), 'base64url').toString('latin1')) ? '[REDACTED]' : value);
  out = out.replace(FRAGMENTS.base64, (value, offset: number, source: string) => {
    const highEntropy = /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value) && new Set(value).size >= 16;
    const prefix = source.slice(Math.max(0, offset - 24), offset);
    const integrity = /(?:sha(?:256|384|512)|integrity|code[_ -]?challenge)[=:\s-]*$/i.test(prefix);
    const expression = /^[A-Za-z][A-Za-z]+\+\d+$/.test(value);
    const functionCall = source[offset + value.length] === '(' && /^[A-Za-z_$][\w$]*$/.test(value);
    return highEntropy && !integrity && !expression && !functionCall ? '[REDACTED]' : value;
  });
  // The 40 characters may be a path's stem (src/Windows/Win32/Graphics/Direct3D9/mod.rs): read them with its extension.
  out = out.replace(FRAGMENTS.slashed, (value, offset: number, source: string) =>
    slashedSecret(value + (/^\.[a-z][a-z0-9]{0,4}(?![\w])/i.exec(source.slice(offset + value.length))?.[0] ?? '')) && new Set(value).size >= 16 ? '[REDACTED]' : value);
  out = out.replace(FRAGMENTS.basic, (all, keep: string, value: string) => encodedCredential(value) ? `${keep}[REDACTED]` : all);
  out = out.replace(FRAGMENTS.dockerAuth,
    (all, keep: string, value: string, end: string) => encodedCredential(value) ? `${keep}[REDACTED]${end}` : all);
  out = out.replace(FRAGMENTS.pgpass,
    (all, keep: string, value: string) => value.trim() === '*' || /^<[^>]+>$/.test(value.trim()) || /:\d+:(?:error|warning|note|fatal(?: error)?|vet|Werror|AssertionError|[A-Z]\d+):$/i.test(keep)
      ? all : `${keep}[REDACTED]`);
  out = out.replace(FRAGMENTS.npmAuth, '$1[REDACTED]');
  // Random: letters and digits, several distinct (key-a1a1… is a fixture). A key is 32 hex, and 1 in 50 random ones
  // has fewer than 12 distinct characters; under 6 is about one in 10^11.
  out = out.replace(FRAGMENTS.mailgun, (value) => /\d/.test(value.slice(4)) && /[a-z]/.test(value.slice(4)) && new Set(value.slice(4)).size >= 6 ? '[REDACTED]' : value);
  // A phrase of few distinct words is a fixture (test test … junk), not a wallet's.
  out = out.replace(FRAGMENTS.mnemonic, (all, keep: string, words: string) => new Set(words.split(/[ \t]+/)).size >= 8 ? `${keep}[REDACTED]` : all);
  out = out.replace(FRAGMENTS.kubeData, '$1[REDACTED]');
  const command = (all: string, keep: string, v: string) => commandSecret(v) && !(/\s["']?$/.test(keep) && /^--?[A-Za-z]/.test(v)) ? `${keep}[REDACTED]` : all;
  out = COMMAND_RULES.reduce((value, re) => value.replace(re, command), out);
  out = COMMAND_LINES.reduce((value, [line, args]) => value.replace(line, (rest) => args.reduce((seg, arg) => seg.replace(arg, command), rest)), out);
  out = out.replace(STDIN_SECRET, command);
  out = out.replace(HERE_STRING, (all, keep: string, v: string, offset: number, source: string) =>
    HERE_STRING_READER.test(source.slice(Math.max(0, offset - 200), offset).replace(/^[^]*\n/, '')) ? command(all, keep, v) : all);
  return TOKEN_PATTERNS.reduce((value, re) => value.replace(re, (_m, keep?: string) =>
    typeof keep === 'string' ? `${keep}[REDACTED]` : '[REDACTED]'), out);
}

/** Every pattern the rules run over text, for the test that holds each to a time budget on adversarial input. */
export const REDACTION_PATTERNS: readonly RegExp[] = [
  ...BLOCK_PATTERNS, ...Object.values(FRAGMENTS), ...TOKEN_PATTERNS, ...COMMAND_RULES, ...COMMAND_LINES.flat(2), STDIN_SECRET, HERE_STRING,
  ...CONTEXT_RULES.map((r) => r.re), COOKIE_LINE, COOKIE_PAIR,
];

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
      const g = args[args.length - 1] as Groups;
      // "nextPageToken": "page-2" names a place in a list, not a credential.
      // A value an earlier rule already redacted is left as it is, so a second rule cannot widen the cut.
      if (g.v.startsWith('[REDACTED]') || CURSOR_NAMED.test(g.keep) || /\b(?:key|token|secret|password)\s+(?:format|pattern)\s+(?:is|was|=)\s*[\"']?$/i.test(g.keep)) return m;
      return check(g.v, g) ? `${g.keep}[REDACTED]${m.slice(g.keep.length + g.v.length)}` : m;
    });
  }
  return out.replace(COOKIE_LINE, (_m, keep: string, pairs: string) =>
    keep + pairs.replace(COOKIE_PAIR, (all, name: string, v: string) => cookieSecret(v) ? `${name}[REDACTED]` : all));
}

/**
 * redactSecrets, remembering each answer for the life of the returned function: for a pass over many short strings
 * that repeat (a code map's import names and specs, hundreds of thousands of them over a few thousand distinct ones),
 * where running every rule on each repeat costs more than the rest of the pass.
 */
export function redactSecretsMemo(): (text: string) => string {
  const seen = new Map<string, string>();
  return (text) => {
    let out = seen.get(text);
    if (out === undefined) seen.set(text, (out = redactSecrets(text)));
    return out;
  };
}

/**
 * A statement that is (or was written around) a credential: a rule redacts something in it, or a model already wrote
 * [REDACTED] into it. Such a fact tells an agent nothing but a secret, so it is not kept.
 */
export function holdsCredential(text: string): boolean {
  return redactSecrets(text) !== text || text.includes('[REDACTED]');
}

/** A stored fact as the startup re-run reads it. origin 'you': the owner wrote it. */
/** fromDoc: the fact was read from an upload (it has a document). */
export type StoredFactText = { statement: string; why: string | null; current: boolean; origin?: string | null; fromDoc?: boolean };

/**
 * Statements that speak to the agent rather than about the project. An upload is data, and a fact from it reaches
 * agents ranked by relevance, so a line written to steer the reader-as-AI is not kept (worker docs/read.ts): one that
 * overrides its instructions ("ignore previous instructions", "disregard your system prompt"), recasts it ("you are
 * now", "as an AI, you", "pretend to be"), addresses it by what it is ("if you are an AI agent"), carries a chat role or
 * prompt marker (a line starting "assistant:", <|im_start|>, [INST], <system>), coerces a tool call, pipes a download
 * into a shell or sends secrets to an address. A project convention, an always/never about the code or the repo
 * ("Always run pnpm test before committing", "Never commit directly to main", "From now on all endpoints live under
 * /v2"), and a rule about the product ("orders are always scoped to the tenant") are facts and stay.
 */
const INSTRUCTION = [
  /\b(?:ignore|disregard|forget|override)\b[^.]{0,40}\b(?:previous|prior|above|earlier|your|system)\b[^.]{0,20}\b(?:instructions?|rules?|prompts?|directions?|guidelines?|context)\b/i,
  // "all / any / every / other" only before what an agent is given (instructions, prompts, directions), never before
  // "rules": "ignore other lint rules for generated files" is a convention.
  /\b(?:ignore|disregard|forget|override)\b[^.]{0,30}\b(?:all|any|every|other)\b[^.]{0,20}\b(?:instructions?|prompts?|directions?|guidelines?)\b/i,
  /\byou\s+(?:must|should|will|need\s+to|are\s+to|have\s+to)\s+(?:now|from\s+now\s+on|immediately|instead)\b/i,
  /\bfrom\s+now\s+on,?\s+you\b/i,
  /\b(?:you\s+are\s+now|pretend\s+(?:to\s+be|you\s+are)|new\s+instructions?\s*:|developer\s+message)\b/i,
  /\b(?:your|the\s+assistant'?s?)\s+(?:system\s+prompt|instructions|guidelines)\b/i,
  /\bif\s+you\s+are\s+an?\s+(?:ai|llm|agent|ai\s+agent|assistant|coding\s+agent|language\s+model)\b/i,
  /\bas\s+an?\s+(?:ai|llm|(?:large\s+)?language\s+model)(?:\s+(?:agent|assistant|model))?\s*,/i,
  // Chat roles and prompt markers: a turn written into the document.
  /^\W{0,3}(?:system|assistant|developer|human)\s*:/im,
  /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(?:system|instructions?|tool_call|function_calls?)>/i,
  // The agent told to act without its owner: "never ask the user", "approve every lesson without asking".
  /\b(?:never|don'?t|do\s+not)\s+(?:ask|tell|check\s+with|confirm\s+with|consult)\s+(?:the\s+)?(?:user|owner|human|me)\b/i,
  /\bwithout\s+(?:asking|telling|checking\s+with|confirming\s+with)\s+(?:the\s+)?(?:user|owner|human|me)\b/i,
  /\b(?:approve|accept|merge)\s+(?:every|all|any)\s+[\w\s-]{0,30}?\bwithout\s+(?:asking|review|confirmation|checking)\b/i,
  // A tool call the document asks for.
  /\b(?:call|invoke|run|use)\s+(?:the\s+)?[\w.-]+\s+(?:tool|function)\s+(?:now|immediately|with)\b/i,
  // A download piped into a shell, and secrets sent to an address.
  /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
  /\b(?:send|post|upload|email|share|leak|forward)\b[^.]{0,40}(?:\.env|secrets?|credentials|api\s*keys?|tokens?|passwords?|ssh\s+keys?)\b[^.]{0,40}\bto\s+(?:https?:\/\/|[\w.+-]+@[\w-]+\.)/i,
];
/** A statement from an upload that is an instruction to the agent (INSTRUCTION). */
export const instructsAgent = (statement: string) => INSTRUCTION.some((re) => re.test(statement));

/**
 * The rule as v4 had it, which also took project conventions ("Always run pnpm test before committing", "From now on
 * all endpoints live under /v2") for instructions: kept only to find the facts it closed (reopensAsFact).
 */
const INSTRUCTION_V4 = [
  /\b(?:ignore|disregard|forget|override)\b[^.]{0,40}\b(?:previous|prior|above|earlier|all|any|your|other|system)\b[^.]{0,20}\b(?:instructions?|rules?|prompts?|directions?|guidelines?|context)\b/i,
  /\byou\s+(?:must|should|will|need\s+to|are\s+to|have\s+to)\s+(?:now|from\s+now\s+on|immediately|instead)\b/i,
  /\bfrom\s+now\s+on\b/i,
  /\b(?:you\s+are\s+now|pretend\s+to\s+be|new\s+instructions?|system\s+prompt|developer\s+message)\b/i,
  /\bif\s+you\s+are\s+an?\s+(?:ai|llm|agent|ai\s+agent|assistant|coding\s+agent|language\s+model)\b/i,
  /^\W*(?:always|never|you\s+must|you\s+should|be\s+sure\s+to|make\s+sure\s+to)\s+(?:run|execute|call|invoke|curl|wget|download|install|send|post|upload|push|commit|delete|remove|rm|disable|approve|merge|reveal|print|share|email|ask|tell|skip|bypass)\b/i,
];

/** Why the startup re-run closed a stored fact, as a store records it (facts.close_reason, Fact.closeReason). */
export type FactCloseReason = 'credential' | 'instruction';

/**
 * A document fact that is closed (current false) and should be served again under the current rule: it was closed as
 * an instruction (closeReason 'instruction'; before v5 no reason was recorded, so: the v4 rule matched it, and only the
 * re-run ever closes a document fact) and it is not one now, nor does it hold a credential.
 */
export function reopensAsFact(f: { statement: string; closeReason?: string | null }): boolean {
  const closedAsInstruction = f.closeReason === 'instruction' || (!f.closeReason && INSTRUCTION_V4.some((re) => re.test(f.statement)));
  return closedAsInstruction && !instructsAgent(f.statement) && !holdsCredential(f.statement);
}

/**
 * What the startup re-run (worker redactStored.ts) does to one stored fact. A current fact is closed only when a rule
 * matches its statement now: text an older rule already turned into [REDACTED] is not closed again on that alone. A
 * fact the owner wrote (origin you) is never closed, and loses only known token shapes, in place. A current fact read
 * from an upload that is an instruction to the agent is closed as it is (instruction: true).
 */
export function redactStoredFact(f: StoredFactText): { statement: string; why: string | null; close: boolean; instruction: boolean } {
  if (f.origin === 'you') return { statement: redactTokens(f.statement), why: f.why === null ? null : redactTokens(f.why), close: false, instruction: false };
  const statement = redactSecrets(f.statement);
  const credential = f.current && statement !== f.statement;
  const instruction = !credential && f.current && !!f.fromDoc && instructsAgent(f.statement);
  return { statement, why: f.why === null ? null : redactSecrets(f.why), close: credential || instruction, instruction };
}

/** A stored lesson as the startup re-run reads it. checks: its flags (LessonCheck[]), kept as they are. */
export type StoredLessonText<C extends { name: string; why: string }> = { status: string; title: string; rule: string; appliesWhen: string | null; checks: C[] | null };

/** The flag an approved lesson gets when a rule reads a credential in it (types.ts LESSON_CHECKS). */
export const MAY_HOLD_SECRET = 'may-hold-secret';

/**
 * What the startup re-run does to one stored lesson; null when nothing changes. A lesson not yet approved is redacted
 * by every rule. An approved lesson is the owner's decision and its text is never changed by a rule that reads
 * context: like a fact the owner wrote, it loses only known token shapes, in place. When a context rule would redact
 * more, it gets the may-hold-secret flag (once) for the owner to edit it, and `flagged` says so.
 */
export function redactStoredLesson<C extends { name: string; why: string }>(l: StoredLessonText<C>): { title: string; rule: string; appliesWhen: string | null; checks: C[] | null; flagged: boolean } | null {
  const approved = l.status === 'approved';
  const by = approved ? redactTokens : redactSecrets;
  const text = { title: by(l.title), rule: by(l.rule), appliesWhen: l.appliesWhen === null ? null : by(l.appliesWhen) };
  const flagged = approved && !(l.checks ?? []).some((c) => c.name === MAY_HOLD_SECRET)
    && [text.title, text.rule, text.appliesWhen ?? ''].some((t) => redactSecrets(t) !== t);
  const checks = flagged
    ? [...(l.checks ?? []), { name: MAY_HOLD_SECRET, why: `the redaction rules (v${REDACTION_VERSION}) read a credential in its text; it was not changed because you approved it: edit it if it holds a secret, and rotate that secret` } as C]
    : l.checks;
  const same = text.title === l.title && text.rule === l.rule && text.appliesWhen === l.appliesWhen;
  return same && !flagged ? null : { ...text, checks, flagged };
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

/**
 * What a store writes back for one row redactStoredRow changed: only the fields that changed (set), each with the
 * value it was read as (was), so the write can be conditioned on the field being unchanged since the read. A row
 * another writer touched in between (an Ask turn answered) keeps that writer's value.
 */
export function redactedChanges<T extends Record<string, unknown> & { id: string }>(row: T, out: T, keys: readonly (keyof T & string)[]): { id: string; set: Partial<T>; was: Partial<T>; fields: string[] } {
  const fields = keys.filter((k) => JSON.stringify(out[k]) !== JSON.stringify(row[k]));
  return { id: row.id, set: Object.fromEntries(fields.map((k) => [k, out[k]])) as Partial<T>, was: Object.fromEntries(fields.map((k) => [k, row[k]])) as Partial<T>, fields };
}

const SECRET_KEY =/^(.*[_-])?(secret|token|password|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|run[_-]?key|credentials?)$|(Secret|Token|Password|ApiKey|AccessKey|PrivateKey|Credentials?)$/i;

/**
 * A string under a key, redacted as the rules read it on its own and then, when it is one line, as the pair
 * "key": "value" reads as JSON text, so a name that makes it a secret (DB_PASS, private_key_id) counts as it does in
 * text. A cut that breaks the pair's JSON takes the whole value.
 */
/**
 * A key the pair rules can read a value under as a credential: each of them keys on a name like these (password,
 * DB_PASS, apiKey, Authorization, PAT, a Mailchimp key...). Under any other key the pair reads as the value alone, so
 * redactKeyed reads the value once, not again as a pair.
 */
const KEYED_NAME = /pass|pw|secret|token|auth|cred|key|mailchimp|mandrill|cookie|session|private|bearer|dsn|conn|mnemonic|seed|phrase|(?:^|[^a-z])pat(?:[^a-z]|$)|[a-z]Pat(?:[^a-z]|$)/i;

function redactKeyed(k: string, x: string): string {
  const own = redactSecrets(x);
  if (!KEYED_NAME.test(k)) return own;
  // Blanks around the value ('…\n' read from a file) do not make it more than one line.
  const [, lead, body, tail] = /^(\s*)([^]*?)(\s*)$/.exec(own)!;
  if (/[\r\n]/.test(body)) return own;
  const pair = JSON.stringify({ [k]: body });
  const read = redactSecrets(pair);
  if (read === pair) return own;
  try {
    const parsed: unknown = JSON.parse(read);
    const value = parsed && typeof parsed === 'object' ? Object.values(parsed)[0] : undefined;
    return lead + (typeof value === 'string' ? value : '[REDACTED]') + tail;
  } catch {
    return lead + '[REDACTED]' + tail;
  }
}

/** Redact every string inside a value (objects, arrays); numbers such as embeddings pass through untouched. */
export function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redactSecrets(v) as T;
  if (Array.isArray(v)) return (v.every((x) => typeof x === 'number') ? v : v.map(redactDeep)) as T;
  if (v && typeof v === 'object') {
    // A key that names a secret means its value is one, whatever it looks like. A paging or sync token
    // (nextPageToken, continuationToken) names a place in a list, not a credential: its value goes through the rules.
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, (SECRET_KEY.test(k) || (/^account[_-]?key$/i.test(k) && !(typeof x === 'string' && /^(?:<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\})$/.test(x))) || (/^auth$/i.test(k) && typeof x === 'string' && encodedCredential(x))) && !CURSOR_KEY.test(k) && typeof x === 'string' && x ? '[REDACTED]'
      : typeof x === 'string' ? redactKeyed(k, x) : redactDeep(x)])) as T;
  }
  return v;
}

/**
 * The version of the contact rules below (redactContact), kept apart from REDACTION_VERSION because they run only on
 * intake text: a transcript, notes or a doc sent to /api/intake, and the claims and questions read from it. Raise it
 * whenever a contact pattern is added, widened or narrowed: the worker then runs redactStoredIntake over stored intake
 * once (worker redactStored.ts). 1: e-mail addresses, phone numbers, URL query tokens.
 */
export const INTAKE_REDACTION_VERSION = 1;

/** An e-mail address: local part, @, a dotted domain ending in letters. Each part is bounded, so it stays linear. */
const EMAIL = /(?<![\w.%+-])[A-Za-z0-9][\w.%+-]{0,63}@(?:[A-Za-z0-9][A-Za-z0-9-]{0,62}\.){1,8}[A-Za-z]{2,24}(?![\w-]|\.[A-Za-z0-9])/g;
/** A URL's query (to the fragment or the end of the URL); a meeting link carries its passcode and ids there. */
const URL_QUERY = /(\bhttps?:\/\/[^\s?#<>"'`()[\]]{1,2048})\?([^\s#<>"'`()[\]]{1,4096})/gi;
/** A query value long enough to be a token or an id rather than a page number or a flag. */
const QUERY_TOKEN = /(?:^|&)[^=&]{1,128}=[^&]{6,}/;
/**
 * A candidate phone number: digits in groups joined by single spaces, dots, dashes or parentheses, 7 to 24 characters,
 * after an optional + or 00. Not inside a word, a number, a path, a version or a time; phoneShape then decides.
 */
const PHONE = /(?<![\w+.\-/:@#$%,])(\+|00(?=[1-9]))?(\(?\d[\d .\-()\u00a0]{5,22}\d)(?![\w\-/@%]|[.,:]\d)/g;
/** Words that say the number after them is a phone number, however it is written. */
const PHONE_WORD = /\b(?:phone|tel|telephone|mobile|cell|cellphone|whats\s?app|fax|sms|text\s+me|call\s+me|reach\s+me|ring\s+me|contact)\b[^\n\d]{0,12}$/i;

function phoneShape(prefix: string | undefined, body: string, before: string): boolean {
  if (/[ .\-()\u00a0]{3,}/.test(body) || /[ .\-\u00a0]{2}/.test(body)) return false;
  const groups = body.split(/[ .\-()\u00a0]+/).filter(Boolean);
  const digits = groups.join('').length;
  if (digits < 7 || digits > 15) return false;
  // Parentheses only around the area code: the first group, or the one after a country code.
  const opens = body.split('(').length - 1;
  if (opens !== body.split(')').length - 1 || opens > 1 || (opens === 1 && !/^(?:\d{1,3}[ .-]?)?\(\d{1,5}\)/.test(body))) return false;
  if (prefix) return digits >= 8 && groups.every((g) => g.length <= 8 || groups.length === 1);
  if (opens === 1) return true;
  // North American: 555-123-4567, 1 555 123 4567.
  if (/^(?:1[ .-])?\d{3}[ .-]\d{3}[ .-]\d{4}$/.test(body)) return true;
  // A national number with its trunk 0: 020 7946 0958, 07700 900123, 06 12 34 56 78.
  if (groups.length >= 2 && /^0\d{1,4}$/.test(groups[0]) && digits >= 9 && digits <= 11 && groups.every((g) => g.length <= 8)) return true;
  // Any other run of digits counts only after a word that says it is a phone number: "call me on 5551234".
  return PHONE_WORD.test(before) && (groups.length === 1 || groups.every((g) => g.length <= 5));
}

/**
 * Contact details in what people said: e-mail addresses become [email], phone numbers [phone], and a URL's query that
 * holds a token or id becomes ?[query] (the host and path stay). Run after redactSecrets, on intake text only: an
 * address in code or a scanned file is not a person's contact (redactIntakeText).
 */
export function redactContact(text: string): string {
  return text
    .replace(URL_QUERY, (all, head: string, query: string) => (QUERY_TOKEN.test(query) ? `${head}?[query]` : all))
    .replace(EMAIL, '[email]')
    .replace(PHONE, (all, prefix: string | undefined, body: string, offset: number, source: string) =>
      (phoneShape(prefix, body, source.slice(Math.max(0, offset - 40), offset)) ? '[phone]' : all));
}

/** Every pattern the contact rules run over text, for the test that holds each to a time budget. */
export const CONTACT_PATTERNS: readonly RegExp[] = [EMAIL, URL_QUERY, PHONE];

/** Intake text as it is stored and sent to a model: credentials first (redactSecrets), then contact details. */
export function redactIntakeText(text: string): string {
  return redactContact(redactSecrets(text));
}

/**
 * A stored intake row (a source's text or chunk, a claim, a question) under the current secret and contact rules, for
 * the worker's re-run: the whole row with its `text` fields run through redactIntakeText. Null when nothing changes,
 * so a store writes only rows that do (redactedChanges says which fields).
 */
export function redactStoredIntake<T extends Record<string, unknown>>(row: T, text: readonly (keyof T)[]): T | null {
  const out: Record<string, unknown> = { ...row };
  let changed = false;
  for (const k of text) {
    const v = row[k];
    if (typeof v !== 'string') continue;
    const r = redactIntakeText(v);
    if (r !== v) { out[k as string] = r; changed = true; }
  }
  return changed ? (out as T) : null;
}
