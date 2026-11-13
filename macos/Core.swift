import Foundation

// The menu bar app's decisions that need no window, no Docker and no network: what .env settings to read, how the
// stack's containers add up to one status, what the doctor said, when to poll next, what an upgrade would do.
// macos/Tests/main.swift tests them (scripts/test-mac-app.sh).

/// The few .env settings the app needs. Only these keys are read: a token or password line is never kept, whatever
/// its name, because no secret key is in the list.
struct InstallSettings: Equatable {
    /// The model settings of the worker's jobs, as CODEX_JOB_SETTINGS in scripts/lib/env.sh: provider specs, not secrets.
    static let jobModelKeys = ["CLASSIFY_LLM", "POSTMORTEM_LLM", "SCAN_LLM", "DOCS_LLM", "CHAT_LLM", "SUMMARY_LLM", "LOOP_LLM", "INTAKE_LLM", "CONFLICT_LLM"]
    static let keys: Set<String> = Set(["FG_INSTANCE", "API_PORT", "OLLAMA_URL", "OLLAMA_PORT", "OLLAMA_MODEL", "OLLAMA_EMBED_MODEL"] + jobModelKeys)

    var values: [String: String] = [:]

    /// The last KEY= line of each listed key, surrounding quotes removed (as the scripts' envval reads it).
    static func parse(_ text: String) -> InstallSettings {
        var out: [String: String] = [:]
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = String(raw)
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = String(line[..<eq])
            guard keys.contains(key) else { continue }
            var value = String(line[line.index(after: eq)...])
            if let f = value.first, f == "\"" || f == "'" { value.removeFirst() }
            if let l = value.last, l == "\"" || l == "'" { value.removeLast() }
            out[key] = value
        }
        return InstallSettings(values: out)
    }

    private func value(_ key: String) -> String? {
        guard let v = values[key], !v.isEmpty else { return nil }
        return v
    }
    /// The Compose project name, as fg_instance in scripts/lib/env.sh.
    var instance: String { value("FG_INSTANCE") ?? "feedback-graph" }
    var apiPort: Int { value("API_PORT").flatMap(Int.init) ?? 8787 }
    var dashboardURL: URL { URL(string: "http://localhost:\(apiPort)/")! }
    var chatModel: String { value("OLLAMA_MODEL") ?? "gemma4" }
    var embedModel: String { value("OLLAMA_EMBED_MODEL") ?? "nomic-embed-text" }
    /// Whether a job is set to codex-cli, the only thing the Codex runner runs.
    var codexUsed: Bool { Self.jobModelKeys.contains { k in value(k).map { $0 == "codex-cli" || $0.hasPrefix("codex-cli:") } ?? false } }
    /// The scan model: SCAN_LLM, else the local Ollama model (as the worker picks it).
    var scanModel: String { value("SCAN_LLM") ?? "ollama:\(chatModel)" }
    /// The containers' Ollama as seen from this Mac, as ollama_host_url in scripts/lib/ollama.sh.
    var ollamaURL: String {
        let url = value("OLLAMA_URL") ?? ""
        if url.isEmpty || url.contains("host.docker.internal") { return "http://localhost:11434" }
        if url.hasPrefix("http://ollama:11434") {
            let port = value("OLLAMA_PORT").flatMap(Int.init) ?? 11435
            return "http://localhost:\(port)"
        }
        return url
    }
}

/// A folder is an install when it has what setup.sh and docker compose need.
func isInstallFolder(_ path: String, exists: (String) -> Bool) -> Bool {
    exists(path + "/docker-compose.yml") && exists(path + "/scripts/setup.sh")
}

// MARK: the stack

enum StackStatus: Equatable {
    case running, starting, stopped, problem
}

/// One container of the install's Compose project, from a `docker ps -a` line (see ContainerRow.format).
struct ContainerRow: Equatable {
    var service: String
    var state: String // running, exited, created, restarting, paused, dead
    var status: String // "Up 2 minutes (healthy)", "Exited (0) 3 minutes ago"
    var workingDir: String
    var oneoff: Bool

    /// The `docker ps --format` template whose lines `parse` reads.
    static let format = "{{.Label \"com.docker.compose.service\"}}\t{{.State}}\t{{.Status}}\t{{.Label \"com.docker.compose.project.working_dir\"}}\t{{.Label \"com.docker.compose.oneoff\"}}"

    static func parse(_ output: String) -> [ContainerRow] {
        output.split(whereSeparator: \.isNewline).compactMap { line in
            let f = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard f.count >= 5, !f[0].isEmpty else { return nil }
            return ContainerRow(service: f[0], state: f[1], status: f[2], workingDir: f[3], oneoff: f[4] == "True")
        }
    }

    /// The services that run once at each start and exit (docker-compose.yml); every other one runs until stopped.
    static let initServices: Set<String> = ["archive-key-init", "runner-control-init"]

    var healthStarting: Bool { status.contains("health: starting") }
    var unhealthy: Bool { status.contains("(unhealthy)") }
    /// An init container that ran and finished, as archive-key-init does on every start. A long-running service that
    /// exited 0 was stopped, which the doctor fails ("worker: stopped").
    var exitedCleanly: Bool { state == "exited" && status.hasPrefix("Exited (0)") && Self.initServices.contains(service) }
    /// codex-runner exits 78 while its persisted isolation-safety flag keeps it off (Dockerfile); the doctor warns,
    /// the Dashboard shows "Codex runner off", and everything else runs.
    var runnerOff: Bool { service == "codex-runner" && state == "exited" && status.hasPrefix("Exited (78)") }
}

/// What the stack is doing, and one line that says so.
struct StackReport: Equatable {
    var status: StackStatus
    var headline: String
}

/// Everything one poll learned, reduced to running / starting / stopped / problem.
/// - foreignDir: set when containers under this install's name were started from another folder.
func classifyStack(engineRunning: Bool, engineName: String, rows allRows: [ContainerRow], installDir: String,
                   apiReady: Bool, ollamaProblem: String?, actionInFlight: String?, settings: InstallSettings = InstallSettings()) -> StackReport {
    guard engineRunning else {
        return StackReport(status: .problem, headline: "\(engineName) is not running: start it, then Feedback Graph")
    }
    let rows = allRows.filter { !$0.oneoff }
    if let other = rows.first(where: { !$0.workingDir.isEmpty && standardPath($0.workingDir) != standardPath(installDir) }) {
        return StackReport(status: .problem, headline: "Another folder's install runs under this name (\(other.workingDir))")
    }
    if let action = actionInFlight { return StackReport(status: .starting, headline: action) }
    let up = rows.filter { $0.state == "running" || $0.state == "restarting" }
    if up.isEmpty { return StackReport(status: .stopped, headline: "Stopped") }
    // A paused service does nothing, as the doctor says ("worker: paused, so it does nothing").
    let failed = rows.filter { $0.state == "restarting" || $0.state == "dead" || $0.state == "paused" || $0.unhealthy || ($0.state == "exited" && !$0.exitedCleanly && !$0.runnerOff) }
    if !failed.isEmpty {
        let names = failed.map(\.service).sorted().joined(separator: ", ")
        return StackReport(status: .problem, headline: "Running with a problem: \(names) \(failed.count == 1 ? "is" : "are") not healthy")
    }
    if rows.contains(where: \.healthStarting) || !apiReady {
        return StackReport(status: .starting, headline: "Starting…")
    }
    if let ollamaProblem { return StackReport(status: .problem, headline: "Running, but \(ollamaProblem)") }
    // No job set to codex-cli: nothing waits for the runner, so it is named neutrally rather than as paused work.
    if rows.contains(where: \.runnerOff) {
        return StackReport(status: .running, headline: settings.codexUsed ? "Running · Codex runner off: scans paused" : "Running · Codex runner: not used (scans use \(settings.scanModel))")
    }
    return StackReport(status: .running, headline: "Running")
}

/// A path with /private/tmp and /tmp (and other links) compared as one.
func standardPath(_ path: String) -> String {
    var p = (path as NSString).resolvingSymlinksInPath
    if p.hasPrefix("/private/") { p.removeFirst("/private".count) }
    while p.count > 1 && p.hasSuffix("/") { p.removeLast() }
    return p
}

/// Seconds until the next poll: quick while something is changing, gentle while running, slower and slower while
/// stopped (no engine to ask often), so an idle Mac is barely touched.
func nextPollInterval(_ status: StackStatus, stoppedPolls: Int) -> TimeInterval {
    switch status {
    case .starting: return 5
    case .running, .problem: return 15
    case .stopped: return min(15 * pow(2, Double(max(0, stoppedPolls))), 120)
    }
}

// MARK: Ollama

/// Model names from Ollama's /api/tags answer.
func ollamaModelNames(_ data: Data) -> [String]? {
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let models = json["models"] as? [[String: Any]] else { return nil }
    return models.compactMap { $0["name"] as? String }
}

/// Ollama resolves a name without a tag to name:latest; a tagged name must match exactly.
func ollamaHasModel(_ wanted: String, in names: [String]) -> Bool {
    let full = wanted.contains(":") ? wanted : wanted + ":latest"
    return names.contains(full) || names.contains(wanted)
}

// MARK: doctor

struct DoctorSummary: Equatable {
    var pass = 0, warn = 0, fail = 0, skip = 0
    /// The FAIL and WARN checks, each with its indented how-to-fix lines.
    var attention: [String] = []

    var line: String {
        "\(pass) passed, \(warn) warning\(warn == 1 ? "" : "s"), \(fail) failed, \(skip) skipped"
    }

    static func parse(_ output: String) -> DoctorSummary {
        var s = DoctorSummary()
        var keeping = false
        for raw in output.split(whereSeparator: \.isNewline) {
            let line = String(raw)
            if line.hasPrefix("PASS  ") { s.pass += 1; keeping = false }
            else if line.hasPrefix("SKIP  ") { s.skip += 1; keeping = false }
            else if line.hasPrefix("WARN  ") { s.warn += 1; keeping = true; s.attention.append(line) }
            else if line.hasPrefix("FAIL  ") { s.fail += 1; keeping = true; s.attention.append(line) }
            else if keeping && line.hasPrefix("      ") { s.attention.append(line) }
            else { keeping = false }
        }
        return s
    }
}

// MARK: learning loop

struct LoopSummary: Equatable {
    var mode: String
    var effectiveMode: String
    var paused: Bool
    var proposalsWaiting: Int
    /// Why the loop runs below its mode: paused, disabled (LOOP_DISABLED=1) or tokenless.
    var capped: String?

    /// From `fg loop status --json`.
    static func parse(_ data: Data) -> LoopSummary? {
        guard let s = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let mode = s["mode"] as? String else { return nil }
        let counts = s["counts"] as? [String: Any]
        let capped = s["capped"] as? String
        return LoopSummary(mode: mode, effectiveMode: s["effectiveMode"] as? String ?? mode,
                           paused: capped == "paused" || (s["paused"] is [String: Any]),
                           proposalsWaiting: counts?["proposed"] as? Int ?? 0, capped: capped)
    }

    var line: String {
        let state: String
        if paused { state = "paused" }
        else if capped == "disabled" { state = "disabled (LOOP_DISABLED=1)" }
        else if effectiveMode != mode { state = "\(mode), runs as \(effectiveMode)" }
        else { state = mode }
        let waiting = proposalsWaiting == 1 ? "1 proposal waiting" : "\(proposalsWaiting) proposals waiting"
        return "Learning loop: \(state) · \(waiting)"
    }
}

/// The `OPERATOR_ALLOW=` line an operator token's 403 on pause or resume prints (`fg loop pause --json`): the verbs the
/// token may use now plus loop_settings. A list there replaces the default verbs, so this whole line is what goes in
/// .env, never loop_settings alone. Nil for any other answer, a tokenless install's included: its 403 prints a line
/// too, but the line does nothing until the install has tokens, and the 403 says how to add them.
func loopSettingsAllowLine(_ output: String) -> String? {
    guard output.contains("loop_setting"), !output.contains("has no owner token"),
          let r = output.range(of: #"OPERATOR_ALLOW=[a-z_,]+"#, options: .regularExpression) else { return nil }
    let line = String(output[r])
    return line.split(separator: "=")[1].split(separator: ",").contains("loop_settings") ? line : nil
}

// MARK: sign-in

/// The one-time link from `fg signin --json`, accepted only when it is this install's own dashboard on this Mac: the
/// app never opens a sign-in link anywhere else.
func signinURL(_ data: Data, apiPort: Int) -> URL? {
    guard let s = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let text = s["url"] as? String, let url = URL(string: text),
          url.scheme == "http", ["localhost", "127.0.0.1"].contains(url.host ?? ""), url.port == apiPort else { return nil }
    return url
}

// MARK: Docker engine

/// Which engine answers, from `docker context show` and the apps installed.
func engineName(context: String, installed: [String]) -> String {
    let c = context.lowercased()
    if c.contains("orbstack") { return "OrbStack" }
    if c.contains("colima") { return "Colima" }
    if c.hasPrefix("desktop") { return "Docker Desktop" }
    if installed.count == 1 { return installed[0] }
    return "The Docker engine"
}

/// Folders a Mac's Docker CLIs and Node live in; an app opened from the Finder gets only /usr/bin:/bin:/usr/sbin:/sbin.
func searchPath(home: String, inherited: String?) -> String {
    let extra = ["\(home)/.orbstack/bin", "/opt/homebrew/bin", "/usr/local/bin", "\(home)/.docker/bin",
                 "/Applications/Docker.app/Contents/Resources/bin", "\(home)/.colima/bin", "\(home)/.local/bin"]
    var seen = Set<String>()
    return (extra + (inherited ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init) + ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])
        .filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
}

/// The environment the scripts and docker compose run with: the install's .env decides FG_INSTANCE, ports, Compose
/// files and tokens, so none of them is passed on from the app's own environment (nor FEEDBACK_GRAPH_URL, which would
/// point fg at another install). Only what finds programs, the user and the Docker engine goes through.
func childEnvironment(_ inherited: [String: String], home: String) -> [String: String] {
    let pass = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "SSH_AUTH_SOCK",
                "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]
    var env: [String: String] = [:]
    for k in pass { if let v = inherited[k] { env[k] = v } }
    env["PATH"] = searchPath(home: home, inherited: inherited["PATH"])
    env["NO_COLOR"] = "1"
    env["TERM"] = "dumb"
    return env
}

// MARK: upgrade

/// What Upgrade does to the install's git checkout.
enum UpgradePlan: Equatable {
    /// On a branch: git pull --ff-only, with this many new commits (0: already current).
    case pull(branch: String, newCommits: Int)
    /// On a release tag: check out the newest release tag.
    case checkout(from: String, to: String)
    case upToDate(String)
    case refuse(String)

    var summary: String {
        switch self {
        case let .pull(branch, n): return "pull \(n) new commit\(n == 1 ? "" : "s") on \(branch)"
        case let .checkout(from, to): return "move from \(from) to \(to)"
        case let .upToDate(what): return "already up to date (\(what))"
        case let .refuse(why): return why
        }
    }
}

/// - branch: `git symbolic-ref --short HEAD`, nil when detached. tag: `git describe --tags --exact-match`, nil when
///   none. tags: every tag after `git fetch --tags`. dirty: tracked files changed (untracked .env and backups are fine).
func upgradePlan(branch: String?, behind: Int?, tag: String?, tags: [String], dirty: Bool) -> UpgradePlan {
    if dirty { return .refuse("The install folder has changed files under version control: commit or undo them first") }
    if let branch {
        guard let behind else { return .refuse("\(branch) has no upstream branch to pull from") }
        return behind == 0 ? .upToDate(branch) : .pull(branch: branch, newCommits: behind)
    }
    guard let tag, let current = releaseVersion(tag) else {
        return .refuse("The install is not on a branch or a release tag: check out one in Terminal first")
    }
    let newest = tags.compactMap { t in releaseVersion(t).map { (t, $0) } }.max { $0.1.lexicographicallyPrecedes($1.1) }
    guard let newest, current.lexicographicallyPrecedes(newest.1) else { return .upToDate(tag) }
    return .checkout(from: tag, to: newest.0)
}

/// v1.2.3 or 1.2.3 as numbers; a pre-release (v1.2.3-rc1) is not a release.
func releaseVersion(_ tag: String) -> [Int]? {
    let t = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
    let parts = t.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3 else { return nil }
    let nums = parts.compactMap { Int($0) }
    return nums.count == 3 ? nums : nil
}

/// A path for a shell script, in single quotes.
func shellQuoted(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
