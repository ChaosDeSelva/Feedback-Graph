/** An ISO 8601 time as transcripts write it: a date, a time to the minute or finer, and maybe a zone. */
const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Whether a transcript's timestamp is a real time every store can hold. JavaScript reads `2026-02-30` as 2 March and
 * Neo4j keeps the text, but Postgres refuses it (and minute 60), and with it the whole transcript, every cycle.
 */
export function storableTimestamp(ts: string): boolean {
  const m = ISO.exec(ts);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map((x) => Number(x ?? 0));
  return mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() && h <= 23 && mi <= 59 && s <= 59;
}
