import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { relOfKey, type Root } from '@fb/core';

/**
 * The folders of these projects as the worker sees them: under the container side of the first root that has them
 * (plain directories only, nested repos too). A project under no root is left out. Never the host path a project
 * summary stores: inside Docker that is not there, and a check against it can tell nothing.
 */
export async function containerFolders(keys: readonly string[], roots: readonly Root[]): Promise<{ key: string; repoPath: string }[]> {
  const out: { key: string; repoPath: string }[] = [];
  for (const key of keys) {
    for (const r of roots) {
      const repoPath = join(r.container, relOfKey(key, r));
      if ((await lstat(repoPath).catch(() => null))?.isDirectory()) {
        out.push({ key, repoPath });
        break;
      }
    }
  }
  return out;
}
