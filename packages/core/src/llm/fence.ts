/**
 * Untrusted text in a prompt (an upload, a transcript, a side of a conflict), fenced as data. Like the Ask pack's
 * fences: a line of the text starting with --- or === is quoted, so it cannot close ours.
 */
export const defuse = (s: string) => s.replace(/^(\s*)(===|---)/gm, '$1> $2');
/** A label or title on one line of at most 200 characters, defused. */
export const oneLine = (s: string) => defuse(s.replace(/\s+/g, ' ').trim()).slice(0, 200);
export const fenced = (label: string, text: string) => `--- begin untrusted document ${oneLine(label)} ---\n${defuse(text)}\n--- end of untrusted document ---`;
