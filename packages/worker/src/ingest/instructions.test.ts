import { describe, expect, test } from 'vitest';
import { parseCodexSession } from './codex.ts';
import { claudeInstructionFiles, codexInstructionFiles } from './instructions.ts';
import { parseTranscript } from './parseTranscript.ts';

const rec = (o: object) => JSON.stringify({ sessionId: 's1', cwd: '/Users/you/Vibe/demo', timestamp: '2026-10-25T10:00:00Z', ...o });

describe('claudeInstructionFiles: the instruction files a Claude Code transcript shows the agent had', () => {
  test('an attachment record naming AGENTS.md or CLAUDE.md (an @-import, a nested file, a mention)', () => {
    expect(claudeInstructionFiles({ type: 'attachment', attachment: { type: 'nested_memory', path: '/Users/you/Vibe/demo/AGENTS.md', content: { path: '/Users/you/Vibe/demo/AGENTS.md', content: 'Use pnpm.' } } }))
      .toEqual(['/Users/you/Vibe/demo/AGENTS.md']);
    expect(claudeInstructionFiles({ type: 'attachment', attachment: { type: 'file', filename: '/r/web/CLAUDE.md' } })).toEqual(['/r/web/CLAUDE.md']);
    // Attachments of other files are not instruction files.
    expect(claudeInstructionFiles({ type: 'attachment', attachment: { type: 'file', filename: '/r/web/src/a.ts' } })).toEqual([]);
  });

  test('a reminder that holds the contents of an instruction file or memory note', () => {
    const text = '<system-reminder>\nContents of /Users/you/Vibe/demo/CLAUDE.md (project instructions, checked into the codebase):\n\n@AGENTS.md\n\nContents of /Users/you/Vibe/demo/AGENTS.md (project instructions, checked into the codebase):\nUse pnpm.\n</system-reminder>';
    expect(claudeInstructionFiles({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text }] } }))
      .toEqual(['/Users/you/Vibe/demo/CLAUDE.md', '/Users/you/Vibe/demo/AGENTS.md']);
    expect(claudeInstructionFiles({ type: 'user', message: { content: 'Contents of /Users/you/Vibe/demo/README.md (notes):' } })).toEqual([]);
  });

  test('parseTranscript keeps them on the session, once each, and nothing when there are none', () => {
    const lines = [
      rec({ type: 'attachment', uuid: 'a0', attachment: { type: 'nested_memory', path: '/Users/you/Vibe/demo/AGENTS.md' } }),
      rec({ type: 'user', uuid: 'u1', message: { content: 'add the members list' } }),
      rec({ type: 'attachment', uuid: 'a1', attachment: { type: 'nested_memory', path: '/Users/you/Vibe/demo/AGENTS.md' } }),
    ];
    expect(parseTranscript(lines.join('\n'), 'f')[0].instructionFiles).toEqual(['/Users/you/Vibe/demo/AGENTS.md']);
    expect(parseTranscript(lines[1], 'f')[0].instructionFiles).toEqual([]);
  });
});

describe('codexInstructionFiles: Codex puts AGENTS.md in the instructions it sends', () => {
  test('the "# AGENTS.md instructions for <dir>" part names the folder', () => {
    expect(codexInstructionFiles('# AGENTS.md instructions for /work/demo-shop\n\n<INSTRUCTIONS>\nUse pnpm.\n</INSTRUCTIONS>')).toEqual(['/work/demo-shop/AGENTS.md']);
    expect(codexInstructionFiles('<user_instructions>\nAlways write tests.\n</user_instructions>')).toEqual([]);
  });

  test('parseCodexSession keeps them on the session', () => {
    const meta = JSON.stringify({ timestamp: '2026-10-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'c1', timestamp: '2026-10-01T10:00:00.000Z', cwd: '/work/demo-shop', thread_source: 'user' } });
    const injected = JSON.stringify({ timestamp: '2026-10-01T10:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work/demo-shop\n\n<INSTRUCTIONS>\nUse pnpm.\n</INSTRUCTIONS>' }] } });
    const said = JSON.stringify({ timestamp: '2026-10-01T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a search box' }] } });
    expect(parseCodexSession([meta, injected, said].join('\n'), 'f')[0].instructionFiles).toEqual(['/work/demo-shop/AGENTS.md']);
    expect(parseCodexSession([meta, said].join('\n'), 'f')[0].instructionFiles).toEqual([]);
  });
});
