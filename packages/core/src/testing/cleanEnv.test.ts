import { expect, test } from 'vitest';
import { isDeveloperVariable, withoutDeveloperVariables } from './cleanEnv.ts';
import { execResult } from './exec.ts';

const DEVELOPER = { FEEDBACK_GRAPH_URL: 'http://127.0.0.1:8787', FEEDBACK_GRAPH_TOKEN: 't', FG_OWNER_TOKEN: 'o', FG_INSTANCE: 'mine', API_TOKEN: 'a', COMPOSE_PROJECT_NAME: 'feedback-graph', COMPOSE_FILE: 'docker-compose.yml', DOCKER_HOST: 'unix:///x.sock' };
const seen = async (env?: NodeJS.ProcessEnv) => (await execResult('env', [], env && { env })).stdout.split('\n').map((line) => line.split('=')[0]);

test('a script a test runs with the inherited environment sees none of the developer\'s install variables', async () => {
  // The setup file already took them out of this worker's environment, whatever the shell running vitest exports.
  expect((await seen()).filter(isDeveloperVariable)).toEqual([]);
});

test('the developer\'s variables are dropped and everything else, test settings included, is kept', async () => {
  const names = await seen(withoutDeveloperVariables({ ...DEVELOPER, PATH: process.env.PATH, FG_TEST_RUNNER_UNMASK_SYSTEM_PATHS: '1', NEO4J_TEST_URL: 'bolt://x' }));
  for (const name of Object.keys(DEVELOPER)) expect(names).not.toContain(name);
  expect(names).toEqual(expect.arrayContaining(['PATH', 'FG_TEST_RUNNER_UNMASK_SYSTEM_PATHS', 'NEO4J_TEST_URL']));
});
