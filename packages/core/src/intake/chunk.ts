/**
 * An intake source's chunks. The worker reads a source back as its chunks joined by a blank line (DocToRead.text) and
 * keys every claim to offsets in that text, so the chunks must join back to the stored text exactly: they break only
 * at a blank line ("\n\n", which the join puts back), never inside a paragraph. A paragraph longer than `size` is one
 * chunk of its own; its embedding reads the start of it (embeddingInput).
 */
export function chunkSourceText(text: string, size = 1500): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (const para of text.split('\n\n')) {
    if (cur !== null && cur.length + 2 + para.length > size) {
      out.push(cur);
      cur = null;
    }
    cur = cur === null ? para : `${cur}\n\n${para}`;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** What a chunk's embedding is made from: at most `max` characters of it (a long paragraph past what the model reads). */
export const embeddingInput = (chunk: string, max = 4000) => (chunk.length > max ? chunk.slice(0, max) : chunk);
