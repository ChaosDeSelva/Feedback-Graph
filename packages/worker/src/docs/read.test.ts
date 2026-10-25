import { expect, test } from 'vitest';
import { ModelTimeoutError, ProviderUnavailableError, STRICT_JSON, type ActivityInput, type DocToRead, type EmbeddedFact, type LlmProvider, type JsonTask } from '@fb/core';
import { readOneDoc, type ReadDeps } from './read.ts';

const textDoc: DocToRead = { id: 'doc:shop:upload:spec.md', projectKey: 'shop', ref: 'spec.md', title: 'Spec', kind: 'text', text: 'Orders are always scoped to the tenant.\n\nTo set up the profiler, install X.', image: null, attempts: 0, version: 'v1' };
const png = { mediaType: 'image/png' as const, data: 'aGVsbG8=' };
const imageDoc: DocToRead = { id: 'doc:shop:upload:flow.png', projectKey: 'shop', ref: 'flow.png', title: 'Checkout flow', kind: 'image', text: '', image: png, attempts: 0, version: 'v1' };
const fact = (statement: string, relevance: number, confidence = 0.9) => ({ kind: 'architecture', statement, path: 'x', lines: null, confidence, why: 'w', relevance });

function deps(job: DocToRead | null, answer: (t: JsonTask) => unknown, over: Partial<ReadDeps> = {}) {
  const saved: { id: string; version?: string; chunks?: { text: string }[]; facts: EmbeddedFact[]; source: string }[] = [];
  const failures: { id: string; error: string; o: object }[] = [];
  const marked: string[] = [];
  const activity: ActivityInput[] = [];
  const asked: JsonTask[] = [];
  const llm: LlmProvider = { id: 'ollama:gemma4', agentic: false, vision: true, json: async (t) => { asked.push(t); return answer(t); } };
  const d: ReadDeps = {
    docs: {
      nextDocToRead: async () => job,
      markDocReading: async (id) => { marked.push(id); return true; },
      saveDocReading: async (id, r) => { saved.push({ id, ...r }); return true; },
      recordDocFailure: async (id, error, o) => { failures.push({ id, error, o }); return { attempts: 1, retryAt: 'later' }; },
    },
    llm,
    embed: async (texts) => texts.map(() => [1, 0]),
    inScope: async () => true,
    activity: { record: async (a) => { activity.push(a); } },
    ...over,
  };
  return { d, saved, failures, marked, activity, asked };
}

test('a text upload is read into facts with relevance, filed under the document, and logged', async () => {
  const t = deps(textDoc, () => ({ summary: 'The product spec', facts: [fact('Orders are scoped to the tenant', 0.9), fact('Profiler setup', 0.1), fact('Unsure', 0.5, 0.2)] }));
  expect(await readOneDoc(t.d)).toEqual({ read: true });
  expect(t.marked).toEqual([textDoc.id]);
  expect(t.asked[0].user).toContain('Orders are always scoped to the tenant.');
  expect(t.asked[0].system).toMatch(/relevance/i);
  expect(t.asked[0].images).toBeUndefined();
  expect(t.saved[0].chunks).toBeUndefined();
  expect(t.saved[0].facts.map((f) => [f.statement, f.relevance, f.path])).toEqual([['Orders are scoped to the tenant', 0.9, 'spec.md'], ['Profiler setup', 0.1, 'spec.md']]);
  expect(t.saved[0].source).toBe('ollama:gemma4');
  expect(t.activity[0]).toMatchObject({ kind: 'doc_read', actor: 'ollama:gemma4', projectKey: 'shop', subject: 'read "Spec": 2 facts', targets: [textDoc.id] });
});

test('an image is sent to the model, and its description becomes the document\'s searchable text', async () => {
  const t = deps(imageDoc, () => ({ description: 'A checkout flow: cart, then address, then payment. Button text: "Pay now".', facts: [fact('Checkout asks for the address before payment', 0.8)] }));
  await readOneDoc(t.d);
  expect(t.asked[0].images).toEqual([png]);
  expect(t.asked[0].system).toMatch(/visible text/i);
  expect(t.saved[0].chunks?.map((c) => c.text)).toEqual(['Image "Checkout flow" (flow.png): A checkout flow: cart, then address, then payment. Button text: "Pay now".']);
  expect(t.saved[0].facts[0]).toMatchObject({ statement: 'Checkout asks for the address before payment', path: 'flow.png' });
});

test('an image with a model that cannot see fails for good at once, naming the model', async () => {
  const t = deps(imageDoc, () => ({}), {});
  t.d.llm = { id: 'jev', agentic: false, vision: false, json: async () => ({}) };
  expect(await readOneDoc(t.d)).toEqual({ read: false });
  expect(t.failures[0]).toMatchObject({ id: imageDoc.id, o: { counted: true, final: true } });
  expect(t.failures[0].error).toMatch(/jev cannot read images.*DOCS_LLM/);
});

test('an unreachable model leaves the document waiting without counting an attempt; other failures count', async () => {
  const down = deps(textDoc, () => { throw new ProviderUnavailableError('ECONNREFUSED'); });
  expect(await readOneDoc(down.d)).toEqual({ read: false, unavailable: expect.stringContaining('ECONNREFUSED') });
  expect(down.failures[0].o).toEqual({ counted: false, version: 'v1' });
  const bad = deps(textDoc, () => ({ nonsense: true }));
  expect(await readOneDoc(bad.d)).toEqual({ read: false });
  expect(bad.failures[0].o).toEqual({ counted: true, version: 'v1' });
});

test('a reading that timed out counts an attempt (backoff, then failed), instead of waiting on the document forever', async () => {
  const slow = deps(textDoc, () => { throw new ModelTimeoutError('Ollama (gemma4) did not answer within 300 s'); });
  expect(await readOneDoc(slow.d)).toEqual({ read: false });
  expect(slow.failures[0]).toMatchObject({ o: { counted: true, version: 'v1' }, error: expect.stringMatching(/did not answer within 300 s/) });
});

test('an answer of the wrong shape is asked again once, more strictly; the failure keeps the end of what came back', async () => {
  const replies: unknown[] = [{ nonsense: true }, { summary: 'Spec', facts: [fact('Orders are scoped to the tenant', 0.9)] }];
  const t = deps(textDoc, () => replies.shift());
  expect(await readOneDoc(t.d)).toEqual({ read: true });
  expect(t.asked[1].system).toContain(STRICT_JSON);
  const bad = deps(textDoc, () => ({ nonsense: 'still not it' }));
  await readOneDoc(bad.d);
  expect(bad.failures[0].error).toMatch(/did not match the schema.*still not it/);
});

test('nothing to read is no work; a document of a project no longer selected waits', async () => {
  expect(await readOneDoc(deps(null, () => ({})).d)).toBeNull();
  const t = deps(textDoc, () => { throw new Error('should not ask'); }, { inScope: async () => false });
  expect(await readOneDoc(t.d)).toEqual({ read: false });
  expect(t.failures[0]).toMatchObject({ o: { counted: false } });
  expect(t.marked).toEqual([]);
});

test('a long document is cut to what one prompt holds, and the text goes to the model redacted', async () => {
  const key = `ghp_${'G'.repeat(36)}`;
  const t = deps({ ...textDoc, text: `token ${key} ${'x'.repeat(100_000)}` }, () => ({ summary: '', facts: [] }));
  await readOneDoc(t.d);
  expect(t.asked[0].user).not.toContain(key);
  expect(t.asked[0].user.length).toBeLessThan(50_000);
});

test('the reading is saved for the version that was read, so a re-upload in the meantime is not overwritten', async () => {
  const t = deps(textDoc, () => ({ summary: '', facts: [] }));
  await readOneDoc(t.d);
  expect(t.saved[0].version).toBe('v1');
  const replaced = deps(textDoc, () => ({ summary: '', facts: [fact('old', 0.9)] }));
  replaced.d.docs.saveDocReading = async () => false;
  expect(await readOneDoc(replaced.d)).toEqual({ read: false });
  expect(replaced.activity).toEqual([]);
});

test('a failure after the model answered (embedding, saving) is recorded, so the document never stays "reading"', async () => {
  const t = deps(textDoc, () => ({ summary: '', facts: [fact('x', 0.9)] }), { embed: async () => { throw new Error('ollama embed 500'); } });
  expect(await readOneDoc(t.d)).toEqual({ read: false });
  expect(t.failures[0]).toMatchObject({ id: textDoc.id, o: { counted: true, version: 'v1' } });
  expect(t.failures[0].error).toMatch(/ollama embed 500/);
});
