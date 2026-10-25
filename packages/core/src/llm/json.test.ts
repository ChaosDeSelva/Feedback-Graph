import { expect, test } from 'vitest';
import { askJson, extractJsonAnswer, ModelOutputError, outputTail, STRICT_JSON } from './json.ts';
import type { JsonTask, LlmProvider } from './providers.ts';

test('a bare JSON answer parses as is', () => {
  expect(extractJsonAnswer('{"a":1}')).toEqual({ a: 1 });
  expect(extractJsonAnswer('  [1,2]\n')).toEqual([1, 2]);
});

test('a fenced json block wins over prose and other braces around it', () => {
  const text = 'Thinking about {the set}...\n6. Construct the JSON:\n```json\n{"label":"neutral","summary":"x"}\n```\nDone {ok}.';
  expect(extractJsonAnswer(text)).toEqual({ label: 'neutral', summary: 'x' });
  // An unlabelled fence holding JSON counts too.
  expect(extractJsonAnswer('Here:\n```\n{"a":2}\n```')).toEqual({ a: 2 });
});

test('without a fence, the last balanced top-level object is the answer', () => {
  const text = 'First draft {"a":1} was wrong. Final answer: {"facts":[{"path":"src/a.ts","statement":"uses } and { in strings"}]} and first literal';
  expect(extractJsonAnswer(text)).toEqual({ facts: [{ path: 'src/a.ts', statement: 'uses } and { in strings' }] });
});

test('strings with escaped quotes and brackets do not end the object early', () => {
  expect(extractJsonAnswer('answer: {"s":"a \\"quoted\\" ] }"} trailing')).toEqual({ s: 'a "quoted" ] }' });
});

test('an object is preferred over a later stray array, and unbalanced openers are skipped', () => {
  expect(extractJsonAnswer('{"facts":[]} see the [docs] marker and')).toEqual({ facts: [] });
  expect(extractJsonAnswer('use {x to start, then {"a":3}')).toEqual({ a: 3 });
  expect(extractJsonAnswer('only an array: [1, 2]')).toEqual([1, 2]);
});

test('no JSON at all is a ModelOutputError carrying a short redacted tail of what came back', () => {
  const secret = `sk-${'x'.repeat(30)}`;
  const raw = `${'blah '.repeat(300)}I could not finish, marker and ${secret}`;
  let err: unknown;
  try {
    extractJsonAnswer(raw);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ModelOutputError);
  const m = (err as Error).message;
  expect(m).toMatch(/no JSON/);
  expect(m).toMatch(/marker and/);
  expect(m).not.toContain(secret);
  expect((err as ModelOutputError).tail.length).toBeLessThanOrEqual(500);
});

test('outputTail keeps the end, collapses whitespace and marks a cut', () => {
  expect(outputTail('a\n\n  b')).toBe('a b');
  const t = outputTail('x'.repeat(600) + 'END', 100);
  expect(t.length).toBeLessThanOrEqual(100);
  expect(t.startsWith('…')).toBe(true);
  expect(t.endsWith('END')).toBe(true);
});

const fake = (answers: (unknown | Error)[]) => {
  const seen: JsonTask[] = [];
  const llm: LlmProvider = {
    id: 'fake', agentic: false,
    json: async (t) => {
      seen.push(t);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return { llm, seen };
};
const task = { system: 'SYS', user: 'U', schema: { type: 'object' } };
const isA = (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || typeof (raw as { a?: unknown }).a !== 'number') throw new Error('a: expected number');
  return raw as { a: number };
};

test('askJson returns the validated answer and asks once when it is good', async () => {
  const { llm, seen } = fake([{ a: 1 }]);
  expect(await askJson(llm, task, isA)).toEqual({ a: 1 });
  expect(seen).toHaveLength(1);
});

test('askJson asks once more, with a stricter instruction, after unparseable output or a schema mismatch', async () => {
  const { llm, seen } = fake([new ModelOutputError('no JSON object in the answer', 'prose'), { a: 2 }]);
  expect(await askJson(llm, task, isA)).toEqual({ a: 2 });
  expect(seen[1].system).toBe(`SYS\n\n${STRICT_JSON}`);

  const two = fake([{ b: 1 }, { a: 3 }]);
  expect(await askJson(two.llm, task, isA)).toEqual({ a: 3 });
  expect(two.seen).toHaveLength(2);
});

test('askJson fails after the second bad answer, naming the problem and the tail of the answer', async () => {
  const { llm, seen } = fake([{ b: 1 }, { b: 'still wrong' }]);
  const err = await askJson(llm, task, isA).catch((e: unknown) => e);
  expect(seen).toHaveLength(2);
  expect(err).toBeInstanceOf(ModelOutputError);
  expect((err as Error).message).toMatch(/did not match the schema: a: expected number/);
  expect((err as Error).message).toMatch(/still wrong/);
});

test('askJson does not retry other errors (timeouts, unavailability, HTTP 400)', async () => {
  const { llm, seen } = fake([new Error('openai:gpt 400: context length exceeded')]);
  await expect(askJson(llm, task, isA)).rejects.toThrow(/400/);
  expect(seen).toHaveLength(1);
});

test('askJson with promptOnly gives an agentic provider a fresh folder', async () => {
  const seen: JsonTask[] = [];
  const llm: LlmProvider = { id: 'a', agentic: true, json: async (t) => { seen.push(t); return { a: 1 }; } };
  await askJson(llm, task, isA, { promptOnly: true });
  expect(seen[0].cwd).toMatch(/fb-prompt-/);
});
