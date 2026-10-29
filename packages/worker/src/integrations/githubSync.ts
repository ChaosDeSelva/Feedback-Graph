import { INCREMENTAL_MAX_PRS, parsePrBacklog, prBacklogKey, prContextToChunks, redactSecrets, ticketIdsIn, type ActivityStore, type DocsStore, type FetchPrOpts, type PrBacklog, type PrContext } from '@fb/core';

export type GithubSyncDeps = {
  /** project key → owner/repo, from GITHUB_REPOS. */
  repos: Map<string, string>;
  authors?: Map<string, string>;
  token: string;
  fetchPrs(o: FetchPrOpts): Promise<PrContext[]>;
  docs: Pick<DocsStore, 'upsertDoc' | 'getCursor' | 'setCursor'> & Partial<Pick<DocsStore, 'listDocs'>>;
  embed(texts: string[]): Promise<number[][]>;
  activity?: Pick<ActivityStore, 'record'>;
  /** Skip a project synced less than this long ago. */
  minIntervalMs?: number;
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

/** Pull PR descriptions, reviews and comments into the docs store, one doc per PR, with the Linear tickets it names. */
export async function syncGithub(d: GithubSyncDeps): Promise<{ prs: number }> {
  const now = d.now ?? (() => new Date().toISOString());
  let prs = 0;
  for (const [projectKey, repo] of d.repos) {
    const key = `github:${projectKey}`;
    const cursor = (await d.docs.getCursor(key)) ?? undefined;
    if (cursor && Date.parse(now()) - Date.parse(cursor) < (d.minIntervalMs ?? 0)) continue;
    const started = now();
    const ticketsKnown = !!(await d.docs.getCursor(ticketsCursor(projectKey)));
    const backfillFrom = new Date(Date.parse(started) - TICKETS_BACKFILL_DAYS * 86_400_000).toISOString();
    const since = cursor && !ticketsKnown && backfillFrom < cursor ? backfillFrom : cursor;
    try {
      const backlog = parsePrBacklog(await d.docs.getCursor(prBacklogKey(projectKey)));
      const store = async (list: PrContext[]) => {
        for (const pr of list) {
          if (d.authors?.get(projectKey) && pr.author.toLowerCase() !== d.authors.get(projectKey)!.toLowerCase()) continue;
          const chunks = prContextToChunks(pr).map((c) => redactSecrets(c.text));
          const vectors = chunks.length ? await d.embed(chunks) : [];
          await d.docs.upsertDoc(
            { projectKey, source: 'github', ref: `github:${repo}#${pr.number}`, title: `${repo}#${pr.number}: ${pr.title}`, url: pr.url },
            chunks.map((text, i) => ({ text, embedding: vectors[i] })),
            // The Linear tickets it names (ENG-123 in its title, body or branch): linked to their documents (linkedDocs).
            { tickets: ticketIdsIn(pr.title, pr.body, pr.headBranch) },
          );
        }
      };
      // Independent of the redaction-rules cursor: installs that already completed v7 still repair PR chunks.
      const repairKey = `github-redaction-source-repair-v8:${projectKey}`;
      const repairAt = await d.docs.getCursor(repairKey);
      if (repairAt !== 'done' && d.docs.listDocs) {
        const existing = new Set((await d.docs.listDocs(projectKey, { source: 'github', limit: 2147483647 })).map(doc => doc.ref));
        let cappedAt: string | null = null;
        const originals = existing.size ? await d.fetchPrs({ repo, token: d.token, since: '1970-01-01T00:00:00.000Z', maxPrs: 100,
          ...(repairAt ? { until: repairAt } : {}), onCap: at => { cappedAt = at; }, ...(d.authors?.get(projectKey) ? { author: d.authors.get(projectKey) } : {}) }) : [];
        const restored = originals.filter(pr => existing.has(`github:${repo}#${pr.number}`));
        await store(restored);
        await d.docs.setCursor(repairKey, cappedAt ?? 'done');
        if (restored.length) await d.activity?.record({ kind: 'doc_added', actor: 'github', projectKey,
          subject: `re-fetched ${restored.length} existing GitHub documents after redaction`,
          why: 'Rebuilt stored PR chunks from GitHub under the current redaction rules; this does not recover unavailable fact or lesson originals.',
          details: { recovery: 'redaction-v8-source', documentsRefetched: restored.length, complete: !cappedAt },
          targets: restored.map(pr => `doc:${projectKey}:github:github:${repo}#${pr.number}`) });
      }
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
    }
  }
  return { prs };
}

/** GITHUB_REPOS narrowed to the projects selected in Settings (and not excluded). */
export function reposInScope(repos: Map<string, string>, inScope: (projectKey: string) => boolean): Map<string, string> {
  return new Map([...repos].filter(([k]) => inScope(k)));
}
