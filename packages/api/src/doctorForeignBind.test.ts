import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { execResult, SCRIPT_TEST_TIMEOUT_MS } from '@fb/core/testing/exec';

// doctor on a copy, with a stand-in docker reporting the containers under this name as another folder's.
vi.setConfig({ testTimeout: SCRIPT_TEST_TIMEOUT_MS });
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

test("doctor, with another folder's api running under this name, says that api's bind was not checked", async () => {
  const base = mkdtempSync(join(tmpdir(), 'fgforeignbind-'));
  const repo = join(base, 'repo');
  const bin = join(base, 'bin');
  for (const d of [join(repo, 'scripts', 'lib'), bin, join(base, 'home')]) mkdirSync(d, { recursive: true });
  for (const f of ['scripts/doctor.sh', 'scripts/lib/env.sh', 'scripts/lib/ollama.sh', 'scripts/lib/restore-journal.sh']) copyFileSync(join(repoRoot, f), join(repo, f));
  writeFileSync(join(repo, '.env'), `API_PORT=8787\nAPI_TOKEN=${'a'.repeat(32)}\n`);
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub('docker', 'case "$*" in "ps -a "*) echo /srv/live/feedback-graph ;; esac\nexit 0');
  stub('curl', 'exit 7');
  stub('nc', 'exit 1');
  stub('uname', 'echo Darwin');
  const r = await execResult('bash', [join(repo, 'scripts', 'doctor.sh')], {
    env: { PATH: `${bin}:/usr/bin:/bin:${dirname(process.execPath)}`, HOME: join(base, 'home') },
  });
  expect(r.stdout).toContain('SKIP  containers, api and agent endpoint: not checked');
  expect(r.stdout).not.toContain('the api is not running');
  expect(r.stdout).toContain('API bind: loopback only as configured here (127.0.0.1); the running api was not checked, since it is the install in /srv/live/feedback-graph');
});
