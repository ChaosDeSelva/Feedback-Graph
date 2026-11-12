import { appendFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { FileState } from '../state.ts';
import { sessionCwds, readSessionHead } from './heads.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'fb-heads-edge-'));
const BIG = 'x'.repeat(1100 * 1024); // past the 1 MiB head cap

test('a Claude Code head passes over blank and broken lines to the first cwd', async () => {
  const p = join(tmp(), 's.jsonl');
  writeFileSync(p, ['', '{"type":"user", broken', JSON.stringify({ type: 'user', cwd: '/H/Vibe/demo' })].join('\n'));
  expect(await readSessionHead(p, 'claude')).toEqual({ cwd: '/H/Vibe/demo', human: true });
});

test('a Claude Code first line past the cap still gives its cwd by pattern; none found leaves the cwd unknown', async () => {
  const dir = tmp();
  const withCwd = join(dir, 'a.jsonl');
  writeFileSync(withCwd, `{"type":"user","cwd":"/H/Vibe/big","message":{"content":"${BIG}"}}\n`);
  expect(await readSessionHead(withCwd, 'claude')).toEqual({ cwd: '/H/Vibe/big', human: true });
  const without = join(dir, 'b.jsonl');
  writeFileSync(without, `{"type":"user","message":{"content":"${BIG}"}}\n`);
  expect(await readSessionHead(without, 'claude')).toEqual({ cwd: null, human: true });
  // A cwd whose JSON string cannot be decoded is no cwd.
  const badEscape = join(dir, 'c.jsonl');
  writeFileSync(badEscape, `{"type":"user","cwd":"/H/\\q","message":{"content":"${BIG}"}}\n`);
  expect(await readSessionHead(badEscape, 'claude')).toEqual({ cwd: null, human: true });
});

test('a Codex head skips records before session_meta; a rollout with no meta has no head', async () => {
  const dir = tmp();
  const late = join(dir, 'late.jsonl');
  writeFileSync(late, [
    JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
    JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: '/H/Vibe/late', thread_source: 'user' } }),
  ].join('\n'));
  expect(await readSessionHead(late, 'codex')).toEqual({ cwd: '/H/Vibe/late', human: true });
  const none = join(dir, 'none.jsonl');
  writeFileSync(none, JSON.stringify({ type: 'response_item', payload: {} }) + '\n');
  expect(await readSessionHead(none, 'codex')).toEqual({ cwd: null, human: false });
});

test('a Codex meta line past the cap is read by pattern: its thread source, else a subagent marker, says who drove it', async () => {
  const dir = tmp();
  const write = (name: string, extra: string) => {
    const p = join(dir, name);
    writeFileSync(p, `{"type":"session_meta","payload":{"id":"x","cwd":"/H/Vibe/c",${extra}"base_instructions":"${BIG}"}}\n`);
    return p;
  };
  expect(await readSessionHead(write('voice.jsonl', '"thread_source":"voice_chat",'), 'codex')).toEqual({ cwd: '/H/Vibe/c', human: true });
  expect(await readSessionHead(write('exec.jsonl', '"thread_source":"exec",'), 'codex')).toEqual({ cwd: '/H/Vibe/c', human: false });
  expect(await readSessionHead(write('sub.jsonl', '"source":{"subagent":"review"},'), 'codex')).toEqual({ cwd: '/H/Vibe/c', human: false });
  expect(await readSessionHead(write('plain.jsonl', ''), 'codex')).toEqual({ cwd: '/H/Vibe/c', human: true });
});

test('sessionCwds reads only what was appended, skips broken turn_context lines, and starts over on a file that shrank', async () => {
  const dir = tmp();
  const p = join(dir, 'r.jsonl');
  const state = new FileState(':memory:');
  const tc = (cwd: string) => JSON.stringify({ type: 'turn_context', payload: { cwd } }) + '\n';
  const at = () => ({ path: p, size: statSync(p).size, mtimeMs: 1, source: 'codex' as const });
  writeFileSync(p, tc('/H/a') + '{"type":"turn_context", broken\n');
  expect(await sessionCwds(state, at())).toEqual(['/H/a']);
  appendFileSync(p, tc('/H/b'));
  expect(await sessionCwds(state, at())).toEqual(['/H/a', '/H/b']);
  // Unchanged: nothing is read again.
  expect(await sessionCwds(state, at())).toEqual(['/H/a', '/H/b']);
  writeFileSync(p, tc('/H/c'));
  expect(await sessionCwds(state, at())).toEqual(['/H/c']);
});

test('sessionCwds of a file that cannot be opened gives what was known', async () => {
  const state = new FileState(':memory:');
  expect(await sessionCwds(state, { path: join(tmp(), 'missing.jsonl'), size: 10, mtimeMs: 1, source: 'codex' })).toEqual([]);
});

test('sessionCwds of a Claude Code transcript: every record\'s own cwd, not one its message quotes', async () => {
  const p = join(tmp(), 's.jsonl');
  const state = new FileState(':memory:');
  const line = (o: object) => JSON.stringify(o) + '\n';
  writeFileSync(p, line({ type: 'user', cwd: '/H/Code', message: { content: 'start' } })
    + line({ type: 'summary', message: { content: '{"cwd":"/H/quoted"}' } })
    + line({ type: 'assistant', cwd: '/H/Code/demo-shop', message: { content: 'the config says "cwd": "/H/elsewhere"' } }));
  const at = () => ({ path: p, size: statSync(p).size, mtimeMs: 1, source: 'claude' as const });
  expect(await sessionCwds(state, at())).toEqual(['/H/Code', '/H/Code/demo-shop']);
  appendFileSync(p, line({ type: 'user', cwd: '/H/Code/side-tool', message: { content: 'next' } }));
  expect(await sessionCwds(state, at())).toEqual(['/H/Code', '/H/Code/demo-shop', '/H/Code/side-tool']);
});
