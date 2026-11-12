import { expect, test } from 'vitest';
import { run, type CliIO } from './cli.ts';

// fg cleanup of a run an API agent opened, sent with FG_OPERATOR_TOKEN (which wins over API_TOKEN): the server refuses
// the operator token and points at --owner, but clearing FG_OPERATOR_TOKEN for the command lets API_TOKEN do it.
const refusal = 'run probe was opened by an API agent: only the owner can clean it up: use fg cleanup --run <id> --owner with FG_OWNER_TOKEN, or the authenticated browser UI; the operator token cleans up only runs opened with its private FG_RUN_KEY';

function cleanup(env: Record<string, string>) {
  const err: string[] = [];
  const io: CliIO = {
    env,
    out: () => {},
    err: (s) => err.push(s),
    sleep: async () => {},
    fetch: (async () => Response.json({ error: refusal }, { status: 403 })) as typeof fetch,
  };
  return run(['cleanup', '--run', 'probe'], io).then((code) => ({ code, err: err.join('\n') }));
}

test('an operator-token cleanup of an API agent\'s run says the operator token was sent and how to use API_TOKEN instead', async () => {
  const both = await cleanup({ FG_OPERATOR_TOKEN: 'o'.repeat(32), API_TOKEN: 'a'.repeat(32), FG_RUN_KEY: 'k'.repeat(40) });
  expect(both.code).toBe(1);
  expect(both.err).toContain('(fg sent FG_OPERATOR_TOKEN, which takes precedence over API_TOKEN: to act with API_TOKEN, clear it for this command: FG_OPERATOR_TOKEN= ./scripts/fg ...)');
  // Without an API token there is nothing to switch to: the server's --owner advice stands alone.
  expect((await cleanup({ FG_OPERATOR_TOKEN: 'o'.repeat(32), FG_RUN_KEY: 'k'.repeat(40) })).err).not.toContain('takes precedence');
});
