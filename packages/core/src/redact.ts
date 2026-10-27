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
 */
export const REDACTION_VERSION = 6;
/** Rows a store reads per page when it redacts stored text again under new rules. */
export const REDACT_PAGE = 1000;

/**
 * The end of a name that holds a secret, in any casing and with any separators: DB_PASSWORD, apiKey, client-secret,
 * AWS_SECRET_ACCESS_KEY, secret_key_base. The name must END with it, so TOKEN_URL, tokenizer and passwordHash do not.
 */
const SECRET_NAME = String.raw`(?:secret|token|password|passwd|passphrase|pass[_-]?code|api[_-]?key|apikey|private[_-]?key|access[_-]?key|signing[_-]?key|encryption[_-]?key|credentials?)(?:[_-]?key(?:[_-]?base)?)?`;
/** Names whose "token" is a place in a list or a sync, not a credential: nextPageToken, continuation_token, syncToken. */
const CURSOR = String.raw`(?:next|prev(?:ious)?|page|next[_-]?page|prev[_-]?page|continuation|sync|cursor|resume|start|end|change|delta|marker|pagination)[_-]?token`;
/** A JSON key that is such a name. */
const CURSOR_KEY = new RegExp(`^${CURSOR}$`, 'i');
/** The kept part of a context rule's match (name, separator, opening quote) when the name is such a name. */
const CURSOR_NAMED = new RegExp(String.raw`(?<![A-Za-z])${CURSOR}["']?\s*(?::=|=|:)?\s*["'\x60]?$`, 'i');
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
 * A value with slashes after a secret name: base64 secrets hold "/" and "+" (an AWS secret access key does). It is one
 * when it mixes upper and lower case and digits, is 16+ characters, and is not a path: no leading / . ~, no file
 * extension, and not made of plain words (src/Components/Button2, secrets/prod/db-password2 stay).
 */
function slashedSecret(v: string): boolean {
  if (!/[/\\]/.test(v) || URL_START.test(v) || /^[./~\\]/.test(v) || /\.[a-z][a-z0-9]{0,4}$/i.test(v)) return false;
  if (v.length < 16 || !/[A-Z]/.test(v) || !/[a-z]/.test(v) || !/\d/.test(v)) return false;
  return !v.split(/[/\\]/).every((seg) => /^[A-Za-z][a-z]*\d*$/.test(seg) || IDENT.test(seg));
}

/** An unquoted value after a secret name: one that looks like a secret, slashes and all. */
const namedSecret = (v: string) => looksLikeSecret(v) || slashedSecret(v);

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
  /\b(?:gsk_|pypi-|whsec_|lin_oauth_|GOCSPX-|xapp-)[A-Za-z0-9_-]{16,}/g,
  /\b(Basic\s+)[A-Za-z0-9+/]{8,}={0,2}/gi,
  /\b(AccountKey\s*=\s*)[^;\s"']{16,}/gi,
  /("auth"\s*:\s*")[A-Za-z0-9+/]{8,}={0,2}(?=")/g,
  // .pgpass records: host:port:database:user:password; escaped colons stay within a field.
  /^((?:[^:\r\n\\]|\\.)+:(?:\d+|\*):(?:[^:\r\n\\]|\\.)+:(?:[^:\r\n\\]|\\.)+:)[^\r\n]+/gm,
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
  // The head of a token cut at a length cap (an Activity subject before v5 was cut before it was redacted): a known
  // token prefix running into the cut's ellipsis at the end of the text. The ellipsis stays.
  /\b(?:(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|hf|npm|lin_api|fgc_pat|[sr]k_(?:live|test))_|sk-|xox[abprs]-|AKIA|ASIA|ya29\.|AIza|eyJ)[A-Za-z0-9_.-]{4,}(?=…$)/g,
  // user:password@ in a URL; the user name stays. A ${VAR} in its place is a reference, not a secret.
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)(?!\$\{)[^\s@/]+(?=@)/gi,
  // A webhook URL is its own secret: the host and kind stay, the path that grants access goes.
  /\b(https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9_/-]{8,}/g,
  /\b(https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/)\d+\/[A-Za-z0-9_-]{20,}/g,
  // A secret in a URL's query or fragment: ?token=, &api_key=, &sig=, #access_token=. Only values of 8+ characters with
  // a digit, a capital or an escape in them; a ${VAR}, {{template}} or <placeholder> stays, and so does ?key=name.
  /([?&#](?:[\w-]*[_-])?(?:token|api_?key|key|sig|signature|secret|password|passwd|pwd|X-Amz-Signature|X-Amz-Credential|X-Goog-Signature)=)(?![$<{])(?=[^\s&#"'<>\x60]*[0-9A-Z%])[^\s&#"'<>\x60]{8,}/gi,
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
  // A command-line flag and its whole value, up to the next space: --token …, --password=…, -password … . A shell
  // passes trailing punctuation as part of the value, so all of Secret123! goes; the check reads it without that.
  {
    re: new RegExp(String.raw`(?<keep>(?:^|\s)--?[\w-]*?(?:${SECRET_NAME}|pwd?)(?:=|\s+))(?<v>(?![$<{%~&*!/.\-])[^\s"'\x60]{6,})`, 'gi'),
    check: (v) => namedSecret(v.replace(/[!?.,;:)]+$/, '')),
  },
  { re: new RegExp(String.raw`(?<keep>(?<nq>["']?)${NAME_START}(?:${SECRET_NAME}|pwd?)\k<nq>\s*(?::=|:|=(?![=>~]))\s*)(?<v>${UNQUOTED_SECRET})`, 'gi'), check: namedSecret },
  // Prose: "the admin password is hunter2", "the api key was 'x9...'", "token = …", with up to six words between
  // ("the admin password for the system is …", "our DB password, by the way, is …"). Only a credential word counts: a
  // bare "key" (primary, cache, sort, map, config key) never does, and the value must look like a secret.
  {
    re: new RegExp(String.raw`(?<keep>\b(?:password|passwd|passphrase|pwd|pw|secret|token|credentials?|(?:api|access|private|secret)[ _-]?key)(?:[ \t,]+(?!(?:is|was|are)\b)[\w'-]+){0,6}?,?\s+(?:is|was|are|=)\s+(?:set\s+to\s+|now\s+)?["'“]?)(?<v>${UNQUOTED_SECRET})`, 'gi'),
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
      // "nextPageToken": "page-2" names a place in a list, not a credential.
      if (CURSOR_NAMED.test(g.keep)) return m;
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

const SECRET_KEY =/^(.*[_-])?(secret|token|password|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)$|(Secret|Token|Password|ApiKey|AccessKey|PrivateKey|Credentials?)$/i;

/** Redact every string inside a value (objects, arrays); numbers such as embeddings pass through untouched. */
export function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redactSecrets(v) as T;
  if (Array.isArray(v)) return (typeof v[0] === 'number' ? v : v.map(redactDeep)) as T;
  if (v && typeof v === 'object') {
    // A key that names a secret means its value is one, whatever it looks like. A paging or sync token
    // (nextPageToken, continuationToken) names a place in a list, not a credential: its value goes through the rules.
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, (SECRET_KEY.test(k) || /^(?:auth|account[_-]?key)$/i.test(k)) && !CURSOR_KEY.test(k) && typeof x === 'string' && x ? '[REDACTED]' : redactDeep(x)])) as T;
  }
  return v;
}
