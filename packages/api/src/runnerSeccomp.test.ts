import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const profile = JSON.parse(readFileSync(resolve(root, 'scripts/seccomp/codex-runner.json'), 'utf8')) as {
  defaultAction: string; defaultErrnoRet: number;
  syscalls: { names: string[]; action: string; errnoRet?: number; args?: { index: number; value: number; valueTwo?: number; op: string }[]; includes?: { caps?: string[] } }[];
};
const allows = (name: string) => profile.syscalls.filter(rule => rule.action === 'SCMP_ACT_ALLOW' && rule.names.includes(name));

test('runner keeps default-deny syscall filtering and blocks host-dangerous syscall families', () => {
  expect(profile).toMatchObject({ defaultAction: 'SCMP_ACT_ERRNO', defaultErrnoRet: 1 });
  for (const name of ['bpf', 'ptrace', 'process_vm_readv', 'process_vm_writev', 'perf_event_open', 'init_module', 'finit_module', 'delete_module', 'keyctl', 'add_key', 'request_key', 'io_uring_setup', 'io_uring_enter', 'io_uring_register', 'open_by_handle_at', 'reboot']) expect(allows(name), name).toEqual([]);
  expect(profile.syscalls.some(rule => rule.includes?.caps?.length)).toBe(false);
});

test('runner permits namespace setup but preserves clone3 fallback and flag restrictions', () => {
  for (const name of ['clone', 'mount', 'umount2', 'pivot_root', 'chroot', 'sethostname']) expect(allows(name), name).toHaveLength(1);
  expect(allows('clone3')).toEqual([]);
  expect(profile.syscalls.find(rule => rule.names.includes('clone3'))).toMatchObject({ action: 'SCMP_ACT_ERRNO', errnoRet: 38 });
  expect(allows('unshare')).toEqual([expect.objectContaining({ args: [{ index: 0, value: (0xffffffff ^ (0x7e020000 | 0x600)) >>> 0, valueTwo: 0, op: 'SCMP_CMP_MASKED_EQ' }] })]);
  expect(allows('setns')).toEqual([expect.objectContaining({ args: [{ index: 1, value: (0xffffffff ^ 0x7e020000) >>> 0, valueTwo: 0, op: 'SCMP_CMP_MASKED_EQ' }] })]);
});

test('only runner Compose opts into its attributed checked-in seccomp allowlist', () => {
  const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
  expect(compose).toContain('seccomp=./scripts/seccomp/codex-runner.json');
  expect(compose).not.toContain('seccomp=unconfined');
  expect(readFileSync(resolve(root, 'scripts/seccomp/README.md'), 'utf8')).toContain('4b8214fc4971e06172938a1f1554ccff6647ee80');
  expect(readFileSync(resolve(root, 'scripts/seccomp/LICENSE.moby'), 'utf8')).toContain('Apache License');
});
