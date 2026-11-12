import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileInfo } from '../cycle.ts';

/** Claude Code transcripts sit one level down: <transcripts>/<encoded-project>/<session>.jsonl. Links are not followed. */
export async function claudeTranscriptFiles(dir: string): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    for (const f of await readdir(join(dir, d.name)).catch(() => [] as string[])) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(dir, d.name, f);
      const s = await lstat(path).catch(() => null);
      if (s?.isFile()) out.push({ path, size: s.size, mtimeMs: s.mtimeMs, source: 'claude' });
    }
  }
  return out;
}
