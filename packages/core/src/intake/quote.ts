/**
 * Quote validation (deterministic): a claim a model drew from a source must quote it. The quote is found in the stored
 * source's utterances, inside one or a run of consecutive ones, said by the speaker the claim names. A near match
 * (edit distance within 3% of the quote's length) is kept and flagged, and what is stored is always the source's span,
 * never the model's words.
 */

/** The parts of an utterance (intake/parse.ts) a quote is checked against. */
export type QuotedUtterance = { idx: number; speaker: string | null; text: string };

/** Where a quote is in a source: from charStart in utterance utt to charEnd (exclusive) in uttEnd, both in .text. */
export type QuoteSpan = { utt: number; charStart: number; uttEnd: number; charEnd: number };

export type QuoteMatch = QuoteSpan & {
  ok: true;
  /** The source's words over the span (the utterances' parts joined by a space): what is stored, not the model's. */
  quote: string;
  /** Who said it, from the source. */
  speaker: string | null;
  /** Edits between the normalised quote and the span; 0 for an exact match. */
  distance: number;
  /** 'quote-fuzzy' when the match is not exact. */
  flags: 'quote-fuzzy'[];
};

/**
 * empty: nothing left after normalising. not-found: in no utterance, exactly or within the edit budget. wrong-speaker:
 * found, but said by someone else. mixed-speakers: found only across utterances of more than one speaker.
 */
export type QuoteMiss = { ok: false; reason: 'empty' | 'not-found' | 'wrong-speaker' | 'mixed-speakers' };

/** The edit budget of a near match, as a share of the normalised quote's length (rounded down: none under 34 chars). */
export const QUOTE_FUZZY_SHARE = 0.03;

/** Characters dropped without a trace, so "don't" and "don’t" and "dont" are one word. */
const APOSTROPHE = /['’‘ʼ`´]/u;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/**
 * Text normalised for matching: Unicode compatibility forms, lower case, apostrophes dropped, every other run of
 * punctuation or whitespace one space, trimmed. map[i] is the index in the input of the character normalised char i
 * came from, so a match maps back to the source.
 */
export function normalizeForQuote(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let i = 0;
  for (const cp of text) {
    for (const ch of cp.normalize('NFKC').toLowerCase()) {
      if (APOSTROPHE.test(ch)) continue;
      if (WORD_CHAR.test(ch)) {
        norm += ch;
        map.push(i);
      } else if (norm && !norm.endsWith(' ')) {
        norm += ' ';
        map.push(i);
      }
    }
    i += cp.length;
  }
  if (norm.endsWith(' ')) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}

/** Whether a quote, normalised, occurs in a text normalised (the judge's citation check: no fuzz, no speakers). */
export function quoteOccursIn(quote: string, text: string): boolean {
  const q = normalizeForQuote(quote).norm;
  return !!q && ` ${normalizeForQuote(text).norm} `.includes(` ${q} `);
}

const nameKey = (s: string | null) => (s === null ? null : s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase());

/** The utterances, normalised and joined by a space, with each normalised char's utterance and place in its text. */
type Haystack = { norm: string; utt: number[]; at: number[]; ends: number[] };

function haystack(utterances: readonly QuotedUtterance[]): Haystack {
  let norm = '';
  const utt: number[] = [];
  const at: number[] = [];
  const ends: number[] = [];
  utterances.forEach((u, k) => {
    const n = normalizeForQuote(u.text);
    if (!n.norm) return;
    if (norm) {
      norm += ' ';
      utt.push(-1);
      at.push(-1);
      ends.push(-1);
    }
    norm += n.norm;
    for (let j = 0; j < n.map.length; j++) {
      utt.push(k);
      at.push(n.map[j]);
      // A normalised char ends after the whole code point it came from.
      ends.push(n.map[j] + (u.text.codePointAt(n.map[j])! > 0xffff ? 2 : 1));
    }
  });
  return { norm, utt, at, ends };
}

/** A candidate place [start, end) in the haystack's normalised text, with its edit distance. */
type Hit = { start: number; end: number; distance: number };

/** Every exact occurrence, at word boundaries. */
function exactHits(h: Haystack, q: string): Hit[] {
  const out: Hit[] = [];
  for (let i = h.norm.indexOf(q); i >= 0; i = h.norm.indexOf(q, i + 1)) {
    const before = i === 0 || h.norm[i - 1] === ' ';
    const after = i + q.length === h.norm.length || h.norm[i + q.length] === ' ';
    if (before && after) out.push({ start: i, end: i + q.length, distance: 0 });
  }
  return out;
}

/** At most this many regions are aligned for one quote, so a quote of common words cannot make it slow. */
const MAX_REGIONS = 200;

/**
 * Near matches within k edits. A match within k edits holds one of k+1 pieces of the quote exactly (pigeonhole), so
 * only the regions around each piece's occurrences are aligned (Sellers' approximate substring alignment), each giving
 * its best end and where that alignment started.
 */
function fuzzyHits(h: Haystack, q: string, k: number): Hit[] {
  const pieceLen = Math.floor(q.length / (k + 1));
  const regions = new Set<number>();
  for (let p = 0; p <= k && regions.size < MAX_REGIONS; p++) {
    const from = p * pieceLen;
    const piece = q.slice(from, p === k ? q.length : from + pieceLen);
    for (let i = h.norm.indexOf(piece); i >= 0 && regions.size < MAX_REGIONS; i = h.norm.indexOf(piece, i + 1)) regions.add(Math.max(0, i - from - k));
  }
  const hits: Hit[] = [];
  for (const start of [...regions].sort((a, b) => a - b)) {
    const hit = align(h.norm, q, start, Math.min(h.norm.length, start + q.length + 2 * k));
    if (hit && hit.distance <= k) hits.push(hit);
  }
  return hits;
}

function align(text: string, q: string, from: number, to: number): Hit | null {
  const m = q.length;
  let cost = Array.from({ length: m + 1 }, (_, i) => i);
  let starts = new Array<number>(m + 1).fill(from);
  let best: Hit | null = null;
  for (let x = from; x < to; x++) {
    const next = new Array<number>(m + 1);
    const nextStarts = new Array<number>(m + 1);
    next[0] = 0;
    nextStarts[0] = x + 1;
    for (let i = 1; i <= m; i++) {
      const sub = cost[i - 1] + (q[i - 1] === text[x] ? 0 : 1);
      const skipText = cost[i] + 1;
      const skipQuote = next[i - 1] + 1;
      if (sub <= skipText && sub <= skipQuote) {
        next[i] = sub;
        nextStarts[i] = starts[i - 1];
      } else if (skipText <= skipQuote) {
        next[i] = skipText;
        nextStarts[i] = starts[i];
      } else {
        next[i] = skipQuote;
        nextStarts[i] = nextStarts[i - 1];
      }
    }
    cost = next;
    starts = nextStarts;
    if (!best || cost[m] < best.distance) best = { start: starts[m], end: x + 1, distance: cost[m] };
  }
  if (!best) return null;
  // Blanks at either end are not part of the span, and it takes whole words: the source's, not part of one.
  while (best.start < best.end && text[best.start] === ' ') best.start++;
  while (best.end > best.start && text[best.end - 1] === ' ') best.end--;
  const [start, end] = [best.start, best.end];
  while (best.start > 0 && text[best.start - 1] !== ' ') best.start--;
  while (best.end < text.length && text[best.end] !== ' ') best.end++;
  if (best.start !== start || best.end !== end) best.distance = editDistance(q, text.slice(best.start, best.end));
  return best.end > best.start ? best : null;
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), row[j] + 1, next[j - 1] + 1);
    row = next;
  }
  return row[b.length];
}

/**
 * Find a claim's quote in the source and check who said it. speaker: the label the claim gives (after the worker maps
 * the model's handle back), compared ignoring case and spacing; null when the claim names no one, which any speaker
 * satisfies (the match then carries the source's speaker). A quote across utterances must stay with one speaker.
 * The first passing place wins: exact before near, then fewest edits, then earliest.
 */
export function validateQuote(utterances: readonly QuotedUtterance[], quote: string, speaker: string | null): QuoteMatch | QuoteMiss {
  const q = normalizeForQuote(quote).norm;
  if (!q) return { ok: false, reason: 'empty' };
  const h = haystack(utterances);
  const k = Math.floor(q.length * QUOTE_FUZZY_SHARE);
  let hits = exactHits(h, q);
  if (!hits.length && k > 0) hits = fuzzyHits(h, q, k).sort((a, b) => a.distance - b.distance || a.start - b.start);
  if (!hits.length) return { ok: false, reason: 'not-found' };
  const want = nameKey(speaker);
  let miss: QuoteMiss['reason'] = 'not-found';
  for (const hit of hits) {
    const first = h.utt[hit.start];
    const last = h.utt[hit.end - 1];
    const covered = utterances.slice(first, last + 1).filter((u) => normalizeForQuote(u.text).norm);
    const speakers = new Set(covered.map((u) => nameKey(u.speaker)));
    if (speakers.size > 1) {
      if (miss === 'not-found') miss = 'mixed-speakers';
      continue;
    }
    const said = covered[0].speaker;
    if (want !== null && nameKey(said) !== want) {
      miss = 'wrong-speaker';
      continue;
    }
    const charStart = h.at[hit.start];
    const charEnd = h.ends[hit.end - 1];
    const words = first === last
      ? utterances[first].text.slice(charStart, charEnd)
      : [utterances[first].text.slice(charStart), ...utterances.slice(first + 1, last).map((u) => u.text), utterances[last].text.slice(0, charEnd)].join(' ');
    return {
      ok: true, utt: utterances[first].idx, charStart, uttEnd: utterances[last].idx, charEnd, quote: words, speaker: said,
      distance: hit.distance, flags: hit.distance ? ['quote-fuzzy'] : [],
    };
  }
  return { ok: false, reason: miss };
}
