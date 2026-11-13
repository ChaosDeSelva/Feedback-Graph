import { redactSecrets, type VerdictsStore } from '@fb/core';

/** Inbox items embedded per batch, and at most this many batches a wake: a large backlog drains over a few wakes. */
export const INBOX_EMBED_BATCH = 32;
export const INBOX_EMBED_BATCHES = 8;

/**
 * Embed the Inbox items that have no embedding of their flagged words (0.9.5): those decided before 0.9.1 embedded each
 * flagged turn, or flagged while the embedder was down. The approve score finds your past verdicts by these vectors
 * (VerdictsStore.neighbours), so without them an item has no similar verdicts. Same text and model as the flagging
 * path (cycle.ts). Returns how many were embedded; an embedder down stops it until the next wake.
 */
export async function embedInboxBacklog(d: { verdicts: Pick<VerdictsStore, 'inboxToEmbed' | 'setInboxEmbeddings'>; embed: (texts: string[]) => Promise<number[][]>; log: (msg: string, extra?: object) => void }): Promise<number> {
  let done = 0;
  for (let i = 0; i < INBOX_EMBED_BATCHES; i++) {
    const rows = await d.verdicts.inboxToEmbed(INBOX_EMBED_BATCH);
    if (!rows.length) break;
    let vectors: number[][];
    try {
      vectors = await d.embed(rows.map((r) => r.text));
    } catch (err) {
      d.log('inbox items not embedded', { error: redactSecrets(String(err)).slice(0, 200) });
      break;
    }
    await d.verdicts.setInboxEmbeddings(rows.map((r, j) => ({ id: r.id, embedding: vectors[j] })));
    done += rows.length;
    if (rows.length < INBOX_EMBED_BATCH) break;
  }
  return done;
}
