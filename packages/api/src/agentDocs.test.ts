import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { agentDocsFor } from './agentDocs.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('the AGENTS.md and CLAUDE.md files on the path of named files: nearest first, each file once, none from outside the repo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbagentdocs-'));
  const outside = mkdtempSync(join(tmpdir(), 'fbagentdocs-out-'));
  dirs.push(dir, outside);
  const w = (p: string, c = '# rules\n') => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  // The root's CLAUDE.md links to its AGENTS.md (one file, listed once); a service has both, linked the same way.
  w('AGENTS.md');
  symlinkSync('AGENTS.md', join(dir, 'CLAUDE.md'));
  w('src/storefront/AGENTS.md');
  symlinkSync('AGENTS.md', join(dir, 'src/storefront/CLAUDE.md'));
  // A deeper folder with a CLAUDE.md of its own, a link out of the repo, and a folder named like the file.
  w('src/storefront/core/CLAUDE.md');
  w('src/storefront/core/src/a.ts', 'x');
  w('src/storefront/apps/api/b.ts', 'x');
  writeFileSync(join(outside, 'AGENTS.md'), '# not ours\n');
  symlinkSync(join(outside, 'AGENTS.md'), join(dir, 'src/storefront/apps/AGENTS.md'));
  mkdirSync(join(dir, 'src/storefront/apps/api/AGENTS.md'));
  w('src/sync/x.py', 'x');
  // A dangling link and a link to a folder are not files.
  symlinkSync('gone.md', join(dir, 'src/sync/AGENTS.md'));
  symlinkSync('../storefront', join(dir, 'src/sync/CLAUDE.md'));
  const got = await agentDocsFor(dir, ['src/storefront/apps/api/b.ts', 'src/storefront/core/src/a.ts', 'src/sync/x.py', 'README.md']);
  expect(got).toEqual(['src/storefront/core/CLAUDE.md', 'src/storefront/AGENTS.md', 'AGENTS.md']);
  // The same for one file, and nothing for a folder that is gone.
  expect(await agentDocsFor(dir, ['src/storefront/core/src/a.ts'])).toEqual(['src/storefront/core/CLAUDE.md', 'src/storefront/AGENTS.md', 'AGENTS.md']);
  expect(await agentDocsFor(join(dir, 'missing'), ['a.ts'])).toEqual([]);
});

test('a named folder lists its own AGENTS.md first; a link to a secret file is never listed (sweep 4 rel #2, NEW-7)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fbagentdocs-'));
  dirs.push(dir);
  const w = (p: string, c = '# rules\n') => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
  w('AGENTS.md');
  w('src/notify/internal/pagerules/AGENTS.md');
  w('src/notify/internal/pagerules/rule.go', 'x');
  w('.env', 'TOKEN=x\n');
  w('deploy/app.yaml', 'x');
  symlinkSync('../.env', join(dir, 'deploy/AGENTS.md'));
  expect(await agentDocsFor(dir, ['deploy/app.yaml'])).toEqual(['AGENTS.md']);
  for (const f of ['src/notify/internal/pagerules', 'src/notify/internal/pagerules/']) expect(await agentDocsFor(dir, [f])).toEqual(['src/notify/internal/pagerules/AGENTS.md', 'AGENTS.md']);
});
