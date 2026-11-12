import { providerKind, type Config } from '@fb/core';

/**
 * Intake's model: INTAKE_LLM, else DOCS_LLM, else SCAN_LLM, else the local model, the first the allow list
 * (INTAKE_PROVIDER_ALLOW, default ollama and claude-cli) takes. An inherited model the list refuses is skipped and
 * said so (`skipped`); INTAKE_LLM itself was refused at startup (config). Null: the list refuses them all.
 */
export function intakeModelSpec(config: Pick<Config, 'intake' | 'llm'>, localModel: string): { spec: string | null; skipped: string[] } {
  const chain = [config.intake.llm, config.llm.docs, config.llm.scan, localModel].filter((s): s is string => !!s);
  const skipped: string[] = [];
  for (const spec of chain) {
    if (config.intake.providerAllow.includes(providerKind(spec))) return { spec, skipped };
    skipped.push(spec);
  }
  return { spec: null, skipped };
}
