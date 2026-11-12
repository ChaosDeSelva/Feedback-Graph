import { aliasNorm, holdsCredential, instructsAgent, normalizeForQuote, validateQuote, type ClaimFlag, type ClaimScope, type ClaimType, type QuestionKind, type Utterance } from '@fb/core';
import { junkPathReason } from '../postmortem/paths.ts';
import { plainText, riskyInstructions } from '../postmortem/lessonCheck.ts';

/**
 * The deterministic half of intake extraction: windows of whole utterances, speaker handles in place of names, and
 * the checks every claim and question the model returns must pass before anything is stored. Pure: no store, no model.
 */

/** About 2.5k tokens of transcript a window: inside OLLAMA_NUM_CTX 16384 with room for the prompt and the answer. */
export const INTAKE_WINDOW_CHARS = 8000;
/** Utterances a window repeats from the one before, so a claim cut by the boundary is seen whole. */
export const WINDOW_OVERLAP = 2;

/**
 * Utterances [start, end) of the source. own: the first one this window lists claims from; those before it are the
 * previous window's end, shown for context only.
 */
export type IntakeWindow = { start: number; own: number; end: number };

const lineLength = (u: Utterance) => u.text.length + (u.speaker ? 6 : 0) + 1;

/**
 * The windows of a source: each owns whole utterances up to `max` characters (at least one, however long), after up to
 * `overlap` utterances of the one before. Deterministic, so a resumed extraction finds the same windows.
 */
export function windowsOf(utterances: readonly Utterance[], max = INTAKE_WINDOW_CHARS, overlap = WINDOW_OVERLAP): IntakeWindow[] {
  const out: IntakeWindow[] = [];
  let own = 0;
  while (own < utterances.length) {
    const start = Math.max(0, own - overlap);
    let size = utterances.slice(start, own).reduce((n, u) => n + lineLength(u), 0);
    let end = own;
    do size += lineLength(utterances[end++]);
    while (end < utterances.length && size + lineLength(utterances[end]) <= max);
    out.push({ start, own, end });
    own = end;
  }
  return out;
}

/** Speaker labels as handles (S1, S2, ... by first appearance), so no name reaches the model as a speaker. */
export type Handles = { label(handle: string | null): string | null; handle(label: string | null): string | null; all: string[] };

export function speakerHandles(utterances: readonly Utterance[]): Handles {
  const byNorm = new Map<string, string>();
  const labels = new Map<string, string>();
  for (const u of utterances) {
    const key = u.speaker === null ? '' : aliasNorm(u.speaker);
    if (!key || byNorm.has(key)) continue;
    const h = `S${byNorm.size + 1}`;
    byNorm.set(key, h);
    labels.set(h, u.speaker!);
  }
  return {
    label: (h) => (h === null ? null : labels.get(h.trim().toUpperCase()) ?? null),
    handle: (l) => (l === null ? null : byNorm.get(aliasNorm(l)) ?? null),
    all: [...labels.keys()],
  };
}

/** Utterances as the model reads them: one per line, the speaker as its handle. */
export const renderUtterances = (utterances: readonly Utterance[], handles: Handles) =>
  utterances.map((u) => `${handles.handle(u.speaker) ?? '(no speaker)'}: ${u.text}`).join('\n');

// ── Statement-adds ─────────────────────────────────────────────────────

const MONTHS = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
/** Numbers, versions and times: "30", "2.5", "v1.4.2", "02:00", "12th". */
const NUMBER = /(?<![\w.])v?\d+(?:[.,:]\d+)*(?:st|nd|rd|th)?(?![\w])/gi;
/** Code-shaped names: backticked, a path, dotted.call(), camelCase, snake_case or SCREAMING_CASE. */
const CODE = [
  /`([^`\n]+)`/g,
  /(?<![\w/:.])[\w.@-]+(?:\/[\w.@*-]+)+/g,
  /\b[A-Za-z_][\w]*\.[A-Za-z_][\w.]*(?:\(\))?/g,
  /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g,
  /\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/g,
  /\b[A-Z]{2,}[0-9]*\b/g,
];

/**
 * What a statement names that its quote does not: numbers, versions, dates and code-shaped names (modelled on
 * lessonCheck's addedContent). A model's statement is its words, not the speaker's: what it adds is flagged
 * `statement-adds`, so the claim is reviewed and never auto-accepted.
 */
export function statementAdds(statement: string, quote: string): string[] {
  const text = plainText(statement);
  const known = ` ${normalizeForQuote(quote).norm} `;
  const items = [
    ...[...text.matchAll(NUMBER)].map((m) => m[0]),
    ...[...text.matchAll(MONTHS)].map((m) => m[0]),
    ...CODE.flatMap((re) => [...text.matchAll(re)].map((m) => m[1] ?? m[0])),
  ].map((i) => i.replace(/[.,;:]+$/, ''));
  const added = items.filter((i) => {
    const n = normalizeForQuote(i).norm;
    return !!n && !known.includes(` ${n} `) && !known.includes(` ${n.replace(/^v(?=\d)/, '')} `);
  });
  // A part of a longer name found ("client.ts" in "src/ledger/client.ts") is not named again.
  return [...new Set(added)].filter((i, _, all) => !all.some((o) => o !== i && o.includes(i)));
}

/** Why a text may not become a claim or question: it speaks to the agent, carries a risky command, or a credential. */
export function injectionReason(...texts: string[]): 'injection' | 'credential' | null {
  for (const t of texts) if (holdsCredential(t)) return 'credential';
  for (const t of texts) if (instructsAgent(t) || riskyInstructions(t).length) return 'injection';
  return null;
}

// ── Vetting the model's answer ─────────────────────────────────────────

/** A claim as the model answers it (handles, its words). */
export type RawClaim = {
  type: ClaimType; speaker: string | null; quote: string; statement: string; confidence: number;
  scope: { area: string | null; files: string[] }; about: string; due?: string | null;
};
export type RawQuestion = { text: string; kind: QuestionKind; quote: string; askedBy: string | null };

/** Where a kept quote is: utterance idx (first, last) and offsets into the source text. */
export type SourceSpan = { utt: number; uttEnd: number; start: number; end: number };

/** A claim that passed: the source's words and speaker label (never the model's), its span, and its flags. */
export type VettedClaim = {
  type: ClaimType; statement: string; quote: string; speaker: string | null; span: SourceSpan; startMs: number | null;
  confidence: number; scope: ClaimScope; about: string; due: string | null; flags: ClaimFlag[];
};
export type VettedQuestion = { text: string; kind: QuestionKind; quote: string; askedBy: string | null; span: SourceSpan };

/** Why what the model said was not kept, counted (Activity, the eval). */
export type Dropped = Record<string, number>;
export const countDrop = (d: Dropped, reason: string) => {
  d[reason] = (d[reason] ?? 0) + 1;
};

/** Repository paths a claim may carry: those of the project's code map. Null: no map, so none are kept. */
export type KnownFiles = ReadonlySet<string> | null;

/** The span of a validated quote in source offsets (utterance offset + char index). */
function spanOf(utterances: readonly Utterance[], m: { utt: number; charStart: number; uttEnd: number; charEnd: number }): SourceSpan {
  return { utt: m.utt, uttEnd: m.uttEnd, start: utterances[m.utt].offset + m.charStart, end: utterances[m.uttEnd].offset + m.charEnd };
}

/** Find a quote in the window's utterances, said by `label` (null: anyone). */
function locate(all: readonly Utterance[], w: IntakeWindow, quote: string, label: string | null) {
  const m = validateQuote(all.slice(w.start, w.end), quote ?? '', label);
  return m.ok ? { ...m, span: spanOf(all, m) } : { ok: false as const, why: m.reason === 'wrong-speaker' || m.reason === 'mixed-speakers' ? 'wrong-speaker' : 'unquoted' };
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * The window's claims and questions that pass: the quote is in the window and said by the speaker the handle names
 * (exact, or near and flagged quote-fuzzy), nothing reads as an instruction to an agent or a credential, and the
 * claim starts in an utterance this window owns (the overlap's were the previous window's). The statement is checked
 * against the source's span (statement-adds), and scope.files kept only when the code map has them.
 */
export function vetWindow(
  all: readonly Utterance[], w: IntakeWindow, handles: Handles, raw: { claims: RawClaim[]; questions: RawQuestion[] }, knownFiles: KnownFiles,
): { claims: VettedClaim[]; questions: VettedQuestion[]; dropped: Dropped } {
  const dropped: Dropped = {};
  const claims: VettedClaim[] = [];
  const seen = new Set<string>();
  for (const c of raw.claims) {
    const statement = clean(c.statement);
    if (!statement) {
      countDrop(dropped, 'empty');
      continue;
    }
    const m = locate(all, w, c.quote, handles.label(c.speaker));
    if (!m.ok) {
      countDrop(dropped, m.why);
      continue;
    }
    const why = injectionReason(statement, m.quote, c.about ?? '');
    if (why) {
      countDrop(dropped, why);
      continue;
    }
    // A repeat from the overlap: the window before listed it.
    if (m.utt < w.own) continue;
    const key = `${c.type}|${m.span.start}|${m.span.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const flags: ClaimFlag[] = [...m.flags];
    if (statementAdds(statement, m.quote).length) flags.push('statement-adds');
    claims.push({
      type: c.type, statement, quote: m.quote, speaker: m.speaker, span: m.span, startMs: all[m.utt].startMs,
      confidence: clamp01(c.confidence), about: clean(c.about) || statement.slice(0, 80),
      scope: { area: clean(c.scope?.area) || null, files: keptFiles(c.scope?.files ?? [], knownFiles) },
      due: c.type === 'plan' || c.type === 'commitment' ? clean(c.due) || null : null, flags,
    });
  }
  const questions: VettedQuestion[] = [];
  for (const q of raw.questions) {
    const text = clean(q.text);
    if (!text) {
      countDrop(dropped, 'empty');
      continue;
    }
    const m = locate(all, w, q.quote, null);
    if (!m.ok) {
      countDrop(dropped, m.why);
      continue;
    }
    const why = injectionReason(text, m.quote);
    if (why) {
      countDrop(dropped, why);
      continue;
    }
    if (m.utt < w.own) continue;
    questions.push({ text, kind: q.kind, quote: m.quote, askedBy: m.speaker ?? handles.label(q.askedBy), span: m.span });
  }
  return { claims, questions, dropped };
}

/** Paths as postmortem/paths.ts cleans them, kept only when the code map has the file. */
export function keptFiles(files: readonly string[], known: KnownFiles): string[] {
  if (!known) return [];
  const out = files.map((f) => f.trim().replace(/^\.\//, '')).filter((f) => !junkPathReason(f) && known.has(f));
  return [...new Set(out)];
}

/** A claim as the cross-window call reads it (`ref` is how the model cites it). */
export type ListedClaim = { ref: string; type: ClaimType; statement: string; speaker: string | null; about: string; due: string | null; quote: string; span: SourceSpan };
export type RawCrossQuestion = { text: string; kind: QuestionKind; claims: string[] };

/**
 * The cross-window questions that pass: each cites claims of the list, and takes the first one's quote and span (the
 * model never quotes here, so it cannot misquote); asked by no one.
 */
export function vetCrossQuestions(listed: readonly ListedClaim[], raw: RawCrossQuestion[]): { questions: VettedQuestion[]; dropped: Dropped } {
  const dropped: Dropped = {};
  const byRef = new Map(listed.map((c) => [c.ref.toLowerCase(), c]));
  const questions: VettedQuestion[] = [];
  const seen = new Set<string>();
  for (const q of raw) {
    const text = clean(q.text);
    const cited = q.claims.map((r) => byRef.get(r.trim().toLowerCase())).find((c) => !!c);
    if (!text || !cited) {
      countDrop(dropped, text ? 'uncited' : 'empty');
      continue;
    }
    const why = injectionReason(text);
    if (why) {
      countDrop(dropped, why);
      continue;
    }
    if (seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    questions.push({ text, kind: q.kind, quote: cited.quote, askedBy: null, span: cited.span });
  }
  return { questions, dropped };
}
