import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { codexSessionFiles, codexSessionParser, parseCodexSession } from './codex.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../fixtures/codex/${name}`, import.meta.url), 'utf8');
const parse = (name: string) => parseCodexSession(fixture(name), `/codex/${name}`);
const ts = (s: number) => `2026-10-01T10:00:${String(s).padStart(2, '0')}.000Z`;

describe('parseCodexSession: current format', () => {
  test('normal session: meta, human turns, preceding work', () => {
    const sessions = parse('normal.jsonl');
    expect(sessions).toHaveLength(1);
    const [s] = sessions;
    expect(s.sessionId).toBe('codex-normal-0001');
    expect(s.sourceFile).toBe('/codex/normal.jsonl');
    expect(s.cwd).toBe('/work/demo-shop');
    expect(s.gitBranch).toBe('main');
    expect(s.startedAt).toBe(ts(0));
    expect(s.endedAt).toBe(ts(12));
    expect(s.turns.map((t) => t.text)).toEqual(['Add a search box to the products page', 'No, the filter must run on the server.']);
    expect(s.turns.map((t) => t.index)).toEqual([0, 1]);
    expect(s.turns.every((t) => t.sessionId === 'codex-normal-0001')).toBe(true);
    expect(new Set(s.turns.map((t) => t.uuid)).size).toBe(2);
    expect(s.turns[0].precedingAssistantText).toBe('');
    expect(s.turns[0].precedingToolCalls).toEqual([]);
    const t = s.turns[1];
    expect(t.ts).toBe(ts(10));
    expect(t.precedingAssistantText).toBe('Search is done with client-side filtering.');
    expect(t.precedingToolCalls).toEqual([
      { name: 'Bash', ts: ts(5), command: 'pnpm test' },
      { name: 'Bash', ts: ts(6), command: 'sed -n 1,80p src/products.tsx' },
      { name: 'Read', ts: ts(6), filePath: '/work/demo-shop/src/products.tsx' },
      { name: 'Edit', ts: ts(7), filePath: '/work/demo-shop/src/products.tsx' },
      { name: 'Write', ts: ts(7), filePath: '/work/demo-shop/src/search.ts' },
    ]);
    expect(s.toolCalls).toHaveLength(5);
  });

  test('turn uuids are stable across re-parses', () => {
    const a = parse('normal.jsonl')[0].turns.map((t) => t.uuid);
    const b = parse('normal.jsonl')[0].turns.map((t) => t.uuid);
    expect(a).toEqual(b);
  });
});

describe('parseCodexSession: tool calls', () => {
  test('shell, local_shell_call, apply_patch, exec_command, MCP and other tools', () => {
    const [s] = parse('tools.jsonl');
    expect(s.gitBranch).toBe('feature/cart');
    expect(s.turns.map((t) => t.text)).toEqual(['Fix the cart total', 'You deleted the wrong file.']);
    const t = s.turns[1];
    expect(t.precedingAssistantText).toBe('Cart total fixed.');
    expect(t.precedingToolCalls).toEqual([
      { name: 'Bash', ts: ts(2), command: 'ls -la src' },
      { name: 'Bash', ts: ts(3), command: 'git status' },
      { name: 'Edit', ts: ts(4), filePath: '/work/demo-shop/src/cart.ts' },
      { name: 'Write', ts: ts(4), filePath: '/work/demo-shop/src/total.ts' },
      { name: 'Delete', ts: ts(4), filePath: '/work/demo-shop/src/legacy.ts' },
      { name: 'Edit', ts: ts(4), filePath: '/work/demo-shop/src/b.ts' },
      { name: 'Edit', ts: ts(5), filePath: '/work/demo-shop/README.md' },
      { name: 'Bash', ts: ts(6), command: 'pnpm vitest run' },
      { name: 'update_plan', ts: ts(7) },
      { name: 'mcp__docs__search', ts: ts(7) },
    ]);
  });
});

describe('parseCodexSession: what is not a human turn', () => {
  test('injected instructions, environment, images, aborts, compaction and agent messages', () => {
    const [s] = parse('injected.jsonl');
    expect(s.turns.map((t) => t.text)).toEqual([
      'postgres, not sqlite',
      'The price column is misaligned',
      'The header overlaps the logo, see screenshot.',
    ]);
  });

  test('a question reply is a turn: the answers are its text, the questions what preceded it', () => {
    const [s] = parse('injected.jsonl');
    expect(s.turns[0].precedingAssistantText).toBe('Which database should I use?\nAdd an index?');
  });

  test('context blocks keep the human request that follows "## My request:"', () => {
    const [s] = parse('normal.jsonl');
    expect(s.turns[0].text).toBe('Add a search box to the products page');
    expect(parse('injected.jsonl')[0].turns[1].text).toBe('The price column is misaligned');
  });

  test('guardian sub-agent sessions yield nothing', () => {
    expect(parse('subagent.jsonl')).toEqual([]);
  });

  test('forked sub-agent sessions yield nothing, and the parent meta does not take over', () => {
    expect(parse('fork.jsonl')).toEqual([]);
  });
});

describe('parseCodexSession: robustness', () => {
  test('a truncated last line is skipped', () => {
    const [s] = parse('truncated.jsonl');
    expect(s.turns.map((t) => t.text)).toEqual(['Rename the cart module', 'Thanks, looks right']);
    expect(s.turns[1].precedingAssistantText).toBe('Renamed.');
  });

  test('unknown record and item types are skipped, never guessed at', () => {
    const [s] = parse('unknown.jsonl');
    expect(s.turns.map((t) => t.text)).toEqual(['The only real turn']);
    expect(s.toolCalls).toEqual([]);
  });

  test('garbage and empty input', () => {
    expect(parseCodexSession('', 'e.jsonl')).toEqual([]);
    expect(parseCodexSession('not json\n{"type":', 'g.jsonl')).toEqual([]);
  });

  test('records before any session_meta are ignored', () => {
    const line = JSON.stringify({ timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'orphan' }] } });
    expect(parseCodexSession(line + '\n', 'o.jsonl')).toEqual([]);
  });

  test('CRLF line endings parse', () => {
    const [s] = parseCodexSession(fixture('truncated.jsonl').replace(/\n/g, '\r\n'), 'crlf.jsonl');
    expect(s.turns).toHaveLength(2);
  });

  test('the line-by-line parser matches the whole-text parser', () => {
    const text = fixture('normal.jsonl');
    const p = codexSessionParser('/codex/normal.jsonl');
    for (const line of text.split('\n')) p.push(line);
    expect(p.finish()).toEqual(parseCodexSession(text, '/codex/normal.jsonl'));
  });
});

describe('parseCodexSession: cwd changes', () => {
  test('a cwd switch starts a new session segment so each project gets its own turns', () => {
    const sessions = parse('cwd-change.jsonl');
    expect(sessions.map((s) => [s.sessionId, s.cwd, s.turns.map((t) => t.text)])).toEqual([
      ['codex-cwd-0006', '/work/demo-shop', ['Update the shop footer', 'Good']],
      ['codex-cwd-0006#2', '/work/admin-panel', ['Now do the same in the admin panel', 'That broke the admin build']],
      ['codex-cwd-0006#3', '/work/demo-shop', ['Back to the shop: undo the footer']],
    ]);
    const [a, b, c] = sessions;
    expect(a.toolCalls).toEqual([{ name: 'Bash', ts: ts(2), command: 'pnpm build' }]);
    // The index runs on across segments: the first turn after a switch follows agent work, so it is classifiable
    // (unclassifiedTurns skips index 0 as a session's opening request).
    expect(sessions.map((s) => s.turns.map((t) => t.index))).toEqual([[0, 1], [2, 3], [4]]);
    expect(b.turns.every((t) => t.sessionId === 'codex-cwd-0006#2')).toBe(true);
    expect(b.turns[1].precedingToolCalls).toEqual([{ name: 'Bash', ts: ts(6), command: 'pnpm build' }]);
    expect(b.turns[1].precedingAssistantText).toBe('Admin footer updated.');
    expect([b.startedAt, b.endedAt]).toEqual([ts(5), ts(8)]);
    expect(c.startedAt).toBe(ts(9));
    const uuids = sessions.flatMap((s) => s.turns.map((t) => t.uuid));
    expect(new Set(uuids).size).toBe(uuids.length);
  });

  test('a cwd set before the first human turn retargets the session instead of splitting it', () => {
    const lines = [
      { timestamp: ts(0), type: 'session_meta', payload: { id: 'x', timestamp: ts(0), cwd: '/work/a' } },
      { timestamp: ts(1), type: 'turn_context', payload: { cwd: '/work/b' } },
      { timestamp: ts(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
    ].map((r) => JSON.stringify(r)).join('\n');
    const sessions = parseCodexSession(lines, 'x.jsonl');
    expect(sessions.map((s) => [s.sessionId, s.cwd])).toEqual([['x', '/work/b']]);
  });
});

describe('parseCodexSession: oldest bare format', () => {
  test('bare meta line, bare items, cwd from environment_context, meta timestamp', () => {
    const [s] = parse('legacy-bare.jsonl');
    expect(s.sessionId).toBe('codex-legacy-0009');
    expect(s.cwd).toBe('/work/demo-shop');
    expect(s.gitBranch).toBe('main');
    expect(s.startedAt).toBe('2025-06-01T09:00:00.000Z');
    expect(s.turns.map((t) => t.text)).toEqual(['List the routes', 'There are two, look again']);
    expect(s.turns[1].precedingToolCalls).toEqual([{ name: 'Bash', ts: '2025-06-01T09:00:00.000Z', command: 'ls src/routes' }]);
    expect(s.turns[1].precedingAssistantText).toBe('There is one route.');
    expect(new Set(s.turns.map((t) => t.uuid)).size).toBe(2);
  });
});

describe('parseCodexSession: text handling', () => {
  const session = (...items: object[]) =>
    [{ timestamp: ts(0), type: 'session_meta', payload: { id: 's', timestamp: ts(0), cwd: '/w' } }, ...items.map((payload, i) => ({ timestamp: ts(i + 1), type: 'response_item', payload }))]
      .map((r) => JSON.stringify(r)).join('\n');

  test('assistant text is trimmed to the last 2000 chars', () => {
    const [s] = parseCodexSession(session(
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(2500) + 'END' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ok' }] },
    ), 't.jsonl');
    expect(s.turns[0].precedingAssistantText).toHaveLength(2000);
    expect(s.turns[0].precedingAssistantText.endsWith('END')).toBe(true);
  });

  test('secrets are redacted from turn text, assistant text and commands', () => {
    const key = 'sk-proj-' + 'Z9'.repeat(20);
    const out = JSON.stringify(parseCodexSession(session(
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `set OPENAI_API_KEY=${key}` }] },
      { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `export K=${key}` }), call_id: 'c1' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: `use this ${key}` }] },
    ), 'k.jsonl'));
    expect(out).not.toContain(key);
    expect(out).toContain('[REDACTED]');
  });

  test('unparseable tool arguments keep the call name only', () => {
    const [s] = parseCodexSession(session({ type: 'function_call', name: 'shell', arguments: '{oops', call_id: 'c' }), 'a.jsonl');
    expect(s.toolCalls).toEqual([{ name: 'Bash', ts: ts(1) }]);
  });
});

describe('codexSessionFiles', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test('lists rollout files under the date tree, skipping symlinks and other files', async () => {
    root = mkdtempSync(join(tmpdir(), 'codex-files-'));
    const day = join(root, '2026', '10', '01');
    mkdirSync(day, { recursive: true });
    const real = join(day, 'rollout-2026-10-01T10-00-00-abc.jsonl');
    writeFileSync(real, '{}\n');
    utimesSync(real, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    writeFileSync(join(day, 'notes.jsonl'), '{}\n');
    writeFileSync(join(day, 'rollout-x.json'), '{}\n');
    const outside = mkdtempSync(join(tmpdir(), 'codex-outside-'));
    writeFileSync(join(outside, 'rollout-secret.jsonl'), '{}\n');
    symlinkSync(join(outside, 'rollout-secret.jsonl'), join(day, 'rollout-link.jsonl'));
    symlinkSync(outside, join(root, '2026', 'linked-dir'));
    try {
      expect(await codexSessionFiles(root)).toEqual([{ path: real, size: 3, mtimeMs: 1_700_000_000_000 }]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a missing root is an empty list', async () => {
    expect(await codexSessionFiles(join(tmpdir(), 'no-such-codex-root-' + Date.now()))).toEqual([]);
  });

  test('a symlinked root is not followed', async () => {
    root = mkdtempSync(join(tmpdir(), 'codex-files-'));
    const target = join(root, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'rollout-a.jsonl'), '{}\n');
    symlinkSync(target, join(root, 'sessions'));
    expect(await codexSessionFiles(join(root, 'sessions'))).toEqual([]);
  });
});
