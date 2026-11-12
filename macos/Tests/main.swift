import Foundation

// Tests for macos/Core.swift, compiled together with it by scripts/test-mac-app.sh. No XCTest: the Command Line
// Tools ship without it.

var failures = 0
var checks = 0
func expect(_ ok: @autoclosure () -> Bool, _ what: String, file: StaticString = #file, line: UInt = #line) {
    checks += 1
    if !ok() { failures += 1; print("FAIL \(what) (\(file):\(line))") }
}
func eq<T: Equatable>(_ a: T, _ b: T, _ what: String, line: UInt = #line) {
    checks += 1
    if a != b { failures += 1; print("FAIL \(what): got \(a), want \(b) (line \(line))") }
}

// .env: only the listed keys, last line wins, quotes removed, secrets never kept.
do {
    let env = """
    # comment
    FG_INSTANCE=first
    API_TOKEN=secret-api
    FG_OWNER_TOKEN="secret-owner"
    NEO4J_PASSWORD=secret-pass
    FG_INSTANCE="fgmacapp"
    API_PORT='10020'
    OLLAMA_MODEL=
    """
    let s = InstallSettings.parse(env)
    eq(s.instance, "fgmacapp", "last FG_INSTANCE line, quotes removed")
    eq(s.apiPort, 10020, "API_PORT in single quotes")
    eq(s.chatModel, "gemma4", "an empty OLLAMA_MODEL is the default")
    eq(s.embedModel, "nomic-embed-text", "embed model default")
    expect(!s.values.values.contains { $0.contains("secret") }, "no secret value is kept")
    expect(Set(s.values.keys).isSubset(of: InstallSettings.keys), "only allow-listed keys")
    expect(!InstallSettings.keys.contains { $0.contains("TOKEN") || $0.contains("PASSWORD") || $0.hasSuffix("_KEY") }, "no secret key is ever listed")
    eq(s.dashboardURL.absoluteString, "http://localhost:10020/", "dashboard on API_PORT")

    let d = InstallSettings.parse("")
    eq(d.instance, "feedback-graph", "default instance")
    eq(d.apiPort, 8787, "default port")
    eq(d.ollamaURL, "http://localhost:11434", "host Ollama by default")
    eq(InstallSettings.parse("OLLAMA_URL=http://host.docker.internal:11434").ollamaURL, "http://localhost:11434", "host.docker.internal is this Mac")
    eq(InstallSettings.parse("OLLAMA_URL=http://ollama:11434\nOLLAMA_PORT=10024").ollamaURL, "http://localhost:10024", "bundled ollama profile on OLLAMA_PORT")
    eq(InstallSettings.parse("OLLAMA_URL=http://ollama:11434").ollamaURL, "http://localhost:11435", "bundled ollama default port")
    eq(InstallSettings.parse("OLLAMA_URL=http://gpu-box:11434").ollamaURL, "http://gpu-box:11434", "a remote Ollama as written")
    eq(InstallSettings.parse("API_PORT=abc").apiPort, 8787, "a bad port is the default")
}

// Install folder.
do {
    let files: Set<String> = ["/a/docker-compose.yml", "/a/scripts/setup.sh", "/b/docker-compose.yml"]
    expect(isInstallFolder("/a", exists: files.contains), "compose file and setup script make an install")
    expect(!isInstallFolder("/b", exists: files.contains), "no setup script, no install")
}

// Containers to status.
do {
    let dir = "/private/tmp/fg"
    func row(_ s: String, _ state: String, _ status: String, dir d: String = dir, oneoff: Bool = false) -> ContainerRow {
        ContainerRow(service: s, state: state, status: status, workingDir: d, oneoff: oneoff)
    }
    let parsed = ContainerRow.parse("api\trunning\tUp 2 minutes (healthy)\t/x\tFalse\nbackup\texited\tExited (0) 1 minute ago\t/x\tTrue\n\n")
    eq(parsed.count, 2, "two rows parsed")
    eq(parsed[0], row("api", "running", "Up 2 minutes (healthy)", dir: "/x"), "fields in order")
    expect(parsed[1].oneoff, "one-off flag")

    let healthy = [row("api", "running", "Up 2 minutes (healthy)"), row("worker", "running", "Up 2 minutes (healthy)"),
                   row("neo4j", "running", "Up 3 minutes (healthy)"), row("archive-key-init", "exited", "Exited (0) 3 minutes ago")]
    func classify(_ rows: [ContainerRow], engine: Bool = true, api: Bool = true, ollama: String? = nil, action: String? = nil, install: String = "/tmp/fg") -> StackReport {
        classifyStack(engineRunning: engine, engineName: "OrbStack", rows: rows, installDir: install, apiReady: api, ollamaProblem: ollama, actionInFlight: action)
    }
    eq(classify(healthy).status, .running, "healthy services and a finished init container are running (/tmp is /private/tmp)")
    eq(classify(healthy, engine: false).status, .problem, "no engine is a problem")
    expect(classify(healthy, engine: false).headline.contains("OrbStack"), "names the engine")
    eq(classify([]).status, .stopped, "no containers is stopped")
    eq(classify(healthy.map { var r = $0; r.state = "exited"; r.status = "Exited (0) 1 minute ago"; return r }).status, .stopped, "all exited is stopped")
    eq(classify(healthy, api: false).status, .starting, "api not answering yet is starting")
    eq(classify([row("api", "running", "Up 5 seconds (health: starting)")]).status, .starting, "health starting")
    eq(classify(healthy + [row("x", "restarting", "Restarting (1) 2 seconds ago")]).status, .problem, "a restarting service")
    eq(classify(healthy + [row("x", "exited", "Exited (137) 1 minute ago")]).status, .problem, "a service that died")
    eq(classify(healthy + [row("runner-control-init", "exited", "Exited (0) 3 minutes ago")]).status, .running, "the codex profile's init container finished")
    // codex-runner exits 78 when its persisted isolation-safety flag turns it off, which the doctor only warns about.
    let runnerOff = classify(healthy + [row("codex-runner", "exited", "Exited (78) 48 minutes ago")])
    eq(runnerOff.status, .running, "a codex runner its safety flag turned off is not a problem")
    expect(runnerOff.headline.contains("Codex runner off"), "says the codex runner is off")
    eq(classify(healthy + [row("codex-runner", "exited", "Exited (1) 1 minute ago")]).status, .problem, "a codex runner that crashed is a problem")
    eq(classify(healthy + [row("codex-runner", "exited", "Exited (78) 1 minute ago")], api: false).status, .starting, "starting wins over the runner note")
    // As the 0.8.0 doctor fails them: "worker: stopped" and "worker: paused, so it does nothing".
    let workerStopped = classify(healthy.map { var r = $0; if r.service == "worker" { r.state = "exited"; r.status = "Exited (0) 1 minute ago" }; return r })
    eq(workerStopped.status, .problem, "a long-running service stopped while the rest run")
    expect(workerStopped.headline.contains("worker"), "names the stopped service")
    eq(classify(healthy.map { var r = $0; if r.service == "worker" { r.state = "paused"; r.status = "Up 5 minutes (Paused)" }; return r }).status, .problem, "a paused service")
    let unhealthy = classify([row("api", "running", "Up 9 minutes (unhealthy)"), row("worker", "running", "Up (healthy)")])
    eq(unhealthy.status, .problem, "unhealthy")
    expect(unhealthy.headline.contains("api"), "names the unhealthy service")
    eq(classify(healthy, ollama: "Ollama does not answer").status, .problem, "Ollama down while running")
    eq(classify([], ollama: "Ollama does not answer").status, .stopped, "Ollama does not matter while stopped")
    eq(classify([], action: "Starting…").status, .starting, "a start in flight")
    eq(classify(healthy + [row("backup", "running", "Up 1 second", oneoff: true)], api: true).status, .running, "one-off containers are ignored")
    let foreign = classify([row("api", "running", "Up (healthy)", dir: "/Users/x/feedback-graph")])
    eq(foreign.status, .problem, "another folder's containers under this name")
    expect(foreign.headline.contains("/Users/x/feedback-graph"), "names the other folder")
    eq(standardPath("/private/tmp/a/"), "/tmp/a", "private prefix and trailing slash")
}

// Polling.
do {
    eq(nextPollInterval(.running, stoppedPolls: 0), 15, "running polls every 15 s")
    eq(nextPollInterval(.problem, stoppedPolls: 3), 15, "a problem polls every 15 s")
    eq(nextPollInterval(.starting, stoppedPolls: 0), 5, "starting polls quickly")
    eq(nextPollInterval(.stopped, stoppedPolls: 0), 15, "first stopped poll")
    eq(nextPollInterval(.stopped, stoppedPolls: 1), 30, "backs off")
    eq(nextPollInterval(.stopped, stoppedPolls: 2), 60, "backs off more")
    eq(nextPollInterval(.stopped, stoppedPolls: 10), 120, "at most two minutes")
}

// Ollama.
do {
    let tags = #"{"models":[{"name":"gemma4:latest"},{"name":"nomic-embed-text:latest"},{"name":"qwen3:8b"}]}"#.data(using: .utf8)!
    let names = ollamaModelNames(tags)!
    eq(names.count, 3, "three models")
    expect(ollamaHasModel("gemma4", in: names), "untagged name is :latest")
    expect(ollamaHasModel("qwen3:8b", in: names), "tagged exact")
    expect(!ollamaHasModel("qwen3", in: names), "untagged name is not any tag")
    expect(!ollamaHasModel("gemma4:e4b", in: names), "another tag is missing")
    expect(ollamaModelNames("not json".data(using: .utf8)!) == nil, "garbage is nil")
}

// Doctor.
do {
    let out = """
    PASS  docker: the daemon answers
    WARN  ollama: slow
          Pull it again.
    PASS  ports: free
    FAIL  api: does not answer
          Run docker compose up -d.
          Then try again.
    SKIP  GitHub: no token
    FAIL  worker: paused, so it does nothing
          docker compose unpause worker
    FAIL  api: stopped
          docker compose up -d api

    Some checks failed; fix the FAIL lines above and run ./scripts/doctor.sh again.
    """
    let s = DoctorSummary.parse(out)
    eq([s.pass, s.warn, s.fail, s.skip], [2, 1, 3, 1], "counts")
    eq(s.attention, ["WARN  ollama: slow", "      Pull it again.", "FAIL  api: does not answer", "      Run docker compose up -d.", "      Then try again.",
                     "FAIL  worker: paused, so it does nothing", "      docker compose unpause worker", "FAIL  api: stopped", "      docker compose up -d api"], "attention lines with their fixes")
    eq(s.line, "2 passed, 1 warning, 3 failed, 1 skipped", "summary line")
}

// Learning loop.
do {
    let running = #"{"mode":"auto","effectiveMode":"auto","paused":null,"capped":null,"counts":{"proposed":3,"week":{}}}"#
    let r = LoopSummary.parse(running.data(using: .utf8)!)!
    eq(r.paused, false, "not paused")
    eq(r.proposalsWaiting, 3, "proposals")
    eq(r.line, "Learning loop: auto · 3 proposals waiting", "line")
    let paused = #"{"mode":"auto","effectiveMode":"off","paused":{"by":"you","at":"2026-11-11T00:00:00Z"},"capped":"paused","counts":{"proposed":1}}"#
    let p = LoopSummary.parse(paused.data(using: .utf8)!)!
    expect(p.paused, "paused")
    eq(p.line, "Learning loop: paused · 1 proposal waiting", "paused line")
    let tokenless = #"{"mode":"auto","effectiveMode":"observe","paused":null,"capped":"tokenless","counts":{"proposed":0}}"#
    eq(LoopSummary.parse(tokenless.data(using: .utf8)!)!.line, "Learning loop: auto, runs as observe · 0 proposals waiting", "capped line")
    expect(LoopSummary.parse(#"{"error":"HTTP 401"}"#.data(using: .utf8)!) == nil, "an error is nil")
    let disabled = #"{"mode":"auto","effectiveMode":"off","disabled":true,"paused":null,"capped":"disabled","counts":{"proposed":2,"week":{"observed":0,"proposed":0,"applied":0,"rolledBack":0}}}"#
    eq(LoopSummary.parse(disabled.data(using: .utf8)!)!.line, "Learning loop: disabled (LOOP_DISABLED=1) · 2 proposals waiting", "disabled line")

    // fg loop pause --json, refused, as 0.8.0 prints it.
    let refused = #"{"error":"POST /api/loop/pause: 403 the operator token may not loop settings (loop_settings): in .env set OPERATOR_ALLOW=scan,loop_decide,loop_settings (what it may do now, and loop_settings) and restart, or do it in the Feedback Graph UI","status":403}"#
    eq(loopSettingsAllowLine(refused), "OPERATOR_ALLOW=scan,loop_decide,loop_settings", "the whole line, with the verbs the token has now")
    let tokenlessRefused = #"{"error":"POST /api/loop/pause: 403 this install has no owner token, so owner actions are read-only (the API cannot tell your browser or ./scripts/fg from any other program on the machine). Run ./scripts/setup.sh --yes --enable-auth in the install folder (it restarts the API), then sign in with FG_OWNER_TOKEN in the browser (./scripts/fg signin), or let ./scripts/fg do it with FG_OPERATOR_TOKEN and OPERATOR_ALLOW=scan,demo,loop_settings in .env (the defaults and loop_settings). Until then the learning loop only observes; to stop it, set LOOP_DISABLED=1 in .env and run docker compose up -d","status":403}"#
    expect(loopSettingsAllowLine(tokenlessRefused) == nil, "a tokenless install needs tokens first")
    expect(loopSettingsAllowLine(#"{"error":"POST /api/loop/pause: 403 only you can make this decision, from the Feedback Graph UI, or with FG_OPERATOR_TOKEN as a Bearer for the verbs OPERATOR_ALLOW names","status":403}"#) == nil, "no operator token")
}

// Sign-in link: only this install's own dashboard.
do {
    func url(_ s: String) -> Data { "{\"url\":\"\(s)\",\"expiresInSeconds\":60}".data(using: .utf8)! }
    expect(signinURL(url("http://localhost:10020/api/session/link?t=x"), apiPort: 10020) != nil, "localhost on the port")
    expect(signinURL(url("http://127.0.0.1:10020/x"), apiPort: 10020) != nil, "127.0.0.1")
    expect(signinURL(url("http://localhost:8787/x"), apiPort: 10020) == nil, "another install's port")
    expect(signinURL(url("http://evil.example:10020/x"), apiPort: 10020) == nil, "another host")
    expect(signinURL(url("https://localhost:10020/x"), apiPort: 10020) == nil, "another scheme")
    expect(signinURL(#"{"error":"fg signin needs FG_OWNER_TOKEN"}"#.data(using: .utf8)!, apiPort: 10020) == nil, "an error")
}

// Engine and environment.
do {
    eq(engineName(context: "orbstack", installed: ["OrbStack", "Docker Desktop"]), "OrbStack", "OrbStack context")
    eq(engineName(context: "desktop-linux", installed: []), "Docker Desktop", "Docker Desktop context")
    eq(engineName(context: "colima", installed: []), "Colima", "Colima context")
    eq(engineName(context: "default", installed: ["Colima"]), "Colima", "the only one installed")
    eq(engineName(context: "default", installed: []), "The Docker engine", "unknown")
    let path = searchPath(home: "/Users/you", inherited: "/usr/bin:/opt/homebrew/bin")
    expect(path.hasPrefix("/Users/you/.orbstack/bin:"), "OrbStack first")
    eq(path.components(separatedBy: ":").filter { $0 == "/opt/homebrew/bin" }.count, 1, "no duplicates")
    let env = childEnvironment(["HOME": "/Users/you", "FEEDBACK_GRAPH_URL": "http://x", "FG_INSTANCE": "other", "API_PORT": "1",
                                "COMPOSE_PROJECT_NAME": "p", "COMPOSE_FILE": "f", "API_TOKEN": "t", "DOCKER_HOST": "unix:///d"], home: "/Users/you")
    for k in ["FEEDBACK_GRAPH_URL", "FG_INSTANCE", "API_PORT", "COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "API_TOKEN"] {
        expect(env[k] == nil, "\(k) is left to the install's .env")
    }
    eq(env["DOCKER_HOST"], "unix:///d", "the engine's socket goes through")
    eq(env["HOME"], "/Users/you", "home")
}

// Upgrade.
do {
    eq(upgradePlan(branch: "main", behind: 3, tag: nil, tags: [], dirty: false), .pull(branch: "main", newCommits: 3), "branch behind")
    eq(upgradePlan(branch: "main", behind: 0, tag: nil, tags: [], dirty: false), .upToDate("main"), "branch current")
    if case .refuse = upgradePlan(branch: "main", behind: nil, tag: nil, tags: [], dirty: false) {} else { expect(false, "no upstream refuses") }
    if case .refuse = upgradePlan(branch: "main", behind: 2, tag: nil, tags: [], dirty: true) {} else { expect(false, "dirty refuses") }
    let tags = ["v0.7.5", "v0.8.0", "v0.10.0-rc1", "v0.9.2", "notes"]
    eq(upgradePlan(branch: nil, behind: nil, tag: "v0.7.5", tags: tags, dirty: false), .checkout(from: "v0.7.5", to: "v0.9.2"), "newest release tag, numerically, no pre-release")
    eq(upgradePlan(branch: nil, behind: nil, tag: "v0.9.2", tags: tags, dirty: false), .upToDate("v0.9.2"), "on the newest tag")
    if case .refuse = upgradePlan(branch: nil, behind: nil, tag: nil, tags: tags, dirty: false) {} else { expect(false, "detached without a tag refuses") }
    eq(releaseVersion("v0.10.1"), [0, 10, 1], "version numbers")
    expect(releaseVersion("v1.2") == nil, "two parts is not a release")
    eq(shellQuoted("/a/it's"), "'/a/it'\\''s'", "single quote escaped")
}

print("\(checks - failures) of \(checks) checks passed")
exit(failures == 0 ? 0 : 1)
