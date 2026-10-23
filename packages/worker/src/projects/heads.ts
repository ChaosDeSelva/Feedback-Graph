import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { SessionSource } from '@fb/core';
import { isHumanSession } from '../ingest/codex.ts';
import type { FileState } from '../state.ts';

/** Where a session ran and whether a person drove it, from the first records of its file. */
export type SessionHead = { cwd: string | null; human: boolean };

/** A Codex meta line can carry tens of KB of instructions; past this the head is given up on (or regex-read). */
const MAX_HEAD_BYTES = 1024 * 1024;
const MAX_HEAD_LINES = 200;
const CHUNK = 64 * 1024;
const NONE: SessionHead = { cwd: null, human: false };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Read only the head of a session file. Claude Code: the first record that carries a cwd. Codex: session_meta's
 * cwd (or, in the earliest format, the first turn_context / environment_context cwd) and its thread source.
 * Symlinks are refused (O_NOFOLLOW); an unreadable file has no head.
 */
export async function readSessionHead(path: string, source: SessionSource): Promise<SessionHead> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return NONE;
  }
  try {
    const scan = source === 'codex' ? codexScanner() : claudeScanner();
    const buf = Buffer.alloc(CHUNK);
    let pending = '';
    let read = 0;
    let lines = 0;
    while (read < MAX_HEAD_BYTES && lines < MAX_HEAD_LINES) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, read);
      if (!bytesRead) break;
      read += bytesRead;
      pending += buf.toString('utf8', 0, bytesRead);
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0 && lines < MAX_HEAD_LINES) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        lines++;
        const done = scan.line(line);
        if (done) return done;
      }
    }
    // The last line may have no newline yet; a line past the cap is read with a pattern instead of JSON.
    const last = read < MAX_HEAD_BYTES ? scan.line(pending) : scan.partial(pending);
    return last ?? scan.result();
  } finally {
    await fh.close();
  }
}

type Scanner = { line(l: string): SessionHead | null; partial(text: string): SessionHead | null; result(): SessionHead };

function parse(line: string): Obj | undefined {
  if (!line.trim()) return undefined;
  try {
    return obj(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** A JSON string property out of text that is not (yet) whole JSON. */
function rawString(text: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(text);
  if (!m) return undefined;
  try {
    return str(JSON.parse(m[1]));
  } catch {
    return undefined;
  }
}

function claudeScanner(): Scanner {
  return {
    line: (l) => {
      const cwd = str(parse(l)?.cwd);
      return cwd ? { cwd, human: true } : null;
    },
    partial: (text) => {
      const cwd = rawString(text, 'cwd');
      return cwd ? { cwd, human: true } : null;
    },
    result: () => ({ cwd: null, human: true }),
  };
}

function codexScanner(): Scanner {
  let meta: Obj | null = null;
  let human = false;
  return {
    line: (l) => {
      const rec = parse(l);
      if (!rec) return null;
      const type = str(rec.type);
      const payload = obj(rec.payload);
      if (!meta) {
        if (type === 'session_meta' && payload) meta = payload;
        else if (!type && !('record_type' in rec) && str(rec.id) && str(rec.timestamp)) meta = rec; // earliest format
        else return null;
        human = isHumanSession(meta);
        const cwd = str(meta.cwd);
        return cwd || !human ? { cwd: cwd ?? null, human } : null;
      }
      if (type === 'turn_context' && payload && str(payload.cwd)) return { cwd: str(payload.cwd)!, human };
      const item = type === 'response_item' ? payload : type === 'message' ? rec : undefined;
      for (const part of Array.isArray(item?.content) ? item.content : []) {
        const m = /<cwd>([^<]+)<\/cwd>/.exec(str(obj(part)?.text) ?? '');
        if (m) return { cwd: m[1].trim(), human };
      }
      return null;
    },
    partial: (text) => {
      if (meta) return null;
      const source = rawString(text, 'thread_source');
      const isHuman = source ? source === 'user' || source === 'voice_chat' : !/"source"\s*:\s*(\{\s*"subagent"|"subagent")/.test(text);
      const cwd = rawString(text, 'cwd');
      return cwd ? { cwd, human: isHuman } : null;
    },
    result: () => (meta ? { cwd: null, human } : NONE),
  };
}

export type HeadFile = { path: string; size: number; mtimeMs: number; source: SessionSource };

/**
 * A file's head is read once: appending to a session does not move its cwd. It is read again when the file shrank
 * (replaced) or when no cwd was found yet and the file has grown since.
 */
export async function cachedHead(state: FileState, f: HeadFile, read: (path: string, source: SessionSource) => Promise<SessionHead> = readSessionHead): Promise<SessionHead> {
  const hit = state.getHead(f.path);
  if (hit && f.size >= hit.size && (hit.cwd !== null || f.size === hit.size)) return { cwd: hit.cwd, human: hit.human };
  const head = await read(f.path, f.source);
  state.putHead(f.path, f.size, head);
  return head;
}

const SCAN_CHUNK = 1024 * 1024;

/**
 * Every cwd a Codex rollout switched to after its head (turn_context records), so a session that moved into a selected
 * folder is read. Incremental: only bytes past the last scan are read, a line at a time, and only turn_context lines
 * are parsed; nothing else of the session is kept. A file that shrank (replaced) is scanned again from the start.
 */
export async function codexCwds(state: FileState, f: HeadFile): Promise<string[]> {
  const known = state.getCwds(f.path);
  let from = known && known.scanned <= f.size ? known.scanned : 0;
  const cwds = new Set(from ? known!.cwds : []);
  if (from === f.size && known) return [...cwds];
  let fh;
  try {
    fh = await open(f.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return [...cwds];
  }
  try {
    const buf = Buffer.alloc(SCAN_CHUNK);
    let carry = Buffer.alloc(0);
    let pos = from;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, SCAN_CHUNK, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      let data = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
      let nl;
      while ((nl = data.indexOf(10)) !== -1) {
        const line = data.subarray(0, nl);
        data = data.subarray(nl + 1);
        from += line.length + 1;
        if (line.includes('"turn_context"')) {
          try {
            const cwd = str(obj(obj(JSON.parse(line.toString('utf8')))?.payload)?.cwd);
            if (cwd) cwds.add(cwd);
          } catch {
            // not a whole record: skipped, as the parser skips it
          }
        }
      }
      // A line longer than the buffer keeps growing here; a partial last line waits for the next scan.
      carry = Buffer.from(data);
    }
  } finally {
    await fh.close().catch(() => {});
  }
  state.putCwds(f.path, from, [...cwds]);
  return [...cwds];
}
