import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { calibrateRelevance, type ActivityStore, type FactCheck, type FactsStore, type RelevanceUpdate, type StoredFact } from '@fb/core';
import { checkCitations, FACT_CHECK_VERSION, repoReader, summarizeDependencies } from './scan.ts';

export type RecheckDeps = {
  /** setFactRelevance (optional): calibrate the relevance a model gave stored facts (calibrateRelevance). */
  facts: Pick<FactsStore, 'factsToRecheck' | 'applyFactChecks' | 'listFacts' | 'markFilesRemoved'> & Partial<Pick<FactsStore, 'setFactRelevance'>>;
  /** Embeds a reworded fact's new statement (as the scan does: "path: statement"); absent: its embedding stays. */
  embed?: (texts: string[]) => Promise<number[][]>;
  /** The selected projects and their folders as the worker sees them. */
  projects: () => Promise<{ key: string; repoPath: string }[]>;
  maxBytes: number;
  activity?: Pick<ActivityStore, 'record'>;
  log?: (msg: string, extra?: object) => void;
  /** Facts per store round trip. */
  batch?: number;
};

/** shortened: dependency facts summarized (summarizeDependencies); recalibrated: model relevance scores calibrated. */
export type RecheckResult = { checked: number; closed: number; linesDropped: number; shortened: number; recalibrated: number };

/** Facts listed in an Activity entry at most (the counts are always whole). */
const LISTED = 50;
/**
 * More than this share of a project's distinct cited files missing (and more than one) means the folder is not the
 * repo the facts are about (a wrong mount, where package.json and the README may still be there): the project is skipped.
 */
const MISSING_RATIO = 0.3;
/** Current facts per page when counting a project's cited files. */
const PAGE = 500;
/** A dependency list summarizeDependencies can read (scan.ts DEP_SECTION): only such a fact is summarized. */
const DEP_LIST = /\b(?:Dependencies|Dev dependencies|Requires)(?: \(\d+\))?: /;

/**
 * The summary a stored dependency fact gets, or null when it stays as it is: one with no list to read (a model's prose
 * about dependencies) is not cut, since cutting would lose what it says.
 */
function dependencySummary(statement: string): string | null {
  if (!DEP_LIST.test(statement)) return null;
  const s = summarizeDependencies(statement);
  return s === statement ? null : s;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false;
const exists = async (p: string) => (await lstat(p).catch(() => null)) !== null;

/** The distinct files the project's current facts cite, and how many of them are not in the folder. */
async function citedFiles(d: RecheckDeps, key: string, repoPath: string): Promise<{ cited: number; missing: number }> {
  const paths = new Set<string>();
  for (let offset = 0; ; offset += PAGE) {
    const page = await d.facts.listFacts({ projectKey: key, limit: PAGE, offset });
    // As factsToRecheck sees them: a document's facts and yours cite no repo file.
    for (const f of page) if (f.path && f.path !== '.' && !f.docId && f.origin !== 'you') paths.add(f.path);
    if (page.length < PAGE) break;
  }
  let missing = 0;
  for (const path of paths) if (!(await exists(join(repoPath, path)))) missing++;
  return { cited: paths.size, missing };
}

/**
 * A rule change migrates its data: current scan facts last checked by an older citation rule (FACT_CHECK_VERSION) are
 * checked again against the repo as it is now, once. A fact citing an instruction file (AGENTS.md, CLAUDE.md) or a file
 * that is gone is closed, so it is no longer served; cited lines that no longer hold what the fact names are dropped
 * (the fact stays, evidence 'file'); every fact checked is stamped, so the next start does nothing. A file that is gone
 * is marked removed (its hash forgotten), so if it was only missing at start-up (an older branch checked out) the next
 * scan reads it again. What changed is in Activity, per project. A project whose folder is not there, or where too many
 * of the cited files are missing (MISSING_RATIO), is left alone, and the log says so.
 */
export async function recheckFacts(d: RecheckDeps): Promise<RecheckResult> {
  const total: RecheckResult = { checked: 0, closed: 0, linesDropped: 0, shortened: 0, recalibrated: 0 };
  const batch = d.batch ?? 500;
  for (const p of await d.projects()) {
    if (!p.repoPath || !(await isDir(p.repoPath))) continue;
    const first = await d.facts.factsToRecheck({ projectKey: p.key, version: FACT_CHECK_VERSION, limit: 1 });
    if (!first.length) continue;
    const files = await citedFiles(d, p.key, p.repoPath);
    if (files.missing > Math.max(1, MISSING_RATIO * files.cited)) {
      d.log?.('facts recheck skipped: too many of the files they cite are missing from the folder, which is likely not the repo they are about', {
        project: p.key, repoPath: p.repoPath, citedFiles: files.cited, missingFiles: files.missing,
      });
      continue;
    }
    const read = repoReader(p.repoPath, d.maxBytes);
    const mine: RecheckResult = { checked: 0, closed: 0, linesDropped: 0, shortened: 0, recalibrated: 0 };
    const closed: StoredFact[] = [];
    const unlined: StoredFact[] = [];
    /** original: the statement before it was summarized (redacted as Activity is), so it can be restored. */
    const shortened: { id: string; path: string; from: number; statement: string; original: string }[] = [];
    const recalibrated: { id: string; statement: string; from: number; to: number }[] = [];
    for (;;) {
      const facts = await d.facts.factsToRecheck({ projectKey: p.key, version: FACT_CHECK_VERSION, limit: batch });
      if (!facts.length) break;
      // A shard's fact about its own directory is about the shard as a whole: nothing to check.
      const dirs = new Set<string>();
      for (const f of facts) if (f.path !== '.' && (await lstat(join(p.repoPath, f.path)).catch(() => null))?.isDirectory()) dirs.add(f.id);
      // Checked as the scan checks what a model cites (a stored fact has a null evidence where an extracted one has none).
      const { kept, dropped } = await checkCitations(facts.filter((f) => !dirs.has(f.id)).map((f) => ({ ...f, evidence: f.evidence ?? undefined })), read);
      // A dependency fact is a summary now (summarizeDependencies), never the full list: reworded in place, re-embedded.
      const reworded = new Map<string, string>();
      for (const f of kept) {
        const summary = f.kind === 'dependency' ? dependencySummary(f.statement) : null;
        if (summary) reworded.set(f.id, summary);
      }
      const keptReworded = kept.filter((f) => reworded.has(f.id));
      const vectors = d.embed && keptReworded.length ? await d.embed(keptReworded.map((f) => `${f.path}: ${reworded.get(f.id)}`)) : [];
      const embedding = new Map(keptReworded.map((f, i) => [f.id, vectors[i] ?? null]));
      const checks: FactCheck[] = [
        ...facts.filter((f) => dirs.has(f.id)).map((f) => ({ id: f.id, keep: true, lines: null, evidence: 'none' as const })),
        ...kept.map((f) => ({ id: f.id, keep: true, lines: f.lines, evidence: f.evidence ?? null, ...(reworded.has(f.id) ? { statement: reworded.get(f.id)!, embedding: embedding.get(f.id) ?? null } : {}) })),
        ...dropped.map((f) => ({ id: f.id, keep: false, lines: f.lines, evidence: f.evidence ?? null })),
      ];
      mine.closed += await d.facts.applyFactChecks(FACT_CHECK_VERSION, checks);
      for (const f of keptReworded) shortened.push({ id: f.id, path: f.path, from: f.statement.length, statement: reworded.get(f.id)!, original: f.statement });
      mine.shortened += keptReworded.length;
      // Relevance a model gave is calibrated as a scan now calibrates it (calibrateRelevance); yours is left alone.
      if (d.facts.setFactRelevance) {
        const keptIds = new Set(kept.map((f) => f.id).concat(facts.filter((f) => dirs.has(f.id)).map((f) => f.id)));
        const scored = facts.filter((f) => keptIds.has(f.id) && f.relevanceBy === 'model' && typeof f.relevance === 'number');
        const updates: RelevanceUpdate[] = [];
        for (const [i, f] of calibrateRelevance(scored).entries()) {
          if (f.relevance === scored[i].relevance) continue;
          updates.push({ id: f.id, relevance: f.relevance!, by: 'model' });
          recalibrated.push({ id: f.id, statement: f.statement, from: scored[i].relevance!, to: f.relevance! });
        }
        if (updates.length) mine.recalibrated += await d.facts.setFactRelevance(updates);
      }
      const gone: string[] = [];
      for (const path of new Set(dropped.map((f) => f.path))) if (path !== '.' && !(await exists(join(p.repoPath, path)))) gone.push(path);
      await d.facts.markFilesRemoved(p.key, gone);
      mine.checked += checks.length;
      closed.push(...dropped);
      const lost = kept.filter((f) => f.lines === null && f.evidence === 'file' && facts.find((x) => x.id === f.id)?.lines);
      unlined.push(...lost);
      mine.linesDropped += lost.length;
      if (facts.length < batch) break;
    }
    total.checked += mine.checked;
    total.closed += mine.closed;
    total.linesDropped += mine.linesDropped;
    total.shortened += mine.shortened;
    total.recalibrated += mine.recalibrated;
    if (!mine.closed && !mine.linesDropped && !mine.shortened && !mine.recalibrated) continue;
    const row = (f: StoredFact) => ({ id: f.id, path: f.path, statement: f.statement });
    const also = [
      mine.shortened ? `${plural(mine.shortened, 'dependency list')} summarized` : '',
      mine.recalibrated ? `${plural(mine.recalibrated, 'relevance score')} calibrated` : '',
    ].filter(Boolean).map((x) => `, ${x}`).join('');
    await d.activity?.record({
      kind: 'facts_extracted',
      actor: 'deterministic',
      projectKey: p.key,
      subject: `rechecked ${plural(mine.checked, 'fact')} of ${p.key}: ${mine.closed} closed, ${mine.linesDropped} lost ${mine.linesDropped === 1 ? 'its' : 'their'} line range${also}`,
      why: `the fact rules changed (${FACT_CHECK_VERSION}), so facts saved before were checked again against the repo: a fact citing AGENTS.md, CLAUDE.md or a file that is gone is no longer served, cited lines that do not hold what a fact names were dropped from it, a dependency fact holding a full list now says how many and the notable ones (the list it held is kept in this log, so it can be restored), and a model's relevance is calibrated so everyday stays the minority (yours is left alone)`,
      details: {
        checkVersion: FACT_CHECK_VERSION, checked: mine.checked, closed: closed.slice(0, LISTED).map(row), linesDropped: unlined.slice(0, LISTED).map(row),
        ...(shortened.length ? { shortened: shortened.slice(0, LISTED) } : {}), ...(recalibrated.length ? { recalibrated: recalibrated.slice(0, LISTED) } : {}),
      },
      targets: [...new Set([...closed, ...unlined, ...shortened].slice(0, LISTED).map((f) => `${p.key}:${f.path}`))],
    });
    // Every summarized fact keeps its original: those past the first entry's list go in entries of their own.
    for (let i = LISTED; i < shortened.length; i += LISTED) {
      const part = shortened.slice(i, i + LISTED);
      await d.activity?.record({
        kind: 'facts_extracted', actor: 'deterministic', projectKey: p.key,
        subject: `dependency facts of ${p.key} summarized: originals ${i + 1}-${i + part.length} of ${shortened.length}`,
        why: 'the statements dependency facts held before they were summarized, so any of them can be restored',
        details: { checkVersion: FACT_CHECK_VERSION, shortened: part },
        targets: [...new Set(part.map((f) => `${p.key}:${f.path}`))],
      });
    }
    d.log?.('facts rechecked', { project: p.key, ...mine });
  }
  return total;
}
