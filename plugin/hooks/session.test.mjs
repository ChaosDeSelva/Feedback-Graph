import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

async function sessionHook(status) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, body });
    res.writeHead(status);
    res.end(status === 204 ? '' : 'DO_NOT_ECHO_SERVER_SECRET');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const temp = mkdtempSync(join(tmpdir(), 'fg-session-hook-'));
  try {
    const child = spawn(process.execPath, [new URL('./feedback-graph.mjs', import.meta.url).pathname, 'session'], {
      env: { ...process.env, TMPDIR: temp, FEEDBACK_GRAPH_HOOKS: '', FEEDBACK_GRAPH_URL: `http://127.0.0.1:${server.address().port}`, FEEDBACK_GRAPH_TOKEN: 'PRIVATE_API_TOKEN', FG_RUN: 'labelled', FG_RUN_KEY: 'PRIVATE_RUN_KEY', FG_SANDBOX: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.stdin.end(JSON.stringify({ session_id: 'real-session' }));
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    return { code, out, err, requests };
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(temp, { recursive: true, force: true });
  }
}

test('labelled SessionStart posts JSON and run credentials to registration endpoint', async () => {
  const result = await sessionHook(204);
  expect(result.code).toBe(0);
  expect(result.out).toBe('');
  expect(result.err).toBe('');
  expect(result.requests).toEqual([expect.objectContaining({ path: '/api/sessions/real-session/run', body: '{}', headers: expect.objectContaining({ 'content-type': 'application/json', 'x-fg-run': 'labelled', 'x-fg-run-key': 'PRIVATE_RUN_KEY', 'x-fg-sandbox': 'true' }) })]);
});

test.each([409, 415, 503])('registration HTTP %s is visible without exposing credentials or server output', async status => {
  const result = await sessionHook(status);
  expect(result.code).toBe(0);
  expect(result.err).toContain(`HTTP ${status}`);
  const output = JSON.parse(result.out).hookSpecificOutput;
  expect(output.hookEventName).toBe('SessionStart');
  expect(output.additionalContext).toContain('This session was not tagged');
  expect(result.out + result.err).not.toMatch(/PRIVATE_API_TOKEN|PRIVATE_RUN_KEY|DO_NOT_ECHO_SERVER_SECRET/);
});
