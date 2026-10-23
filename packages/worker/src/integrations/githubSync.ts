import { INCREMENTAL_MAX_PRS, prContextToChunks, redactSecrets, type ActivityStore, type DocsStore, type FetchPrOpts, type PrContext } from '@fb/core';

export type GithubSyncDeps = {
  /** project key → owner/repo, from GITHUB_REPOS. */
  repos: Map<string, string>;
  token: string;
  fetchPrs(o: FetchPrOpts): Promise<PrContext[]>;
  docs: Pick<DocsStore, 'upsertDoc' | 'getCursor' | 'setCursor'>;
  embed(texts: string[]): Promise<number[][]>;
  activity?: Pick<ActivityStore, 'record'>;
  /** Skip a project synced less than this long ago. */
  minIntervalMs?: number;
  now?: () => string;
  log?: (msg: string, extra?: object) => void;
};

/** Pull PR descriptions, reviews and comments into the docs store, one doc per PR. */
export async function syncGithub(d: GithubSyncDeps): Promise<{ prs: number }> {
  const now = d.now ?? (() => new Date().toISOString());
  let prs = 0;
  for (const [projectKey, repo] of d.repos) {
    const key = `github:${projectKey}`;
    const since = (await d.docs.getCursor(key)) ?? undefined;
    if (since && Date.parse(now()) - Date.parse(since) < (d.minIntervalMs ?? 0)) continue;
    const started = now();
    try {
      const list = await d.fetchPrs({ repo, token: d.token, since });
      for (const pr of list) {
        const chunks = prContextToChunks(pr).map((c) => redactSecrets(c.text));
        const vectors = chunks.length ? await d.embed(chunks) : [];
        await d.docs.upsertDoc(
          { projectKey, source: 'github', ref: `github:${repo}#${pr.number}`, title: `${repo}#${pr.number}: ${pr.title}`, url: pr.url },
          chunks.map((text, i) => ({ text, embedding: vectors[i] })),
        );
      }
      if (since && list.length >= INCREMENTAL_MAX_PRS) d.log?.('github sync hit its cap; older updates were skipped', { projectKey, repo, cap: INCREMENTAL_MAX_PRS });
      await d.docs.setCursor(key, started);
      prs += list.length;
      if (list.length) {
        await d.activity?.record({
          kind: 'doc_added', actor: 'github', projectKey,
          subject: `synced ${list.length} pull request${list.length === 1 ? '' : 's'} from ${repo}`,
          why: since ? `updated since the last sync at ${since}` : 'first sync of this repository',
          details: { repo, prs: list.map((p) => ({ number: p.number, title: p.title, comments: p.comments.length })) },
          targets: list.map((p) => `doc:${projectKey}:github:github:${repo}#${p.number}`),
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
