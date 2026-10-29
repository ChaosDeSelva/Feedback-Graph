# Dedicated demo probe

Use `~/Code/demo-shop`, a separate Git repository, as the agent's working directory. Running from `Feedback-Graph/examples/demo-shop` can resolve the session as the real Feedback Graph project. The reserved `demo-shop` project identity now stays local-only even for legacy records without `demoCreated`; this is a read-time cloud boundary and does not relabel stored projects. Other project identities, including a real repository whose remote happens to end in `demo-shop`, keep their existing behavior. Sharing the reserved identity requires the owner's explicit `shareDemoProjects: ["demo-shop"]` policy.

Preview preparation, then explicitly create the independent fixture:

```sh
node scripts/demo-probe.mjs prepare
node scripts/demo-probe.mjs prepare --apply
```

The helper copies only the known fixture files, initializes its own Git root and a fixture-only baseline commit (so diffs work), and refuses to overwrite an existing unmarked project. The bundled files match the supplied demo fixture, including `CLAUDE.md` and its isolated no-console rule. `CLAUDE.md` is fixture instruction content for the test agent; it does not direct the setup helper. To use an extracted copy, pass `--source /path/to/extracted/demo-shop`. No agent, Docker service, lesson decision or API write runs during ordinary preparation.

The parent `~/Code` must already be mounted as a project root. Select only the new `demo-shop` in the owner UI while preserving existing selections. Alternatively, with the existing owner `API_TOKEN` available in the environment, explicitly automate reversible preparation:

```sh
node scripts/demo-probe.mjs prepare --apply --configure
```

This verifies the folder is under a mounted root, saves the original demo membership, marks the project local-only, verifies that protection, then adds it to the selection. It preserves unrelated projects. A failed intermediate request can be retried without losing the restoration snapshot. Tokens are never written into that snapshot. For a tokenless installation on this machine, explicitly choose the same-origin local-owner mode instead:

```sh
node scripts/demo-probe.mjs prepare --apply --configure --local-owner --api-url http://127.0.0.1:8787
```

`--local-owner` works only with HTTP(S) loopback URLs (`localhost`, `127.0.0.1`, `[::1]`), sends explicit same-origin owner intent, and sends no bearer token. It never follows redirects or automatically falls back from failed token authentication. If the server configures `API_TOKEN`, its HTTP 401 still requires that token: omit `--local-owner` and provide the token in the environment, or use the owner UI. Ordinary `--configure` remains token-required. Do not broaden `OPERATOR_ALLOW` for a probe.

Run the actual test agent from the dedicated folder. Set a fresh run label, sandbox flag, private run key and the existing operator token in its environment. Register its actual session before creating evidence (`scripts/fg sessions register` inside Codex uses `CODEX_THREAD_ID`; Claude's configured SessionStart hook registers its session). Use the installation's absolute `scripts/fg` path from this working directory. Seed only the isolated corpus with `fg demo seed --run "$FG_RUN" --sandbox --json`, then submit the returned task/files/diff to `check_before_done` with the actual session ID. The seeded rule forbids `console.log` in `src/probes/no-console.ts`. Keep both a violating and clean response. For the synthetic pushback flow, `scripts/demo-pushback.sh` now also requires the helper-owned dedicated folder and keeps edits for review instead of cleaning an enclosing repository.

For automatic tests without real agents, model calls or Docker:

```sh
node node_modules/vitest/vitest.mjs run --configLoader runner --project unit \
  plugin/hooks/demo-probe.test.mjs plugin/hooks/session.test.mjs plugin/hooks/lib.test.mjs \
  packages/worker/src/memory/memory.test.ts packages/api/src/demo.test.ts \
  packages/api/src/regressions065.test.ts packages/api/src/regressions069.test.ts
```

The hook tests use a loopback stub service; memory tests use synthetic session/feedback files. The demo and judge tests use fake stores/providers. They verify registration payloads, post-pushback memory correlation, and clean/violating console evidence without creating live approved lessons.

After a real probe, preview and apply `fg cleanup --run "$FG_RUN" --apply` using the same run key. Restore only the preparation's demo selection/privacy memberships with:

```sh
node scripts/demo-probe.mjs restore --apply
```

For tokenless loopback preparation, repeat the explicit mode for restoration: `node scripts/demo-probe.mjs restore --apply --local-owner`. Unrelated changes made during the probe are preserved. Fixture files and agent edits remain for inspection; the helper never deletes an existing project or personal memory. If preparation was done through the UI, restore its prior demo selection/privacy memberships there instead.

If worker discovery has not yet listed the new folder, configuration stops before changing privacy or selection. Wait for the discovery pass, verify that `demo-shop` is selectable in Settings, and rerun the same command. Existing prepared files are preserved. Token-authenticated owner requests also send the matching Origin required by the owner API.
