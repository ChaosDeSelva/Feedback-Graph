import { createHash } from 'node:crypto';
import { authorKindOf, feedbackSkipRule, foldsIntoInline, SKIP_RULES_VERSION, type ActivityStore, type DocsStore, type GraphStore, type PendingExternalItem } from '@fb/core';

/**
 * The skip rules (core feedbackRules.ts) run once more over what is already pending in the Inbox, so a rule change
 * migrates its data: a comment synced while an older rule let it through (or before its author was known) gets the
 * skip it would get today. Each match is rejected by `skip-rules`, with the rule as the reason and the `skip:<rule>`
 * signal on its turn; only items still pending are touched, so your decisions stand. Comments still waiting for the
 * classifier need nothing: the cycle applies the current rules to them.
 */

export type PendingSkipDeps = {
  graph: Pick<GraphStore, 'pendingExternalItems' | 'skipPendingItem'>;
  activity?: Pick<ActivityStore, 'record'>;
  /** GITHUB_BOT_LOGINS and GITHUB_AGENT_LOGINS: applied again, so a login added since the sync counts. */
  botLogins?: string[];
  agentLogins?: string[];
  /** Only this project's items; unset: every project's. */
  projectKey?: string;
  log?: (msg: string, extra?: object) => void;
};

/** Where the rules version last applied to pending items is kept. */
export const SKIP_RULES_CURSOR = 'feedback-skip-rules';
const PAGE = 500;
const MAX_TARGETS = 50;
const MAX_SAMPLES = 5;
const SAMPLE_CHARS = 200;
export const SKIP_DECIDER = 'skip-rules';

/** The rules as they apply now: their version and the login lists (a login added is a rule change too). */
export function skipRulesStamp(o: Pick<PendingSkipDeps, 'botLogins' | 'agentLogins'>): string {
  const logins = `bots=${[...(o.botLogins ?? [])].sort().join(',')};agents=${[...(o.agentLogins ?? [])].sort().join(',')}`;
  return `v${SKIP_RULES_VERSION} ${createHash('sha256').update(logins).digest('hex').slice(0, 12)}`;
}

/** The rule that skips this item today, with its author kind worked out again from the current login lists. */
function ruleFor(i: PendingExternalItem, d: PendingSkipDeps) {
  const a = authorKindOf({ source: i.external.source, login: i.external.author, body: i.text, botLogins: d.botLogins, agentLogins: d.agentLogins });
  return feedbackSkipRule(i.text, { ...i.external, authorKind: a.kind, authorVerified: a.verified });
}

/** How far apart a review's summary and its inline comments are posted (GitHub submits them together). */
const REVIEW_SPAN_MS = 10 * 60_000;

/**
 * Review summaries synced before the sync folded them (feedbackSync prThread): a pending summary whose words are those
 * of the same reviewer's pending inline comments on the same pull request, posted with it. By summary id: the inline
 * comment's turn it folds into.
 */
function foldedSummaries(items: PendingExternalItem[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of items) {
    const e = s.external;
    if (e.source !== 'github' || e.kind !== 'review' || e.foldedInto) continue;
    const at = Date.parse(e.createdAt);
    const inline = items.filter((c) =>
      c.external.kind === 'review_comment' && c.external.thread === e.thread && c.external.author === e.author && !c.external.isReply &&
      Math.abs(Date.parse(c.external.createdAt) - at) <= REVIEW_SPAN_MS);
    if (foldsIntoInline(s.text, inline.map((c) => c.text))) out.set(s.id, inline[0].turnUuid);
  }
  return out;
}

/**
 * Skip every pending synced item a rule matches. `why` says what prompted it (the rules changed, the authors became
 * known). One comments_skipped entry per project, with per-rule counts, so Settings counts these beside the comments
 * skipped at sync.
 */
export async function skipMatchingPending(d: PendingSkipDeps & { why: string }): Promise<{ skipped: number; byProject: Record<string, Record<string, number>> }> {
  const hits = new Map<string, { id: string; rule: string; text: string }[]>();
  // All of them first: a review's summary folds into inline comments that can be on another page.
  const pending: PendingExternalItem[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await d.graph.pendingExternalItems({ limit: PAGE, afterId: after });
    pending.push(...page.filter((i) => !d.projectKey || i.projectKey === d.projectKey));
    if (page.length < PAGE) break;
    after = page[page.length - 1].id;
  }
  const folds = foldedSummaries(pending);
  for (const i of pending) {
    const rule = ruleFor(folds.has(i.id) ? { ...i, external: { ...i.external, foldedInto: folds.get(i.id) } } : i, d);
    if (!rule) continue;
    const note = `skipped by the ${rule.name} rule after it was flagged (skip rules v${SKIP_RULES_VERSION}): ${rule.description}`;
    if (!(await d.graph.skipPendingItem(i.id, { rule: rule.name, note, by: SKIP_DECIDER }))) continue;
    hits.set(i.projectKey, [...(hits.get(i.projectKey) ?? []), { id: i.id, rule: rule.name, text: i.text }]);
  }
  const byProject: Record<string, Record<string, number>> = {};
  let skipped = 0;
  for (const [projectKey, list] of hits) {
    const rules: Record<string, number> = {};
    for (const h of list) rules[h.rule] = (rules[h.rule] ?? 0) + 1;
    byProject[projectKey] = rules;
    skipped += list.length;
    await d.activity?.record({
      kind: 'comments_skipped', actor: SKIP_DECIDER, projectKey,
      subject: `${list.length} pending Inbox item${list.length === 1 ? '' : 's'} skipped: a skip rule matches ${list.length === 1 ? 'it' : 'them'} now`,
      why: `${d.why}; ${Object.entries(rules).map(([r, n]) => `${r}: ${n}`).join(', ')}`,
      details: {
        rules, pending: list.length, rulesVersion: SKIP_RULES_VERSION,
        samples: list.slice(0, MAX_SAMPLES).map((h) => ({ rule: h.rule, turn: h.id, text: h.text.slice(0, SAMPLE_CHARS) })),
      },
      targets: list.slice(0, MAX_TARGETS).map((h) => h.id),
    });
  }
  if (skipped) d.log?.('pending Inbox items skipped by the skip rules', { skipped, byProject });
  return { skipped, byProject };
}

/**
 * At worker start: when the rules (or the login lists) differ from the ones last applied, run them over the pending
 * items and record the new stamp. Returns how many were skipped, or null when the rules have not changed. A failure
 * leaves the old stamp, so the next start tries again.
 */
export async function skipPendingOnRulesChange(d: Omit<PendingSkipDeps, 'projectKey'> & { cursors: Pick<DocsStore, 'getCursor' | 'setCursor'> }): Promise<number | null> {
  const stamp = skipRulesStamp(d);
  const last = await d.cursors.getCursor(SKIP_RULES_CURSOR);
  if (last === stamp) return null;
  const r = await skipMatchingPending({ ...d, why: last ? `the skip rules changed (${last} to ${stamp})` : `the skip rules (${stamp}) had not been run over the Inbox yet` });
  await d.cursors.setCursor(SKIP_RULES_CURSOR, stamp);
  return r.skipped;
}
