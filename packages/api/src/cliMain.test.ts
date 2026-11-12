import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { main, type CliProcess } from './cli.ts';

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

/** A process for main: its environment, the standard input it reads, and what it wrote to each stream. */
function proc(env: Record<string, string>, stdin: (string | Buffer)[]) {
  const out: string[] = [];
  const err: string[] = [];
  const p = {
    env,
    stdin: Readable.from(stdin),
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
  } as unknown as CliProcess;
  return { p, out, err };
}

test('main reads a token from standard input and sends it to the API at FEEDBACK_GRAPH_URL', async () => {
  const seen: { method?: string; url?: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, body }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); });
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { p, out, err } = proc({ FEEDBACK_GRAPH_URL: url }, ['ghp_', Buffer.from('secret\n')]);
  expect(await main(['integrations', 'set', 'github', '--from-stdin'], p)).toBe(0);
  expect(seen).toEqual([{ method: 'PUT', url: '/api/settings/integrations/github', body: JSON.stringify({ token: 'ghp_secret' }) }]);
  expect(out.join('')).toMatch(/^SERVICE\s+STATE\ngithub\s+saved\n$/);
  expect(err).toEqual([]);
});

test('main writes a usage mistake to standard error and resolves to exit code 2', async () => {
  const { p, out, err } = proc({}, []);
  expect(await main(['scan'], p)).toBe(2);
  expect(out).toEqual([]);
  expect(err.join('')).toBe('fg: fg scan needs --all or --key k1,k2 (see fg help scan)\n');
});

test('run as a program (node src/cli.ts help), cli.ts prints the usage and sets the exit code', async () => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  const written: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { written.push(String(s)); return true; });
  try {
    process.argv = [argv[0], fileURLToPath(new URL('./cli.ts', import.meta.url)), 'help'];
    vi.resetModules();
    await import('./cli.ts');
    expect(process.exitCode).toBe(0);
    expect(written.join('')).toMatch(/^fg: drive Feedback Graph from a terminal or an agent\n/);
  } finally {
    write.mockRestore();
    process.argv = argv;
    process.exitCode = exitCode;
  }
});
