import { expect, test } from 'vitest';
import { writesMemory } from './memoryWrite.ts';
import type { ToolCall } from './types.ts';

const ts = '2026-10-01T00:00:00Z';
const PATH = '/home/me/.claude/projects/shop/memory/testing.md';

test('an edit tool writing the memory file is a write, matched by its memory-relative name on any OS', () => {
  expect(writesMemory([{ name: 'Write', ts, filePath: PATH }], PATH)).toBe(true);
  expect(writesMemory([{ name: 'apply_patch', ts, filePath: 'C:\\Users\\me\\.claude\\projects\\shop\\memory\\testing.md' }], PATH)).toBe(true);
  expect(writesMemory([{ name: 'Edit', ts, filePath: '/elsewhere/memory/testing.md' }], 'C:\\x\\memory\\testing.md')).toBe(true);
});

test('reading the memory file, or writing a different one, is not a write', () => {
  expect(writesMemory([{ name: 'Read', ts, filePath: PATH }], PATH)).toBe(false);
  expect(writesMemory([{ name: 'Write', ts, filePath: '/home/me/.claude/projects/shop/memory/other.md' }], PATH)).toBe(false);
  expect(writesMemory([{ name: 'Write', ts, filePath: '/home/me/notes/testing.md' }], PATH)).toBe(false);
  expect(writesMemory([], PATH)).toBe(false);
});

test('a shell command counts only when it writes to the file, not when it reads or mentions it', () => {
  const bash = (command: string): ToolCall[] => [{ name: 'Bash', ts, command }];
  for (const command of [
    `echo "x" > ${PATH}`, `cat a | tee ${PATH}`, `cp /tmp/t.md ${PATH}`, `mv /tmp/t.md ${PATH}`, `sed -i 's/a/b/' ${PATH}`,
    `python -c "open('${PATH}').write_text('x')"`, `node -e "fs.writeFile('${PATH}')"`,
  ]) expect(writesMemory(bash(command), PATH), command).toBe(true);
  for (const command of [`cat ${PATH}`, `grep foo ${PATH}`, `echo hi > /tmp/memory/other.md`, 'ls'])
    expect(writesMemory(bash(command), PATH), command).toBe(false);
  // a Bash call with no command at all
  expect(writesMemory([{ name: 'Bash', ts }], PATH)).toBe(false);
});
