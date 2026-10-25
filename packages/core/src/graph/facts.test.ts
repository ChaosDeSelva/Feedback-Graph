import { expect, test } from 'vitest';
import { isManifestDependency, MAX_SCAN_REQUESTS, scanRequestPaths } from './facts.ts';

test('scan requests keep repo-relative paths only, each once, and at most MAX_SCAN_REQUESTS', () => {
  expect(scanRequestPaths(['src/a.ts', './src/a.ts', ' src/b.ts ', '', '.', '/etc/passwd', '../x.ts', 'src/../../x.ts', 'a\0b'])).toEqual(['src/a.ts', 'src/b.ts']);
  expect(scanRequestPaths(Array.from({ length: 80 }, (_, i) => `f${i}.ts`))).toHaveLength(MAX_SCAN_REQUESTS);
});

test('a manifest dependency list is told apart from other facts, older ones by the manifest reader\'s reason', () => {
  expect(isManifestDependency({ kind: 'dependency', origin: 'manifest' })).toBe(true);
  expect(isManifestDependency({ kind: 'dependency', origin: null, why: 'Read directly from package.json; no model involved.' })).toBe(true);
  expect(isManifestDependency({ kind: 'dependency', origin: 'model' })).toBe(false);
  expect(isManifestDependency({ kind: 'command', origin: 'manifest' })).toBe(false);
});
