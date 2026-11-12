import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isSecretPath, type MapSymbol } from '@fb/core';
import { fileMaxBytes, isParsedPath, parseSymbols } from '@fb/worker/codegraph';

/** Files whose parsed symbols are kept, least recently used dropped first: the named files of recent calls. */
export const SYMBOL_CACHE_FILES = 256;

/**
 * The symbols of a named repo file, parsed when asked (ContextDeps.parseSymbols): a file past the code map's cap has
 * none in the map. Bounded like the map itself: only a source file the map parses, within its size limit (fileMaxBytes),
 * inside the repo (no link out) and not secret-named; anything else is null. Kept by content hash, so a file asked
 * about again is parsed again only once it changed.
 */
export function symbolsOnDemand(limits: { maxBytes: number; sourceMaxBytes?: number }, cacheFiles = SYMBOL_CACHE_FILES) {
  const cache = new Map<string, MapSymbol[]>();
  return async (repoPath: string, rel: string): Promise<MapSymbol[] | null> => {
    if (!rel || rel.startsWith('/') || rel.split('/').some((s) => s === '..' || s === '') || isSecretPath(rel) || !isParsedPath(rel)) return null;
    const root = await realpath(repoPath).catch(() => null);
    const abs = root && (await realpath(join(root, rel)).catch(() => null));
    if (!root || !abs || !abs.startsWith(`${root}/`) || isSecretPath(abs.slice(root.length + 1))) return null;
    const st = await lstat(abs).catch(() => null);
    if (!st?.isFile() || st.size > fileMaxBytes(rel, limits)) return null;
    const buf = await readFile(abs);
    const key = `${repoPath}\0${rel}\0${createHash('sha1').update(buf).digest('hex')}`;
    const kept = cache.get(key);
    if (kept) {
      cache.delete(key);
      cache.set(key, kept);
      return kept;
    }
    const symbols = await parseSymbols(rel, buf.toString('utf8'));
    cache.set(key, symbols);
    while (cache.size > cacheFiles) cache.delete(cache.keys().next().value!);
    return symbols;
  };
}
