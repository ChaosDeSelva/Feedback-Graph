import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { exec, execResult } from '../testing/exec.ts';

const root = resolve(import.meta.dirname, '../../../..');
const docker = (args: string[], timeout = 30_000) => exec('docker', args, { timeout });
const available = process.env.SKIP_DOCKER_TESTS !== '1' && await docker(['info', '--format', '{{.ServerVersion}}']).then(() => true, () => false);
const id = `fgnet${process.pid}${Date.now().toString(36)}`, image = 'node:26.5.0-slim';
const names = ['api', 'worker', 'runner', 'provider'].map(role => `${id}-${role}`);
const networks = ['default', 'private', 'egress'].map(role => `${id}-${role}`);
let pulled = false;

describe.skipIf(!available)('runner network boundary', () => {
  beforeAll(async () => {
    if ((await execResult('docker', ['image', 'inspect', image])).status !== 0) { await docker(['pull', image], 180_000); pulled = true; }
    await docker(['network', 'create', networks[0]]);
    await docker(['network', 'create', '--internal', networks[1]]);
    await docker(['network', 'create', networks[2]]);
    const hold = 'setInterval(()=>{},1000)';
    const serve = 'require("http").createServer((q,s)=>s.end("CANARY")).listen(8787,"0.0.0.0")';
    for (const [index, network, code] of [[0, networks[0], serve], [1, networks[0], hold], [2, networks[1], serve], [3, networks[2], serve]] as const) {
      await docker(['run', '-d', '--name', names[index], '--label', `fg.test=${id}`, '--network', network, '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', '1000:1000', image, 'node', '-e', code]);
    }
    await docker(['network', 'connect', networks[1], names[1]]);
    await docker(['network', 'connect', networks[2], names[2]]);
  }, 240_000);
  afterAll(async () => {
    for (const name of names) await execResult('docker', ['rm', '-f', '-v', name]);
    for (const name of networks) await execResult('docker', ['network', 'rm', name]);
    if (pulled) await execResult('docker', ['image', 'rm', image]);
  });
  // fetch is allowed to discard/replace Host. Use the raw client so this covers the forged-Host path that bypassed
  // virtual-host checks on Docker Desktop in the field.
  const get = async (container: string, target: string) => JSON.parse(await docker(['exec', container, 'node', '-e', `const u=new URL(${JSON.stringify(target)}),http=require("node:http");const r=http.request({hostname:u.hostname,port:u.port,path:u.pathname,headers:{Host:"localhost"},timeout:1500},x=>{let b="";x.on("data",c=>b+=c);x.on("end",()=>console.log(JSON.stringify(b)))});r.on("timeout",()=>r.destroy());r.on("error",()=>console.log("null"));r.end()`]));
  test('Compose separates runner/API while preserving the worker control channel and provider egress', async ({ skip }) => {
    const config = JSON.parse(await exec('docker', ['compose', '--env-file', '/dev/null', '-f', resolve(root, 'docker-compose.yml'), '--profile', 'codex', 'config', '--format', 'json'], { env: { ...process.env, NEO4J_PASSWORD: 'test-only' } }));
    const attached = (name: string) => Object.keys(config.services[name].networks);
    expect(attached('api')).toEqual(['default']);
    expect(attached('codex-runner').sort()).toEqual(['runner-egress', 'runner-private']);
    expect(attached('worker').sort()).toEqual(['default', 'runner-private']);
    expect(config.networks['runner-private'].internal).toBe(true);
    expect(config.networks['runner-egress'].internal ?? false).toBe(false);
    expect(Number(config.services.neo4j.mem_limit)).toBe(3 * 1024 ** 3);
    const ip = (await docker(['inspect', '--format', `{{(index .NetworkSettings.Networks "${networks[0]}").IPAddress}}`, names[0]])).trim();
    expect(await get(names[1], `http://${names[0]}:8787`)).toBe('CANARY');
    expect(await get(names[1], `http://${names[2]}:8787`)).toBe('CANARY');
    expect(await get(names[2], `http://${names[0]}:8787`)).toBeNull();
    expect(await get(names[2], `http://${names[3]}:8787`)).toBe('CANARY');
    // Whether this Docker isolates bridge networks at all is the host's, not the topology's: the provider stand-in is on
    // the egress network only, which nothing but Docker's bridge isolation keeps from the API. Where it reaches the API's
    // address (OrbStack and some Docker Desktop builds route between bridges), doctor.sh's live probe finds the runner
    // reaching it too, fails, and stops codex-runner; no Compose topology can hold there.
    skip(await get(names[3], `http://${ip}:8787`) !== null, `this Docker routes between bridge networks (a container on another network reached ${ip}:8787), so it cannot isolate codex-runner; doctor.sh detects this host and disables the runner`);
    expect(await get(names[2], `http://${ip}:8787`)).toBeNull();
  });
});
