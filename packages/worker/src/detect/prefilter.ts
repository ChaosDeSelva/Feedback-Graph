/**
 * Cheap gate in front of the local model. Tuned on real Claude Code sessions:
 * pushback there is terse, often all-caps, and frequently doubts "done".
 */
const PUSHBACK: RegExp[] = [
  /\b(not|isn'?t|aren'?t) good enough\b/i,
  /\b(you )?(missed|forgot|skipped|ignored)\b/i,
  /\byou (didn'?t|did not|never|keep|still)\b/i,
  /\bI (told|asked|said) you\b|\bI told\b/i,
  /\b(that'?s|this is|it'?s) not what I\b|\bnot what I (asked|wanted|meant|said)\b/i,
  /\b(wrong|incorrect)\b/i,
  /\b(broken|broke|buggy)\b/i,
  /\b(doesn'?t|does not|isn'?t|is not|not) work(ing)?\b/i,
  /\bstill (broken|see|seeing|there|has|shows?|showing|getting|not|fails?|failing|wrong)\b/i,
  /\bnot (seeing|showing|loading|rendering|visible)\b/i,
  /\b(redo|re-do|revert|undo|try again|start over)\b/i,
  /\b(looks?|is|seems?) (bad|off|weird|wrong|ugly|broken|boring|terrible|awful)\b/i,
  /\bcut off\b|\bway too\b|\btoo (big|small|large|tiny|fast|slow|much|dark|light)\b/i,
  /\bshould (match|be|have|not|still)\b/i,
  /\bwhy (did|didn'?t|isn'?t|doesn'?t)\b/i,
  /\byou were supposed? to\b/i,
  /\bI (don'?t|do not) like\b|\b(sucks|lame)\b/i,
  /\bf+u+c+k/i,
  /^\s*(no|nope|stop)\b/i,
  /\b(is|are) (this|it|that|all (of )?(this|it))\b[^?]{0,40}\b(done|finished|complete|ready)\b/i,
];

/**
 * Signals that are as often a question, a bug report or a developer explaining themselves as pushback: they count
 * only in a short message that is not mostly something pasted (an error, a log).
 */
const WEAK: RegExp[] = [/\bwhy (is|are|the|does|do|would)\b/i, /\b(wtf|wth|ffs)\b/i];
/** Prose longer than this is an explanation, not a terse complaint: a weak signal alone does not flag it. */
const WEAK_MAX_PROSE = 300;

/** A line that is pasted output, not typed prose: a stack frame, an error or log line, a request line, JSON. */
const PASTED_LINE = [
  /^\s*at\s+\S.*[:(]\d+/,
  /^\s*(?:[A-Z]\w*(?:Error|Exception)|Error|Traceback|Caused by|FATAL|ERROR|WARN(?:ING)?|panic)\b[:\s]/,
  /^\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S*/,
  /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,
  /^\s*[{[]\s*"/,
  /^\s*File "[^"]+", line \d+/,
];

/** The message split into what the developer typed and what they pasted (fenced or indented code, quotes, logs). */
export function splitPasted(text: string): { prose: string; pasted: string } {
  const prose: string[] = [];
  const pasted: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const isPaste = fenced || /^(?: {4}|\t)/.test(line) || /^\s*>/.test(line) || PASTED_LINE.some((re) => re.test(line));
    (isPaste ? pasted : prose).push(line);
  }
  return { prose: prose.join('\n').trim(), pasted: pasted.join('\n').trim() };
}

const matches = (res: RegExp[], text: string) => res.map((re) => text.match(re)?.[0]).filter((m): m is string => !!m);

export function prefilterPushback(text: string): { hit: boolean; signals: string[] } {
  const { prose, pasted } = splitPasted(text);
  const strong = matches(PUSHBACK, prose);
  const weakCounts = prose.length <= WEAK_MAX_PROSE && pasted.length <= prose.length;
  const signals = [...strong, ...(strong.length || weakCounts ? matches(WEAK, prose) : [])];
  return { hit: signals.length > 0, signals };
}
