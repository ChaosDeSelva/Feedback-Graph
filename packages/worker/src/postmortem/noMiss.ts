/**
 * A post-mortem whose own miss says there was none: "the agent did not miss any defects", "nothing was missed", "the
 * agent did not receive the feedback". Most came from a comment matched to the wrong session, or from a comment that
 * was no pushback: whatever lesson it wrote is invented, so it yields no lesson (postmortem/step.ts). A miss that only
 * mentions "no error handling" or "missing" is a miss.
 */
const NO_MISS = [
  /\b(?:claim|feedback|pushback|allegation|report) (?:is|was|proved|turned out to be) (?:incorrect|wrong|false|unfounded|invalid)\b/i,
  /\b(?:correctly|rightly) (?:disputed|rejected|challenged|pushed back)\b/i,
  /\b(?:did not|didn'?t|does not|doesn'?t) (?:actually |really )?miss (?:anything|any\b|a thing)/i,
  /\bnothing (?:was |has been |is )?(?:actually |really )?missed\b/i,
  /^\W*no (?:actual |real )?miss(?:es)?\b/i,
  /\b(?:there (?:was|is|were)|with|found|had) no (?:actual |real )?(?:miss(?:es)?|defects?|bugs?|mistakes?)\b(?! (?:in|of) (?:handling|the error))/i,
  /\bno (?:actual |real )?(?:defects?|bugs?|mistakes?) (?:was |were )?(?:missed|made|introduced|found)\b/i,
  /\bnot (?:actually |really )?a miss\b/i,
  /\b(?:did not|didn'?t|never) (?:receive|see|get) (?:the|this|that|any) (?:feedback|comment|review)\b/i,
];

/** The text that says there was no miss, or null. */
export function saysNoMiss(pm: { missed: string; causeExplanation: string }): string | null {
  for (const text of [pm.missed ?? '', pm.causeExplanation ?? '']) {
    const m = NO_MISS.map((re) => re.exec(text)).find(Boolean);
    if (m) return text;
  }
  return null;
}
