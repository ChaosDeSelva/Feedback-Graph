/**
 * Intake parsing: a transcript, notes or a doc (txt, md, vtt, srt) turned into utterances, the unit later stages chunk,
 * window and check quotes against: everything is keyed by (source, utterance idx, char start, char end).
 */

export const INTAKE_FORMATS = ['txt', 'md', 'vtt', 'srt'] as const;
export type IntakeFormat = (typeof INTAKE_FORMATS)[number];

/**
 * One thing said, or one paragraph of notes. speaker: the label as written ("Ana Lopez", "SPEAKER_01"), null when the
 * text names none. startMs: from the cue or line timestamp. offset: where its text starts in normalizeSourceText(input).
 * Text formats keep the source verbatim, so offset + a char index is a place in the source; caption text has its
 * markup stripped and its lines joined, so there offset is where its first words are on the cue line it begins on (the
 * line's start when markup splits them, as after a voice tag).
 */
export type Utterance = { idx: number; speaker: string | null; startMs: number | null; text: string; offset: number };

/** An utterance longer than this is split at line or sentence ends (same speaker and start), so windows stay bounded. */
export const MAX_UTTERANCE_CHARS = 2000;

/**
 * The text as it is stored and parsed: no byte order mark, \n line ends, no NUL. Idempotent, so parsing the stored text
 * again gives the same offsets.
 */
export function normalizeSourceText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?|\u2028|\u2029/g, '\n').replace(/\0/g, '');
}

/** The format of an upload: a caption file by its content first (a .txt holding SRT is SRT), then by its name, else txt. */
export function intakeFormat(fileName: string | null, text: string): IntakeFormat {
  const head = normalizeSourceText(text.slice(0, 2000));
  if (/^\s*WEBVTT(?:[ \t]|\n|$)/.test(head)) return 'vtt';
  if (/^\s*\d+[ \t]*\n[ \t]*(?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{1,3}[ \t]*-->/.test(head)) return 'srt';
  const ext = /\.([a-z0-9]+)$/i.exec(fileName ?? '')?.[1]?.toLowerCase();
  if (ext === 'vtt' || ext === 'srt' || ext === 'md') return ext;
  if (ext === 'markdown') return 'md';
  return 'txt';
}

const TS = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?`;

/** "01:02:03.500", "2:03", "00:00:01,000" to milliseconds; null when it is not a time (minutes or seconds of 60+). */
export function parseTimestamp(s: string): number | null {
  const m = /^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?\s*$/.exec(s);
  if (!m) return null;
  const [h, min, sec] = [Number(m[1] ?? 0), Number(m[2]), Number(m[3])];
  if (sec >= 60 || (m[1] !== undefined && min >= 60)) return null;
  return ((h * 60 + min) * 60 + sec) * 1000 + (m[4] ? Number(m[4].padEnd(3, '0')) : 0);
}

/**
 * Parse any intake format into utterances. A caption file with no cue in it is read as text, so nothing is lost,
 * unless it opens with a WEBVTT header (a caption file with nothing said).
 */
export function parseIntake(input: string, format: IntakeFormat): Utterance[] {
  const text = normalizeSourceText(input);
  const captions = format === 'vtt' || format === 'srt';
  let parts = captions ? parseCaptions(text, format) : [];
  if (!parts.length && !(captions && /^\s*WEBVTT(?:[ \t]|\n|$)/.test(text))) parts = parseText(text);
  return parts.flatMap(splitLong).map((p, idx) => ({ idx, ...p }));
}

type Part = Omit<Utterance, 'idx'>;
type Line = { text: string; start: number };

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (const t of text.split('\n')) {
    out.push({ text: t, start });
    start += t.length + 1;
  }
  return out;
}

const blank = (l: Line) => !l.text.trim();

// ---------------------------------------------------------------------------------------------------------------------
// Speaker labels

/** Label words that end in a colon in notes and are not people. */
const NOT_A_SPEAKER = new Set(`note notes todo to-do action actions decision decisions summary agenda question questions answer
q a re subject date time when where who what why how attendees participants present absent location warning error tip fyi
ps nb eta owner owners status next follow follow-up follow-ups outcome outcomes result results goal goals problem solution
context background risk risks blocker blockers important example title topic minutes link links url http https recording
transcript meeting call project team step phase part chapter section update updates source sources reference references
item items task tasks issue issues bug bugs fix feature features idea ideas pros cons option options proposal edit edited
monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september
october november december`.split(/\s+/));

const NAME_WORD = String.raw`(?:\p{Lu}[\p{L}\p{M}'’-]*\.?|\p{Lu}\.|\d{1,3})`;
const PARTICLE = String.raw`(?:de|da|del|della|la|le|van|von|der|den|di|du|bin|al|el|ten|ter)`;
/** A speaker label: Title Case words or initials ("Ana", "Ana de la Cruz", "Dr. Bo", "Speaker 1", "SPEAKER_01"). */
const NAME = String.raw`\p{Lu}[\p{L}\p{M}\p{N}_'’.-]{0,40}(?:[ \t]+(?:${PARTICLE}[ \t]+){0,2}${NAME_WORD}){0,3}`;
/** Markdown around a label: a list marker or quote, and bold or italic around the name (**Ana:** or **Ana**:). */
const DECOR = String.raw`(?:[-*+>][ \t]+)?(?:\*\*|__|\*|_)?`;
const UNDECOR = String.raw`(?:\*\*|__|\*|_)?`;

/** "[00:12:03] Ana Lopez: text", "00:12:03 Ana: text", "**Ana** (12:03): text", "Ana: text" */
const TS_THEN_NAME = new RegExp(String.raw`^[ \t]*${DECOR}[\[(]?(${TS})[\])]?[ \t]+(?:[-–][ \t]+)?${UNDECOR}(${NAME})${UNDECOR}[ \t]*:${UNDECOR}(?:[ \t]+|$)`, 'u');
const NAME_THEN_TS = new RegExp(String.raw`^[ \t]*${DECOR}(${NAME})${UNDECOR}(?:[ \t]*[\[(](${TS})[\])])?[ \t]*:${UNDECOR}(?:[ \t]+|$)`, 'u');
/** An Otter heading, alone on its line: "Ana Lopez  0:03" (the words follow on the next lines). */
const HEADING = new RegExp(String.raw`^[ \t]*${DECOR}(${NAME})${UNDECOR}[ \t]+[\[(]?(${TS})[\])]?[ \t]*$`, 'u');
/** A timestamped line with no speaker: "[00:12:03] text". */
const TS_ONLY = new RegExp(String.raw`^[ \t]*[\[(](${TS})[\])][ \t]+(?=\S)`, 'u');

const speakerName = (name: string) => {
  const n = name.trim();
  const first = n.split(/[\s.]+/)[0].toLowerCase();
  return NOT_A_SPEAKER.has(first) || NOT_A_SPEAKER.has(n.toLowerCase()) ? null : n;
};

/** A line that opens a turn: who speaks, when, and where on the line the words start (null for a heading). */
type Turn = { speaker: string | null; startMs: number | null; textAt: number | null };

function turnOf(line: string): Turn | null {
  let m = TS_THEN_NAME.exec(line);
  if (m && speakerName(m[2])) return { speaker: speakerName(m[2]), startMs: parseTimestamp(m[1]), textAt: m[0].length };
  m = NAME_THEN_TS.exec(line);
  // "Docs: https://..." is a label and a link, not a person speaking.
  if (m && speakerName(m[1]) && !line.slice(m[0].length).startsWith('//')) {
    return { speaker: speakerName(m[1]), startMs: m[2] ? parseTimestamp(m[2]) : null, textAt: m[0].length };
  }
  m = HEADING.exec(line);
  if (m && speakerName(m[1])) return { speaker: speakerName(m[1]), startMs: parseTimestamp(m[2]), textAt: null };
  m = TS_ONLY.exec(line);
  if (m) return { speaker: null, startMs: parseTimestamp(m[1]), textAt: m[0].length };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// txt and md

/**
 * A transcript when at least two lines, and three in ten of the non-blank ones, open a turn: each turn runs to the
 * next turn or blank line, and text outside any turn is a paragraph with no speaker. Otherwise one utterance per
 * paragraph. Utterance text is the source verbatim, so offset + a char index is a place in the source.
 */
function parseText(text: string): Part[] {
  const lines = linesOf(text);
  const nonBlank = lines.filter((l) => !blank(l)).length;
  const turns = lines.map((l) => (blank(l) ? null : turnOf(l.text)));
  const turnCount = turns.filter(Boolean).length;
  return turnCount >= 2 && turnCount * 10 >= nonBlank * 3 ? transcriptOf(text, lines, turns) : paragraphsOf(text, lines);
}

/** The source between start and end, trimmed, with the offset of its first character. */
function slice(text: string, start: number, end: number): { text: string; offset: number } {
  const raw = text.slice(start, end);
  const lead = raw.length - raw.trimStart().length;
  return { text: raw.trim(), offset: start + lead };
}

function paragraphsOf(text: string, lines: Line[]): Part[] {
  const out: Part[] = [];
  let from: Line | null = null;
  let last: Line | null = null;
  const close = () => {
    if (from && last) out.push({ speaker: null, startMs: null, ...slice(text, from.start, last.start + last.text.length) });
    from = last = null;
  };
  for (const l of lines) {
    if (blank(l)) close();
    else {
      from ??= l;
      last = l;
    }
  }
  close();
  return out;
}

function transcriptOf(text: string, lines: Line[], turns: (Turn | null)[]): Part[] {
  const out: Part[] = [];
  type Open = { speaker: string | null; startMs: number | null; start: number | null; end: number };
  let cur: Open | null = null;
  const close = () => {
    if (cur && cur.start !== null) {
      const s = slice(text, cur.start, cur.end);
      if (s.text) out.push({ speaker: cur.speaker, startMs: cur.startMs, ...s });
    }
    cur = null;
  };
  lines.forEach((l, i) => {
    const turn = turns[i];
    if (blank(l)) {
      // A heading keeps its turn open across blank lines until its words come.
      if (cur && cur.start === null) return;
      close();
      return;
    }
    if (turn) {
      close();
      const at = turn.textAt === null || turn.textAt >= l.text.length ? null : l.start + turn.textAt;
      cur = { speaker: turn.speaker, startMs: turn.startMs, start: at, end: l.start + l.text.length };
      return;
    }
    if (cur) {
      cur.start ??= l.start;
      cur.end = l.start + l.text.length;
    } else cur = { speaker: null, startMs: null, start: l.start, end: l.start + l.text.length };
  });
  close();
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// vtt and srt

const TIMING = new RegExp(String.raw`^[ \t]*(${TS})[ \t]*-->[ \t]*(${TS})`);
const VTT_BLOCK = /^[ \t]*(?:WEBVTT|NOTE|STYLE|REGION)(?:[ \t]|$)/;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

/** Caption markup off: VTT tags (<c.x>, <i>, <00:00:01.000>, <lang>), SRT <font> and {\an8}, entities decoded. */
const cleanCaption = (s: string) =>
  s.replace(/<[^>\n]{0,200}>/g, '').replace(/\{\\[^}\n]{0,40}\}/g, '').replace(/&(amp|lt|gt|quot|apos|nbsp|lrm|rlm);/g, (_m, e: string) => ENTITIES[e]);

type Cue = { startMs: number | null; lines: Line[] };

/**
 * Cues by their timing lines. Tolerates what exports get wrong: no WEBVTT header, no blank line between cues (a
 * number line right before a timing line is the next cue's index), hours left out, a timing line that is not a time
 * (startMs null), and text with no timing line (joined to the cue before it, or a cue of its own when there is none
 * or it opens with a speaker).
 */
function cuesOf(text: string): Cue[] {
  const lines = linesOf(text);
  const cues: Cue[] = [];
  let cur: Cue | null = null;
  let skipping = false;
  let afterBlank = true;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (blank(l)) {
      cur = null;
      skipping = false;
      afterBlank = true;
      continue;
    }
    const wasAfterBlank = afterBlank;
    afterBlank = false;
    const timing = TIMING.exec(l.text);
    if (timing) {
      skipping = false;
      if (cur && cur.lines.length && /^\s*\d+\s*$/.test(cur.lines[cur.lines.length - 1].text)) cur.lines.pop();
      cur = { startMs: parseTimestamp(timing[1]), lines: [] };
      cues.push(cur);
      continue;
    }
    if (skipping) continue;
    if (cur) {
      cur.lines.push(l);
      continue;
    }
    // Outside a cue: a header or note block, a cue id or index, or stray text.
    if (wasAfterBlank && VTT_BLOCK.test(l.text)) {
      skipping = true;
      continue;
    }
    const next = lines[i + 1];
    if (/^\s*\d+\s*$/.test(l.text) || (next && TIMING.test(next.text))) continue;
    const prev = cues[cues.length - 1];
    if (prev && prev.lines.length && !turnOf(cleanCaption(l.text))) {
      prev.lines.push(l);
      cur = prev;
    } else {
      cur = { startMs: null, lines: [l] };
      cues.push(cur);
    }
  }
  return cues;
}

/**
 * Each cue into utterances: one per <v Name> voice span (a cue may hold several), and within text with no voice tag
 * one per line that opens with a speaker ("Ana: ...", "- Ana: ..."), the other lines joined to the one before.
 */
function parseCaptions(text: string, format: IntakeFormat): Part[] {
  const out: Part[] = [];
  for (const cue of cuesOf(text)) {
    let speaker: string | null = null;
    let open = null as Part | null;
    const push = (p: Part) => {
      if (open) out.push(open);
      open = p;
    };
    const add = (line: Line, raw: string, voice: string | null | undefined) => {
      if (voice !== undefined) {
        // A voice tag starts a new utterance even when the text after it is on the next line.
        speaker = voice;
        push({ speaker, startMs: cue.startMs, text: '', offset: line.start });
      }
      const words = cleanCaption(raw).trim();
      if (!words) return;
      const dash = /^[-–][ \t]+/.exec(words)?.[0].length ?? 0;
      const turn = format === 'vtt' && voice !== undefined ? null : turnOf(words.slice(dash));
      if (turn && turn.speaker && turn.textAt !== null) {
        speaker = turn.speaker;
        const said = words.slice(dash + turn.textAt).trim();
        const at = line.text.indexOf(said.slice(0, 12));
        push({ speaker, startMs: cue.startMs, text: said, offset: line.start + (at < 0 ? 0 : at) });
        return;
      }
      const said = words.slice(dash);
      if (!open || dash) {
        const at = line.text.indexOf(said.slice(0, 12));
        push({ speaker, startMs: cue.startMs, text: said, offset: line.start + (at < 0 ? 0 : at) });
      } else {
        const o: Part = open;
        o.text = o.text ? `${o.text}\n${said}` : said;
      }
    };
    for (const line of cue.lines) {
      // <v Ana>, <v.loud Ana>; the text before the first tag on a line keeps the voice before it.
      const spans = line.text.split(/<v(?:\.[\w.-]*)?[ \t]+([^>\n]{1,80})>/);
      add(line, spans[0], undefined);
      for (let k = 1; k < spans.length; k += 2) add(line, spans[k + 1].replace(/<\/v>/g, ''), spans[k].trim() || null);
    }
    if (open) out.push(open);
  }
  return out.filter((p) => p.text.trim());
}

// ---------------------------------------------------------------------------------------------------------------------

/** An utterance over MAX_UTTERANCE_CHARS in pieces: at the last line end, else sentence end, else space before the cap. */
function splitLong(p: Part): Part[] {
  const out: Part[] = [];
  let rest = p.text;
  let offset = p.offset;
  while (rest.length > MAX_UTTERANCE_CHARS) {
    const head = rest.slice(0, MAX_UTTERANCE_CHARS);
    const min = MAX_UTTERANCE_CHARS / 2;
    const at = [head.lastIndexOf('\n'), Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! ')) + 1, head.lastIndexOf(' ')]
      .find((x) => x >= min) ?? MAX_UTTERANCE_CHARS;
    const piece = rest.slice(0, at);
    const next = rest.slice(at);
    const lead = next.length - next.trimStart().length;
    out.push({ ...p, text: piece.trimEnd(), offset });
    offset += at + lead;
    rest = next.trimStart();
  }
  if (rest) out.push({ ...p, text: rest, offset });
  return out;
}
