import { redactSecrets } from '@fb/core';
import { extract } from './extract.ts';
import { langOf } from './lang.ts';
import type { CodeSymbol } from './types.ts';

/** What the api reads of the code map's parser: which size limit a file falls under, and a file's symbols. */
export { fileMaxBytes, isParsedPath } from './lang.ts';

/**
 * The symbols of one file as the map would keep them (names redacted), parsed now: for a file an agent names that the
 * map keeps no symbols for (past its cap). Empty for a language the map does not parse or content it cannot.
 */
export async function parseSymbols(path: string, content: string): Promise<CodeSymbol[]> {
  const ex = await extract(langOf(path), content).catch(() => null);
  return (ex?.symbols ?? []).map((s) => {
    const name = redactSecrets(s.name);
    return { id: `${path}#${name}`, path, ...s, name };
  });
}
