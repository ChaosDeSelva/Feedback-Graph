import type { AuthorKind, ExternalRef, ExternalSource } from './types.ts';

/**
 * Which GitHub and Linear comments never reach the classifier, and who wrote a comment. Browser-safe (no imports
 * beyond types): the worker applies the rules before the model and the UI lists them, from this one list.
 */

/** A comma list of logins (GITHUB_BOT_LOGINS, GITHUB_AGENT_LOGINS), trimmed and lower-cased. */
export function parseLogins(spec: string | undefined): string[] {
  return (spec ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * A comment an AI agent wrote, by its opening tag: "[claude] ...", "[codex] ...", or a review finding's priority
 * "[P0]".."[P3]", optionally inside markdown emphasis, a quote or <sub> tags.
 */
const AGENT_MARKER = /^(?:\s|[*_`>]|<\/?sub>)*\[(?:claude|codex|p[0-3])\]/i;

/**
 * Who wrote a comment. `verified`: the kind comes from something the author cannot type into the comment: a GitHub
 * login (GitHub's own [bot] suffix, GITHUB_BOT_LOGINS, GITHUB_AGENT_LOGINS). A marker in the text labels a comment
 * agent but is never verified. Linear authors are display names (free text), so only the marker applies there; Linear's
 * own bot signal (botActor) drops a comment at fetch. GitHub accounts of type Bot are dropped at fetch too.
 */
export function authorKindOf(o: { source: ExternalSource; login: string; body: string; botLogins?: string[]; agentLogins?: string[] }): { kind: AuthorKind; verified: boolean } {
  if (o.source === 'github') {
    const login = o.login.trim().toLowerCase();
    if (login.endsWith('[bot]') || o.botLogins?.includes(login)) return { kind: 'bot', verified: true };
    if (o.agentLogins?.includes(login)) return { kind: 'agent', verified: true };
  }
  return AGENT_MARKER.test(o.body) ? { kind: 'agent', verified: false } : { kind: 'human', verified: false };
}

/** One rule: a comment it matches is labelled neutral without asking the model, and the rule's name is recorded. */
export type FeedbackSkipRule = { name: string; description: string; skips(text: string, ext: ExternalRef): boolean };

/**
 * The whole comment is a status note, nothing more, anchored at both ends so "Resolved? No, ..." is not one:
 * - a status word alone ("Done.", "Fixed", "Updated."), or followed by where: a commit sha, a #ref, or "the latest
 *   commit" / "the last push" / "the follow-up commit", optionally after a thank-you ("Good catch, fixed in <sha>");
 * - "Fixed: <what was done>" (one short line), unless it reads as a correction: a question mark or a word such as not,
 *   still, but, wrong, revert, only, should ("Fixed: not really, ..." is kept);
 * - "Closing in favour of #12", "Superseded by #12", "Replaced by #12", "Duplicate of #12";
 * - an acknowledgement of a known tradeoff, "Not applicable after <sha>", "N/A", "Won't fix", a "Closing:" note.
 */
const REF = String.raw`(?:[0-9a-f]{7,40}|#\d+|[\w.-]+(?:/[\w.-]+)?#\d+)`;
const STATUS_WORD = String.raw`(?:fixed|done|addressed|resolved|updated|changed|implemented|applied|handled|removed|reverted)`;
const WHERE = String.raw`(?:${REF}|(?:the |this |that |a )?(?:latest|last|next|new|most recent|follow-?up|same)? ?(?:commit|push|revision|changes?|pr|pull request)(?: ${REF})?)`;
const THANKS = String.raw`(?:(?:thanks|thank you|good catch|nice catch|great catch|good point|ack|ok(?:ay)?|sure|yep|yes)[,!.]?\s+)?`;
const CORRECTION_CUE = String.raw`\b(?:not|no|nope|n't|isn't|doesn't|didn't|still|but|though|however|wrong|revert\w*|broke\w*|break\w*|please|again|why|should|must|instead|forgot\w*|only|yet)\b|n't\b`;
const STATUS_NOTE = new RegExp(
  String.raw`^(?:${THANKS}${STATUS_WORD}(?: (?:in|by|with|via|on) ${WHERE})?` +
    String.raw`|${STATUS_WORD}\s*:\s+(?![^\n]*(?:${CORRECTION_CUE}))[^\n?]{1,160}?` +
    String.raw`|(?:closing|closed) in fav(?:ou|o)r of ${REF}|(?:superseded|replaced) by ${REF}|duplicate of ${REF}` +
    String.raw`|not applicable(?: (?:after|since|with) ${REF})?|acknowledged(?:[,;:]? (?:known|accepted|intended) (?:tradeoff|trade-off|limitation|behaviou?r))?|n\/a|won'?t fix|closing: [^\n]{1,120})[.!]?$`,
  'i',
);
/**
 * Bumped whenever a skip rule changes what it matches: the worker then runs the rules once over the items already
 * pending in the Inbox (worker integrations/pendingSkips.ts), so a better rule also clears what the old one let through.
 */
export const SKIP_RULES_VERSION = 3;
/** "@claude review", "@codex please re-review this", "/review": a request for a review, nothing more. */
const REVIEW_TRIGGER = /^(?:(?:@[\w-]+[\s,]+)+(?:please\s+)?(?:re-?)?review(?:\s+(?:this|again|it))?(?:\s+please)?|\/(?:re-?)?review)[.!]*$/i;

/** The text without an agent's opening tag, so "[claude] Fixed in abc" reads as the status note it is. */
const untagged = (text: string) => text.replace(AGENT_MARKER, '').replace(/^[\s*_:]+/, '').trim();

/**
 * A review that says an AI or a bot wrote it: it opens with 🤖, "Claude Code here", "Automated review", "This is an
 * AI-generated review", or carries a "Generated with Claude Code" footer. Not "[claude]"-tagged findings (authorKindOf):
 * those are an agent's findings someone chose to post, and are classified.
 */
const AI_REVIEW_OPENING = /^(?:\s|[*_#>]|<\/?sub>)*(?:🤖|(?:claude(?: code)?|codex)\s+here\b|(?:this is an?\s+)?(?:automated|ai[- ]generated|ai|bot)\s+(?:code\s+)?review\b|this (?:review|comment) (?:was|is) (?:generated|written|posted) by (?:an? )?(?:ai|bot|claude|codex)\b)/i;
const AI_FOOTER = /🤖\s*generated (?:with|by)\b|\bgenerated (?:with|by) \[?(?:claude code|codex)\b/i;

/** A nit or optional remark, by its marker (isNitComment). "minor" or "optional" inside a sentence is just a word. */
const NIT_MARK = /^\W{0,4}(?:optional\s+)?(?:nit|nitpick|minor|optional|cosmetic|non-blocking)\b|[([*_]{1,2}\s*(?:nit|nitpick|minor|optional|cosmetic)\s*[)\]*_]{1,2}|\bnit:|\bnitpick|\bnon-blocking\b|\bnot a blocker\b/i;
/** A part of an approval that is a nit or optional: left out when asking whether anything is asked to change. */
const NIT_PART = /\b(?:nit|nitpick|minor|optional|non-blocking|not a blocker)\b/i;
/** An approval or praise opening. */
const APPROVAL = /^\W{0,4}(?:lgtm|looks good|looks great|approved?|approving|ship it|great work|nice work|good work|well done|nice|👍|✅)/i;
/** Something asked of the author: a modal, a correction word, a condition, a question. */
const ASKS = /\b(?:but|however|except|although|though|should|must|please|need|needs|fix|change|wrong|bug|broken|missing|instead|once|until|before|todo|why|not|don'?t|isn'?t|doesn'?t|can'?t|won'?t)\b|\?/i;
/** At most this much praise is still a summary; more is a review that says something. */
const APPROVAL_CHARS = 200;

/** An approval with nothing asked to change, once its nits and optional remarks are set aside. */
function approvalOnly(text: string, ext: ExternalRef): boolean {
  const parts = text.split('\n').flatMap((l) => l.split(/(?<=[.!])\s+/)).map((p) => p.trim()).filter(Boolean);
  const rest = parts.filter((p) => !NIT_PART.test(p)).join(' ');
  if (!rest || rest.length > APPROVAL_CHARS || ASKS.test(rest)) return false;
  return APPROVAL.test(rest) || (ext.reviewState === 'APPROVED' && APPROVAL.test(text.trim()));
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/;
const STATUS_CELL = /\b(?:fixed|resolved|addressed|done|open|pending|deferred|wontfix|won'?t fix|not applicable|n\/a|in progress|outdated)\b|(?:[✅❌⏳]|✔️?)/i;

/** A markdown table that relays where earlier findings stand: most of the comment, most rows with a status. */
function statusTable(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim());
  const rows = lines.filter((l) => TABLE_ROW.test(l));
  const data = rows.filter((l) => !TABLE_RULE.test(l)).slice(1);
  return data.length >= 2 && rows.length >= lines.length * 0.6 && data.filter((r) => STATUS_CELL.test(r)).length >= data.length / 2;
}

/** "@sam hold off merging until your branch lands": addressed to someone, about when branches merge, no code in it. */
const MENTIONS = /^\s*(?:@[\w-]+[\s,:]*)+/;
const MERGE_TIMING = /\b(?:rebase[sd]?|rebasing|merge[sd]?|merging|lands?|landed|hold off|wait(?:ing)? (?:for|until|on))\b/i;
const BRANCH_REF = /\b(?:branch|branches|#\d+|pr|pull request|yours|first)\b|#\d+/i;
const BRANCH_TIMING_CHARS = 300;
function branchTiming(text: string): boolean {
  const t = text.trim();
  const m = MENTIONS.exec(t);
  if (!m || t.length > BRANCH_TIMING_CHARS || t.includes('`')) return false;
  const rest = t.slice(m[0].length);
  return MERGE_TIMING.test(rest) && BRANCH_REF.test(rest);
}

/** A nit or optional comment ("nit:", "Minor:", "optional nit:", "**nit**", "(optional)"): never a project-wide lesson. */
export function isNitComment(text: string): boolean {
  return NIT_MARK.test(text.trim());
}

const STOP = new Set(['the', 'and', 'for', 'from', 'with', 'this', 'that', 'these', 'those', 'are', 'was', 'were', 'has', 'have', 'its', 'into', 'two', 'one', 'issues', 'issue', 'also', 'here', 'there', 'some', 'just', 'see', 'inline', 'comments', 'comment']);
const words = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
/** How much of a review summary's words its inline comments must hold for it to be the same content. */
const FOLD_COVERAGE = 0.8;

/**
 * Whether a review's summary says the same as its inline comments (the same reviewer's, on the same pull request): most
 * of its words are theirs. Then it is one item, the inline comments, not two.
 */
export function foldsIntoInline(summary: string, inline: string[]): boolean {
  const mine = words(summary);
  if (mine.size < 4 || !inline.length) return false;
  const theirs = words(inline.join('\n'));
  let held = 0;
  for (const w of mine) if (theirs.has(w)) held++;
  return held / mine.size >= FOLD_COVERAGE;
}

export const FEEDBACK_SKIP_RULES: readonly FeedbackSkipRule[] = [
  {
    name: 'bot-author',
    description: 'Comments by bots: logins ending in [bot] (left out at sync) and the logins listed in GITHUB_BOT_LOGINS.',
    skips: (_text, ext) => ext.authorKind === 'bot',
  },
  {
    name: 'pr-author-reply',
    description: "The pull request author's replies to another reviewer's comment, such as \"Fixed in <sha>\": an answer to the reviewer, not feedback on the work. Replies in a thread the author opened are classified.",
    // Only an answer to someone else: a solo developer reviewing their agent's PR under their own account replies in
    // threads they opened, and that is feedback.
    skips: (_text, ext) => {
      const me = ext.author.toLowerCase();
      return ext.source === 'github' && !!ext.isReply && !!ext.threadAuthor && me === ext.threadAuthor.toLowerCase() && !!ext.repliesTo && ext.repliesTo.toLowerCase() !== me;
    },
  },
  {
    name: 'status-note',
    description: 'A comment that is only a status note ("Fixed in <sha>", "Fixed: <what changed>", "Done.", "Addressed in the latest commit", "Closing in favour of #12", "Superseded by #12", "Acknowledged", "Not applicable after <sha>") by the pull request author or a bot or agent listed by login. One that also says something is wrong ("Fixed? No, ...", "Done. But ...") is classified, as is anyone else\'s.',
    skips: (text, ext) => {
      const own = ext.source === 'github' && !!ext.threadAuthor && ext.author.toLowerCase() === ext.threadAuthor.toLowerCase();
      return (own || !!ext.authorVerified) && STATUS_NOTE.test(untagged(text));
    },
  },
  {
    name: 'review-trigger',
    description: 'Bare requests for an automated review, such as "@claude review" or "@codex review", with nothing else in them.',
    skips: (text) => REVIEW_TRIGGER.test(text.trim()),
  },
  {
    name: 'ai-review',
    description: 'A review that says an AI or a bot wrote it: it opens with 🤖, "Claude Code here" or "Automated review", or ends with a "Generated with Claude Code" footer.',
    skips: (text) => AI_REVIEW_OPENING.test(text) || AI_FOOTER.test(text),
  },
  {
    name: 'approval-summary',
    description: 'An approval with nothing asked to change ("LGTM", "Looks good, nice work"), once remarks marked nit or optional are set aside. One that still asks for something ("LGTM, but ...") is classified.',
    skips: (text, ext) => approvalOnly(text, ext),
  },
  {
    name: 'status-table',
    description: 'A table relaying where earlier review findings stand (fixed, addressed, open), with little else in the comment.',
    skips: (text) => statusTable(text),
  },
  {
    name: 'branch-timing',
    description: 'A comment addressed to someone about when branches merge or rebase ("@sam hold off merging until your branch lands"), with no code in it.',
    skips: (text) => branchTiming(text),
  },
  {
    name: 'review-folded',
    description: "A review's summary that says the same as its inline comments: one item (the inline comments), not two.",
    skips: (_text, ext) => !!ext.foldedInto,
  },
];

/**
 * An AI agent reviewing its own pull request: an agent-written comment posted under the PR author's account (the
 * developer's agent reviewing the agent's PR). Still classified, but labelled self-review rather than a reviewer's
 * pushback, in the Inbox and on the lesson.
 */
export function isSelfReview(ext: ExternalRef): boolean {
  return ext.source === 'github' && ext.authorKind === 'agent' && !!ext.threadAuthor && ext.author.toLowerCase() === ext.threadAuthor.toLowerCase();
}

/** The first rule that skips this comment, or null when it goes to the model. */
export function feedbackSkipRule(text: string, ext: ExternalRef): FeedbackSkipRule | null {
  return FEEDBACK_SKIP_RULES.find((r) => r.skips(text, ext)) ?? null;
}
