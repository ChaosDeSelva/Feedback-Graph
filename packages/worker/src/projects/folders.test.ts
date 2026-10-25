import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { repoHas } from '../postmortem/paths.ts';
import { containerFolders } from './folders.ts';

test('project folders are found under the container side of the roots, never at the host path', async () => {
  const container = mkdtempSync(join(tmpdir(), 'fbfolders-'));
  mkdirSync(join(container, 'demo-shop/src'), { recursive: true });
  mkdirSync(join(container, 'github.com/acme/web'), { recursive: true });
  // The host path is what listProjects stores; inside Docker it is not there.
  const roots = [
    { host: '/Users/you/Vibe', container: join(tmpdir(), 'fb-no-such-root') },
    { host: '/Users/you/src', container, nested: ['github.com/acme/web'] },
  ];
  const folders = await containerFolders(['demo-shop', 'github.com__acme__web', 'acme'], roots);
  expect(folders).toEqual([
    { key: 'demo-shop', repoPath: join(container, 'demo-shop') },
    { key: 'github.com__acme__web', repoPath: join(container, 'github.com/acme/web') },
  ]);
  // So a lesson path that is gone is seen as gone (at the host path, repoHas could not tell and said yes).
  expect(await repoHas(folders[0].repoPath, 'src/gone.ts')).toBe(false);
  expect(await repoHas('/Users/you/src/demo-shop', 'src/gone.ts')).toBe(true);
});
