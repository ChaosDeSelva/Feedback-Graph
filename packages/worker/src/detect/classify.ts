import { z } from 'zod';
import { TURN_LABELS, type Classification, type HumanTurn } from '@fb/core';
import { ProviderUnavailableError, providerUnavailableReason, type LlmProvider } from '@fb/core';
import { prefilterPushback } from './prefilter.ts';

const Result = z.object({
  label: z.enum(TURN_LABELS as [string, ...string[]]),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
});

const SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string', enum: [...TURN_LABELS] },
    confidence: { type: 'number' },
    summary: { type: 'string' },
  },
  required: ['label', 'confidence', 'summary'],
};

const SYSTEM = `You label one message a developer sent to an AI coding agent, right after the agent did some work.
Labels:
- pushback: the developer says the agent's work is wrong, incomplete, broken, or not what they asked for.
- correction: the developer corrects a specific detail of what the agent just did (a value, size, place, wording) because it is off.
- approval: the developer accepts the work ("looks good", "perfect, ship it").
- neutral: a new request, a question, an instruction, or status chatter that does not judge the previous work.
New feature requests are neutral even if phrased as "make X bigger" without implying the agent got it wrong.
summary: one short sentence naming what the developer thinks was missed or wrong (empty for neutral/approval).
confidence: 0..1.`;


export function describeTurn(turn: HumanTurn): string {
  const tools = turn.precedingToolCalls
    .map((c) => `${c.name} ${c.filePath ?? c.command ?? ''}`.trim())
    .slice(-15)
    .join('\n');
  return [
    `AGENT'S LAST MESSAGE:\n${turn.precedingAssistantText || '(none)'}`,
    `AGENT'S TOOL CALLS:\n${tools || '(none)'}`,
    `DEVELOPER'S MESSAGE:\n${turn.text}`,
  ].join('\n\n');
}

/**
 * The model's label for `turn`, or null when its answer cannot be used (that counts against the turn). Throws
 * ProviderUnavailableError when the model could not be asked at all, which must never count against the turn.
 */
export async function classifyTurn(turn: HumanTurn, llm: LlmProvider): Promise<Classification | null> {
  let raw: unknown;
  try {
    raw = await llm.json({ system: SYSTEM, user: describeTurn(turn), schema: SCHEMA, timeoutMs: 120_000 });
  } catch (err) {
    const unavailable = providerUnavailableReason(err);
    if (unavailable) throw err instanceof ProviderUnavailableError ? err : new ProviderUnavailableError(unavailable);
    return null;
  }
  const r = Result.safeParse(raw);
  if (!r.success) return null;
  return { ...r.data, label: r.data.label as Classification['label'], signals: prefilterPushback(turn.text).signals };
}
