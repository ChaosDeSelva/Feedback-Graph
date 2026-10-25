import { createHash } from 'node:crypto';
import type { ParsedSession } from '@fb/core';

/**
 * Codex can import Claude Code conversations into its own session store (external-agent-import-sync), and its rollout
 * files carry no marker we can rely on saying so. The same conversation would then be ingested twice, once per agent,
 * and give two Inbox items for every miss. A fingerprint of the opening human turns (normalised: case, spacing and
 * punctuation dropped) lets ingest skip the Codex copy of a conversation already read from Claude Code.
 */

/** Enough opening turns to tell conversations apart, few enough that a copy which has grown since still matches. */
const OPENING_TURNS = 3;
/** Below this much normalised text ("hi", "go on") two different conversations could look the same. */
const MIN_CHARS = 40;
const PER_TURN = 500;

const normalise = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, PER_TURN);

/** The conversation's fingerprint, or null when its opening is too short (or a single turn) to tell it apart from another. */
export function conversationFingerprint(s: Pick<ParsedSession, 'turns'>): string | null {
  const opening = s.turns.slice(0, OPENING_TURNS).map((t) => normalise(t.text));
  // One turn is not enough: the same prompt given to both agents, to compare them, is two conversations.
  if (opening.length < 2 || opening.join('').length < MIN_CHARS) return null;
  return createHash('sha256').update(opening.join('\n')).digest('hex').slice(0, 32);
}
