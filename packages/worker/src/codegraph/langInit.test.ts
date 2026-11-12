import { expect, test, vi } from 'vitest';

// The tree-sitter runtime fails to start once (as a wasm fetch or a memory limit can), then works.
vi.mock('web-tree-sitter', async (importOriginal) => {
  const m = await importOriginal<typeof import('web-tree-sitter')>();
  let failures = 1;
  class Parser extends m.Parser {
    static override init(...args: Parameters<typeof m.Parser.init>) {
      if (failures-- > 0) return Promise.reject(new Error('runtime did not start'));
      return m.Parser.init(...args);
    }
  }
  return { ...m, Parser };
});

const { loadParser } = await import('./lang.ts');

test('a tree-sitter runtime that fails to start is started again on the next load, not cached as failed', async () => {
  await expect(loadParser('typescript')).rejects.toThrow('runtime did not start');
  const parser = await loadParser('typescript');
  const tree = parser!.parse('const a = 1;\n');
  expect(tree?.rootNode.type).toBe('program');
  tree?.delete();
});
