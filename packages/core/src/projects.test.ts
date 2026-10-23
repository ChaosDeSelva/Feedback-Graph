import { expect, test } from 'vitest';
import { projectFromCwd } from './projects.ts';

const roots = [{ host: '/Users/you/code', container: '/vibe' }];

test('maps a nested cwd to its top-level project', () => {
  expect(projectFromCwd('/Users/you/code/GameX_1.2.0/source', roots)).toEqual({
    key: 'GameX_1.2.0',
    name: 'GameX_1.2.0',
    repoPath: '/vibe/GameX_1.2.0',
  });
});

test('the root itself is not a project', () => {
  expect(projectFromCwd('/Users/you/code', roots)).toBeNull();
  expect(projectFromCwd('/Users/you/code/', roots)).toBeNull();
});

test('paths outside every root are skipped', () => {
  expect(projectFromCwd('/private/tmp/x', roots)).toBeNull();
  expect(projectFromCwd('/Users/you/codeOther/x', roots)).toBeNull();
  expect(projectFromCwd('', roots)).toBeNull();
});

test('rootsFromEnv pairs container and host roots, rejecting mismatched lists', async () => {
  const { rootsFromEnv } = await import('./projects.ts');
  expect(rootsFromEnv('/vibe,/code', '/Users/j/Vibe,/Users/j/Code')).toEqual([
    { container: '/vibe', host: '/Users/j/Vibe' },
    { container: '/code', host: '/Users/j/Code' },
  ]);
  expect(() => rootsFromEnv('/vibe', '')).toThrow();
});

test('the most specific (longest) root wins when roots are nested', () => {
  const nested = [
    { host: '/Users/j/Vibe', container: '/vibe' },
    { host: '/Users/j/Vibe/feedback_tool/examples', container: '/examples' },
  ];
  expect(projectFromCwd('/Users/j/Vibe/feedback_tool/examples/demo-shop/src', nested)).toEqual({
    key: 'demo-shop', name: 'demo-shop', repoPath: '/examples/demo-shop',
  });
  expect(projectFromCwd('/Users/j/Vibe/feedback_tool', nested)?.key).toBe('feedback_tool');
});
