import { describe, expect, test } from 'vitest';
import { intakeFormat, MAX_UTTERANCE_CHARS, normalizeSourceText, parseIntake, parseTimestamp, type Utterance } from './parse.ts';

const brief = (us: Utterance[]) => us.map((u) => [u.speaker, u.startMs, u.text]);

/** Every utterance's offset points at its text in the normalised source (text formats keep the source verbatim). */
function expectVerbatim(source: string, us: Utterance[]) {
  const src = normalizeSourceText(source);
  for (const u of us) expect(src.slice(u.offset, u.offset + u.text.length)).toBe(u.text);
}

describe('parseTimestamp', () => {
  test.each([
    ['00:00:01.000', 1000], ['01:02:03.5', 3_723_500], ['2:03', 123_000], ['00:00:01,250', 1250], ['10:15', 615_000], ['1:00:00', 3_600_000],
  ])('%s is %d ms', (s, ms) => expect(parseTimestamp(s)).toBe(ms));
  test.each(['', 'abc', '1:2', '00:61', '1:60:00', '12'])('%j is not a time', (s) => expect(parseTimestamp(s)).toBeNull());
});

describe('intakeFormat', () => {
  test('caption content wins over the name, then the extension, else txt', () => {
    expect(intakeFormat('call.txt', '﻿WEBVTT\n\n00:01.000 --> 00:02.000\nhi')).toBe('vtt');
    expect(intakeFormat(null, '1\r\n00:00:01,000 --> 00:00:02,000\r\nhi\r\n')).toBe('srt');
    expect(intakeFormat('a.SRT', 'hello')).toBe('srt');
    expect(intakeFormat('a.vtt', 'hello')).toBe('vtt');
    expect(intakeFormat('notes.md', '# Notes')).toBe('md');
    expect(intakeFormat('notes.markdown', '# Notes')).toBe('md');
    expect(intakeFormat('notes.rtf', 'x')).toBe('txt');
    expect(intakeFormat(null, 'Ana: hello')).toBe('txt');
    // WEBVTT must be the whole first word.
    expect(intakeFormat(null, 'WEBVTTish notes')).toBe('txt');
  });
});

describe('normalizeSourceText', () => {
  test('drops a BOM and NULs, ends lines with \\n, and is idempotent', () => {
    const once = normalizeSourceText('﻿a\r\nb\rc d\0e');
    expect(once).toBe('a\nb\nc\nde');
    expect(normalizeSourceText(once)).toBe(once);
  });
});

describe('txt and md transcripts', () => {
  test('Name: text lines, with continuation lines joined to the turn', () => {
    const src = 'Ana Lopez: We should move the retry timeout to 30 seconds.\nIt keeps failing on slow networks.\nBo: I disagree, 60 seconds is safer.\n\nAna Lopez: Fine, let us test both.';
    const us = parseIntake(src, 'txt');
    expect(brief(us)).toEqual([
      ['Ana Lopez', null, 'We should move the retry timeout to 30 seconds.\nIt keeps failing on slow networks.'],
      ['Bo', null, 'I disagree, 60 seconds is safer.'],
      ['Ana Lopez', null, 'Fine, let us test both.'],
    ]);
    expect(us.map((u) => u.idx)).toEqual([0, 1, 2]);
    expectVerbatim(src, us);
  });

  test('timestamped lines in the shapes meeting tools export', () => {
    const src = [
      '[00:12:03] Ana: First point.',
      '00:12:10 Bo Chen: Second point.',
      '(00:12:20) Ana: Third.',
      '[12:30] - Bo Chen: Fourth.',
      'Ana (00:13:00): Fifth.',
      'Bo Chen [13:05]: Sixth.',
      '[00:13:10] A line with no speaker.',
    ].join('\n');
    expect(brief(parseIntake(src, 'txt'))).toEqual([
      ['Ana', 723_000, 'First point.'],
      ['Bo Chen', 730_000, 'Second point.'],
      ['Ana', 740_000, 'Third.'],
      ['Bo Chen', 750_000, 'Fourth.'],
      ['Ana', 780_000, 'Fifth.'],
      ['Bo Chen', 785_000, 'Sixth.'],
      [null, 790_000, 'A line with no speaker.'],
    ]);
    expectVerbatim(src, parseIntake(src, 'txt'));
  });

  test('Otter headings: the speaker and time on a line of their own, the words after', () => {
    const src = 'Ana Lopez  0:03\nWe ship on the twelfth.\n\nBo Chen  0:15\n\nNot before January.\nThe audit runs first.\n';
    const us = parseIntake(src, 'txt');
    expect(brief(us)).toEqual([
      ['Ana Lopez', 3000, 'We ship on the twelfth.'],
      ['Bo Chen', 15_000, 'Not before January.\nThe audit runs first.'],
    ]);
    expectVerbatim(src, us);
  });

  test('markdown decoration around a speaker: bold names and list markers', () => {
    const src = '# Weekly sync\n\n**Ana:** We use Postgres.\n- **Bo**: We use MySQL.\n* _Cy Dee_: Either works.\n> Ana: Postgres then.';
    const us = parseIntake(src, 'md');
    expect(brief(us)).toEqual([
      [null, null, '# Weekly sync'],
      ['Ana', null, 'We use Postgres.'],
      ['Bo', null, 'We use MySQL.'],
      ['Cy Dee', null, 'Either works.'],
      ['Ana', null, 'Postgres then.'],
    ]);
    expectVerbatim(src, us);
  });

  test('labels that end in a colon are not speakers', () => {
    const src = 'Decision: we use Postgres.\nAction items: Ana writes the migration.\nNote: the audit runs first.\nDocs: https://example.test/spec';
    expect(brief(parseIntake(src, 'md'))).toEqual([[null, null, src]]);
  });

  test('prose with a colon mid-sentence is not a speaker', () => {
    const src = 'The plan is simple: we ship on Friday.\nwhat we know: not much.\n\nAnother paragraph.';
    expect(brief(parseIntake(src, 'txt'))).toEqual([
      [null, null, 'The plan is simple: we ship on Friday.\nwhat we know: not much.'],
      [null, null, 'Another paragraph.'],
    ]);
  });

  test('one speaker line in a page of notes leaves it as paragraphs', () => {
    const src = 'Context for the project.\nMore context.\nEven more.\nAnd more.\n\nAna: one aside.\nThen notes again.\nAnd again.';
    expect(parseIntake(src, 'txt').every((u) => u.speaker === null)).toBe(true);
  });

  test('a preamble before the first turn is a paragraph with no speaker', () => {
    const src = 'Weekly sync, 10 November\n\nAna: Hello.\nBo: Hi.';
    expect(brief(parseIntake(src, 'txt'))).toEqual([[null, null, 'Weekly sync, 10 November'], ['Ana', null, 'Hello.'], ['Bo', null, 'Hi.']]);
  });

  test('a blank line ends a turn: the paragraph after it has no speaker', () => {
    const src = 'Ana: One.\nBo: Two.\n\nA paragraph after.';
    expect(brief(parseIntake(src, 'txt'))).toEqual([['Ana', null, 'One.'], ['Bo', null, 'Two.'], [null, null, 'A paragraph after.']]);
  });

  test('a speaker label with nothing after it takes the lines that follow', () => {
    const src = 'Ana:\nWe should cache it.\nBo:\n\nAgreed.';
    expect(brief(parseIntake(src, 'txt'))).toEqual([['Ana', null, 'We should cache it.'], ['Bo', null, 'Agreed.']]);
  });

  test('a speaker who says nothing gives no utterance', () => {
    expect(brief(parseIntake('Ana:\nBo: Hi.\nCy: Yo.', 'txt'))).toEqual([['Bo', null, 'Hi.'], ['Cy', null, 'Yo.']]);
    expect(brief(parseIntake('Bo: Hi.\nAna:\n\nCy: Yo.', 'txt'))).toEqual([['Bo', null, 'Hi.'], ['Cy', null, 'Yo.']]);
  });

  test('speaker labels as recognisers write them', () => {
    const src = 'SPEAKER_01: Hello.\nSpeaker 2: Hi.\nDr. Bo: Yes.\nAna de la Cruz: Fine.\nJ. R.: Done.';
    expect(parseIntake(src, 'txt').map((u) => u.speaker)).toEqual(['SPEAKER_01', 'Speaker 2', 'Dr. Bo', 'Ana de la Cruz', 'J. R.']);
  });

  test('CRLF and a BOM: offsets index the normalised text', () => {
    const src = '﻿Ana: Hello there.\r\nBo: Hi.\r\n';
    const us = parseIntake(src, 'txt');
    expect(brief(us)).toEqual([['Ana', null, 'Hello there.'], ['Bo', null, 'Hi.']]);
    expectVerbatim(src, us);
  });
});

describe('txt and md documents', () => {
  test('one utterance per paragraph, verbatim', () => {
    const src = '  First paragraph,\nstill first.  \n\n\n\nSecond.\n   \nThird.';
    const us = parseIntake(src, 'md');
    expect(brief(us)).toEqual([[null, null, 'First paragraph,\nstill first.'], [null, null, 'Second.'], [null, null, 'Third.']]);
    expectVerbatim(src, us);
  });

  test('empty and blank input give nothing', () => {
    expect(parseIntake('', 'txt')).toEqual([]);
    expect(parseIntake(' \n\n\t\n', 'md')).toEqual([]);
    expect(parseIntake('', 'vtt')).toEqual([]);
  });

  test('a long paragraph is split at line ends, a long line at sentence ends, keeping its speaker', () => {
    const sentence = 'The retry timeout stays at thirty seconds for now. ';
    const line = sentence.repeat(60).trim();
    const src = `Ana: ${line}\nBo: Short.`;
    const us = parseIntake(src, 'txt');
    expect(us.length).toBeGreaterThan(2);
    for (const u of us) expect(u.text.length).toBeLessThanOrEqual(MAX_UTTERANCE_CHARS);
    expect(us.slice(0, -1).every((u) => u.speaker === 'Ana' && u.text.endsWith('.'))).toBe(true);
    expect(us.at(-1)).toMatchObject({ speaker: 'Bo', text: 'Short.' });
    expect(us.slice(0, -1).map((u) => u.text).join(' ')).toBe(line);
    expect(us.map((u) => u.idx)).toEqual(us.map((_, i) => i));
    expectVerbatim(src, us);

    const lines = Array.from({ length: 80 }, (_, i) => `Line ${i} of the spec says something.`).join('\n');
    const para = parseIntake(lines, 'md');
    expect(para.length).toBeGreaterThan(1);
    expect(para.every((u) => u.text.length <= MAX_UTTERANCE_CHARS && !u.text.startsWith('\n'))).toBe(true);
    expectVerbatim(lines, para);
  });

  test('text with no break at all is cut at the cap', () => {
    const src = 'x'.repeat(MAX_UTTERANCE_CHARS * 2 + 10);
    const us = parseIntake(src, 'txt');
    expect(us.map((u) => u.text.length)).toEqual([MAX_UTTERANCE_CHARS, MAX_UTTERANCE_CHARS, 10]);
    expectVerbatim(src, us);
  });
});

describe('vtt', () => {
  test('cues with voice tags, ids, settings, notes and styles', () => {
    const src = `WEBVTT - Weekly sync
Kind: captions

NOTE recorded by the meeting tool
it spans lines

STYLE
::cue { color: white }

intro
00:00:01.000 --> 00:00:04.000 align:start position:10%
<v Ana Lopez>We should move the retry timeout
to <b>30 seconds</b>.</v>

00:00:05.000 --> 00:00:07.500
<v.loud Bo>No, keep it at 60 &amp; add jitter.

00:01:02.250 --> 00:01:03.000
<c.yellow>Unvoiced caption</c> <00:01:02.500>text`;
    const us = parseIntake(src, 'vtt');
    expect(brief(us)).toEqual([
      ['Ana Lopez', 1000, 'We should move the retry timeout\nto 30 seconds.'],
      ['Bo', 5000, 'No, keep it at 60 & add jitter.'],
      [null, 62_250, 'Unvoiced caption text'],
    ]);
    const norm = normalizeSourceText(src);
    expect(norm.slice(us[0].offset).startsWith('<v Ana Lopez>')).toBe(true);
    expect(norm.slice(us[1].offset).startsWith('<v.loud Bo>')).toBe(true);
    expect(norm.slice(us[2].offset).startsWith('Unvoiced caption')).toBe(true);
  });

  test('several voices in one cue, one per utterance, and a voice carried to the next line', () => {
    const src = 'WEBVTT\n\n00:10.000 --> 00:12.000\n<v Ana>Ready?</v> <v Bo>Yes.</v>\nLet us go.\n';
    expect(brief(parseIntake(src, 'vtt'))).toEqual([['Ana', 10_000, 'Ready?'], ['Bo', 10_000, 'Yes.\nLet us go.']]);
  });

  test('a voice tag with its words on the next line', () => {
    expect(brief(parseIntake('WEBVTT\n\n00:01.000 --> 00:02.000\n<v Ana>\nHello.', 'vtt'))).toEqual([['Ana', 1000, 'Hello.']]);
  });

  test('Name: prefixes in cues (Zoom), and dialogue dashes', () => {
    const src = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nAna Lopez: We ship Friday.\n\n2\n00:00:03.000 --> 00:00:05.000\n- Bo: Monday.\n- Ana Lopez: Friday!\n';
    expect(brief(parseIntake(src, 'vtt'))).toEqual([['Ana Lopez', 1000, 'We ship Friday.'], ['Bo', 3000, 'Monday.'], ['Ana Lopez', 3000, 'Friday!']]);
  });

  test('malformed: no header, no blank lines between cues, a header block running into the first cue', () => {
    const noHeader = '00:01.000 --> 00:02.000\nAna: One.\n00:02.000 --> 00:03.000\nBo: Two.';
    expect(brief(parseIntake(noHeader, 'vtt'))).toEqual([['Ana', 1000, 'One.'], ['Bo', 2000, 'Two.']]);
    const runOn = 'WEBVTT\nKind: captions\n00:01.000 --> 00:02.000\nHello.';
    expect(brief(parseIntake(runOn, 'vtt'))).toEqual([[null, 1000, 'Hello.']]);
  });

  test('malformed: a timing line that is not a time, an empty cue, and stray text', () => {
    const src = 'WEBVTT\n\n00:99.000 --> 00:100.000\nBroken time.\n\n00:01.000 --> 00:02.000\n\n00:02.000 --> 00:03.000\nAna: First half\n\nsecond half after a blank line.\n\nBo: a stray turn with no timing.';
    expect(brief(parseIntake(src, 'vtt'))).toEqual([
      // A timing line by its shape whose time is not one.
      [null, null, 'Broken time.'],
      ['Ana', 2000, 'First half\nsecond half after a blank line.'],
      ['Bo', null, 'a stray turn with no timing.'],
    ]);
  });

  test('a caption file with no cue at all is read as text, unless it is a WEBVTT file with none', () => {
    expect(brief(parseIntake('Ana: hello\nBo: hi', 'vtt'))).toEqual([['Ana', null, 'hello'], ['Bo', null, 'hi']]);
    expect(brief(parseIntake('Just a paragraph.', 'srt'))).toEqual([[null, null, 'Just a paragraph.']]);
    expect(parseIntake('WEBVTT\n\nNOTE only a note', 'vtt')).toEqual([]);
  });
});

describe('srt', () => {
  test('numbered cues with comma milliseconds, tags and positioning codes', () => {
    const src = '1\r\n00:00:01,000 --> 00:00:04,000\r\n<i>Ana:</i> We will use Redis.\r\n\r\n2\r\n00:00:04,500 --> 00:00:06,000\r\n{\\an8}<font color="#fff">Bo: We will not.</font>\r\n\r\n3\r\n01:00:00,000 --> 01:00:02,000\r\nNo speaker here,\r\nacross two lines.\r\n';
    expect(brief(parseIntake(src, 'srt'))).toEqual([
      ['Ana', 1000, 'We will use Redis.'],
      ['Bo', 4500, 'We will not.'],
      [null, 3_600_000, 'No speaker here,\nacross two lines.'],
    ]);
  });

  test('malformed: missing blank lines, missing indexes, a missing timing line', () => {
    const src = '1\n00:00:01,000 --> 00:00:02,000\nAna: One.\n2\n00:00:02,000 --> 00:00:03,000\nBo: Two.\n00:00:03,000 --> 00:00:04,000\nThree, no index.\n\n4\nAna: Four, no timing.';
    expect(brief(parseIntake(src, 'srt'))).toEqual([
      ['Ana', 1000, 'One.'], ['Bo', 2000, 'Two.'], [null, 3000, 'Three, no index.'], ['Ana', null, 'Four, no timing.'],
    ]);
  });

  test('a cue with only markup gives no utterance', () => {
    expect(parseIntake('1\n00:00:01,000 --> 00:00:02,000\n<i></i>\n\n2\n00:00:02,000 --> 00:00:03,000\nHi.', 'srt').map((u) => u.text)).toEqual(['Hi.']);
  });
});
