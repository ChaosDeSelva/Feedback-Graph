import type { ToolCall } from './types.ts';
/** Match a persisted write, never a read or a mention in the agent's prose. */
export function writesMemory(calls: ToolCall[], path: string): boolean {
  const suffix = `/memory/${path.replaceAll('\\', '/').split('/').at(-1)}`;
  return calls.some(call => {
    if (/(?:write|edit|patch)/i.test(call.name) && call.filePath?.replaceAll('\\', '/').endsWith(suffix)) return true;
    const command = call.command?.replaceAll('\\', '/');
    return !!command?.includes(suffix) && /(?:>|\btee\b|\bcp\b|\bmv\b|write_text|writeFile|\bsed\s+-i\b)/.test(command);
  });
}
