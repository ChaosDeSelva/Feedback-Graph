import { expect, test } from 'vitest';
import { isTestPath, langOf, loadParser } from './lang.ts';

test('langOf maps extensions to grammars and everything else to its extension or name', () => {
  expect(langOf('src/a.ts')).toBe('typescript');
  expect(langOf('src/a.d.ts')).toBe('typescript');
  expect(langOf('src/A.tsx')).toBe('tsx');
  expect(['a.js', 'a.jsx', 'a.mjs', 'a.cjs'].map(langOf)).toEqual(['javascript', 'javascript', 'javascript', 'javascript']);
  expect(langOf('pkg/mod.py')).toBe('python');
  expect(langOf('main.go')).toBe('go');
  expect(langOf('src/lib.rs')).toBe('rust');
  expect(langOf('App/Program.cs')).toBe('csharp');
  expect(langOf('Sources/App/View.swift')).toBe('swift');
  expect(langOf('scenes/player.gd')).toBe('gdscript');
  expect(langOf('README.md')).toBe('md');
  expect(langOf('docker/Dockerfile')).toBe('dockerfile');
  expect(langOf('.gitignore')).toBe('gitignore');
});

test('isTestPath recognises test naming conventions and test directories', () => {
  for (const p of [
    'src/a.test.ts', 'src/a.spec.tsx', 'src/repo.int.test.ts', 'test_api.py', 'pkg/api_test.py', 'cmd/main_test.go',
    'src/__tests__/a.ts', 'tests/conftest.py', 'pkg/tests/helpers/x.py', 'test/setup.js', 'App.Tests/FooTests.cs', 'Tests/AppTests/ViewTests.swift', 'game/test_player.gd',
  ]) expect(isTestPath(p), p).toBe(true);
  for (const p of ['src/latest.ts', 'src/testing.ts', 'contest.py', 'src/attest/a.ts', 'testdata.go', 'src/protest_x.py', 'Sources/Testable.swift']) {
    expect(isTestPath(p), p).toBe(false);
  }
});

test('loadParser loads every bundled grammar and has none for GDScript', async () => {
  for (const lang of ['typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'csharp', 'swift']) {
    const p = await loadParser(lang);
    expect(p, lang).not.toBeNull();
    const tree = p!.parse('x\n');
    expect(tree?.rootNode).toBeTruthy();
    tree?.delete();
  }
  expect(await loadParser('gdscript')).toBeNull();
  expect(await loadParser('md')).toBeNull();
});

test('names that collide with Object.prototype are not grammars', async () => {
  expect(await loadParser('constructor')).toBeNull();
  expect(await loadParser('toString')).toBeNull();
  expect(langOf('x.constructor')).toBe('constructor');
});
