import { redactSecrets, type DocsStore, type FactsStore, type LinearIssue, type PostMortemInput, type SearchLinearOpts } from '@fb/core';

export type HuntDeps = {
  embed(texts: string[]): Promise<number[][]>;
  facts?: Pick<FactsStore, 'searchFacts'>;
  docs?: Partial<Pick<DocsStore, 'searchDocs' | 'upsertDoc'>>;
  linear?: { apiKey: string; search(o: SearchLinearOpts): Promise<LinearIssue[]> };
  log?: (msg: string, extra?: object) => void;
};

const FACT_K = 12;
const DOC_K = 6;
const LINEAR_K = 5;
const EXCERPT = 500;
const clip = (s: string) => (s.length > EXCERPT ? `${s.slice(0, EXCERPT)}…` : s).replace(/\s+/g, ' ');

/**
 * The context hunt: everything outside the transcript that might have prevented the miss,
 * as one line per item for the post-mortem prompt. Each source fails independently.
 */
export async function huntContext(input: PostMortemInput, d: HuntDeps): Promise<string[]> {
  const query = `${input.feedback.precedingAssistantText.slice(-500)}\n${input.feedback.text}`;
  const [embedding] = await d.embed([query]);
  const safe = async <T>(name: string, f: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await f();
    } catch (err) {
      d.log?.('context hunt source failed', { source: name, error: String(err) });
      return [];
    }
  };
  const [facts, docs, issues] = await Promise.all([
    safe('facts', async () => (d.facts ? d.facts.searchFacts({ embedding, projectKey: input.projectKey, k: FACT_K }) : [])),
    safe('docs', async () => (d.docs?.searchDocs ? d.docs.searchDocs({ embedding, projectKey: input.projectKey, k: DOC_K }) : [])),
    safe('linear', async () => (d.linear ? d.linear.search({ query: input.feedback.text.slice(0, 200), apiKey: d.linear.apiKey, first: LINEAR_K }) : [])),
  ]);

  // Tickets are not stored as project docs: the search spans the whole Linear workspace, so a hit may belong to
  // another team. Anything the post-mortem cites is kept as a context item on its miss.
  const lines = [
    ...facts.map((h) => `code fact ${h.fact.path}: ${h.fact.statement}`),
    ...docs.map((h) => `${h.source} ${h.ref} (${h.title}): ${clip(h.text)}`),
    ...issues.map((i) => `linear ${i.identifier} (${i.title}, ${i.state}): ${clip(i.description)}`),
  ];
  return lines.map(redactSecrets);
}
