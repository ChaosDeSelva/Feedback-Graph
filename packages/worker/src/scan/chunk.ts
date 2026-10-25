/** A slice of a file for one extraction call; lines: 1-based, inclusive ("12-30"). */
export type Chunk = { text: string; lines: string };

/**
 * A file cut into pieces of at most `max` characters for the model, at the lines where top-level symbols start
 * (`starts`, 1-based), so a function or class is read whole when it fits; a symbol bigger than `max` (or a file with
 * no symbols) is cut at line boundaries. Consecutive pieces are merged while they fit. At most `maxChunks`, from the
 * top of the file. A single line longer than `max` is cut at `max`.
 */
export function chunkBySymbols(content: string, starts: number[], max: number, maxChunks: number): Chunk[] {
  const all = content.split('\n');
  if (content.length <= max) return [{ text: content, lines: `1-${all.length}` }];
  // sum[i]: characters in lines 1..i; lines a..b joined by newlines are sum[b] - sum[a - 1] + (b - a) long.
  const sum = [0];
  for (const l of all) sum.push(sum.at(-1)! + l.length);
  const len = (a: number, b: number) => sum[b] - sum[a - 1] + (b - a);
  const cuts = [...new Set([1, ...starts.filter((s) => Number.isInteger(s) && s >= 1 && s <= all.length)])].sort((a, b) => a - b);
  // Pieces that each fit: a symbol's lines, or line runs of one too big to fit.
  const pieces: [number, number][] = [];
  cuts.forEach((from, i) => {
    const to = i + 1 < cuts.length ? cuts[i + 1] - 1 : all.length;
    if (len(from, to) <= max) return void pieces.push([from, to]);
    let a = from;
    for (let b = from; b <= to; b++) {
      if (b > a && len(a, b) > max) {
        pieces.push([a, b - 1]);
        a = b;
      }
    }
    pieces.push([a, to]);
  });
  const chunks: [number, number][] = [];
  for (const [a, b] of pieces) {
    const last = chunks.at(-1);
    if (last && len(last[0], b) <= max) last[1] = b;
    else chunks.push([a, b]);
  }
  return chunks.slice(0, maxChunks).map(([a, b]) => ({ text: all.slice(a - 1, b).join('\n').slice(0, max), lines: `${a}-${b}` }));
}
