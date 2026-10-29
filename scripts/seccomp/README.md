# Codex runner seccomp profile

Derived from Moby profiles default.json, commit `4b8214fc4971e06172938a1f1554ccff6647ee80`:
https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json

Moby contributors; Apache License2.0 (LICENSE.moby). Upstream SHA256: `6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6`.

Default action remains deny (EPERM). Keep ordinary Docker allowlist and argument/architecture restrictions; omit capability-enabled privileged syscall groups because this runner drops all Docker capabilities. Add only classic clone and namespace construction calls required by Bubblewrap/Codex. unshare/setns permit only known namespace flag bits; clone3 returns ENOSYS so runtimes fall back to classic clone. Kernel user-namespace privilege checks and AppArmor still apply. Explicitly omit ptrace/process-memory access, BPF, perf, module loading, keyrings, handle-based file access, raw IO and io_uring even if a future container capability changes.

This permits more namespace operations than Docker's stock profile but is narrower than the previous seccomp=unconfined. It does not remove Docker system-path masks; procfs compatibility remains a separate explicit operator opt-in. Only codex-runner uses this profile. Validate real outer/nested sandbox health and container isolation in CI before publishing changes; never fall back to unconfined if a syscall is denied.
