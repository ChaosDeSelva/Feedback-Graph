import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const docker = (args: string[], timeout = 30_000) => execFileSync('docker', args, { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] });
const available = (() => { if (process.env.SKIP_DOCKER_TESTS === '1') return false; try { docker(['info', '--format', '{{.ServerVersion}}']); return true; } catch { return false; } })();
const id = `fgnet${process.pid}${Date.now().toString(36)}`, image = 'node:26.5.0-slim';
const names = ['api', 'worker', 'runner', 'provider'].map(role => `${id}-${role}`);
const networks = ['default', 'private', 'egress'].map(role => `${id}-${role}`);
let pulled = false;

describe.skipIf(!available)('runner network boundary', () => {
  beforeAll(() => {
    try { docker(['image', 'inspect', image]); } catch { docker(['pull', image], 180_000); pulled = true; }
    docker(['network', 'create', networks[0]]);
    docker(['network', 'create', '--internal', networks[1]]);
    docker(['network', 'create', networks[2]]);
    const hold = 'setInterval(()=>{},1000)';
    const serve = 'require("http").createServer((q,s)=>s.end("CANARY")).listen(8787,"0.0.0.0")';
    for (const [index, network, code] of [[0, networks[0], serve], [1, networks[0], hold], [2, networks[1], serve], [3, networks[2], serve]] as const) {
      docker(['run', '-d', '--name', names[index], '--label', `fg.test=${id}`, '--network', network, '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', '1000:1000', image, 'node', '-e', code]);
    }
    docker(['network', 'connect', networks[1], names[1]]);
    docker(['network', 'connect', networks[2], names[2]]);
  }, 240_000);
  afterAll(() => {
    for (const name of names) { try { docker(['rm', '-f', '-v', name]); } catch {} }
    for (const name of networks) { try { docker(['network', 'rm', name]); } catch {} }
    if (pulled) { try { docker(['image', 'rm', image]); } catch {} }
  });
  const get = (container: string, target: string) => JSON.parse(docker(['exec', container, 'node', '-e', `fetch(${JSON.stringify(target)},{headers:{host:"localhost"},signal:AbortSignal.timeout(1500)}).then(async r=>console.log(JSON.stringify(await r.text()))).catch(()=>console.log("null"))`]));
  test('Compose separates runner/API while preserving the worker control channel and provider egress', () => {
    const config = JSON.parse(execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', resolve(root, 'docker-compose.yml'), '--profile', 'codex', 'config', '--format', 'json'], { encoding: 'utf8', env: { ...process.env, NEO4J_PASSWORD: 'test-only' } }));
    const attached = (name: string) => Object.keys(config.services[name].networks);
    expect(attached('api')).toEqual(['default']);
    expect(attached('codex-runner').sort()).toEqual(['runner-egress', 'runner-private']);
    expect(attached('worker').sort()).toEqual(['default', 'runner-private']);
    expect(config.networks['runner-private'].internal).toBe(true);
    expect(config.networks['runner-egress'].internal ?? false).toBe(false);
    expect(Number(config.services.neo4j.mem_limit)).toBe(3 * 1024 ** 3);
    const ip = docker(['inspect', '--format', `{{(index .NetworkSettings.Networks "${networks[0]}").IPAddress}}`, names[0]]).trim();
    expect(get(names[1], `http://${names[0]}:8787`)).toBe('CANARY');
    expect(get(names[1], `http://${names[2]}:8787`)).toBe('CANARY');
    expect(get(names[2], `http://${names[0]}:8787`)).toBeNull();
    expect(get(names[2], `http://${ip}:8787`)).toBeNull();
    expect(get(names[2], `http://${names[3]}:8787`)).toBe('CANARY');
  });
});
