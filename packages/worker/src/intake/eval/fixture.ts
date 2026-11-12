import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The intake evaluation fixture (fixtures/intake): sources, the seeded knowledge they are checked against, and what a
 * good run finds in them (expected.json). Spans are UTF-16 offsets into a source file's text exactly as stored.
 */

export const CLAIM_TYPES = ['fact', 'decision', 'opinion', 'plan', 'commitment'] as const;
export const QUESTION_KINDS = ['unanswered', 'contradictory', 'needs_owner'] as const;
export const CONFLICT_KINDS = ['disagreement', 'supersession'] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

const Span = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).refine((s) => s.end > s.start, 'span end must follow its start');
export type Span = z.infer<typeof Span>;

const Source = z.object({
  id: z.string(),
  file: z.string(),
  kind: z.enum(['transcript', 'notes', 'doc']),
  format: z.enum(['vtt', 'srt', 'txt', 'md']),
  projectKey: z.string().nullable(),
  occurredAt: z.string().datetime({ offset: true }),
  participants: z.array(z.string()),
  origin: z.string(),
  private: z.boolean(),
});
const SeedLesson = z.object({
  id: z.string(), projectKey: z.string().nullable(), status: z.enum(['approved', 'proposed']), title: z.string(), rule: z.string(), appliesWhen: z.string(),
  scope: z.string(), paths: z.array(z.string()), createdAt: z.string(), decidedAt: z.string().nullable(),
});
const SeedFact = z.object({
  id: z.string(), projectKey: z.string(), origin: z.string(), kind: z.string(), statement: z.string(), path: z.string(), lines: z.string().nullable(),
  confidence: z.number(), why: z.string(), relevance: z.number().nullable(), createdAt: z.string(),
});
const Claim = z.object({
  id: z.string(), source: z.string(), type: z.enum(CLAIM_TYPES), speaker: z.string().nullable(), quote: z.string(), span: Span,
  optional: z.boolean().optional(),
});
const Question = z.object({
  id: z.string(), source: z.string(), kind: z.enum(QUESTION_KINDS), askedBy: z.string().nullable(),
  /** Any one of these spans is the question (a contradictory one may cite either side). */
  quotes: z.array(z.object({ quote: z.string(), span: Span })).min(1),
  optional: z.boolean().optional(),
});
const MustDrop = z.object({
  id: z.string(), source: z.string(), reason: z.enum(['injection', 'fabricated']), quote: z.string(), span: Span, attributedTo: z.string().optional(),
});
const Contradiction = z.object({
  id: z.string(),
  family: z.enum(['number', 'date', 'version', 'negation', 'alternative']).nullable(),
  /** An expected claim id, or a seed as `lesson:<id>` / `fact:<id>`. */
  a: z.string(),
  b: z.string(),
  /** disagreement / supersession: a Conflict of that kind. none: no Conflict (`relation` says what it is). question: a contradictory Question. */
  expect: z.enum(['disagreement', 'supersession', 'none', 'question']),
  newer: z.enum(['a', 'b']).optional(),
  relation: z.enum(['refines', 'same']).optional(),
  note: z.string().optional(),
});

export const IntakeExpected = z.object({
  version: z.literal(1),
  about: z.string().optional(),
  /** The owner's display name: a claim from a notes source with no speaker is the owner's. */
  owner: z.string(),
  sources: z.array(Source).min(1),
  seeds: z.object({ lessons: z.array(SeedLesson), facts: z.array(SeedFact) }),
  claims: z.array(Claim),
  questions: z.array(Question),
  mustDrop: z.array(MustDrop),
  contradictions: z.array(Contradiction),
});
export type IntakeExpected = z.infer<typeof IntakeExpected>;
export type ExpectedClaim = IntakeExpected['claims'][number];
export type ExpectedQuestion = IntakeExpected['questions'][number];
export type ExpectedContradiction = IntakeExpected['contradictions'][number];
export type EvalSource = IntakeExpected['sources'][number];
export type IntakeSeeds = IntakeExpected['seeds'];

/** expected.json and the text of every source it names. */
export type IntakeFixture = { expected: IntakeExpected; texts: Map<string, string> };

/** Read and check a fixture directory: a fixture that does not hold together is refused, never scored. */
export async function loadIntakeFixture(dir: string): Promise<IntakeFixture> {
  const expected = IntakeExpected.parse(JSON.parse(await readFile(join(dir, 'expected.json'), 'utf8')));
  const texts = new Map<string, string>();
  for (const s of expected.sources) texts.set(s.id, await readFile(join(dir, s.file), 'utf8'));
  const fixture = { expected, texts };
  const problems = fixtureProblems(fixture);
  if (problems.length) throw new Error(`fixture ${dir} does not hold together:\n- ${problems.join('\n- ')}`);
  return fixture;
}

export const isSeedRef = (ref: string) => /^(lesson|fact):/.test(ref);

/** What is wrong with a fixture: unknown ids, duplicate ids, and spans that do not hold their quote. */
export function fixtureProblems({ expected: e, texts }: IntakeFixture): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  const unique = (id: string) => {
    if (ids.has(id)) out.push(`duplicate id ${id}`);
    ids.add(id);
  };
  for (const s of e.sources) unique(s.id);
  const spanHolds = (where: string, source: string, quote: string, span: Span) => {
    const text = texts.get(source);
    if (text === undefined) return out.push(`${where}: unknown source ${source}`);
    if (text.slice(span.start, span.end) !== quote) out.push(`${where}: span ${span.start}-${span.end} of ${source} is "${text.slice(span.start, span.end)}", not "${quote}"`);
  };
  for (const c of e.claims) {
    unique(c.id);
    spanHolds(c.id, c.source, c.quote, c.span);
  }
  for (const q of e.questions) {
    unique(q.id);
    q.quotes.forEach((x, i) => spanHolds(`${q.id}[${i}]`, q.source, x.quote, x.span));
  }
  for (const d of e.mustDrop) {
    unique(d.id);
    spanHolds(d.id, d.source, d.quote, d.span);
  }
  const seeds = new Set([...e.seeds.lessons.map((l) => `lesson:${l.id}`), ...e.seeds.facts.map((f) => `fact:${f.id}`)]);
  const claims = new Set(e.claims.map((c) => c.id));
  for (const c of e.contradictions) {
    unique(c.id);
    for (const ref of [c.a, c.b]) if (!claims.has(ref) && !seeds.has(ref)) out.push(`${c.id}: unknown side ${ref}`);
    if (c.expect === 'supersession' && !c.newer) out.push(`${c.id}: a supersession names the newer side`);
    if (c.expect === 'none' && !c.relation) out.push(`${c.id}: a planted non-conflict names its relation`);
  }
  return out;
}
