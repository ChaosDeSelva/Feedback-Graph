import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { keyOfRel, type ActivityStore, type LessonInput, type GraphStore, type RunTag } from '@fb/core';
import type { FileState } from '../state.ts';

export type MemoryNote = { name: string; description: string; type: string; body: string };

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '');

/** Claude Code memory files: YAML-ish frontmatter (type at top level or under metadata) + markdown body. */
export function parseMemoryFile(text: string): MemoryNote | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const field = (k: string) => {
    const hit = m[1].match(new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm'));
    return hit ? unquote(hit[1]) : '';
  };
  return { name: field('name'), description: field('description'), type: field('type'), body: m[2].trim() };
}

const encode = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-');

/** Claude Code names project dirs by encoding the cwd; subdirectory sessions get their own dir. */
export function projectKeyForDir(dirName: string, hostRoot: string, keys: string[]): string | null {
  let best: string | null = null;
  for (const key of keys) {
    const enc = encode(`${hostRoot.replace(/\/+$/, '')}/${key}`);
    if ((dirName === enc || dirName.startsWith(`${enc}-`)) && (!best || key.length > best.length)) best = key;
  }
  return best;
}

/**
 * The project key a transcripts dir maps to under any root (the longest match, so the deepest nested repo), or null.
 * `keys` are the project folders relative to their root (a nested repo's path, e.g. github.com/org/repo).
 */
function keyForDir(dir: string, roots: { host: string; keys: string[] }[]): string | null {
  const rel = roots
    .map((r) => projectKeyForDir(dir, r.host, r.keys))
    .reduce<string | null>((best, k) => (k && (!best || k.length > best.length) ? k : best), null);
  return rel && keyOfRel(rel);
}

/** The project a memory file (<transcriptsDir>/<dir>/memory/<file>) is imported for, or null. */
export function memoryProjectKey(path: string, transcriptsDir: string, roots: { host: string; keys: string[] }[]): string | null {
  const rel = relative(transcriptsDir, path);
  if (rel.startsWith('..')) return null;
  const [dir] = rel.split(sep);
  return dir && dir !== rel ? keyForDir(dir, roots) : null;
}

export type MemoryDeps = {
  transcriptsDir: string;
  /** Each project root on the host and the project folders under it (relative paths: a nested repo's has a /). */
  roots(): Promise<{ host: string; keys: string[] }[]>;
  /** INGEST_PROJECTS: when set, memories of other projects are left alone. */
  includeProject?: (key: string) => boolean;
  state: FileState;
  embed(texts: string[]): Promise<number[][]>;
  upsertLesson(l: LessonInput): Promise<void>;
  activity?: Pick<ActivityStore, 'record'>;
  /** MEMORY_AUTO_APPROVE: import as approved. Default: proposed, waiting for you in Lessons like a post-mortem's lesson. */
  autoApprove?: boolean;
  runForWrite?(projectKey: string, path: string): Promise<RunTag | null>;
  /** True when the session wrote this memory after feedback already represented in the Inbox. */
  writtenAfterFeedback?(projectKey: string, path: string): Promise<boolean | string | null>;
  withdrawDuplicate?(id: string, feedbackId: string | null): Promise<void>;
  beginCorrelation?(): void;
};

/**
 * Import `type: feedback` memories as project lessons: proposed (or approved with MEMORY_AUTO_APPROVE). Returns how many
 * were (re)imported. A lesson you have decided on or edited is never overwritten by a later version of its file.
 */
export async function importMemories(d: MemoryDeps): Promise<number> {
  d.beginCorrelation?.();
  const roots = await d.roots();
  let imported = 0;
  const recheck = d.state.getSetting('memory-dedup-v3') !== 'done';
  for (const dir of await readdir(d.transcriptsDir).catch(() => [] as string[])) {
    const projectKey = keyForDir(dir, roots);
    if (!projectKey || (d.includeProject && !d.includeProject(projectKey))) continue;
    const memDir = join(d.transcriptsDir, dir, 'memory');
    for (const file of await readdir(memDir).catch(() => [] as string[])) {
      if (!file.endsWith('.md') || file === 'MEMORY.md') continue;
      const path = join(memDir, file);
      const s = await stat(path).catch(() => null); // deleted (or a dangling link) since readdir
      if (!s?.isFile()) continue;
      const changed = d.state.changed(path, s.size, s.mtimeMs);
      const note = parseMemoryFile(await readFile(path, 'utf8'));
      const run = await d.runForWrite?.(projectKey, path);
      const duplicate = note?.type === 'feedback' ? await d.writtenAfterFeedback?.(projectKey, path) : false;
      if (duplicate && d.state.getSetting(`memory-duplicate:${path}`) !== String(duplicate)) {
        await d.withdrawDuplicate?.(`memory:${dir}/${file}`, typeof duplicate === 'string' ? duplicate : null);
        d.state.setSetting(`memory-duplicate:${path}`, String(duplicate));
      }
      if (!duplicate && !changed && !recheck) continue;
      if (note?.type === 'feedback' && !duplicate) {
        const [embedding] = await d.embed([`${note.name}\n${note.description}\n${note.body}`]);
        const oldId = `memory:${dir}/${file}`;
        if (run) await d.withdrawDuplicate?.(oldId, null);
        const id = run ? `${oldId}:run:${run.id}` : oldId;
        const title = note.name || file.replace(/\.md$/, '');
        await d.upsertLesson({
          id,
          projectKey,
          title,
          rule: note.body,
          appliesWhen: note.description,
          scope: 'project',
          paths: [],
          status: d.autoApprove ? 'approved' : 'proposed',
          source: 'memory',
          ...(run && { run }),
          embedding,
        });
        await d.activity?.record({
          ...(run && { run: run.id, sandbox: run.sandbox }),
          kind: 'memory_imported',
          actor: 'memory-file',
          projectKey,
          subject: `lesson "${title}" imported`,
          why: `a feedback memory in ${file} (written in an earlier Claude Code session); ${
            d.autoApprove ? 'approved on import because MEMORY_AUTO_APPROVE is on' : 'proposed: approve it in Lessons before agents are served it'
          }`,
          details: { file: path, description: note.description },
          targets: [id],
        });
        imported++;
      }
      d.state.mark(path, s.size, s.mtimeMs, projectKey);
    }
  }
  d.state.setSetting('memory-dedup-v3', 'done');
  return imported;
}

/** Persisted session calls are authoritative, including shell and Codex writes and old/rejected Inbox events. */
export async function feedbackForMemoryWrite(repo: Pick<GraphStore, 'listCandidates' | 'callsAfter'>, projectKey: string, path: string): Promise<string | null> {
  const suffix = `/memory/${path.replaceAll('\\', '/').split('/').at(-1)}`;
  const seen = new Set<string>();
  for (let offset = 0; ; offset += 500) {
    const page = await repo.listCandidates({ projectKey, limit: 500, offset, includeSandbox: true });
    const fresh = page.filter((candidate) => !seen.has(candidate.id));
    if (!fresh.length) return null;
    for (const candidate of fresh) {
      seen.add(candidate.id);
      const after = await repo.callsAfter(candidate.turnUuid);
      if (after?.calls.some((call) => {
        if (/(?:write|edit|patch)/i.test(call.name) && call.filePath?.replaceAll('\\', '/').endsWith(suffix)) return true;
        const command = call.command?.replaceAll('\\', '/');
        return !!command?.includes(suffix) && /(?:>|\btee\b|\bcp\b|\bmv\b|write_text|writeFile|\bsed\s+-i\b)/.test(command);
      })) return candidate.id;
    }
    if (page.length < 500) return null;
  }
}

/** Cache transcript queries only for one memory pass; newly classified feedback is visible next cycle. */
export function memoryWriteLookup(repo: Pick<GraphStore, 'listCandidates' | 'callsAfter'>) {
  const pages = new Map<string, ReturnType<GraphStore['listCandidates']>>();
  const calls = new Map<string, ReturnType<GraphStore['callsAfter']>>();
  const cached: Pick<GraphStore, 'listCandidates' | 'callsAfter'> = {
    listCandidates: (filter) => { const key = JSON.stringify(filter); if (!pages.has(key)) pages.set(key, repo.listCandidates(filter)); return pages.get(key)!; },
    callsAfter: (uuid) => { if (!calls.has(uuid)) calls.set(uuid, repo.callsAfter(uuid)); return calls.get(uuid)!; },
  };
  return { reset: () => { pages.clear(); calls.clear(); }, find: (projectKey: string, path: string) => feedbackForMemoryWrite(cached, projectKey, path) };
}
