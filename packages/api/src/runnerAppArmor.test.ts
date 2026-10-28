import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';

const check = (restricted: string, profiles: string, selected: string, inventory = true) => {
  const dir = mkdtempSync(join(tmpdir(), 'fg-apparmor-'));
  writeFileSync(join(dir, 'restricted'), restricted);
  if (inventory) writeFileSync(join(dir, 'profiles'), profiles);
  const helper = resolve(import.meta.dirname, '../../../scripts/lib/runner-apparmor.sh');
  try {
    execFileSync('bash', ['-c', 'source "$1"; runner_apparmor_check "$2" "$3" "$4"', 'check', helper, join(dir, 'restricted'), join(dir, 'profiles'), selected], { encoding: 'utf8' });
    return true;
  } catch { return false; }
};

test('restricted Ubuntu refuses an unconfined or unloaded runner policy before starting containers', () => {
  expect(check('1', '', 'unconfined')).toBe(false);
  expect(check('1', '', 'feedback-graph-codex-runner')).toBe(false);
  expect(check('1', 'feedback-graph-codex-runner (unconfined)\n', 'feedback-graph-codex-runner')).toBe(false);
  expect(check('1', 'feedback-graph-codex-runner (enforce)\n', 'feedback-graph-codex-runner')).toBe(true);
});

test('hosts without the userns restriction can keep the Docker Desktop policy', () => {
  expect(check('0', '', 'unconfined')).toBe(true);
});


test('an explicit named policy defers validation to Docker when the kernel inventory cannot be read', () => {
  expect(check('1', '', 'feedback-graph-codex-runner', false)).toBe(true);
  expect(check('1', '', 'unconfined', false)).toBe(false);
  expect(check('1', 'other-feedback-graph-codex-runner (unconfined)\n', 'feedback-graph-codex-runner')).toBe(false);
});


test('installed runner policy enforces its filesystem allowlist without raw network or ptrace allowances', () => {
  const profile = readFileSync(resolve(import.meta.dirname, '../../../scripts/apparmor/feedback-graph-codex-runner'), 'utf8');
  expect(profile).toMatch(/profile feedback-graph-codex-runner flags=\(attach_disconnected,mediate_deleted\)/);
  expect(profile).not.toMatch(/^\s*(?:ptrace|network\s+\S+\s+raw|capability\s+(?:sys_ptrace|net_raw))[,\s]/m);
  expect(profile).toContain('/scratch/fb-mirror-*/** rw,');
  expect(profile).not.toMatch(/^\s*\/\*\*\s+[rwm]/m);
});
