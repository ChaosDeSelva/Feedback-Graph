/**
 * The deterministic conflict pre-filters (0.9.0 contradiction detection, step 2). Each family reads typed values out
 * of both sides' text and reports a signal when the two disagree on them: numbers with units, dates (relative ones
 * resolved against when each side was asserted), versions, negation of a shared predicate, and named alternatives.
 * A signal is a reason to ask the judge, never a verdict: "Node 20" and "Node 22" may both be true of different hosts.
 * Two texts equal after normalisation are `same` (a duplicate, settled without a model).
 */

export const SIGNAL_FAMILIES = ['number', 'date', 'version', 'negation', 'alternative'] as const;
export type SignalFamily = (typeof SIGNAL_FAMILIES)[number];

/**
 * One disagreement. `key`: what both sides speak of (a dimension such as `time` or `count:row`, `date`, a product
 * name, a predicate such as `use redis`, an alternatives group). `a` and `b`: the values as each side wrote them.
 */
export type PrefilterSignal = { family: SignalFamily; key: string; a: string[]; b: string[]; why: string };

/** A side as the pre-filter reads it. `assertedAt` (ISO) anchors relative dates; `about` is the claim's subject phrase. */
export type PrefilterSide = { text: string; assertedAt?: string | null; about?: string | null };
export type PrefilterResult = { same: boolean; signals: PrefilterSignal[] };

/** A pair with no signal still goes to the judge at or above this cosine (§5: keeps local-model cost bounded). */
export const JUDGE_MIN_COSINE = 0.85;

/** Lower case, NFKC, typographic quotes and dashes folded, punctuation dropped, whitespace collapsed. */
export function normalizeStatement(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[^\p{L}\p{N}%'\s]+/gu, ' ')
    .replace(/'(?!\p{L})|(?<!\p{L})'/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compare two sides. Every family is symmetric: prefilter(a, b) and prefilter(b, a) find the same signals, mirrored. */
export function conflictPrefilter(a: PrefilterSide, b: PrefilterSide): PrefilterResult {
  if (normalizeStatement(a.text) === normalizeStatement(b.text)) return { same: true, signals: [] };
  const anchorA = a.assertedAt ?? b.assertedAt ?? null;
  const anchorB = b.assertedAt ?? a.assertedAt ?? null;
  const ea = extract(a.text, anchorA);
  const eb = extract(b.text, anchorB);
  return {
    same: false,
    signals: [
      ...numberSignals(ea.quantities, eb.quantities),
      ...dateSignals(ea.dates, eb.dates),
      ...versionSignals(ea.versions, eb.versions),
      ...negationSignals(a.text, b.text),
      ...alternativeSignals(a, b),
    ],
  };
}

/** Whether a candidate pair goes to the judge: not a duplicate, and a signal or a close enough embedding. */
export const needsJudge = (r: PrefilterResult, cosine: number) => !r.same && (r.signals.length > 0 || cosine >= JUDGE_MIN_COSINE);

// ---------------------------------------------------------------------------------------------------------------------
// Extraction. Dates are read first and versions next; each found span is blanked so a date's day or a version's
// number is not read again as a quantity.

type Extracted = { quantities: Quantity[]; dates: DateSpan[]; versions: VersionRef[] };

function extract(text: string, anchor: string | null): Extracted {
  let t = text.normalize('NFKC').replace(/[‘’]/g, "'");
  const blank = (s: string, from: number, to: number) => s.slice(0, from) + ' '.repeat(to - from) + s.slice(to);
  const dates = findDates(t, anchor);
  for (const d of dates) t = blank(t, d.at, d.at + d.raw.length);
  const versions = findVersions(t);
  for (const v of versions) t = blank(t, v.at, v.at + v.raw.length);
  return { dates, versions, quantities: findQuantities(t) };
}

/** Each side holds a value the other does not: the symmetric rule every value family uses. */
function differ<T>(as: T[], bs: T[], eq: (x: T, y: T) => boolean): boolean {
  return as.some((x) => !bs.some((y) => eq(x, y))) && bs.some((y) => !as.some((x) => eq(x, y)));
}
const uniq = (xs: string[]) => [...new Set(xs)];

// --- numbers with units -----------------------------------------------------------------------------------------------

/** A number with what it counts. `value` is in the dimension's base unit (seconds, bytes, percent, the currency). */
export type Quantity = { value: number; dimension: string; raw: string };

const UNITS: Record<string, [dimension: string, factor: number]> = {};
const unit = (dimension: string, factor: number, ...names: string[]) => { for (const n of names) UNITS[n] = [dimension, factor]; };
unit('time', 0.001, 'ms', 'msec', 'msecs', 'millisecond', 'milliseconds');
unit('time', 1, 's', 'sec', 'secs', 'second', 'seconds');
unit('time', 60, 'min', 'mins', 'minute', 'minutes');
unit('time', 3600, 'h', 'hr', 'hrs', 'hour', 'hours');
unit('time', 86_400, 'd', 'day', 'days');
unit('time', 604_800, 'wk', 'wks', 'week', 'weeks');
unit('time', 2_592_000, 'month', 'months');
unit('time', 31_536_000, 'yr', 'yrs', 'year', 'years');
unit('size', 1, 'b', 'byte', 'bytes');
unit('size', 1e3, 'kb', 'kilobyte', 'kilobytes');
unit('size', 1024, 'kib');
unit('size', 1e6, 'mb', 'megabyte', 'megabytes');
unit('size', 1024 ** 2, 'mib');
unit('size', 1e9, 'gb', 'gigabyte', 'gigabytes');
unit('size', 1024 ** 3, 'gib');
unit('size', 1e12, 'tb', 'terabyte', 'terabytes');
unit('percent', 1, '%', 'percent', 'pct');

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** A spelled-out number up to 999 ("five", "twenty-five", "two hundred"), or null. */
function wordNumber(w: string): number | null {
  const s = w.toLowerCase();
  if (ONES.includes(s)) return ONES.indexOf(s);
  if (TENS.includes(s) && s) return TENS.indexOf(s) * 10;
  const m = /^([a-z]+)-([a-z]+)$/.exec(s);
  if (m && TENS.includes(m[1]) && m[1] && ONES.indexOf(m[2]) > 0 && ONES.indexOf(m[2]) < 10) return TENS.indexOf(m[1]) * 10 + ONES.indexOf(m[2]);
  return null;
}

/** Words after a number that are not what it counts ("20 for", "3 and"). */
const NOT_A_NOUN = new Set([
  'a', 'an', 'the', 'and', 'or', 'nor', 'but', 'so', 'to', 'of', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'as', 'is', 'are', 'was',
  'were', 'be', 'it', 'its', 'this', 'that', 'than', 'then', 'vs', 'versus', 'more', 'less', 'fewer', 'instead', 'now', 'per', 'each', 'if',
  'when', 'we', 'they', 'you', 'i', 'he', 'she', 'not', 'no', 'max', 'min', 'maximum', 'minimum', 'until', 'tops', 'total', 'k',
]);

const singular = (w: string) =>
  w.endsWith('ies') && w.length > 4 ? `${w.slice(0, -3)}y` : /(ches|shes|xes|sses)$/.test(w) ? w.slice(0, -2) : w.endsWith('s') && !w.endsWith('ss') && w.length > 3 ? w.slice(0, -1) : w;

const TOKEN = /[$€£]?\d[\d,]*(?:\.\d+)?|[A-Za-z]+(?:-[A-Za-z]+)*|%|\S/g;

function findQuantities(text: string): Quantity[] {
  const toks = [...text.matchAll(TOKEN)].map((m) => ({ s: m[0], at: m.index }));
  const out: Quantity[] = [];
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i].s;
    const digits = /^([$€£])?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)$/.exec(tok);
    const currency = digits?.[1] ?? null;
    let value = digits ? Number(digits[2].replace(/,/g, '')) : wordNumber(tok);
    const spelledArticle = value === null && /^an?$/i.test(tok);
    if (value === null && !spelledArticle) continue;
    // Preceded by a letter-number join such as "x86", or a "v"/"@" version marker: not a quantity.
    if (digits && toks[i].at > 0 && /[A-Za-z@]/.test(text[toks[i].at - 1])) continue;
    let j = i + 1;
    if (value !== null && toks[j]?.s.toLowerCase() === 'k' && toks[j].at === toks[i].at + tok.length) {
      value *= 1000;
      j++;
    }
    if (toks[j]?.s === '-') j++;
    const next = toks[j]?.s.toLowerCase();
    const end = toks[j] ? toks[j].at + toks[j].s.length : toks[i].at + tok.length;
    const raw = text.slice(toks[i].at, end);
    if (currency) {
      out.push({ value: value!, dimension: `money:${currency}`, raw: text.slice(toks[i].at, toks[i].at + tok.length) });
      continue;
    }
    if (next && UNITS[next]) {
      out.push({ value: (spelledArticle ? 1 : value!) * UNITS[next][1], dimension: UNITS[next][0], raw });
      i = j;
      continue;
    }
    // "a cache" is not one of anything: an article counts only with a unit ("an hour").
    if (spelledArticle) continue;
    if (next && /^[a-z][a-z-]+$/.test(next) && !NOT_A_NOUN.has(next) && !wordNumber(next)) {
      out.push({ value: value!, dimension: `count:${singular(next)}`, raw });
      i = j;
    }
  }
  return out;
}

const same = (x: number, y: number) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));

const BASE_UNIT: Record<string, string> = { time: 'seconds', size: 'bytes' };
const fmt = (n: number) => String(Number(n.toPrecision(6)));

function numberSignals(a: Quantity[], b: Quantity[]): PrefilterSignal[] {
  const dims = uniq(a.map((q) => q.dimension)).filter((d) => b.some((q) => q.dimension === d));
  return dims.flatMap((d) => {
    const qa = a.filter((q) => q.dimension === d);
    const qb = b.filter((q) => q.dimension === d);
    if (!differ(qa, qb, (x, y) => same(x.value, y.value))) return [];
    const ra = uniq(qa.map((q) => q.raw));
    const rb = uniq(qb.map((q) => q.raw));
    // In different units, the amounts in the base one too: a small model misreads "five minutes" vs "120 seconds".
    const base = BASE_UNIT[d];
    const converted = base && uniq([...qa, ...qb].map((q) => q.raw.replace(/[\d.,\s-]+/g, ''))).length > 1
      ? ` (${uniq(qa.map((q) => fmt(q.value))).join(', ')} vs ${uniq(qb.map((q) => fmt(q.value))).join(', ')} ${base})` : '';
    return [{ family: 'number' as const, key: d, a: ra, b: rb, why: `numbers differ: ${ra.join(', ')} vs ${rb.join(', ')}${converted}` }];
  });
}

// --- dates -------------------------------------------------------------------------------------------------------------

/** A date or a range of days (inclusive, ISO `YYYY-MM-DD`), as written at `at`. */
export type DateSpan = { from: string; to: string; raw: string; at: number };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
const DAY = 86_400_000;
/** The year a date with no year and no anchor is placed in, so both sides compare in the same one. */
const REFERENCE_YEAR = 2000;

const monthIndex = (m: string) => MONTHS.indexOf(m.toLowerCase().slice(0, 3));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number) => Date.UTC(y, m, d);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const dayOf = (anchorIso: string) => {
  const d = new Date(anchorIso);
  return utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/**
 * A month (and day) written with no year: the anchor's year, or the next when that would put it more than 90 days
 * before the anchor ("ship on 12 Dec", said in November, is this year's; "in January" is next year's).
 */
function yearFor(m: number, d: number, anchor: number | null): number {
  if (anchor === null) return REFERENCE_YEAR;
  const y = new Date(anchor).getUTCFullYear();
  return utc(y, m, d) < anchor - 90 * DAY ? y + 1 : y;
}

/** A capitalised month name, or one next to a day or year: "may" and "march" are also ordinary words. */
const looksLikeMonth = (raw: string, bare: boolean) => !bare || /^[A-Z]/.test(raw);

function findDates(text: string, anchorIso: string | null): DateSpan[] {
  const anchor = anchorIso && !Number.isNaN(Date.parse(anchorIso)) ? dayOf(anchorIso) : null;
  const out: DateSpan[] = [];
  const taken: [number, number][] = [];
  const add = (at: number, raw: string, from: number, to: number) => {
    if (taken.some(([s, e]) => at < e && at + raw.length > s)) return;
    taken.push([at, at + raw.length]);
    // "by Friday", "before 12 Dec": a deadline covers the days up to it.
    const before = /\b(by|before)\s+(the\s+)?$/i.test(text.slice(Math.max(0, at - 12), at));
    const start = before ? Math.min(anchor ?? Date.UTC(0, 0, 1), from) : from;
    out.push({ from: iso(start), to: iso(to), raw, at });
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    for (const m of text.matchAll(re)) fn(m as RegExpExecArray);
  };

  each(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => {
    const t = utc(+m[1], +m[2] - 1, +m[3]);
    add(m.index, m[0], t, t);
  });
  each(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b(?:,?\\s+(\\d{4})\\b)?`, 'gi'), (m) => {
    const mo = monthIndex(m[2]);
    const d = +m[1];
    if (d < 1 || d > 31) return;
    const t = utc(m[3] ? +m[3] : yearFor(mo, d, anchor), mo, d);
    add(m.index, m[0], t, t);
  });
  each(new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:[:.]\\d|%))(?:,?\\s+(\\d{4})\\b)?`, 'gi'), (m) => {
    const mo = monthIndex(m[1]);
    const d = +m[2];
    if (d < 1 || d > 31 || !looksLikeMonth(m[1], false)) return;
    const t = utc(m[3] ? +m[3] : yearFor(mo, d, anchor), mo, d);
    add(m.index, m[0], t, t);
  });
  each(new RegExp(`\\b(?:(early|mid|late|end of|the end of|beginning of|start of)[\\s-]+)?${MONTH}\\b(?:\\s+(\\d{4})\\b)?`, 'gi'), (m) => {
    if (!looksLikeMonth(m[2], !m[3])) return;
    const mo = monthIndex(m[2]);
    const y = m[3] ? +m[3] : yearFor(mo, lastDay(REFERENCE_YEAR, mo), anchor);
    const last = lastDay(y, mo);
    const part = (m[1] ?? '').toLowerCase();
    const [d0, d1] = part === 'early' || part === 'beginning of' || part === 'start of' ? [1, 10] : part === 'mid' ? [11, 20] : part ? [21, last] : [1, last];
    add(m.index, m[0], utc(y, mo, d0), utc(y, mo, d1));
  });
  each(/\b(?:(end of|the end of)\s+)?Q([1-4])(?:\s+(\d{4}))?\b/g, (m) => {
    const q = +m[2] - 1;
    const y = m[3] ? +m[3] : yearFor(q * 3 + 2, 28, anchor);
    const endMs = utc(y, q * 3 + 2, lastDay(y, q * 3 + 2));
    add(m.index, m[0], m[1] ? utc(y, q * 3 + 2, 1) : utc(y, q * 3, 1), endMs);
  });

  if (anchor === null) return out.sort((x, y) => x.at - y.at);
  // Relative dates, from the anchor's day. Weeks start on Monday.
  const weekStart = anchor - ((new Date(anchor).getUTCDay() + 6) % 7) * DAY;
  const a = new Date(anchor);
  const monthEnd = (y: number, mo: number) => utc(y, mo, lastDay(y, mo));
  each(/\b(today|tonight|tomorrow|yesterday)\b/gi, (m) => {
    const off = { today: 0, tonight: 0, tomorrow: 1, yesterday: -1 }[m[1].toLowerCase() as 'today'];
    add(m.index, m[0], anchor + off * DAY, anchor + off * DAY);
  });
  each(/\b(?:(this|next)\s+week|end of (?:the|this) week)\b/gi, (m) => {
    const s = weekStart + (m[1]?.toLowerCase() === 'next' ? 7 : 0) * DAY;
    add(m.index, m[0], m[1] ? s : s + 4 * DAY, s + 6 * DAY);
  });
  each(/\b(?:(this|next)\s+month|end of (?:the|this) month)\b/gi, (m) => {
    const mo = a.getUTCMonth() + (m[1]?.toLowerCase() === 'next' ? 1 : 0);
    const y = a.getUTCFullYear() + Math.floor(mo / 12);
    const end = monthEnd(y, mo % 12);
    add(m.index, m[0], m[1] ? utc(y, mo % 12, 1) : end - 9 * DAY, end);
  });
  each(/\b(?:(this|next)\s+year|end of (?:the|this) year)\b/gi, (m) => {
    const y = a.getUTCFullYear() + (m[1]?.toLowerCase() === 'next' ? 1 : 0);
    add(m.index, m[0], m[1] ? utc(y, 0, 1) : utc(y, 11, 1), utc(y, 11, 31));
  });
  each(/\bin\s+(\d+|[a-z]+(?:-[a-z]+)?|a|an)\s+(days?|weeks?|months?)\b/gi, (m) => {
    const n = /^\d+$/.test(m[1]) ? +m[1] : /^an?$/i.test(m[1]) ? 1 : wordNumber(m[1]);
    if (n === null) return;
    const u = m[2].toLowerCase().replace(/s$/, '');
    const t = u === 'month' ? utc(a.getUTCFullYear(), a.getUTCMonth() + n, Math.min(a.getUTCDate(), lastDay(a.getUTCFullYear(), a.getUTCMonth() + n))) : anchor + n * (u === 'week' ? 7 : 1) * DAY;
    add(m.index, m[0], t, t);
  });
  // "next Friday": the Friday of next week. "on/this/by Friday" or a bare weekday: the first one after the anchor.
  each(new RegExp(`\\b(?:(next|this|on|by|coming)\\s+)?${WEEKDAY}s?\\b`, 'gi'), (m) => {
    if (m[0].toLowerCase().endsWith('s')) return; // "Fridays" recur: not a date.
    const wd = WEEKDAYS.indexOf(m[2].toLowerCase());
    const t = m[1]?.toLowerCase() === 'next' ? weekStart + (7 + ((wd + 6) % 7)) * DAY : anchor + (((wd - a.getUTCDay() + 6) % 7) + 1) * DAY;
    add(m.index, m[0], t, t);
  });
  return out.sort((x, y) => x.at - y.at);
}

const overlaps = (x: DateSpan, y: DateSpan) => x.from <= y.to && y.from <= x.to;

function dateSignals(a: DateSpan[], b: DateSpan[]): PrefilterSignal[] {
  if (!a.length || !b.length || !differ(a, b, overlaps)) return [];
  const show = (ds: DateSpan[]) => uniq(ds.map((d) => d.raw.trim()));
  const span = (d: DateSpan) => (d.from === d.to ? d.from : `${d.from}..${d.to}`);
  return [{
    family: 'date', key: 'date', a: show(a), b: show(b),
    why: `dates differ: ${show(a).join(', ')} (${uniq(a.map(span)).join(', ')}) vs ${show(b).join(', ')} (${uniq(b.map(span)).join(', ')})`,
  }];
}

// --- versions ----------------------------------------------------------------------------------------------------------

/** A version of something named (`name` lower case, '' when only the number was written). */
export type VersionRef = { name: string; version: string; raw: string; at: number };

/** Lower-case names taken as products even when not capitalised. */
const PRODUCTS = new Set([
  'node', 'nodejs', 'node.js', 'python', 'java', 'ruby', 'php', 'postgres', 'postgresql', 'mysql', 'redis', 'kubernetes', 'k8s', 'ubuntu', 'debian',
  'alpine', 'typescript', 'ts', 'gcc', 'clang', 'rust', 'rustc', 'dotnet', 'go', 'golang', 'pnpm', 'npm', 'yarn', 'bun', 'deno', 'react', 'vue',
  'angular', 'svelte', 'next', 'nextjs', 'django', 'rails', 'spring', 'kotlin', 'swift', 'xcode', 'ios', 'android', 'macos', 'windows', 'terraform',
  'vite', 'webpack', 'eslint', 'vitest', 'jest', 'neo4j', 'mongodb', 'elasticsearch', 'kafka', 'nginx', 'openssl', 'gradle', 'maven', 'helm',
]);
/** Capitalised words that are not product names (sentence starts, months, weekdays...). */
const NOT_A_NAME = new Set([
  ...MONTHS, 'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'sept', ...WEEKDAYS,
  'the', 'a', 'an', 'we', 'i', 'it', 'and', 'or', 'but', 'so', 'to', 'in', 'on', 'at', 'by', 'for', 'of', 'is', 'are', 'was', 'be', 'after', 'before',
  'about', 'around', 'over', 'under', 'up', 'down', 'top', 'step', 'item', 'page', 'line', 'chapter', 'section', 'phase', 'stage', 'room', 'floor',
  'q', 'wait', 'set', 'use', 'keep', 'ship', 'give', 'take', 'make', 'add', 'raise', 'cap', 'cut', 'run', 'need', 'only', 'every', 'each', 'all', 'maybe',
  'decision', 'note', 'notes', 'action', 'open', 'question', 'issue', 'ticket', 'pr', 'sprint', 'week', 'day', 'month', 'year', 'tier', 'level', 'slide',
]);
/** What may follow a version number ("Node 20 for the agents", "on Node 22."); any other word makes it a count. */
const AFTER_VERSION = new Set([
  'and', 'or', 'vs', 'versus', 'to', 'from', 'instead', 'rather', 'is', 'was', 'are', 'were', 'on', 'in', 'for', 'with', 'by', 'now', 'lts', 'as', 'then',
  'but', 'so', 'because', 'only', 'anymore', 'which', 'that', 'at', 'until', 'when', 'if', 'across', 'everywhere', 'too', 'also', 'yet', 'still', 'here',
  'there', 'please', 'again', 'already', 'today', 'tomorrow', 'next', 'this', 'not', 'isn', 'won', 'will', 'should', 'must', 'has', 'have', 'had',
]);

const PRODUCT_ALIASES: Record<string, string> = { postgresql: 'postgres', golang: 'go', k8s: 'kubernetes', nodejs: 'node', 'node.js': 'node' };
const productName = (n: string) => PRODUCT_ALIASES[n.toLowerCase()] ?? n.toLowerCase();

function findVersions(text: string): VersionRef[] {
  const out: VersionRef[] = [];
  const taken: [number, number][] = [];
  const add = (v: VersionRef) => {
    if (taken.some(([s, e]) => v.at < e && v.at + v.raw.length > s)) return;
    taken.push([v.at, v.at + v.raw.length]);
    out.push(v);
  };
  const re = /(?<![\w.@/-])([A-Za-z][A-Za-z0-9+#]*(?:\.js)?)(?:\s+|@|\s*-\s*)(v?)(\d+(?:\.\d+){0,3}(?:\.x)?)(?![\w.]*\d)(?![\w%])/g;
  for (const m of text.matchAll(re)) {
    const [raw, name, v, num] = m;
    const lower = name.toLowerCase();
    if (NOT_A_NAME.has(lower) && !PRODUCTS.has(lower)) continue;
    const explicit = v === 'v' || raw.includes('@') || num.includes('.');
    const known = PRODUCTS.has(lower) || PRODUCTS.has(productName(name));
    if (!explicit && !known && !/^[A-Z]/.test(name)) continue;
    if (!explicit) {
      // "Postgres 16 clusters" counts clusters; "Node 20 for the agents" is a version.
      const next = /^\s*([A-Za-z']+|%)?/.exec(text.slice(m.index + raw.length))![1]?.toLowerCase();
      if (next && (UNITS[next] || next === '%' || !AFTER_VERSION.has(next.replace(/'.*$/, '')))) continue;
    }
    add({ name: productName(name), version: num, raw, at: m.index });
  }
  for (const m of text.matchAll(/(?<![\w.])(v)?(\d+\.\d+\.\d+|(?<=v)\d+\.\d+)(?![\w.]*\d)/g)) {
    add({ name: '', version: m[2], raw: m[0], at: m.index });
  }
  return out.sort((x, y) => x.at - y.at);
}

/** "20" and "20.11" or "20.x" are compatible (one names a release of the other); "20" and "22" are not. */
function compatible(x: string, y: string): boolean {
  const parts = (s: string) => s.replace(/\.x$/, '').split('.').map(Number);
  const [p, q] = [parts(x), parts(y)];
  for (let i = 0; i < Math.min(p.length, q.length); i++) if (p[i] !== q[i]) return false;
  return true;
}

function versionSignals(a: VersionRef[], b: VersionRef[]): PrefilterSignal[] {
  const names = uniq(a.map((v) => v.name)).filter((n) => b.some((v) => v.name === n));
  return names.flatMap((n) => {
    const va = a.filter((v) => v.name === n);
    const vb = b.filter((v) => v.name === n);
    if (!differ(va, vb, (x, y) => compatible(x.version, y.version))) return [];
    const ra = uniq(va.map((v) => v.raw.trim()));
    const rb = uniq(vb.map((v) => v.raw.trim()));
    return [{ family: 'version' as const, key: n || 'version', a: ra, b: rb, why: `versions differ: ${ra.join(', ')} vs ${rb.join(', ')}` }];
  });
}

// --- negation ----------------------------------------------------------------------------------------------------------

const IRREGULAR: Record<string, string> = {
  is: 'be', are: 'be', was: 'be', were: 'be', am: 'be', been: 'be', being: 'be', "'s": 'be', "'re": 'be', "'m": 'be',
  has: 'have', had: 'have', having: 'have', does: 'do', did: 'do', doing: 'do', done: 'do', goes: 'go', went: 'go', gone: 'go',
};
/** Forms a word may be an inflection of: "using", "uses" and "used" share "use"; "shipping" and "ships" share "ship". */
function stems(word: string): Set<string> {
  const w = IRREGULAR[word] ?? word;
  const out = new Set([w]);
  const add = (s: string) => { if (s.length >= 2) out.add(s); };
  if (w.endsWith('ies')) add(`${w.slice(0, -3)}y`);
  if (w.endsWith('ied')) add(`${w.slice(0, -3)}y`);
  if (w.endsWith('es')) add(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1));
  for (const suf of ['ing', 'ed']) {
    if (!w.endsWith(suf)) continue;
    const s = w.slice(0, -suf.length);
    add(s);
    add(`${s}e`);
    if (/([b-df-hj-np-tv-z])\1$/.test(s)) add(s.slice(0, -1));
  }
  if (w.endsWith('d') && w.endsWith('ed')) add(w.slice(0, -1));
  return out;
}
const sameWord = (x: string, y: string) => {
  const sx = stems(x);
  for (const s of stems(y)) if (sx.has(s)) return true;
  return false;
};

const BE = new Set(['is', 'are', 'was', 'were', 'am', 'be', "'s", "'re", "'m"]);
/** Words between a negation and its verb: "will not be going to", "never actually". */
const FILLER = new Set(['going', 'gonna', 'to', 'ever', 'actually', 'really', 'even', 'yet', 'always', 'just', 'have', 'been', 'currently', 'necessarily']);
/** Words skipped between a verb and its object: "use the Redis", "deploy on Fridays". */
const DETERMINERS = new Set([
  'the', 'a', 'an', 'our', 'their', 'its', 'this', 'that', 'these', 'those', 'any', 'some', 'to', 'on', 'for', 'with', 'in', 'of', 'at', 'by',
  'from', 'it', 'them', 'us', 'we', 'into', 'onto', 'up', 'out', 'my', 'your', 'his', 'her', 'anymore', 'again',
]);
const MODALS = new Set(['will', 'would', 'shall', 'should', 'must', 'can', 'could', 'may', 'might', 'do', 'does', 'did', "'ll", "'d", 'need', 'have']);
const NEGATED_CONTRACTIONS = /^(won|wouldn|shan|shouldn|mustn|can|couldn|mightn|don|doesn|didn|isn|aren|wasn|weren|hasn|haven|hadn|needn|ain)'?t$/;

type Clause = string[];
/** Lower-case word tokens, split into clauses at punctuation and "but": negation never reaches across one. */
function clauses(text: string): Clause[] {
  const t = text.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/\bcannot\b/g, "can't").replace(/n't\b/g, "n't");
  return t
    .split(/[.;:!?,()\n]+|\s(?:but|however|whereas|although)\s|\s[-–—]\s/)
    .map((c) => [...c.matchAll(/[a-z0-9][a-z0-9.+#-]*(?:n't|'[a-z]+)?|'(?:s|re|m|ll|d)\b/g)].map((m) => m[0].replace(/\.$/, '')).flatMap((w) => {
      // "won't" -> "won't"; "we'll" -> "we", "'ll"; "it's" -> "it", "'s".
      const c = /^([a-z0-9.+#-]+)('(?:s|re|m|ll|d))$/.exec(w);
      return c ? [c[1], c[2]] : [w];
    }))
    .filter((c) => c.length);
}
const isNegator = (w: string) => w === 'not' || w === 'never' || NEGATED_CONTRACTIONS.test(w);
const beContraction = (w: string) => /^(isn|aren|wasn|weren|ain)'?t$/.test(w);

/** A negated predicate: the verb and the first word of its object ("won't use Redis for X" -> use, redis). */
type Predicate = { verb: string; object: string | null; raw: string };

function negatedPredicates(cs: Clause[]): Predicate[] {
  const out: Predicate[] = [];
  for (const c of cs) {
    for (let i = 0; i < c.length; i++) {
      let negEnd = -1;
      if (isNegator(c[i])) negEnd = i + 1;
      else if (c[i] === 'no' && c[i + 1] === 'longer') negEnd = i + 2;
      if (negEnd < 0) continue;
      let j = negEnd;
      let verb: string | null = null;
      if (beContraction(c[i]) || (c[i] === 'not' && i > 0 && BE.has(c[i - 1]))) verb = 'be';
      while (j < c.length && FILLER.has(c[j])) j++;
      if (!verb) {
        if (c[j] === 'be') {
          verb = 'be';
          j++;
        } else if (c[j] && !isNegator(c[j])) {
          verb = c[j];
          j++;
        }
      }
      if (!verb) continue;
      while (j < c.length && DETERMINERS.has(c[j])) j++;
      const object = c[j] && !isNegator(c[j]) ? c[j] : null;
      out.push({ verb, object, raw: c.slice(Math.max(0, i - 1), Math.min(c.length, j + 1)).join(' ') });
    }
  }
  return out;
}

/** Where a clause states the predicate without a negation in the three words before it. */
function affirms(cs: Clause[], p: Predicate): string | null {
  for (const c of cs) {
    for (let i = 0; i < c.length; i++) {
      const isVerb = p.verb === 'be' ? BE.has(c[i]) : sameWord(c[i], p.verb);
      if (!isVerb) continue;
      let j = i + 1;
      while (j < c.length && (DETERMINERS.has(c[j]) || (p.verb === 'be' && FILLER.has(c[j])))) j++;
      if (p.object !== null && !(c[j] && sameWord(c[j], p.object))) continue;
      const before = c.slice(Math.max(0, i - 3), i);
      if (before.some((w) => isNegator(w) || w === 'longer')) continue;
      if (p.object === null && !before.some((w) => MODALS.has(w))) continue; // a bare verb needs "will"/"must" to be a claim.
      return c.slice(Math.max(0, i - 1), Math.min(c.length, j + 1)).join(' ');
    }
  }
  return null;
}

function negationSignals(ta: string, tb: string): PrefilterSignal[] {
  const [ca, cb] = [clauses(ta), clauses(tb)];
  const out = new Map<string, PrefilterSignal>();
  const scan = (neg: Clause[], pos: Clause[], negSide: 'a' | 'b') => {
    const posNegated = negatedPredicates(pos);
    for (const p of negatedPredicates(neg)) {
      const key = p.object ? `${p.verb} ${p.object}` : p.verb;
      if (out.has(key)) continue;
      // Both sides negate it: they agree.
      if (posNegated.some((q) => sameWord(q.verb, p.verb) && (p.object === null || (q.object !== null && sameWord(q.object, p.object))))) continue;
      const hit = affirms(pos, p);
      if (!hit) continue;
      const [a, b] = negSide === 'a' ? [p.raw, hit] : [hit, p.raw];
      out.set(key, { family: 'negation', key, a: [a], b: [b], why: `one side negates "${key}": "${a}" vs "${b}"` });
    }
  };
  scan(ca, cb, 'a');
  scan(cb, ca, 'b');
  return [...out.values()];
}

// --- named alternatives ------------------------------------------------------------------------------------------------

/**
 * Groups of alternatives that usually exclude each other for one purpose. A name marked `^` matches only when
 * capitalised, because the word is also ordinary English ("react", "spring").
 */
const ALTERNATIVES: Record<string, string[]> = {
  database: ['postgres|postgresql', 'mysql', 'mariadb', 'sqlite', 'mongodb|mongo', 'dynamodb', 'cassandra', 'cockroachdb', 'oracle^', 'sql server|mssql', 'neo4j'],
  cache: ['redis', 'memcached', 'valkey', 'hazelcast'],
  queue: ['kafka', 'rabbitmq', 'sqs', 'nats', 'pub/sub|pubsub', 'kinesis', 'activemq', 'pulsar^'],
  cloud: ['aws', 'gcp|google cloud', 'azure'],
  language: ['typescript', 'javascript', 'python', 'golang', 'rust^', 'java', 'kotlin', 'ruby^', 'scala', 'elixir', 'c#'],
  'ui framework': ['react^', 'vue', 'angular^', 'svelte', 'solid^', 'ember^'],
  'package manager': ['npm', 'pnpm', 'yarn', 'bun^'],
  runtime: ['node|node.js|nodejs', 'deno', 'bun^'],
  bundler: ['vite', 'webpack', 'esbuild', 'rollup', 'parcel^', 'turbopack'],
  'test runner': ['vitest', 'jest', 'mocha', 'jasmine', 'pytest', 'playwright', 'cypress'],
  ci: ['github actions', 'gitlab ci', 'circleci', 'jenkins', 'buildkite', 'travis'],
  orchestrator: ['kubernetes|k8s', 'nomad', 'ecs', 'docker swarm'],
  'api style': ['graphql', 'grpc', 'rest api|rest^|restful'],
  'data format': ['json', 'yaml', 'toml', 'protobuf|protocol buffers', 'avro', 'msgpack|messagepack'],
  'object storage': ['s3', 'gcs', 'azure blob|blob storage', 'minio'],
};

type Named = { group: string; name: string; raw: string };
const ALT_PATTERNS = Object.entries(ALTERNATIVES).flatMap(([group, names]) =>
  names.map((spec) => {
    const forms = spec.split('|');
    const name = forms[0].replace(/\^$/, '');
    return forms.map((f) => {
      const caps = f.endsWith('^');
      const word = f.replace(/\^$/, '').replace(/[.+#/]/g, (c) => `\\${c}`).replace(/ /g, '\\s+');
      return { group, name, re: new RegExp(`(?<![\\w.])${word}(?![\\w#+])`, 'gi'), caps };
    });
  }).flat());

function namedIn(text: string): Named[] {
  const t = text.normalize('NFKC');
  const out: Named[] = [];
  for (const p of ALT_PATTERNS) {
    for (const m of t.matchAll(p.re)) {
      if (p.caps && !/^[A-Z]/.test(m[0])) continue;
      out.push({ group: p.group, name: p.name, raw: m[0] });
    }
  }
  return out;
}

const SUBJECT_STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'we', 'our', 'is', 'are', 'be', 'with', 'which', 'what', 'use']);
const subjectWords = (s: string) => new Set(normalizeStatement(s).split(' ').filter((w) => w.length > 1 && !SUBJECT_STOP.has(w)).map((w) => singular(w)));
/** Both sides' `about` share a subject word; when either has none, the scopes upstream already matched. */
function sameAbout(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return true;
  const wb = subjectWords(b);
  return [...subjectWords(a)].some((w) => wb.has(w));
}

/** "X instead of Y", "X rather than Y", "prefer X over Y": X chosen, Y set aside. */
function explicitChoices(text: string): { chosen: string; rejected: string }[] {
  const t = text.normalize('NFKC');
  const out: { chosen: string; rejected: string }[] = [];
  const word = "([A-Za-z0-9][\\w.+#-]*)";
  for (const m of t.matchAll(new RegExp(`${word}\\s+(?:instead\\s+of|rather\\s+than)\\s+${word}`, 'g'))) out.push({ chosen: m[1], rejected: m[2] });
  for (const m of t.matchAll(new RegExp(`(?:prefer|preferred|chose|chosen|picked|pick)\\s+${word}\\s+over\\s+${word}`, 'gi'))) out.push({ chosen: m[1], rejected: m[2] });
  return out.filter((c) => c.chosen.toLowerCase() !== c.rejected.toLowerCase() && !SUBJECT_STOP.has(c.rejected.toLowerCase()) && !DETERMINERS.has(c.rejected.toLowerCase()));
}
const mentions = (text: string, name: string) => new RegExp(`(?<![\\w.])${name.replace(/[.+#\\-]/g, (c) => `\\${c}`)}(?![\\w#+])`, 'i').test(text);

function alternativeSignals(a: PrefilterSide, b: PrefilterSide): PrefilterSignal[] {
  if (!sameAbout(a.about, b.about)) return [];
  const [na, nb] = [namedIn(a.text), namedIn(b.text)];
  const out = new Map<string, PrefilterSignal>();
  for (const group of uniq(na.map((n) => n.group))) {
    const ga = na.filter((n) => n.group === group);
    const gb = nb.filter((n) => n.group === group);
    if (!gb.length || !differ(ga, gb, (x, y) => x.name === y.name)) continue;
    const ra = uniq(ga.map((n) => n.raw));
    const rb = uniq(gb.map((n) => n.raw));
    out.set(group, { family: 'alternative', key: group, a: ra, b: rb, why: `different ${group}: ${ra.join(', ')} vs ${rb.join(', ')}` });
  }
  const explicit = (from: PrefilterSide, other: PrefilterSide, side: 'a' | 'b') => {
    for (const c of explicitChoices(from.text)) {
      if (!mentions(other.text, c.rejected) || mentions(other.text, c.chosen)) continue;
      if (explicitChoices(other.text).some((o) => o.rejected.toLowerCase() === c.rejected.toLowerCase())) continue;
      const key = `${c.chosen.toLowerCase()} / ${c.rejected.toLowerCase()}`;
      const [x, y] = side === 'a' ? [`${c.chosen} instead of ${c.rejected}`, c.rejected] : [c.rejected, `${c.chosen} instead of ${c.rejected}`];
      if ([...out.values()].some((s) => s.a.concat(s.b).some((r) => r.toLowerCase() === c.rejected.toLowerCase()))) continue;
      out.set(key, { family: 'alternative', key, a: [x], b: [y], why: `one side sets aside ${c.rejected} for ${c.chosen}; the other relies on ${c.rejected}` });
    }
  };
  explicit(a, b, 'a');
  explicit(b, a, 'b');
  return [...out.values()];
}
