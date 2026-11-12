import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readSessionHead } from './heads.ts';

const file = (lines: (object | string)[]) => {
  const p = join(mkdtempSync(join(tmpdir(), 'fb-heads-late-')), 'r.jsonl');
  writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
};
const meta = (payload: object) => ({ type: 'session_meta', payload: { id: 'x', ...payload } });

test('a sub-agent rollout with no cwd in its meta is known at once: not a person, folder unknown', async () => {
  expect(await readSessionHead(file([meta({ source: 'subagent' })]), 'codex')).toEqual({ cwd: null, human: false });
});

test("a person's rollout without a cwd in its meta takes the first turn context that names one", async () => {
  expect(await readSessionHead(file([
    meta({ thread_source: 'user' }),
    { type: 'turn_context' },
    { type: 'turn_context', payload: { model: 'gpt' } },
    { type: 'turn_context', payload: { cwd: '/H/Vibe/ctx' } },
  ]), 'codex')).toEqual({ cwd: '/H/Vibe/ctx', human: true });
});

test('or the environment context of a message, in the wrapped or the earliest bare format, past parts with no text', async () => {
  const env = { type: 'input_text', text: '<environment_context>\n<cwd>/H/Vibe/env</cwd>\n</environment_context>' };
  expect(await readSessionHead(file([
    meta({ thread_source: 'user' }),
    { type: 'response_item', payload: { type: 'message', content: [{ type: 'image' }, env] } },
  ]), 'codex')).toEqual({ cwd: '/H/Vibe/env', human: true });
  expect(await readSessionHead(file([
    { id: 'x', timestamp: '2025-01-01T00:00:00Z' },
    { type: 'message', role: 'user', content: [env] },
  ]), 'codex')).toEqual({ cwd: '/H/Vibe/env', human: true });
});

test('a meta with no cwd and nothing after it naming one leaves the folder unknown, also when a later line is past the cap', async () => {
  expect(await readSessionHead(file([meta({ thread_source: 'user' })]), 'codex')).toEqual({ cwd: null, human: true });
  const big = `{"type":"response_item","payload":{"type":"message","content":[{"type":"input_text","text":"${'x'.repeat(1100 * 1024)}"}]}}`;
  expect(await readSessionHead(file([meta({ thread_source: 'user' }), big]), 'codex')).toEqual({ cwd: null, human: true });
});

test('a meta line past the cap with no cwd in it gives no head', async () => {
  const big = `{"type":"session_meta","payload":{"id":"x","thread_source":"user","base_instructions":"${'x'.repeat(1100 * 1024)}"}}`;
  expect(await readSessionHead(file([big]), 'codex')).toEqual({ cwd: null, human: false });
});
