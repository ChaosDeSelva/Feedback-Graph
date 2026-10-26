// What standing context (CLAUDE.md, AGENTS.md, memory) a session's agent had, judged from the session, and the check
// that refuses a post-mortem cause the evidence contradicts ("the agent does not load AGENTS.md" when the transcript
// attached it).
import type { Cause, LessonCheck, PostMortemInput } from '@fb/core';
import { INSTRUCTION_FILE } from '../ingest/instructions.ts';

type StandingKind = 'claude_md' | 'agents_md' | 'memory';
type Doc = { kind: StandingKind; ref: string; loaded: boolean };

const LABEL: Record<'claude_md' | 'agents_md', string> = { claude_md: 'CLAUDE.md', agents_md: 'AGENTS.md' };
const NAMES: Record<'claude_md' | 'agents_md', RegExp> = { claude_md: /\bCLAUDE(?:\.local)?\.md\b/i, agents_md: /\bAGENTS\.md\b/i };

/**
 * A negation, then within three words a verb of having it: "does not load", "didn't read the", "was not loaded",
 * "never loads", "is not in its context", "without reading".
 */
const NOT_LOADED = /(?:\bnot\b|\bnever\b|\bwithout\b|n't\b)(?:\s+\w+){0,3}?\s+(?:load\w*|read\w*|see|sees|seen|saw|ha(?:ve|s|d)|receiv\w*|available|in\s+(?:its|the(?:\s+agent's)?)\s+context)\b/i;

const sentences = (text: string) => text.split(/(?<=[.!?;])\s+/).filter(Boolean);

/** The instruction-file kinds a sentence of this text says the agent did not load or could not see. */
export function claimsNotLoaded(text: string): ('claude_md' | 'agents_md')[] {
  const out = new Set<'claude_md' | 'agents_md'>();
  for (const s of sentences(text)) {
    if (!NOT_LOADED.test(s)) continue;
    for (const k of ['claude_md', 'agents_md'] as const) if (NAMES[k].test(s)) out.add(k);
  }
  return [...out];
}

/**
 * The files the session shows its agent had: the instruction files its transcript recorded (null: not recorded), and
 * the instruction files it read or edited before the feedback (for a comment: in the session that did the work).
 */
export function sessionEvidence(input: PostMortemInput, instructionFiles: string[] | null): string[] {
  const turns = input.feedback.external ? (input.work?.turns ?? []) : [...input.turns.filter((t) => t.index < input.feedback.index), input.feedback];
  const read = turns.flatMap((t) => t.precedingToolCalls).map((c) => c.filePath).filter((p): p is string => !!p && INSTRUCTION_FILE.test(p));
  return [...new Set([...(instructionFiles ?? []), ...read])];
}

type Correctable = { cause: Cause; missed: string; causeExplanation: string };

/**
 * Refuses a cause that contradicts the evidence: a sentence saying the agent did not load CLAUDE.md or AGENTS.md when
 * the standing context shows one was loaded is dropped and replaced by what the evidence says, and context_missing
 * becomes context_available_ignored (it was there, and not followed). `flag` says what changed (null: nothing).
 */
export function correctStandingClaims<T extends Correctable>(pm: T, standing: Doc[]): T & { flag: LessonCheck | null } {
  const wrong = claimsNotLoaded(`${pm.causeExplanation}\n${pm.missed}`)
    .map((kind) => ({ kind, doc: standing.find((d) => d.kind === kind && d.loaded) }))
    .filter((x): x is { kind: 'claude_md' | 'agents_md'; doc: Doc } => !!x.doc);
  if (!wrong.length) return { ...pm, flag: null };
  const cause: Cause = pm.cause === 'context_missing' ? 'context_available_ignored' : pm.cause;
  const ignored = cause === 'context_available_ignored';
  const keep = (text: string) =>
    sentences(text).filter((s) => !(NOT_LOADED.test(s) && wrong.some((w) => NAMES[w.kind].test(s)))).join(' ');
  const said = wrong.map((w) => `${LABEL[w.kind]} was in the agent's context in this session (${w.doc.ref})${ignored ? ', so it was available and not followed' : ''}.`);
  const missed = keep(pm.missed) || pm.missed;
  const causeExplanation = [...said, keep(pm.causeExplanation)].filter(Boolean).join(' ');
  const names = wrong.map((w) => LABEL[w.kind]).join(' and ');
  const refs = wrong.map((w) => w.doc.ref).join(', ');
  const why = `the post-mortem said ${names} was not loaded, but the session had it (${refs}); ${cause !== pm.cause ? `cause ${pm.cause} changed to ${cause}` : 'the claim was dropped'}`;
  return { ...pm, cause, missed, causeExplanation, flag: { name: 'contradicts-evidence', why } };
}

/**
 * Whether an instruction file the standing context holds (`ref`, as the worker sees it) is one the session's evidence
 * names (as the developer's machine names it): the same path, the same path under a root's host side, or the same path
 * below the project root (`rel`, at least a folder and the file, so the root's own AGENTS.md is not every AGENTS.md).
 */
export function evidenced(ref: string, rel: string | null, evidence: string[], roots: { host: string; container: string }[] = []): boolean {
  const host = roots.flatMap((r) => (ref.startsWith(`${r.container}/`) ? [`${r.host}${ref.slice(r.container.length)}`] : []));
  return evidence.some((e) => e === ref || host.includes(e) || (!!rel && rel.includes('/') && e.endsWith(`/${rel}`)));
}

const IMPORT = /(?:^|\s)@((?:\.{1,2}\/|\/)?[\w.\-/]+\.md)\b/gm;

/** The files a CLAUDE.md imports (`@AGENTS.md`, `@./docs/rules.md`), resolved against its folder; `~` paths are skipped. */
export function imports(text: string, dir: string, resolvePath: (dir: string, p: string) => string): string[] {
  return [...text.matchAll(IMPORT)].map((m) => resolvePath(dir, m[1]));
}
