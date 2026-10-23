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
  /\bwhy (is|are|did|does|do|would|isn'?t|didn'?t|doesn'?t|the)\b/i,
  /\byou were supposed? to\b/i,
  /\bI (don'?t|do not) like\b|\b(sucks|lame)\b/i,
  /\b(wtf|wth|ffs)\b|\bf+u+c+k/i,
  /^\s*(no|nope|stop)\b/i,
  /\b(is|are) (this|it|that|all (of )?(this|it))\b[^?]{0,40}\b(done|finished|complete|ready)\b/i,
];

export function prefilterPushback(text: string): { hit: boolean; signals: string[] } {
  const signals = PUSHBACK.map((re) => text.match(re)?.[0]).filter((m): m is string => !!m);
  return { hit: signals.length > 0, signals };
}
