import { extname } from 'node:path';
import type { ActivityStore, FactsStore } from '@fb/core';

/**
 * Folders of data, not code: session transcripts, logs, exported records and dumps. A project of 28,000 transcript files
 * cost a 40-shard scan in 0.6.2, and `fg status` kept asking to rescan it after every scanner change. They are left out
 * of the scan plan and the code map (the listing says which, and how many files).
 *
 * Content is not data: a data/ folder of game content definitions, a records/ or history/ folder of decision records,
 * docs/ are often what the project is about. So only a folder named like a log or a dump (STRONG_NAMES, a name part:
 * exports-2024) is data at the usual size; a merely data-ish name (WEAK_NAMES) only when very large; any other name
 * never. A folder of mostly Markdown is never data unless its name is a strong one (transcripts often are Markdown),
 * and a folder holding code (CODE_LANG) is never data.
 */
/** Names of logs, transcripts and dumps: such a folder holding DATA_NAMED_MIN files, hardly any of them code, is data. */
const STRONG_NAMES = new Set([
  'transcripts', 'transcript', 'logs', 'log', 'recordings', 'recording', 'dumps', 'dump', 'exports', 'export',
]);
/** Data-ish names that also hold content people write by hand: data only past DATA_UNNAMED_MIN files, and not docs. */
const WEAK_NAMES = new Set([
  'data', 'datasets', 'dataset', 'fixtures', '__fixtures__', 'testdata', 'samples', 'corpus', 'sessions', 'conversations', 'chats',
  'outputs', 'output', 'results', 'snapshots', 'records', 'history',
]);
/** A folder with a strong data name holding at least this many files is data (when hardly any of them is code). */
export const DATA_NAMED_MIN = 200;
/** A folder with a weak data name must hold at least this many files to be data. */
export const DATA_UNNAMED_MIN = 2000;
/** The most of a data folder's files that may be code: a strongly named one, a weakly named one. */
const NAMED_CODE_SHARE = 0.05;
const UNNAMED_CODE_SHARE = 0.02;
/** Past this share of Markdown or text docs a folder is docs, not data (unless strongly named). */
const DOCS_SHARE = 0.5;
const DOC_EXT = new Set(['.md', '.mdx', '.markdown', '.rst', '.adoc', '.org']);
/** Extensions of program code (not docs, data or config): a folder of these is never data. */
const CODE_LANG = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.swift', '.m', '.mm',
  '.cs', '.fs', '.vb', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.c', '.h', '.lua', '.gd', '.gdshader', '.glsl', '.hlsl', '.shader', '.php', '.vue',
  '.svelte', '.astro', '.sh', '.bash', '.zsh', '.ps1', '.sql', '.graphql', '.proto', '.tf', '.prisma', '.scss', '.sass', '.less', '.css', '.dart',
  '.ex', '.exs', '.erl', '.hrl', '.hs', '.ml', '.mli', '.clj', '.cljs', '.elm', '.r', '.jl', '.zig', '.nim', '.pl', '.pm', '.groovy', '.sol', '.html',
]);

const nameParts = (dir: string) => dir.slice(dir.lastIndexOf('/') + 1).toLowerCase().split(/[-_.\s]+/);

export type DataDir = { dir: string; files: number };

/** The topmost data folders among repo-relative `paths` (files), with how many files each holds; sorted by folder. */
export function dataDirs(paths: string[]): DataDir[] {
  const count = new Map<string, { files: number; code: number; docs: number }>();
  for (const p of paths) {
    const segs = p.split('/');
    const ext = extname(p).toLowerCase();
    const code = CODE_LANG.has(ext) ? 1 : 0;
    const docs = DOC_EXT.has(ext) ? 1 : 0;
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join('/');
      const c = count.get(dir) ?? { files: 0, code: 0, docs: 0 };
      c.files++;
      c.code += code;
      c.docs += docs;
      count.set(dir, c);
    }
  }
  const isData = (dir: string, c: { files: number; code: number; docs: number }) => {
    const parts = nameParts(dir);
    if (parts.some((w) => STRONG_NAMES.has(w))) return c.files >= DATA_NAMED_MIN && c.code <= NAMED_CODE_SHARE * c.files;
    if (!parts.some((w) => WEAK_NAMES.has(w))) return false;
    return c.files >= DATA_UNNAMED_MIN && c.code <= UNNAMED_CODE_SHARE * c.files && c.docs <= DOCS_SHARE * c.files;
  };
  const found: DataDir[] = [];
  for (const [dir, c] of [...count].sort(([a], [b]) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))) {
    if (found.some((f) => dir.startsWith(`${f.dir}/`))) continue;
    if (isData(dir, c)) found.push({ dir, files: c.files });
  }
  return found.sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

/** `paths` without the files in data folders (dataDirs), and those folders. */
export function withoutDataDirs(paths: string[]): { paths: string[]; dataDirs: DataDir[] } {
  const dirs = dataDirs(paths);
  if (!dirs.length) return { paths, dataDirs: [] };
  return { paths: paths.filter((p) => !dirs.some((d) => p.startsWith(`${d.dir}/`))), dataDirs: dirs };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export type ForgetDataDeps = {
  facts: Pick<FactsStore, 'fileHashes' | 'markFilesRemoved'>;
  projects: () => Promise<{ key: string; repoPath: string }[]>;
  activity?: Pick<ActivityStore, 'record'>;
  log?: (msg: string, extra?: object) => void;
};

/**
 * A rule change migrates its data: files a scan read in what are now data folders (before they were left out) are
 * marked removed at start, their facts closed and their hashes forgotten, so they no longer count as read by an older
 * scanner and `fg status` stops asking for a rescan of them. Once per change in effect: a project with none left is
 * passed over. What was forgotten is in Activity, per project.
 */
export async function forgetDataFiles(d: ForgetDataDeps): Promise<{ files: number; projects: number }> {
  const total = { files: 0, projects: 0 };
  for (const p of await d.projects()) {
    const stored = [...(await d.facts.fileHashes(p.key)).keys()];
    const { paths, dataDirs: dirs } = withoutDataDirs(stored);
    if (!dirs.length) continue;
    const kept = new Set(paths);
    const gone = stored.filter((x) => !kept.has(x));
    await d.facts.markFilesRemoved(p.key, gone);
    total.files += gone.length;
    total.projects++;
    await d.activity?.record({
      kind: 'facts_extracted', actor: 'deterministic', projectKey: p.key,
      subject: `forgot ${plural(gone.length, 'file')} in data folders of ${p.key}: ${dirs.slice(0, 5).map((x) => `${x.dir}/ (${x.files})`).join(', ')}${dirs.length > 5 ? ', ...' : ''}`,
      why: 'folders of data (transcripts, logs, exports, dumps, very large data sets) are no longer scanned: their files were read by an earlier scan, so they are forgotten and no longer count toward a rescan',
      details: { dataDirs: dirs.slice(0, 50), files: gone.length },
      targets: dirs.slice(0, 20).map((x) => `${p.key}:${x.dir}`),
    });
    d.log?.('data files forgotten', { project: p.key, files: gone.length, dirs: dirs.length });
  }
  return total;
}
