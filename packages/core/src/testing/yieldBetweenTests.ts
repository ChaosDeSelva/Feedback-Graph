/**
 * A vitest setup file: after every test, one turn of the event loop. The worker reports each test to the runner over
 * RPC and gives up on an answer after 60 s; a file of synchronous tests never lets the loop take that answer in, so on a
 * busy host a long file ended `pnpm test` with "Timeout calling onTaskUpdate" though every test passed.
 */
import { setImmediate } from 'node:timers/promises';
import { afterEach } from 'vitest';

afterEach(() => setImmediate());
