import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseTranscript } from './parseTranscript.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../fixtures/transcripts/${name}`, import.meta.url), 'utf8');

describe('parseTranscript', () => {
  test('basic: human turns with preceding work', () => {
    const [s] = parseTranscript(fixture('basic.jsonl'), 'basic.jsonl');
    expect(s.sessionId).toBe('s1');
    expect(s.cwd).toBe('/Users/you/code/demo/app');
    expect(s.gitBranch).toBe('main');
    expect(s.startedAt).toBe('2026-10-01T10:00:00Z');
    expect(s.endedAt).toBe('2026-10-01T10:05:00Z');
    expect(s.turns).toHaveLength(2);
    expect(s.turns.map((t) => t.index)).toEqual([0, 1]);
    const t = s.turns[1];
    expect(t.precedingToolCalls).toEqual([
      { name: 'Edit', ts: '2026-10-01T10:00:10Z', filePath: '/x/a.ts' },
      { name: 'Bash', ts: '2026-10-01T10:00:20Z', command: 'pnpm test' },
    ]);
    expect(t.precedingAssistantText).toBe('Search is done with client-side filtering.');
    expect(s.toolCalls).toHaveLength(2);
  });

  test('strips system-reminder blocks from turn text', () => {
    const [s] = parseTranscript(fixture('basic.jsonl'), 'basic.jsonl');
    expect(s.turns[1].text).toBe("This isn't good enough, filtering should be server-side.");
  });

  test('noise records never become human turns', () => {
    const sessions = parseTranscript(fixture('noise.jsonl'), 'noise.jsonl');
    expect(sessions.flatMap((s) => s.turns)).toEqual([]);
  });

  test('interrupt markers are not human turns', () => {
    const lines = [
      { type: 'user', uuid: 'i', sessionId: 's', timestamp: 't1', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
    ].map((r) => JSON.stringify(r)).join('\n');
    expect(parseTranscript(lines, 'i.jsonl')[0].turns).toEqual([]);
  });

  test('skips malformed and truncated lines', () => {
    const text = fixture('basic.jsonl') + 'not json\n{"type":"user","uuid":"trunc';
    const [s] = parseTranscript('garbage\n' + text, 'x.jsonl');
    expect(s.turns).toHaveLength(2);
  });

  test('assistant text is trimmed to the last 2000 chars', () => {
    const lines = [
      { type: 'assistant', uuid: 'a', sessionId: 's', timestamp: 't1', message: { content: [{ type: 'text', text: 'x'.repeat(2500) + 'END' }] } },
      { type: 'user', uuid: 'b', sessionId: 's', timestamp: 't2', message: { content: 'ok' } },
    ].map((r) => JSON.stringify(r)).join('\n');
    const [s] = parseTranscript(lines, 'y.jsonl');
    expect(s.turns[0].precedingAssistantText).toHaveLength(2000);
    expect(s.turns[0].precedingAssistantText.endsWith('END')).toBe(true);
  });

  test("the agent's reply after the last human turn is kept, redacted, as the session's final reply (not a turn)", () => {
    const lines = [
      { type: 'user', uuid: 'u0', sessionId: 's', timestamp: 't1', message: { content: 'deploy it' } },
      { type: 'assistant', uuid: 'a1', sessionId: 's', timestamp: 't2', message: { content: [{ type: 'text', text: 'working on it' }] } },
      { type: 'assistant', uuid: 'a2', sessionId: 's', timestamp: 't3', message: { content: [{ type: 'text', text: 'Deployed.\nDB_PASSWORD=hunter2EXAMPLE' }] } },
    ].map((r) => JSON.stringify(r)).join('\n');
    const [s] = parseTranscript(lines, 'f.jsonl');
    expect(s.turns).toHaveLength(1);
    expect(s.finalReply).toEqual({ text: expect.stringContaining('Deployed.'), ts: 't3' });
    expect(s.finalReply!.text).not.toContain('hunter2EXAMPLE');
    // A later human turn takes the reply in as its preceding text: there is no final reply then.
    const more = lines + '\n' + JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 's', timestamp: 't4', message: { content: 'thanks' } });
    const [s2] = parseTranscript(more, 'f.jsonl');
    expect(s2.turns[1].precedingAssistantText).toContain('Deployed.');
    expect(s2.finalReply).toBeNull();
    // The basic fixture ends on a human turn.
    expect(parseTranscript(fixture('basic.jsonl'), 'basic.jsonl')[0].finalReply).toBeNull();
  });

  test('Read and NotebookEdit map file paths', () => {
    const lines = [
      { type: 'assistant', uuid: 'a', sessionId: 's', timestamp: 't1', message: { content: [
        { type: 'tool_use', name: 'Read', input: { file_path: '/r.ts' } },
        { type: 'tool_use', name: 'NotebookEdit', input: { notebook_path: '/n.ipynb' } },
      ] } },
    ].map((r) => JSON.stringify(r)).join('\n');
    const [s] = parseTranscript(lines, 'z.jsonl');
    expect(s.toolCalls.map((c) => c.filePath)).toEqual(['/r.ts', '/n.ipynb']);
  });
});

test('secrets are redacted from turn text, assistant text and commands', () => {
  const key = 'sk-proj-' + 'Z9'.repeat(20);
  const lines = [
    { type: 'assistant', uuid: 'a', sessionId: 's', timestamp: 't1', message: { content: [
      { type: 'text', text: `set OPENAI_API_KEY=${key}` },
      { type: 'tool_use', name: 'Bash', input: { command: `export K=${key}` } },
    ] } },
    { type: 'user', uuid: 'b', sessionId: 's', timestamp: 't2', message: { content: `use this ${key}` } },
  ].map((r) => JSON.stringify(r)).join('\n');
  const out = JSON.stringify(parseTranscript(lines, 'k.jsonl'));
  expect(out).not.toContain(key);
  expect(out).toContain('[REDACTED]');
});
