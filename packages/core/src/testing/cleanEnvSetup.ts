/**
 * A vitest setup file for every project: removes the developer's variables (cleanEnv.ts) from this worker's
 * environment, so neither a test nor a script it runs with the inherited environment reaches the developer's install.
 */
import { isDeveloperVariable } from './cleanEnv.ts';

for (const name of Object.keys(process.env)) if (isDeveloperVariable(name)) delete process.env[name];
