import { expect, test } from 'vitest';
import { mapCap, rankCodePaths } from './rank.ts';

test('source before tests before manifests before docs before other, whatever the alphabet says', () => {
  const paths = ['.github/workflows/ci.yml', 'deploy/k8s/api.yaml', 'docs/guide.md', 'README.md', 'pyproject.toml', 'Dockerfile', 'src/app/main.ts', 'src/app/main.test.ts', 'src/svc/handler.py', 'tests/test_handler.py'];
  expect(rankCodePaths(paths)).toEqual([
    'src/app/main.ts', 'src/svc/handler.py',
    'src/app/main.test.ts', 'tests/test_handler.py',
    'Dockerfile', 'pyproject.toml',
    'README.md', 'docs/guide.md',
    'deploy/k8s/api.yaml', '.github/workflows/ci.yml',
  ]);
});

test('within source, languages whose imports resolve come before the rest (shell, terraform, sql)', () => {
  const paths = ['.claude/skills/run.sh', 'db/seeds/a.sql', 'deploy/terraform/main.tf', 'src/webapp/page.tsx', 'src/lib/util.go', 'src/legacy/Thing.java'];
  expect(rankCodePaths(paths)).toEqual(['src/lib/util.go', 'src/webapp/page.tsx', 'src/legacy/Thing.java', 'db/seeds/a.sql', 'deploy/terraform/main.tf', '.claude/skills/run.sh']);
});

test('the manifests imports are resolved against come first: a capped map still resolves its imports', () => {
  const paths = ['src/a.ts', 'web/tsconfig.json', 'package.json', 'go.mod', 'svc/Cargo.toml', 'README.md'];
  expect(rankCodePaths(paths).slice(0, 4)).toEqual(['go.mod', 'package.json', 'svc/Cargo.toml', 'web/tsconfig.json']);
});

test('files sessions edited (most recent first) come before everything else; ones not listed are ignored', () => {
  const paths = ['a/x.ts', 'b/y.ts', 'docs/z.md', 'src/webapp/page.tsx'];
  expect(rankCodePaths(paths, { priority: ['docs/z.md', 'gone.ts', 'src/webapp/page.tsx'] })).toEqual(['docs/z.md', 'src/webapp/page.tsx', 'a/x.ts', 'b/y.ts']);
});

test('hidden folders sort after visible ones in the same tier', () => {
  expect(rankCodePaths(['.config/a.ts', 'z/b.ts'])).toEqual(['z/b.ts', '.config/a.ts']);
});

test('mapCap: a set SCAN_MAX_FILES wins; unset, 40% of the candidates between 400 and 4000', () => {
  expect(mapCap(250, 10_000)).toBe(250);
  expect(mapCap(null, 100)).toBe(400);
  expect(mapCap(null, 2_000)).toBe(800);
  expect(mapCap(null, 10_290)).toBe(4000);
});
