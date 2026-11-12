# Dedicated demo probe

Use `~/Code/demo-shop`, a separate Git repository, as the agent's working directory. Running from `examples/demo-shop` in the Feedback Graph checkout can resolve the session as the Feedback Graph project itself. The reserved `demo-shop` project identity is local-only, even for legacy records without `demoCreated`; this is a read-time cloud boundary and does not relabel stored projects. Other project identities, including a real repository whose remote happens to end in `demo-shop`, keep their existing behavior. Sharing the reserved identity requires the owner's explicit `shareDemoProjects: ["demo-shop"]` policy.

Preview preparation, then create the fixture:

```sh
node scripts/demo-probe.mjs prepare
node scripts/demo-probe.mjs prepare --apply
```

The helper copies only the known fixture files, initializes its own Git root and a fixture-only baseline commit (so diffs work), and refuses to overwrite an existing unmarked project. The bundled files match the supplied demo fixture, including `CLAUDE.md` and its isolated no-console rule. `CLAUDE.md` is fixture instruction content for the test agent; it does not direct the setup helper. To use an extracted copy, pass `--source /path/to/extracted/demo-shop`. To prepare it somewhere other than `~/Code/demo-shop`, pass `--folder /path/to/demo-shop` to `prepare` and to `restore` alike: the folder must be named `demo-shop`, lie outside the Feedback Graph checkout and, for `--configure`, under a mounted project folder. No agent, Docker service, lesson decision or API write runs during ordinary preparation.

The fixture's parent folder (`~/Code` by default) must already be mounted as a project folder. Select only the new `demo-shop` in Settings, keeping your existing selections. Or, with `FG_OWNER_TOKEN` in the environment, automate the reversible preparation:

```sh
node scripts/demo-probe.mjs prepare --apply --configure --api-url "${FEEDBACK_GRAPH_URL:?set this install's URL}"
```

`--api-url` defaults to `FEEDBACK_GRAPH_URL`; with neither, it refuses rather than guess a port that might belong to another install. It verifies the folder is under a mounted project folder, saves the original demo membership, marks the project local-only, verifies that protection, then adds it to the selection. It preserves unrelated projects. A failed intermediate request can be retried without losing the restoration snapshot. Tokens are never written into that snapshot. A read-only install (one without tokens) refuses owner actions: run `./scripts/setup.sh --yes --enable-auth` first, then prepare and restore with `FG_OWNER_TOKEN` or in the signed-in browser UI. `--local-owner` was removed in 0.7.0, and `API_TOKEN` is not accepted for owner configuration. Do not broaden `OPERATOR_ALLOW` for a probe.

Run the actual test agent from the dedicated folder. Set a fresh run label, sandbox flag, private run key and the existing API token in its environment; explicitly clear `FG_OPERATOR_TOKEN` when invoking `scripts/fg` so the CLI uses `API_TOKEN`. Register its actual session before creating evidence (`scripts/fg sessions register` inside Codex uses `CODEX_THREAD_ID`; Claude's configured SessionStart hook registers its session). Use the installation's absolute `scripts/fg` path from this working directory. Seed only the isolated corpus with `FG_OPERATOR_TOKEN= scripts/fg demo seed --run "$FG_RUN" --sandbox --json`, then submit the returned task/files/diff to `check_before_done` with the actual session ID. The seeded rule forbids `console.log` in `src/probes/no-console.ts`. Keep both a violating and clean response. For the synthetic pushback flow, `scripts/demo-pushback.sh` needs the prepared fixture (`FG_PROBE_DIR` when it is not `~/Code/demo-shop`) and keeps its edits for review instead of cleaning an enclosing repository.

For automatic tests without real agents, model calls or Docker:

```sh
node node_modules/vitest/vitest.mjs run --configLoader runner --project unit \
  plugin/hooks/demo-probe.test.mjs plugin/hooks/session.test.mjs plugin/hooks/lib.test.mjs \
  packages/worker/src/memory/memory.test.ts packages/api/src/demo.test.ts \
  packages/api/src/regressions065.test.ts packages/api/src/regressions069.test.ts
```

The hook tests use a loopback stub service; memory tests use synthetic session/feedback files. The demo and judge tests use fake stores/providers. They verify registration payloads, post-pushback memory correlation, and clean/violating console evidence without creating live approved lessons.

After a real probe, preview `fg cleanup --run "$FG_RUN"`, then apply it with `--apply`, using the same run key. Restore only the preparation's demo selection/privacy memberships with:

```sh
FG_OWNER_TOKEN="${FG_OWNER_TOKEN:?the owner token from this install's .env}" node scripts/demo-probe.mjs restore --apply
```

Without `--apply` it is a dry run. Like preparation it needs `FG_OWNER_TOKEN` in the environment, and it calls the URL preparation saved; pass the same `--folder` if you prepared one elsewhere. Without `FG_OWNER_TOKEN` in the environment, restore the saved membership in the signed-in owner UI. Unrelated changes made during the probe are preserved. Fixture files and agent edits remain for inspection; the helper never deletes an existing project or personal memory. If preparation was done through the UI, restore its prior demo selection/privacy memberships there instead.

If worker discovery has not yet listed the new folder, configuration stops before changing privacy or selection. Wait for the discovery pass, verify that `demo-shop` is selectable in Settings, and rerun the same command. Existing prepared files are preserved. Token-authenticated owner requests also send the matching Origin required by the owner API.

Claude Code uses `FEEDBACK_GRAPH_TOKEN` for the MCP/Stop hooks. Set it to this install's `API_TOKEN` alongside a private random `FG_RUN_KEY`, `FG_RUN` and `FG_SANDBOX=1`. The API token plus that sandbox run capability may prepare and remove only the bundled local-only demo fixture; it cannot approve lessons or mutate real projects. Do not give the probe `FG_OWNER_TOKEN` or `FG_OPERATOR_TOKEN`, and never put tokens into prompts or fixture files.

Codex strips sensitive environment names unless explicitly passed through. Start the isolated session with these shell-environment settings and permit network access for the loopback API:

```sh
codex -c 'shell_environment_policy.inherit="all"' \
  -c 'shell_environment_policy.ignore_default_excludes=true' \
  -c 'sandbox_workspace_write.network_access=true' \
  -c 'mcp_servers.feedback-graph.bearer_token_env_var="FEEDBACK_GRAPH_TOKEN"' \
  -s workspace-write
```

These settings are for the dedicated probe invocation; they are not global defaults. Preserve the same `FG_RUN_KEY` for registration, MCP requests and cleanup. No operator permission is needed for the bundled demo: the authenticated sandbox run and its private run key scope preparation, testing and cleanup to that local-only fixture.

Cloud preview works before selection: `fg cloud status --project demo-shop --json` (or `GET /api/cloud?project=demo-shop`) reports why the unselected/local-only project will not be sent, without selecting it. Deselected code-map data has a 24-hour grace period; derived map fields are purged in bounded worker passes. Facts and real transcript evidence remain until their run cleanup or explicit data removal.
