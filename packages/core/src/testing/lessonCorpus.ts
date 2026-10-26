import type { Lesson } from '../types.ts';

/**
 * A realistic set of approved lessons for an acme monorepo (an auth service, a billing service, a React SPA and a data
 * pipeline), and tasks against it, to test which lessons are served for a task. Shared by the unit tests and by the
 * calibration run against a real embedding model.
 */
const lesson = (id: string, title: string, rule: string, appliesWhen: string, paths: string[] = [], projectKey: string | null = 'acme'): Lesson => ({
  id, projectKey, origin: 'acme', title, rule, appliesWhen, scope: projectKey ? 'project' : 'global', paths, status: 'approved',
  source: 'postmortem', cause: 'requirement_unstated', missId: null, createdAt: '2026-10-01T00:00:00Z', decidedAt: '2026-10-02T00:00:00Z',
});

export const ACME_LESSONS: Lesson[] = [
  // services/auth
  lesson('auth-refresh', 'Rotate refresh tokens on every use', 'When a refresh token is exchanged, issue a new one and revoke the old one in the same transaction; reuse of a revoked token logs the whole session family out.', 'changing token refresh or session renewal', ['services/auth/src/tokens/refresh.ts']),
  lesson('auth-jwt-clock', 'Allow 30 seconds of clock skew when verifying JWTs', 'Pass clockTolerance: 30 to jwt.verify; the mobile clients drift and a strict check logs people out at random.', 'verifying or issuing JWTs', ['services/auth/src/tokens/verify.ts']),
  lesson('auth-password-hash', 'Hash passwords with argon2id through the shared helper', 'Call hashPassword from services/auth/src/crypto.ts; never bcrypt directly, never a new cost parameter without the security review.', 'storing or checking passwords', ['services/auth/src/crypto.ts']),
  lesson('auth-oauth-state', 'Validate the OAuth state parameter before exchanging the code', 'The callback must compare state with the signed cookie before calling the provider; a missing check was a login CSRF.', 'adding or changing an OAuth or SSO login provider', ['services/auth/src/oauth/']),
  lesson('auth-rate-limit', 'Login attempts are rate limited per account and per IP', 'Use the loginLimiter middleware on any route that checks a password or a one-time code; both keys, never just the IP.', 'adding a login, password reset or MFA endpoint', ['services/auth/src/routes/']),
  lesson('auth-mfa-recovery', 'Recovery codes are single use and hashed', 'Store MFA recovery codes hashed, mark one used in the same query that checks it, and show them to the user once.', 'changing two-factor authentication or recovery codes'),
  lesson('auth-session-cookie', 'Session cookies are HttpOnly, Secure and SameSite=Lax', 'Set the session cookie through setSessionCookie only; a cookie set by hand once shipped without Secure.', 'setting or changing cookies in the auth service', ['services/auth/src/session/cookie.ts']),
  // services/billing
  lesson('billing-webhook-idem', 'Stripe webhooks are idempotent by event id', 'Record the event id in processed_events before acting on it and skip any id already there; Stripe retries deliveries.', 'handling a Stripe webhook event', ['services/billing/src/webhooks/']),
  lesson('billing-cents', 'Money is integer cents, never floats', 'Amounts are stored and computed as integer cents with the currency beside them; format only at the edge with formatMoney.', 'computing prices, invoices, refunds or totals', ['services/billing/src/money.ts']),
  lesson('billing-proration', 'Proration goes through the subscription preview', 'Mid-cycle plan changes call previewProration first and show the customer the amount; never compute proration by hand.', 'upgrading or downgrading a subscription plan mid-cycle'),
  lesson('billing-tax', 'Tax is computed by the tax provider at invoice time', 'Do not store tax rates in the database; ask the tax provider when the invoice is finalised, with the customer address.', 'changing invoices, checkout or tax'),
  lesson('billing-refund-ledger', 'Refunds write a ledger entry first', 'Every refund inserts a negative ledger entry before calling Stripe, so a failed call can be reconciled by the nightly job.', 'issuing refunds or credits', ['services/billing/src/refunds.ts']),
  lesson('billing-dunning', 'Failed payments go to dunning, not straight to cancellation', 'A failed renewal moves the subscription to past_due and starts the dunning schedule; only dunning may cancel.', 'handling failed payments or subscription cancellation'),
  lesson('billing-currency', 'Never convert currencies in the billing service', 'A customer is billed in the currency of their price; conversion happens only in reporting, with the daily rate snapshot.', 'adding a currency or a price in another currency'),
  // web (React SPA)
  lesson('web-query-keys', 'React Query keys come from the queryKeys factory', 'Build every key with queryKeys.* in web/src/api/keys.ts so invalidation after a mutation hits every list that shows the record.', 'adding a query or mutation in the web app', ['web/src/api/keys.ts']),
  lesson('web-forms', 'Forms use react-hook-form with the zod schema from the API package', 'Import the schema from @acme/api-schema and pass zodResolver; hand-written validation drifted from the server twice.', 'adding or changing a form in the web app', ['web/src/forms/']),
  lesson('web-i18n', 'Every user-facing string goes through t()', 'Add the key to web/src/locales/en.json and use t(); the German and French builds fail on a raw string.', 'adding text to a screen in the web app', ['web/src/locales/']),
  lesson('web-a11y-dialog', 'Dialogs use the shared Modal with focus trap', 'Open dialogs with <Modal> from web/src/ui/Modal.tsx; it traps focus and restores it, which hand-rolled dialogs forgot.', 'adding a dialog, modal or popover', ['web/src/ui/Modal.tsx']),
  lesson('web-routes-lazy', 'Route screens are lazy loaded', 'Register a new screen with lazy() in web/src/routes.tsx; importing it directly put 400 kB back in the first bundle.', 'adding a route or screen to the web app', ['web/src/routes.tsx']),
  lesson('web-tables', 'Tables use the DataTable with server-side sorting', 'Large tables use <DataTable> with sort and page sent to the API; sorting in the browser broke on the invoices table at 10k rows.', 'adding or changing a table in the web app', ['web/src/ui/DataTable.tsx']),
  lesson('web-feature-flags', 'Feature flags are read through useFlag', 'Read flags with useFlag so they update without a reload; a flag read once at startup kept users on the old checkout.', 'putting a web feature behind a flag'),
  lesson('web-dates', 'Dates are shown in the account time zone with formatDate', 'Use formatDate(value, account.timeZone); new Date().toLocaleString showed reports a day off for customers in Asia.', 'displaying dates or date ranges in the web app', ['web/src/lib/dates.ts']),
  // pipeline
  lesson('pipe-idempotent', 'Pipeline jobs are idempotent per partition', 'A job writes its day partition with INSERT OVERWRITE so a rerun replaces it; appends doubled the events after a retry.', 'writing or changing a pipeline job', ['pipeline/jobs/']),
  lesson('pipe-backfill', 'Backfills run through the backfill command with a date range', 'Use pipeline backfill --from --to; it throttles to 4 partitions at a time so the warehouse is not saturated.', 'backfilling or reprocessing historical data', ['pipeline/cli/backfill.py']),
  lesson('pipe-schema', 'Event schema changes are additive only', 'Add new optional columns to the events schema; never rename or drop one, the downstream dashboards read it by name.', 'changing the events schema or a warehouse table', ['pipeline/schemas/events.avsc']),
  lesson('pipe-pii', 'Personal data is hashed before it lands in the warehouse', 'Email and IP columns pass through the pii_hash transform in the ingest step; raw values must never reach the warehouse.', 'ingesting a new source or adding columns with personal data', ['pipeline/transforms/pii.py']),
  lesson('pipe-late-events', 'Late events are accepted for 3 days', 'The sessionization job reads a 3 day lookback window; shortening it dropped mobile events sent after reconnecting.', 'changing sessionization or event lateness windows'),
  lesson('pipe-dbt-tests', 'Every dbt model has unique and not_null tests on its key', 'Add the tests in the model yml; a duplicated key in fct_orders went unnoticed for a week without them.', 'adding or changing a dbt model', ['pipeline/dbt/models/']),
  // Global lessons (learned in acme, served everywhere).
  lesson('g-secrets-logs', 'Never write credentials to logs', 'Redact tokens, passwords and API keys before logging a request or an error.', 'adding logging', [], null),
  lesson('g-migrations', 'Migrations are backward compatible with the running version', 'Add columns nullable and backfill later; a deploy runs old code against the new schema for a few minutes.', 'writing a database migration', [], null),
];

/** Tasks, with the lessons that apply to each (by id). A nonsense task applies none. */
export const ACME_TASKS: { task: string; files?: string[]; applies: string[] }[] = [
  { task: 'make the purple elephant sing opera on tuesdays', applies: [] },
  { task: 'reorganise the bookshelf by colour and plant some tulips', applies: [] },
  { task: 'rotate the refresh token when a session is renewed', applies: ['auth-refresh'] },
  { task: 'add Google as an OAuth login provider', applies: ['auth-oauth-state'] },
  { task: 'let customers upgrade their plan mid-cycle with proration', applies: ['billing-proration'] },
  { task: 'handle the invoice.payment_failed Stripe webhook', applies: ['billing-webhook-idem', 'billing-dunning'] },
  { task: 'add a loading skeleton and sorting to the invoices table in the web app', applies: ['web-tables'] },
  { task: 'add a confirmation dialog before deleting a project', applies: ['web-a11y-dialog'] },
  { task: 'backfill the events table for last month', applies: ['pipe-backfill'] },
  { task: 'the reports page shows the date range a day off for customers in Tokyo', applies: ['web-dates'] },
];

/** A task naming a file a lesson is tied to: that lesson is served whatever the similarity. */
export const PATH_TASK = { task: 'tidy up the error messages', files: ['services/billing/src/webhooks/stripe.ts'], tied: 'billing-webhook-idem' };

const DIMS = 4096;
/** How much of every vector is one shared direction: two texts with no word in common score about this (as on nomic-embed-text, ~0.4-0.6). */
const SHARED = 0.5;
const WORD = /[a-z][a-z0-9]+/g;
const SKIP = new Set('the and for with when not but are any its one all from that this into than then them they before after every never only same by to of in on a an is or be at as it'.split(' '));

/**
 * A deterministic stand-in for an embedding model in tests: the words of a text, each in a bucket, plus one direction
 * every text shares, normalised. Unrelated texts score about SHARED, as on a real model where an absolute floor of 0.3
 * keeps everything; texts sharing words score higher.
 */
export function wordEmbed(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  const words = (text.toLowerCase().match(WORD) ?? []).filter((w) => !SKIP.has(w)).map((w) => (w.length > 5 ? w.slice(0, 6) : w));
  for (const w of words) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
    v[1 + ((h >>> 0) % (DIMS - 1))] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  const out = v.map((x) => (x / norm) * Math.sqrt(1 - SHARED));
  out[0] = Math.sqrt(SHARED);
  return out;
}

export const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));

/** What a search for `task` returns from ACME_LESSONS with wordEmbed, best first (k of them), as the stores do. */
export function searchAcme(task: string, k = ACME_LESSONS.length) {
  const q = wordEmbed(task);
  return ACME_LESSONS.map((lesson) => ({ lesson, score: cosine(q, wordEmbed(`${lesson.title}\n${lesson.rule}\nApplies when: ${lesson.appliesWhen}`)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
