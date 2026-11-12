import type { HumanTurn, ToolCall } from '@fb/core';
import { expect, test } from 'vitest';
import { relativeTo, renderTurn } from './summarize.ts';

const turn = (o: Partial<HumanTurn>): HumanTurn => ({ uuid: 'u', sessionId: 's', ts: 't', index: 3, text: 'do it', precedingAssistantText: '', precedingToolCalls: [], ...o });

test('a turn shows the files the agent touched (relative to the session), repeated tools counted, and a long list cut', () => {
  const calls: ToolCall[] = [
    { name: 'Edit', ts: 't', filePath: '/w/app/src/a.ts' }, { name: 'Read', ts: 't', filePath: '/elsewhere/b.ts' },
    { name: 'Bash', ts: 't', command: 'ls' }, { name: 'Bash', ts: 't', command: 'pwd' }, { name: 'Grep', ts: 't' },
    ...Array.from({ length: 30 }, (_, i): ToolCall => ({ name: 'Read', ts: 't', filePath: `/w/app/f${i}.ts` })),
  ];
  const r = renderTurn(turn({ precedingToolCalls: calls }), '/w/app/');
  expect(r).toContain('AGENT TOOLS: Edit src/a.ts, Read /elsewhere/b.ts, Read f0.ts');
  expect(r).toMatch(/, and 4 more\n/);
  expect(renderTurn(turn({ precedingToolCalls: calls.slice(2, 5) }), null)).toContain('AGENT TOOLS: Bash ×2, Grep');
});

test("a long message is clipped, and one retention emptied says so; the agent's reply comes first", () => {
  const r = renderTurn(turn({ text: 'x'.repeat(2500), precedingAssistantText: 'done' }), null);
  expect(r).toBe(`[turn 3 · t]\nAGENT (reply before this turn): done\nDEVELOPER: ${'x'.repeat(2000)}…`);
  expect(renderTurn(turn({ text: '' }), null)).toBe('[turn 3 · t]\nDEVELOPER: (text removed by retention)');
});

test('a path outside the session folder, or with no folder known, stays as it is', () => {
  expect(relativeTo('/w/app', '/w/application/x.ts')).toBe('/w/application/x.ts');
  expect(relativeTo(null, '/w/app/x.ts')).toBe('/w/app/x.ts');
});
