// The instruction files (CLAUDE.md, AGENTS.md, memory notes) a transcript shows its agent had, so a post-mortem judges
// what the agent loaded from the session itself, not from which agent it was. Paths are as the transcript has them
// (the developer's machine).

/** An instruction file or a Claude Code memory note. */
export const INSTRUCTION_FILE = /(?:^|\/)(?:CLAUDE|AGENTS)(?:\.local)?\.md$|\/memory\/[^/]+\.md$/;

/** Claude Code puts a file's contents in the context under this line (CLAUDE.md, its @-imports, memory). */
const CONTENTS_OF = /Contents of (\/[^\n]*?\.md) \(/g;

type Obj = Record<string, unknown>;

/** Every string under `path`, `filePath`, `filename` or `file_path` in an attachment, however deep. */
function attachedPaths(v: unknown, out: string[], depth = 0) {
  if (!v || typeof v !== 'object' || depth > 4) return;
  for (const [k, x] of Object.entries(v as Obj)) {
    if (typeof x === 'string' && /^(path|filePath|filename|file_path)$/.test(k)) out.push(x);
    else if (typeof x === 'object') attachedPaths(x, out, depth + 1);
  }
}

function texts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.map((p) => (p && typeof p === 'object' && typeof (p as Obj).text === 'string' ? ((p as Obj).text as string) : '')).filter(Boolean);
}

const once = (xs: string[]) => [...new Set(xs)];

/**
 * One Claude Code transcript record: an attachment that names an instruction file (an @-import, a nested CLAUDE.md or
 * AGENTS.md read on the way, a file the developer mentioned), or a reminder holding one's contents.
 */
export function claudeInstructionFiles(rec: Obj): string[] {
  const out: string[] = [];
  if (rec.type === 'attachment') attachedPaths(rec.attachment, out);
  if (rec.type === 'user' || rec.type === 'system') {
    for (const t of texts((rec.message as Obj | undefined)?.content ?? rec.content)) for (const m of t.matchAll(CONTENTS_OF)) out.push(m[1]);
  }
  return once(out.filter((p) => INSTRUCTION_FILE.test(p)));
}

/** Codex: the AGENTS.md part of its instructions names the folder they are for (it holds AGENTS.md from there up). */
export function codexInstructionFiles(text: string): string[] {
  const m = /^# AGENTS\.md instructions for ([^\n]+)/.exec(text.trimStart());
  return m ? [`${m[1].trim().replace(/\/+$/, '')}/AGENTS.md`] : [];
}

/** Adds what a record showed to a session's list, once each, in the order first seen. */
export function addInstructionFiles(list: string[], found: string[]) {
  for (const f of found) if (!list.includes(f)) list.push(f);
}
