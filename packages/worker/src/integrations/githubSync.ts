import { repairGithubDocs } from './githubRepair.ts';
import { INCREMENTAL_MAX_PRS, IntegrationError, parsePrBacklog, prBacklogKey, prContextToChunks, redactSecrets, ticketIdsIn, type ActivityStore, type DocsStore, type FetchPrOpts, type PrBacklog, type PrContext } from '@fb/core';

export type GithubSyncDeps = {
  /** project key → owner/repo, from GITHUB_REPOS. */
  repos: Map<string, string>;
  authors?: Map<string, string>;
  token: string;
  fetchPrs(o: FetchPrOpts): Promise<PrContext[]>;
  docs: Pick<DocsStore, 'upsertDoc' | 'getCursor' | 'setCursor' | 'githubRepairDocs' | 'githubDocChunks'> & Partial<Pick<DocsStore, 'listDocs'>>;
  embed(texts: string[]): Promise<number[][]>;
  activity?: Pick<ActivityStore, 'record'>;
  /** Skip a project synced less than this long ago. */
  minIntervalMs: number;
  now?: () => string;
  log?: (msg: string, extra?: object) => void;
};

/**
 * Set once a project's PR documents carry the Linear tickets they name. PRs synced before have none: the first sync
 * without it reads the last TICKETS_BACKFILL_DAYS again (a rule change migrates its data), then goes on from the cursor.
 */
export const ticketsCursor = (projectKey: string) => `github-tickets:${projectKey}`;
const TICKETS_BACKFILL_DAYS = 14;

const day = (iso: string) => iso.slice(0, 10);

/** One PR as its document: its description (with its state) and each comment a chunk, and the Linear tickets it names. */
export async function storePrDoc(projectKey: string, pr: PrContext, d: { docs: Pick<DocsStore, 'upsertDoc'>; embed(texts: string[]): Promise<number[][]> }): Promise<void> {
  const chunks = prContextToChunks(pr).map((c) => redactSecrets(c.text));
  const vectors = await d.embed(chunks); // a PR is at least its description
  await d.docs.upsertDoc(
    { projectKey, source: 'github', ref: `github:${pr.repo}#${pr.number}`, title: `${pr.repo}#${pr.number}: ${pr.title}`, url: pr.url },
    chunks.map((text, i) => ({ text, embedding: vectors[i] })),
    // The Linear tickets it names (ENG-123 in its title, body or branch): linked to their documents (linkedDocs).
    { tickets: ticketIdsIn(pr.title, pr.body, pr.headBranch) },
  );
}

/**
 * The PR's document stored again when it says another state than the PR has now (merged since): the comment sync reads
 * a PR every INTEGRATION_SYNC_MINUTES, the document sync only every GITHUB_SYNC_HOURS, so search_graph called a PR
 * merged hours ago "(open)". A PR with no document is left alone (the document sync decides what is stored).
 */
export async function refreshPrDocState(projectKey: string, pr: PrContext, d: { docs: Pick<DocsStore, 'upsertDoc' | 'listDocs' | 'docText'>; embed(texts: string[]): Promise<number[][]> }): Promise<boolean> {
  const ref = `github:${pr.repo}#${pr.number}`;
  const doc = (await d.docs.listDocs(projectKey, { source: 'github', ref, limit: 1 })).find((x) => x.ref === ref);
  if (!doc) return false;
  const text = await d.docs.docText(doc.id);
  if (text === null || text.startsWith(`PR ${pr.repo}#${pr.number} (${pr.state})`)) return false;
  await storePrDoc(projectKey, pr, d);
  return true;
}

/** Pull PR descriptions, reviews and comments into the docs store, one doc per PR, with the Linear tickets it names. */
export async function syncGithub(d: GithubSyncDeps): Promise<{ prs: number }> {
  const now = d.now ?? (() => new Date().toISOString());
  let prs = 0;
  for (const [projectKey, repo] of d.repos) {
    const key = `github:${projectKey}`;
    const cursor = (await d.docs.getCursor(key)) ?? undefined;
    const due = !cursor || Date.parse(now()) - Date.parse(cursor) >= d.minIntervalMs;
    const started = now();
    const ticketsKnown = !!(await d.docs.getCursor(ticketsCursor(projectKey)));
    const backfillFrom = new Date(Date.parse(started) - TICKETS_BACKFILL_DAYS * 86_400_000).toISOString();
    const since = cursor && !ticketsKnown && backfillFrom < cursor ? backfillFrom : cursor;
    try {
      const backlog = parsePrBacklog(await d.docs.getCursor(prBacklogKey(projectKey)));
      const store = async (list: PrContext[], repairing = false) => {
        for (const pr of list) {
          if (!repairing && d.authors?.get(projectKey) && pr.author.toLowerCase() !== d.authors.get(projectKey)!.toLowerCase()) continue;
          await storePrDoc(projectKey, pr, d);
        }
      };
      const repair = await repairGithubDocs({ projectKey, repo, token: d.token, docs: d.docs, fetchPrs: d.fetchPrs, store: pr => store([pr], true), now: started });
      if (repair.attemptedDocs) await d.activity?.record({ kind: 'doc_added', actor: 'github', projectKey,
        subject: repair.progress.status === 'waiting' ? `GitHub document repair waiting: ${repair.progress.pending} pending` : `verified ${repair.fetchedDocs} masked GitHub documents against their source; ${repair.repairedMasks} fewer masks`,
        why: 'Only damaged stored documents were fetched. Literal masks in the source remain literal; protected credentials stay redacted.',
        details: { recovery: 'redaction-v9-targeted', fetchedDocs: repair.fetchedDocs, repairedMasks: repair.repairedMasks, ...repair.progress } });
      if (repair.attemptedDocs) d.log?.('github document repair progress', { projectKey, ...repair.progress, fetchedDocs: repair.fetchedDocs, repairedMasks: repair.repairedMasks });
      if (repair.rateLimited) break;
      if (!due) continue;
      let readBackTo = null as string | null; // set by onCap
      const list = await d.fetchPrs({ repo, token: d.token, since, ...(d.authors?.get(projectKey) && { author: d.authors.get(projectKey) }), onCap: (t) => { readBackTo = t; } });
      await store(list);
      // Capped: the newest were read; the rest joins what was left from before (all of it older than the old cursor).
      let left: PrBacklog | null = since && readBackTo ? { since: backlog?.since ?? since, until: readBackTo } : backlog;
      let older: PrContext[] = [];
      if (!readBackTo && backlog) {
        // Not capped this time: one more batch of the backlog, newest first.
        let back = null as string | null;
        older = await d.fetchPrs({ repo, token: d.token, ...(d.authors?.get(projectKey) && { author: d.authors.get(projectKey) }), since: backlog.since, until: backlog.until, onCap: (t) => { back = t; } });
        await store(older);
        left = back ? { since: backlog.since, until: back } : null;
      }
      if (left || backlog) await d.docs.setCursor(prBacklogKey(projectKey), left ? JSON.stringify(left) : '');
      if (left) d.log?.('github sync hit its cap; the PRs it did not read are read on the next syncs', { projectKey, repo, cap: INCREMENTAL_MAX_PRS, backlog: left });
      await d.docs.setCursor(key, started);
      if (!ticketsKnown) await d.docs.setCursor(ticketsCursor(projectKey), started);
      const all = [...list, ...older];
      prs += all.length;
      if (all.length || left) {
        const why = [
          since ? `updated since the last sync at ${since}` : 'first sync of this repository',
          ...(left
            ? [`GitHub listed more than ${INCREMENTAL_MAX_PRS} updated pull requests: those updated between ${day(left.since)} and ${day(left.until)} are read on the next syncs, newest first`]
            : backlog ? ['caught up on the pull requests an earlier capped sync left for later'] : []),
        ].join('; ');
        await d.activity?.record({
          kind: 'doc_added', actor: 'github', projectKey,
          subject: `synced ${all.length} pull request${all.length === 1 ? '' : 's'} from ${repo}`,
          why,
          details: { repo, prs: all.map((p) => ({ number: p.number, title: p.title, comments: p.comments.length })), ...(left ? { backlog: left } : {}) },
          targets: all.map((p) => `doc:${projectKey}:github:github:${repo}#${p.number}`),
        });
      }
    } catch (err) {
      d.log?.('github sync failed', { projectKey, repo, error: String(err) });
      if (err instanceof IntegrationError && err.kind === 'rate_limit') break;
    }
  }
  return { prs };
}

/** GITHUB_REPOS narrowed to the projects selected in Settings (and not excluded). */
export function reposInScope(repos: Map<string, string>, inScope: (projectKey: string) => boolean): Map<string, string> {
  return new Map([...repos].filter(([k]) => inScope(k)));
}
