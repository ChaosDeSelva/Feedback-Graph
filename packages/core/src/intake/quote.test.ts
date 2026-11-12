import { describe, expect, test } from 'vitest';
import { parseIntake } from './parse.ts';
import { normalizeForQuote, QUOTE_FUZZY_SHARE, quoteOccursIn, validateQuote, type QuotedUtterance } from './quote.ts';

const call = parseIntake([
  'Ana Lopez: We should move the retry timeout to 30 seconds, because it keeps failing on slow networks.',
  'Bo: I don’t agree. Sixty seconds is safer for the batch importer.',
  'Bo: And we will not use Redis for the queue.',
  'Ana Lopez: Fine. Let us test both timeouts next week before we decide anything final.',
  'Cy: Noted.',
].join('\n'), 'txt');

describe('normalizeForQuote', () => {
  test('case, whitespace, punctuation, Unicode quote marks and compatibility forms', () => {
    expect(normalizeForQuote('  “Don’t”  SHIP\n\tit — yet!! ').norm).toBe('dont ship it yet');
    expect(normalizeForQuote("don't").norm).toBe(normalizeForQuote('don’t').norm);
    expect(normalizeForQuote('ﬁle ①').norm).toBe('file 1');
    expect(normalizeForQuote('...').norm).toBe('');
  });

  test('map points each normalised character at its place in the input', () => {
    const input = 'A, “b”  c';
    const { norm, map } = normalizeForQuote(input);
    expect(norm).toBe('a b c');
    expect([...norm].map((ch, i) => (ch === ' ' ? ' ' : input[map[i]].toLowerCase())).join('')).toBe(norm);
  });
});

describe('quoteOccursIn', () => {
  test('a normalised substring at word boundaries', () => {
    expect(quoteOccursIn('"retry TIMEOUT to 30 seconds"', 'We should move the retry timeout to 30 seconds.')).toBe(true);
    expect(quoteOccursIn('timeout to 30 second', 'the retry timeout to 30 seconds')).toBe(false);
    expect(quoteOccursIn('  ', 'anything')).toBe(false);
  });
});

describe('validateQuote: exact', () => {
  test('found in one utterance, by its speaker: the span and the source words are returned', () => {
    const r = validateQuote(call, 'retry timeout to 30 seconds', 'Ana Lopez');
    expect(r).toMatchObject({ ok: true, utt: 0, uttEnd: 0, distance: 0, flags: [], speaker: 'Ana Lopez', quote: 'retry timeout to 30 seconds' });
    if (!r.ok) throw new Error('expected a match');
    expect(call[0].text.slice(r.charStart, r.charEnd)).toBe('retry timeout to 30 seconds');
  });

  test('case, punctuation and curly quotes in the model\'s quote do not matter; the stored words are the source\'s', () => {
    const r = validateQuote(call, '"I DON\'T agree -- sixty seconds is safer"', 'bo');
    expect(r).toMatchObject({ ok: true, utt: 1, speaker: 'Bo', quote: 'I don’t agree. Sixty seconds is safer', distance: 0 });
  });

  test('a quote that is part of a word is not found', () => {
    expect(validateQuote(call, 'etry timeout', 'Ana Lopez')).toEqual({ ok: false, reason: 'not-found' });
  });

  test('the wrong speaker is refused', () => {
    expect(validateQuote(call, 'we will not use Redis for the queue', 'Ana Lopez')).toEqual({ ok: false, reason: 'wrong-speaker' });
  });

  test('speaker names compare ignoring case and spacing', () => {
    expect(validateQuote(call, 'Let us test both timeouts', '  ana   LOPEZ ')).toMatchObject({ ok: true, utt: 3, speaker: 'Ana Lopez' });
  });

  test('no speaker named: any speaker passes, and the match carries the source\'s', () => {
    expect(validateQuote(call, 'Noted', null)).toMatchObject({ ok: true, utt: 4, speaker: 'Cy' });
  });

  test('a speaker named against utterances with none is refused', () => {
    const notes = parseIntake('We use Postgres for everything.', 'md');
    expect(validateQuote(notes, 'We use Postgres', 'Ana')).toEqual({ ok: false, reason: 'wrong-speaker' });
    expect(validateQuote(notes, 'We use Postgres', null)).toMatchObject({ ok: true, speaker: null });
  });

  test('of several occurrences, the first said by the named speaker', () => {
    const us: QuotedUtterance[] = [
      { idx: 0, speaker: 'Ana', text: 'Ship it on Friday.' },
      { idx: 1, speaker: 'Bo', text: 'Ship it on Friday?' },
    ];
    expect(validateQuote(us, 'ship it on friday', 'Bo')).toMatchObject({ ok: true, utt: 1, charStart: 0, charEnd: 17 });
    expect(validateQuote(us, 'ship it on friday', null)).toMatchObject({ ok: true, utt: 0 });
  });

  test('empty or punctuation-only quotes are refused', () => {
    expect(validateQuote(call, '', null)).toEqual({ ok: false, reason: 'empty' });
    expect(validateQuote(call, ' "…" ', null)).toEqual({ ok: false, reason: 'empty' });
  });

  test('no utterances: nothing is found', () => {
    expect(validateQuote([], 'anything at all', null)).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('validateQuote: across utterances', () => {
  test('a run of consecutive utterances by one speaker', () => {
    const r = validateQuote(call, 'safer for the batch importer. And we will not use Redis', 'Bo');
    expect(r).toMatchObject({ ok: true, utt: 1, uttEnd: 2, speaker: 'Bo', quote: 'safer for the batch importer. And we will not use Redis' });
    if (!r.ok) throw new Error('expected a match');
    expect(call[1].text.slice(r.charStart)).toBe('safer for the batch importer.');
    expect(call[2].text.slice(0, r.charEnd)).toBe('And we will not use Redis');
  });

  test('a run that spans the middle of three utterances keeps the middle whole', () => {
    const us: QuotedUtterance[] = [
      { idx: 7, speaker: 'Ana', text: 'one two' },
      { idx: 8, speaker: 'Ana', text: 'three' },
      { idx: 9, speaker: 'Ana', text: 'four five' },
    ];
    expect(validateQuote(us, 'two three four', 'Ana')).toMatchObject({ ok: true, utt: 7, uttEnd: 9, charStart: 4, charEnd: 4, quote: 'two three four' });
  });

  test('a run across two speakers is refused', () => {
    expect(validateQuote(call, 'the batch importer. And we will not use Redis for the queue. Fine. Let us test', 'Bo')).toEqual({ ok: false, reason: 'mixed-speakers' });
    expect(validateQuote(call, 'decide anything final. Noted', null)).toEqual({ ok: false, reason: 'mixed-speakers' });
  });

  test('utterances with no words do not break a run', () => {
    const us: QuotedUtterance[] = [
      { idx: 0, speaker: 'Ana', text: 'We will ship' },
      { idx: 1, speaker: 'Bo', text: '...' },
      { idx: 2, speaker: 'Ana', text: 'on Friday.' },
    ];
    expect(validateQuote(us, 'we will ship on friday', 'Ana')).toMatchObject({ ok: true, utt: 0, uttEnd: 2, quote: 'We will ship ... on Friday' });
  });
});

describe('validateQuote: near matches', () => {
  const long = 'Let us test both timeouts next week before we decide anything final';

  test('within 3% of the length: kept, flagged quote-fuzzy, stored as the source\'s words', () => {
    // Two edits in a 68-character quote (budget 2).
    expect(Math.floor(normalizeForQuote(long).norm.length * QUOTE_FUZZY_SHARE)).toBe(2);
    const r = validateQuote(call, 'Let us test both timeout next week before we decided anything final', 'Ana Lopez');
    expect(r).toMatchObject({ ok: true, utt: 3, flags: ['quote-fuzzy'], distance: 2, quote: long, speaker: 'Ana Lopez' });
  });

  test('a near match keeps whole words of the source at its ends', () => {
    const r = validateQuote(call, 'et us test both timeouts next week before we decide anything final', 'Ana Lopez');
    expect(r).toMatchObject({ ok: true, flags: ['quote-fuzzy'], distance: 1, quote: long });
  });

  test('beyond the budget: not found', () => {
    expect(validateQuote(call, 'Let us try both timeouts the next week before we choose anything final', 'Ana Lopez')).toEqual({ ok: false, reason: 'not-found' });
  });

  test('short quotes get no budget: one changed letter is not found', () => {
    expect(validateQuote(call, 'retry timeout to 31 seconds', 'Ana Lopez')).toEqual({ ok: false, reason: 'not-found' });
  });

  test('a near match by the wrong speaker is refused', () => {
    expect(validateQuote(call, 'Let us test both timeout next week before we decided anything final', 'Bo')).toEqual({ ok: false, reason: 'wrong-speaker' });
  });

  test('a near match across utterances', () => {
    const r = validateQuote(call, 'safer for the batch importers. And we will not use Redis for the queue', 'Bo');
    expect(r).toMatchObject({ ok: true, utt: 1, uttEnd: 2, flags: ['quote-fuzzy'], quote: 'safer for the batch importer. And we will not use Redis for the queue' });
  });

  test('the closest of several near matches wins', () => {
    const base = 'the importer retries every batch three times before it gives up on the remote host';
    const us: QuotedUtterance[] = [
      { idx: 0, speaker: 'Ana', text: base.replace('three', 'thre').replace('remote', 'remot') },
      { idx: 1, speaker: 'Ana', text: base.replace('three', 'thre') },
    ];
    expect(validateQuote(us, base, 'Ana')).toMatchObject({ ok: true, utt: 1, distance: 1 });
  });

  test('stays fast on a long source with many repeats of the quote\'s words', () => {
    const filler = 'we will test both of the timeouts next week. ';
    const us: QuotedUtterance[] = Array.from({ length: 400 }, (_, i) => ({ idx: i, speaker: i % 2 ? 'Ana' : 'Bo', text: filler.repeat(5) }));
    const start = performance.now();
    const r = validateQuote(us, 'we will test both of the timeouts next month and then we will decide', 'Ana');
    expect(r.ok).toBe(false);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
