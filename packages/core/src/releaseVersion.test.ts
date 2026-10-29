import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { VERSION } from './config.ts';

test('runtime, workspace packages and both plugin manifests agree on the release version', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const json = (file: string) => JSON.parse(readFileSync(resolve(root, file), 'utf8'));
  const expected = json('package.json').version;
  expect(VERSION).toBe(expected);
  for (const name of ['core', 'api', 'worker', 'store-postgres', 'ui']) expect(json(`packages/${name}/package.json`).version).toBe(expected);
  expect(json('plugin/.claude-plugin/plugin.json').version).toBe(expected);
  expect(json('.claude-plugin/marketplace.json').plugins[0].version).toBe(expected);
});
