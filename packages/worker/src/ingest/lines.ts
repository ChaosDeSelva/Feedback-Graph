import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';

/** A file a line at a time (Codex rollouts can pass 800 MB). O_NOFOLLOW: a file swapped for a link is refused. */
export async function* readLines(path: string): AsyncIterable<string> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stream = fh.createReadStream({ encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    stream.destroy();
    await fh.close().catch(() => {});
  }
}
