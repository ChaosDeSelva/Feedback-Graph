/**
 * Reading a JSON answer out of what a model wrote. Constrained decoding (Ollama's `format`, OpenAI's json_schema) and
 * the CLIs' schema flags usually give bare JSON, but local models and agentic runs still wrap it in reasoning prose or
 * ```json fences now and then. Every provider parses through extractJsonAnswer, and stages that validate the answer ask
 * through askJson, which asks once more, more strictly, before an unusable answer counts as a failure.
 */
import { redactSecrets } from '../redact.ts';
import { askPromptOnly } from './promptOnly.ts';
import type { JsonTask, LlmProvider } from './providers.ts';

/** Appended to the system prompt for the one retry after an unusable answer. */
export const STRICT_JSON = 'Reply with the JSON object only: no prose, no markdown fences, nothing before or after it.';

const TAIL_CHARS = 500;

/** The end of a model's output for an error message: redacted, whitespace collapsed, at most `max` characters. */
export function outputTail(text: string, max = TAIL_CHARS): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `…${flat.slice(flat.length - (max - 1))}`;
}

/**
 * Thrown by an askJson validator that refuses what the answer says (a rule field holding the scope word), not its
 * shape: the one retry is told why, so the model can fix that field.
 */
export class AnswerRefused extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = 'AnswerRefused';
  }
}

/** The model answered, but not with JSON of the asked shape. Not unavailability: it counts against the item. */
export class ModelOutputError extends Error {
  /** The end of what came back (outputTail), so the owner can see it. */
  readonly tail: string;
  constructor(problem: string, raw: string) {
    const tail = outputTail(raw);
    super(`${redactSecrets(problem)}; the answer ended: ${tail || '(empty)'}`);
    this.name = 'ModelOutputError';
    this.tail = tail;
  }
}

const tryParse = (s: string): { ok: true; v: unknown } | { ok: false } => {
  try {
    return { ok: true, v: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
};

/** Every balanced top-level {...} or [...] in `text`, in order. Brackets inside JSON strings do not count. */
function balancedSpans(text: string): string[] {
  const spans: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== '{' && c !== '[') {
      i++;
      continue;
    }
    const end = closeOf(text, i);
    if (end < 0) {
      // Unbalanced (prose like "use {x"): look for the next opener after this one.
      i++;
      continue;
    }
    spans.push(text.slice(i, end + 1));
    i = end + 1;
  }
  return spans;
}

/** Index of the bracket closing the one at `start`, or -1 when it never closes or closes with the wrong kind. */
function closeOf(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inString) {
      if (c === '\\') j++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return j;
    }
  }
  return -1;
}

/**
 * The JSON answer in a model's output: the whole text when it is JSON; else the last fenced block that parses
 * (```json, or an unlabelled fence holding JSON); else the last balanced top-level object that parses, then the last
 * array. Throws ModelOutputError (with the redacted tail of the output) when there is none.
 */
export function extractJsonAnswer(text: string): unknown {
  const whole = text.trim();
  if (whole.startsWith('{') || whole.startsWith('[')) {
    const p = tryParse(whole);
    if (p.ok) return p.v;
  }
  const fences = [...text.matchAll(/```[ \t]*([A-Za-z0-9_-]*)[^\n]*\n?([\s\S]*?)```/g)]
    .filter((m) => m[1].toLowerCase() === 'json' || (!m[1] && /^\s*[[{]/.test(m[2])))
    .reverse();
  for (const m of fences) {
    const p = tryParse(m[2].trim());
    if (p.ok) return p.v;
  }
  const spans = balancedSpans(text).reverse();
  for (const want of ['{', '[']) {
    for (const s of spans) {
      if (!s.startsWith(want)) continue;
      const p = tryParse(s);
      if (p.ok) return p.v;
    }
  }
  throw new ModelOutputError(whole ? 'no JSON object in the answer' : 'the answer was empty', text);
}

const shown = (raw: unknown): string => {
  try {
    return typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? String(raw));
  } catch {
    return String(raw);
  }
};

const problemOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);

/**
 * Ask `llm` and check the answer with `validate` (which throws on a wrong shape, e.g. a zod `.parse`). When the
 * answer is not JSON or does not validate, ask once more with STRICT_JSON appended to the system prompt; a second
 * unusable answer throws ModelOutputError naming the problem and the end of the answer. Any other error (a timeout,
 * an unavailable model, an HTTP 400) is not retried here. `promptOnly`: the request needs no folder (askPromptOnly).
 */
export async function askJson<T>(llm: LlmProvider, task: JsonTask, validate: (raw: unknown) => T, o: { promptOnly?: boolean } = {}): Promise<T> {
  const ask = (t: JsonTask) => (o.promptOnly ? askPromptOnly(llm, t) : llm.json(t));
  let refused: string | null = null;
  const once = async (t: JsonTask): Promise<T> => {
    const raw = await ask(t);
    try {
      return validate(raw);
    } catch (err) {
      if (err instanceof AnswerRefused) refused = problemOf(err);
      throw new ModelOutputError(`the answer did not match the schema: ${problemOf(err)}`, shown(raw));
    }
  };
  try {
    return await once(task);
  } catch (err) {
    if (!(err instanceof ModelOutputError)) throw err;
  }
  return once({ ...task, system: `${task.system}\n\n${STRICT_JSON}${refused ? `\nYour last answer was refused: ${refused}` : ''}` });
}
