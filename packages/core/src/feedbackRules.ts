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
 * The whole comment is a status note, nothing more: the phrase alone or followed only by a commit sha or a #ref, an
 * acknowledgement of a known tradeoff, or a "Closing:" note (short). Anchored at both ends, so "Resolved? No, ..." is not.
 */
const REF = String.raw`(?:[0-9a-f]{7,40}|#\d+|[\w.-]+#\d+)`;
const STATUS_NOTE = new RegExp(
  String.raw`^(?:(?:fixed|done|addressed|resolved|updated|changed) (?:in|by|with) ${REF}|not applicable(?: (?:after|since|with) ${REF})?|resolved|acknowledged(?:[,;:]? (?:known|accepted|intended) (?:tradeoff|trade-off|limitation|behaviou?r))?|n\/a|won'?t fix|closing: [^\n]{1,120})[.!]?$`,
  'i',
);
/** "@claude review", "@codex please re-review this", "/review": a request for a review, nothing more. */
const REVIEW_TRIGGER = /^(?:(?:@[\w-]+[\s,]+)+(?:please\s+)?(?:re-?)?review(?:\s+(?:this|again|it))?(?:\s+please)?|\/(?:re-?)?review)[.!]*$/i;

/** The text without an agent's opening tag, so "[claude] Fixed in abc" reads as the status note it is. */
const untagged = (text: string) => text.replace(AGENT_MARKER, '').replace(/^[\s*_:]+/, '').trim();

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
    description: 'A comment that is only a status note ("Fixed in <sha>", "Resolved", "Acknowledged", "Not applicable after <sha>", "Closing: ...") by the pull request author or a bot or agent listed by login. Anyone else\'s is classified as usual.',
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
];

/** The first rule that skips this comment, or null when it goes to the model. */
export function feedbackSkipRule(text: string, ext: ExternalRef): FeedbackSkipRule | null {
  return FEEDBACK_SKIP_RULES.find((r) => r.skips(text, ext)) ?? null;
}
