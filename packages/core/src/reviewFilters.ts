/** Exact PR and login tokens in transcript-only feedback, without matching #141940 for #14194. */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const reviewPatterns = (pr?: number, author?: string) => ({
  pr: pr ? `(?:#${pr}|(?:^|[^a-z0-9_])(?:PR[ \t#]*${pr}|pull(?: request)?[ /#]*${pr}|pulls?/${pr}))(?:$|[^a-z0-9_])` : null,
  author: author ? `(?:^|[^a-z0-9_-])@?${escape(author)}(?:$|[^a-z0-9_-])` : null,
});
