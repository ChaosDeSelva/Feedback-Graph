import AppKit
import ServiceManagement
import WebKit

// Feedback Graph's menu bar companion: the stack's status, start and stop, the dashboard signed in, the learning
// loop, backups, logs, health and upgrades for one install folder. It runs the install's own scripts and docker
// compose in that folder; it bundles no Docker, keeps no token and leaves the services running when it quits.
// Logic that needs no window lives in Core.swift (tested by scripts/test-mac-app.sh).

@main
struct FeedbackGraphMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}

// MARK: running programs

struct RunResult {
    var status: Int32
    var output: String // standard output
    var errors: String // standard error
    var all: String { [output, errors].filter { !$0.isEmpty }.joined(separator: output.hasSuffix("\n") || output.isEmpty ? "" : "\n") }
}

/// Runs programs the way a terminal in the install folder would, with the environment from childEnvironment.
final class Runner {
    let env: [String: String]
    init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        env = childEnvironment(ProcessInfo.processInfo.environment, home: home)
    }

    /// Blocking: call it off the main thread. `stream` gets output as it arrives (both streams).
    func run(_ args: [String], in dir: String?, timeout: TimeInterval = 60, stream: ((String) -> Void)? = nil) -> RunResult {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = args
        task.environment = env
        if let dir { task.currentDirectoryURL = URL(fileURLWithPath: dir) }
        // No terminal: setup.sh and the other scripts then only do what their flags say.
        task.standardInput = FileHandle.nullDevice
        let out = Pipe(), err = Pipe()
        task.standardOutput = out; task.standardError = err
        let lock = NSLock()
        var outData = Data(), errData = Data()
        func reader(_ pipe: Pipe, _ append: @escaping (Data) -> Void) {
            pipe.fileHandleForReading.readabilityHandler = { h in
                let d = h.availableData
                guard !d.isEmpty else { return }
                lock.lock(); append(d); lock.unlock()
                if let stream, let s = String(data: d, encoding: .utf8) { stream(s) }
            }
        }
        reader(out) { outData.append($0) }
        reader(err) { errData.append($0) }
        do { try task.run() } catch {
            out.fileHandleForReading.readabilityHandler = nil; err.fileHandleForReading.readabilityHandler = nil
            return RunResult(status: 127, output: "", errors: error.localizedDescription)
        }
        let killer = DispatchWorkItem { if task.isRunning { task.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
        task.waitUntilExit()
        killer.cancel()
        out.fileHandleForReading.readabilityHandler = nil; err.fileHandleForReading.readabilityHandler = nil
        let restOut = out.fileHandleForReading.readDataToEndOfFile(), restErr = err.fileHandleForReading.readDataToEndOfFile()
        lock.lock(); outData.append(restOut); errData.append(restErr); lock.unlock()
        if let stream { for d in [restOut, restErr] where !d.isEmpty { stream(String(data: d, encoding: .utf8) ?? "") } }
        return RunResult(status: task.terminationStatus, output: String(data: outData, encoding: .utf8) ?? "",
                         errors: String(data: errData, encoding: .utf8) ?? "")
    }

    /// One HTTP GET with a short deadline; nil when nothing answers.
    func get(_ url: URL, timeout: TimeInterval = 3) -> (Int, Data)? {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        let done = DispatchSemaphore(value: 0)
        var result: (Int, Data)?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            if let http = response as? HTTPURLResponse { result = (http.statusCode, data ?? Data()) }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + timeout + 1)
        return result
    }
}

// MARK: what one poll saw

struct Snapshot {
    var settings = InstallSettings()
    var installDir: String?
    var engineInstalled = true
    var engineRunning = false
    var engineName = "The Docker engine"
    var engineVersion = ""
    var rows: [ContainerRow] = []
    var apiReady = false
    var ollamaAnswers = false
    var ollamaMissing: [String] = []
    var loop: LoopSummary?
    var loopNote: String?
    var report = StackReport(status: .stopped, headline: "Checking…")

    var foreign: Bool { report.headline.hasPrefix("Another folder") }
    var ollamaProblem: String? {
        if !ollamaAnswers { return "Ollama does not answer at \(settings.ollamaURL)" }
        if !ollamaMissing.isEmpty { return "Ollama lacks \(ollamaMissing.joined(separator: " and ")) (ollama pull \(ollamaMissing[0]))" }
        return nil
    }
    var dockerLine: String {
        if !engineInstalled { return "Docker: none found. Install OrbStack, Docker Desktop or Colima" }
        return engineRunning ? "Docker: \(engineName) running\(engineVersion.isEmpty ? "" : " (engine \(engineVersion))")" : "Docker: \(engineName) is not running"
    }
    var ollamaLine: String {
        if installDir == nil { return "Ollama: checked once there is an install folder" }
        if let p = ollamaProblem { return "Ollama: " + p.replacingOccurrences(of: "Ollama ", with: "") }
        return "Ollama: running, \(settings.chatModel) and \(settings.embedModel) ready"
    }
    var loopLine: String {
        if let loop { return loop.line }
        if let loopNote { return "Learning loop: \(loopNote)" }
        return report.status == .running ? "Learning loop: checking…" : "Learning loop: shown while running"
    }
}

extension StackStatus {
    var colour: NSColor {
        switch self {
        case .running: return .systemGreen
        case .starting: return .systemOrange
        case .stopped: return .secondaryLabelColor
        case .problem: return .systemRed
        }
    }
}

// MARK: the app

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let runner = Runner()
    private let defaults = UserDefaults.standard
    private let defaultInstall = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Code/feedback-graph").path
    private let repoURL = "https://github.com/ChaosDeSelva/Feedback-Graph"

    private var statusItem: NSStatusItem!
    private var menuItems: [String: NSMenuItem] = [:]
    private var window: NSWindow!
    private var dashboard: NSWindow?
    private var webView: WKWebView?
    private var dot: NSTextField!
    private var headline: NSTextField!
    private var details: [String: NSTextField] = [:]
    private var output: NSTextView!
    private var buttons: [String: NSButton] = [:]
    private var loginBox: NSButton!
    private var folderLabel: NSTextField!

    private var snap = Snapshot()
    private var busy: String? // what the running action is doing
    private var actionInFlight: String? // a start, stop or restart: the status shows it
    private var polling = false
    private var stoppedPolls = 0
    private var lastPoll = Date.distantPast
    private var lastLoopFetch = Date.distantPast
    private var pollTimer: Timer?

    /// The install folder: the one chosen, else ~/Code/feedback-graph when it is one.
    private var installDir: String? {
        let fm = FileManager.default
        if let chosen = defaults.string(forKey: "installFolder"), !chosen.isEmpty {
            return isInstallFolder(chosen, exists: fm.fileExists) ? chosen : nil
        }
        return isInstallFolder(defaultInstall, exists: fm.fileExists) ? defaultInstall : nil
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = markImage(size: 16)
        statusItem.button?.imagePosition = .imageLeft
        statusItem.button?.setAccessibilityLabel("Feedback Graph")
        statusItem.menu = buildMenu()
        buildWindow()
        applyState()
        if installDir == nil || !defaults.bool(forKey: "welcomed") {
            defaults.set(true, forKey: "welcomed")
            showWindow()
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.poll() }
        poll()
    }

    // MARK: menu

    private func item(_ key: String, _ title: String, _ action: Selector?, enabled: Bool = true) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
        i.target = self
        i.isEnabled = enabled
        menuItems[key] = i
        return i
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        for key in ["status", "docker", "ollama", "loop"] { menu.addItem(item(key, "", nil, enabled: false)) }
        menu.addItem(.separator())
        menu.addItem(item("open", "Open Dashboard", #selector(openDashboard)))
        menu.addItem(item("openWindow", "Open Dashboard in a Window", #selector(openDashboardWindow)))
        menu.addItem(.separator())
        menu.addItem(item("start", "Start", #selector(start)))
        menu.addItem(item("stop", "Stop…", #selector(stop)))
        menu.addItem(item("restart", "Restart", #selector(restart)))
        menu.addItem(item("pause", "Pause Learning Loop", #selector(toggleLoop)))
        menu.addItem(.separator())
        menu.addItem(item("health", "Health Check", #selector(healthCheck)))
        menu.addItem(item("backup", "Back Up Now…", #selector(backup)))
        menu.addItem(item("logs", "Show Logs", #selector(showLogs)))
        menu.addItem(item("upgrade", "Upgrade…", #selector(upgrade)))
        menu.addItem(.separator())
        menu.addItem(item("window", "Show Feedback Graph Window", #selector(showWindow)))
        menu.addItem(item("folder", "Choose Install Folder…", #selector(chooseFolder)))
        menu.addItem(item("login", "Launch at Login", #selector(toggleLogin)))
        menu.addItem(.separator())
        menu.addItem(item("quit", "Quit (Feedback Graph Keeps Running)", #selector(quit)))
        return menu
    }

    func menuWillOpen(_ menu: NSMenu) {
        applyState()
        if Date().timeIntervalSince(lastPoll) > 5 { poll() }
    }

    /// The main menu routes Cmd+C, Cmd+A, Cmd+W and the rest to the windows of an app that shows no menu bar.
    private func installMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        NSApp.mainMenu = main
    }

    // MARK: window

    private func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular, secondary: Bool = false) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: text)
        l.font = .systemFont(ofSize: size, weight: weight)
        if secondary { l.textColor = .secondaryLabelColor }
        return l
    }
    private func button(_ key: String, _ title: String, _ action: Selector, tip: String) -> NSButton {
        let b = NSButton(title: title, target: self, action: action)
        b.bezelStyle = .rounded
        b.toolTip = tip
        b.heightAnchor.constraint(equalToConstant: 28).isActive = true
        buttons[key] = b
        return b
    }
    private func row(_ views: [NSView]) -> NSStackView {
        let s = NSStackView(views: views)
        s.orientation = .horizontal; s.spacing = 10; s.distribution = .fillEqually
        return s
    }
    private func section(_ title: String, _ rows: [NSView], in root: NSStackView) {
        let box = NSStackView(); box.orientation = .vertical; box.alignment = .leading; box.spacing = 8
        box.addArrangedSubview(label(title, size: 13, weight: .semibold))
        for r in rows { box.addArrangedSubview(r); r.widthAnchor.constraint(equalTo: box.widthAnchor).isActive = true }
        root.addArrangedSubview(box)
        box.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 680), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Feedback Graph"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 600, height: 560)
        window.center()
        let content = window.contentView!
        let root = NSStackView(); root.orientation = .vertical; root.alignment = .leading; root.spacing = 16
        root.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(root)
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 22),
            root.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -22),
            root.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
            root.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -18),
        ])

        let icon = NSImageView(image: NSApp.applicationIconImage)
        icon.widthAnchor.constraint(equalToConstant: 40).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 40).isActive = true
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let titles = NSStackView(views: [label("Feedback Graph", size: 20, weight: .bold), label("Menu bar companion \(version)", size: 11, secondary: true)])
        titles.orientation = .vertical; titles.alignment = .leading; titles.spacing = 0
        let header = NSStackView(views: [icon, titles]); header.spacing = 10
        root.addArrangedSubview(header)

        dot = NSTextField(labelWithString: "●"); dot.font = .systemFont(ofSize: 15)
        headline = label("Checking…", size: 15, weight: .medium)
        let status = NSStackView(views: [dot, headline]); status.spacing = 6
        let info = NSStackView(); info.orientation = .vertical; info.alignment = .leading; info.spacing = 3
        info.addArrangedSubview(status)
        for key in ["docker", "ollama", "loop"] {
            let l = label("", size: 12, secondary: true); details[key] = l; info.addArrangedSubview(l)
        }
        root.addArrangedSubview(info)

        section("Feedback Graph", [
            row([button("start", "Start", #selector(startOrStop), tip: "docker compose up -d in the install folder, or down to stop it (your data stays)."),
                 button("restart", "Restart", #selector(restart), tip: "docker compose down, then up -d: picks up .env changes. Your data stays."),
                 button("open", "Open Dashboard", #selector(openDashboard), tip: "Opens the dashboard in your browser, signed in with a one-time link."),
                 button("openWindow", "Open in a Window", #selector(openDashboardWindow), tip: "Opens the dashboard in a window of this app, signed in with a one-time link.")]),
        ], in: root)
        section("Learning loop", [
            row([button("pause", "Pause Loop", #selector(toggleLoop), tip: "./scripts/fg loop pause or resume: stops the learning loop at once, or starts it again."),
                 NSView(), NSView(), NSView()]),
        ], in: root)
        section("Maintenance", [
            row([button("health", "Health Check", #selector(healthCheck), tip: "Checks Docker, Ollama and its models, then runs ./scripts/doctor.sh."),
                 button("backup", "Back Up Now", #selector(backup), tip: "./scripts/backup.sh: the store and the worker's state into backups/ in the install folder."),
                 button("logs", "Show Logs", #selector(showLogs), tip: "The last lines each service logged (docker compose logs)."),
                 button("upgrade", "Upgrade…", #selector(upgrade), tip: "Backs up, updates the install's git checkout (its branch or the newest release tag), then runs ./scripts/setup.sh --yes.")]),
        ], in: root)

        folderLabel = label("", size: 12, secondary: true)
        folderLabel.lineBreakMode = .byTruncatingMiddle
        loginBox = NSButton(checkboxWithTitle: "Launch at login", target: self, action: #selector(toggleLogin))
        loginBox.toolTip = "Opens this app when you log in. Feedback Graph itself starts with Docker, not with this app."
        section("Install", [
            folderLabel,
            row([button("folder", "Choose Folder…", #selector(chooseFolder), tip: "The Feedback Graph folder this app runs: it has docker-compose.yml and scripts/setup.sh."),
                 button("clone", "Get Feedback Graph…", #selector(cloneInstall), tip: "Clones Feedback Graph from GitHub and opens Terminal to run its setup."),
                 loginBox, NSView()]),
        ], in: root)

        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        output = NSTextView(); output.isEditable = false; output.isSelectable = true
        output.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        output.textContainerInset = NSSize(width: 8, height: 8)
        output.autoresizingMask = [.width]; output.isHorizontallyResizable = false; output.textContainer?.widthTracksTextView = true
        output.setAccessibilityLabel("Results of the last action")
        output.string = "Results of what you click appear here. Hover over a button to see what it does.\n\nQuitting this app leaves Feedback Graph running; Stop stops it."
        scroll.documentView = output
        root.addArrangedSubview(scroll)
        scroll.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 160).isActive = true
    }

    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: state

    private func applyState() {
        let s = snap
        let haveInstall = installDir != nil
        // A start, stop or restart in flight shows at once, before the next poll sees it.
        let status = actionInFlight != nil ? .starting : s.report.status
        let running = status == .running || (status == .problem && s.rows.contains { $0.state == "running" } && !s.foreign)
        let up = s.rows.contains { !$0.oneoff && $0.state == "running" }
        var title = actionInFlight ?? s.report.headline
        if !haveInstall { title = "No install folder: choose one, or get Feedback Graph" }
        let colour: NSColor = haveInstall ? status.colour : .systemRed

        // The menu bar: the mark and a coloured dot.
        let dotTitle = NSAttributedString(string: " ●", attributes: [.foregroundColor: colour, .font: NSFont.systemFont(ofSize: 10), .baselineOffset: 1])
        statusItem.button?.attributedTitle = dotTitle
        statusItem.button?.toolTip = "Feedback Graph: \(title)"
        statusItem.button?.setAccessibilityValue(title)

        let where_ = haveInstall ? " · \(s.settings.instance) on port \(s.settings.apiPort)" : ""
        menuItems["status"]?.attributedTitle = NSAttributedString(string: "● ", attributes: [.foregroundColor: colour])
            + NSAttributedString(string: title + where_, attributes: [.foregroundColor: NSColor.labelColor])
        menuItems["docker"]?.title = s.dockerLine
        menuItems["ollama"]?.title = s.ollamaLine
        menuItems["loop"]?.title = s.loopLine
        for key in ["ollama", "loop"] { menuItems[key]?.isHidden = !haveInstall }

        dot.textColor = colour
        headline.stringValue = busy ?? title
        details["docker"]?.stringValue = s.dockerLine
        details["ollama"]?.stringValue = s.ollamaLine
        details["loop"]?.stringValue = s.loopLine
        folderLabel.stringValue = installDir.map { "Install folder: \($0)\(where_)" } ?? "No install folder yet. \(defaultInstall) is used when it has docker-compose.yml and scripts/setup.sh."

        let idle = busy == nil
        let canDocker = haveInstall && s.engineRunning && !s.foreign && idle
        let loopKnown = s.loop != nil && running && idle
        let enabled: [String: Bool] = [
            "start": canDocker && !up, "stop": canDocker && up, "restart": canDocker && up,
            "open": haveInstall && s.apiReady && idle, "openWindow": haveInstall && s.apiReady && idle,
            "pause": loopKnown,
            "health": haveInstall && idle, "backup": canDocker, "logs": canDocker && !s.rows.isEmpty,
            "upgrade": haveInstall && s.engineRunning && !s.foreign && idle, "folder": idle, "clone": idle, "login": true,
            "window": true, "quit": true,
        ]
        for (key, on) in enabled { menuItems[key]?.isEnabled = on; buttons[key]?.isEnabled = on }
        // The window's one start/stop button follows the state.
        if let b = buttons["start"] {
            b.title = up ? "Stop…" : "Start"
            b.isEnabled = canDocker
        }
        let pauseTitle = s.loop?.paused == true ? "Resume Learning Loop" : "Pause Learning Loop"
        menuItems["pause"]?.title = pauseTitle
        buttons["pause"]?.title = s.loop?.paused == true ? "Resume Loop" : "Pause Loop"

        let login = SMAppService.mainApp.status == .enabled
        menuItems["login"]?.state = login ? .on : .off
        loginBox.state = login ? .on : .off
    }

    /// One status check, off the main thread; the next one is scheduled by what it found.
    private func poll() {
        guard !polling else { return }
        polling = true
        lastPoll = Date()
        let dir = installDir
        let fetchLoop = Date().timeIntervalSince(lastLoopFetch) > 60
        let inFlight = actionInFlight
        let previous = snap
        DispatchQueue.global(qos: .utility).async {
            var s = Snapshot()
            s.installDir = dir
            if let dir { s.settings = InstallSettings.parse((try? String(contentsOfFile: dir + "/.env", encoding: .utf8)) ?? "") }
            let context = self.runner.run(["docker", "context", "show"], in: nil, timeout: 10)
            s.engineInstalled = context.status != 127
            var installed: [String] = []
            if FileManager.default.fileExists(atPath: "/Applications/OrbStack.app") { installed.append("OrbStack") }
            if FileManager.default.fileExists(atPath: "/Applications/Docker.app") { installed.append("Docker Desktop") }
            s.engineName = engineName(context: context.output.trimmingCharacters(in: .whitespacesAndNewlines), installed: installed)
            let info = self.runner.run(["docker", "info", "--format", "{{.ServerVersion}}"], in: nil, timeout: 15)
            s.engineRunning = info.status == 0
            s.engineVersion = info.output.trimmingCharacters(in: .whitespacesAndNewlines)
            if s.engineRunning, dir != nil {
                let ps = self.runner.run(["docker", "ps", "-a", "--filter", "label=com.docker.compose.project=\(s.settings.instance)", "--format", ContainerRow.format], in: nil, timeout: 15)
                s.rows = ContainerRow.parse(ps.output)
            }
            if dir != nil {
                if let (code, _) = self.runner.get(URL(string: "http://127.0.0.1:\(s.settings.apiPort)/api/ready")!) { s.apiReady = code == 200 }
                if let base = URL(string: s.settings.ollamaURL), let (code, data) = self.runner.get(base.appendingPathComponent("api/tags")), code == 200,
                   let names = ollamaModelNames(data) {
                    s.ollamaAnswers = true
                    s.ollamaMissing = [s.settings.chatModel, s.settings.embedModel].filter { !ollamaHasModel($0, in: names) }
                }
            }
            s.report = classifyStack(engineRunning: s.engineRunning, engineName: s.engineName, rows: s.rows, installDir: dir ?? "",
                                     apiReady: s.apiReady, ollamaProblem: s.ollamaProblem, actionInFlight: inFlight)
            // The loop answers through fg (it holds the token); asked once a minute while running.
            var loopFetched = false
            if let dir, s.apiReady, !s.foreign {
                if fetchLoop || previous.loop == nil {
                    let r = self.runner.run(["./scripts/fg", "loop", "status", "--json"], in: dir, timeout: 45)
                    loopFetched = true
                    if let loop = LoopSummary.parse(Data(r.output.utf8)) { s.loop = loop }
                    else { s.loopNote = self.loopProblem(r) }
                } else { s.loop = previous.loop; s.loopNote = previous.loopNote }
            }
            DispatchQueue.main.async {
                self.polling = false
                if loopFetched { self.lastLoopFetch = Date() }
                self.snap = s
                self.stoppedPolls = s.report.status == .stopped ? self.stoppedPolls + 1 : 0
                self.applyState()
                self.schedulePoll(nextPollInterval(self.actionInFlight != nil ? .starting : s.report.status, stoppedPolls: max(0, self.stoppedPolls - 1)))
            }
        }
    }

    private func loopProblem(_ r: RunResult) -> String {
        let text = r.output + r.errors
        if text.contains("unknown command") || text.contains("usage:") { return "not in this version" }
        if let d = r.output.data(using: .utf8), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let e = j["error"] as? String {
            return "unavailable (\(e.prefix(80)))"
        }
        return "unavailable"
    }

    private func schedulePoll(_ seconds: TimeInterval) {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in self?.poll() }
    }

    // MARK: actions

    private func show(_ text: String) { output.string = text; output.scrollToBeginningOfDocument(nil) }
    private func append(_ text: String) {
        output.textStorage?.append(NSAttributedString(string: text, attributes: [.font: output.font!, .foregroundColor: NSColor.labelColor]))
        output.scrollToEndOfDocument(nil)
    }

    /// Runs steps one after another off the main thread, their output streamed into the window; stops at the first
    /// that fails. `status` marks the menu bar as starting while it runs.
    private func act(_ working: String, status: Bool = false, steps: [(String, [String], TimeInterval)], done: ((Bool) -> Void)? = nil) {
        guard busy == nil, let dir = installDir else { return }
        busy = working
        if status { actionInFlight = working }
        show(working + "\n")
        applyState()
        showWindow()
        DispatchQueue.global(qos: .userInitiated).async {
            var ok = true
            for (title, args, timeout) in steps {
                DispatchQueue.main.async { self.append("\n$ \(title)\n") }
                let r = self.runner.run(args, in: dir, timeout: timeout) { text in DispatchQueue.main.async { self.append(text) } }
                if r.status != 0 {
                    ok = false
                    DispatchQueue.main.async { self.append("\nThat did not work (exit \(r.status)). Nothing after it ran.\n") }
                    break
                }
            }
            DispatchQueue.main.async {
                self.busy = nil
                self.actionInFlight = nil
                if ok { self.append("\nDone.\n") }
                done?(ok)
                self.lastLoopFetch = .distantPast
                self.applyState()
                self.poll()
            }
        }
    }

    private func compose(_ args: [String]) -> [String] { ["docker", "compose", "-p", snap.settings.instance] + args }

    private func confirm(_ title: String, _ detail: String, _ button: String = "Continue") -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.addButton(withTitle: button); alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    @objc func startOrStop() {
        if snap.rows.contains(where: { !$0.oneoff && $0.state == "running" }) { stop() } else { start() }
    }
    @objc func start() {
        act("Starting Feedback Graph…", status: true, steps: [("docker compose up -d", compose(["up", "-d"]), 1800)])
    }
    @objc func stop() {
        guard confirm("Stop Feedback Graph?", "Its containers stop (docker compose down). Your data stays in its volumes; Start brings it back. Agents cannot reach it while it is stopped.", "Stop") else { return }
        act("Stopping Feedback Graph…", status: true, steps: [("docker compose down", compose(["down"]), 600)])
    }
    @objc func restart() {
        act("Restarting Feedback Graph…", status: true, steps: [("docker compose down", compose(["down"]), 600), ("docker compose up -d", compose(["up", "-d"]), 1800)])
    }

    @objc func toggleLoop() {
        let verb = snap.loop?.paused == true ? "resume" : "pause"
        guard busy == nil, let dir = installDir else { return }
        busy = verb == "pause" ? "Pausing the learning loop…" : "Resuming the learning loop…"
        applyState()
        DispatchQueue.global(qos: .userInitiated).async {
            let r = self.runner.run(["./scripts/fg", "loop", verb, "--json"], in: dir, timeout: 60)
            DispatchQueue.main.async {
                self.busy = nil
                if let loop = LoopSummary.parse(Data(r.output.utf8)) {
                    self.snap.loop = loop
                    self.lastLoopFetch = Date()
                    self.show("\(loop.paused ? "Paused" : "Resumed") the learning loop.\n\n\(loop.line)")
                    self.applyState()
                    return
                }
                self.applyState()
                if let line = loopSettingsAllowLine(r.output) {
                    // By default the operator token fg uses may read the loop but not pause it (OPERATOR_ALLOW).
                    self.show("Pausing and resuming from this app needs loop_settings in OPERATOR_ALLOW in the install's .env. A list there replaces the default verbs rather than adding to them, so do not add loop_settings on its own: use the whole OPERATOR_ALLOW= line fg printed, in place of any OPERATOR_ALLOW line there. It keeps the verbs the token has now and adds loop_settings:\n\n\(line)\n\nThen Restart. Until then, use Pause or Resume on the dashboard's Learning loop page, signed in as you.")
                    if self.confirm("Pause or resume on the Learning loop page?", "This install lets fg read the learning loop but not \(verb) it: OPERATOR_ALLOW in .env leaves out loop_settings, as it does by default. The dashboard's Learning loop page can, signed in as you.", "Open Learning Loop") {
                        self.openInWindow(page: "loop")
                    }
                } else if let d = r.output.data(using: .utf8), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let e = j["error"] as? String {
                    // Said in full: a tokenless install's 403 says how to add tokens and how to stop the loop meanwhile.
                    self.show("The learning loop did not \(verb):\n\n\(e)\n\n\(r.errors)")
                } else {
                    self.show("The learning loop did not \(verb):\n\n\(self.loopProblem(r))\n\n\(r.errors)")
                }
            }
        }
    }

    @objc func backup() {
        guard confirm("Back up now?", "./scripts/backup.sh writes the store and the worker's state to backups/ in the install folder. With Neo4j (the default store) Feedback Graph stops for about a minute while it dumps, then starts again.", "Back Up") else { return }
        act("Backing up (Feedback Graph pauses while it dumps)…", status: true, steps: [("./scripts/backup.sh", ["./scripts/backup.sh"], 3600)])
    }

    @objc func showLogs() {
        guard busy == nil, let dir = installDir else { return }
        showWindow()
        show("Reading logs…")
        let args = compose(["logs", "--no-color", "--tail", "150", "--timestamps"])
        DispatchQueue.global(qos: .userInitiated).async {
            let r = self.runner.run(args, in: dir, timeout: 60)
            DispatchQueue.main.async {
                self.show("The last 150 lines of each service (docker compose logs --tail 150 in \(dir)):\n\n" + r.all)
                self.output.scrollToEndOfDocument(nil)
            }
        }
    }

    @objc func healthCheck() {
        guard busy == nil, let dir = installDir else { return }
        busy = "Checking health…"
        applyState()
        showWindow()
        show("Checking health… (the doctor's Ollama check can take a minute while it loads the model)")
        let s = snap
        DispatchQueue.global(qos: .userInitiated).async {
            let doctor = self.runner.run(["./scripts/doctor.sh"], in: dir, timeout: 600)
            let summary = DoctorSummary.parse(doctor.output)
            var text = "Health check\n\n"
            let mark = { (ok: Bool) in ok ? "OK  " : "--  " }
            text += mark(s.engineInstalled && s.engineRunning) + s.dockerLine + "\n"
            text += mark(s.ollamaProblem == nil) + s.ollamaLine + "\n"
            text += mark(s.report.status == .running) + "Stack: \(s.report.headline) (\(s.settings.instance), http://localhost:\(s.settings.apiPort))\n"
            text += mark(summary.fail == 0) + "Doctor: \(summary.line)\n"
            if !summary.attention.isEmpty { text += "\nNeeds attention:\n" + summary.attention.joined(separator: "\n") + "\n" }
            text += "\n── ./scripts/doctor.sh ──\n" + doctor.all
            DispatchQueue.main.async {
                self.busy = nil
                self.show(text)
                self.applyState()
            }
        }
    }

    // MARK: dashboard

    /// Asks fg for a one-time sign-in link (it trades the owner token at localhost; the token never reaches this app)
    /// and hands it on once. The link is not shown or kept. A tokenless install has no sign-in: its address opens.
    /// `page` is a dashboard page (#loop): the link's redirect to / keeps the fragment.
    private func withSigninLink(page: String? = nil, _ use: @escaping (URL) -> Void) {
        guard busy == nil, let dir = installDir else { return }
        busy = "Opening the dashboard…"
        applyState()
        let settings = snap.settings
        DispatchQueue.global(qos: .userInitiated).async {
            let r = self.runner.run(["./scripts/fg", "signin", "--json"], in: dir, timeout: 45)
            let link = signinURL(Data(r.output.utf8), apiPort: settings.apiPort).map { self.onPage($0, page) }
            DispatchQueue.main.async {
                self.busy = nil
                self.applyState()
                if let link { use(link); return }
                if (r.output + r.errors).contains("FG_OWNER_TOKEN") {
                    // Tokenless: nothing to sign in to.
                    use(self.onPage(settings.dashboardURL, page))
                    return
                }
                self.showWindow()
                self.show("Could not get a sign-in link from ./scripts/fg signin:\n\n" + self.loopProblem(r) + "\n" + r.errors)
            }
        }
    }

    private func onPage(_ url: URL, _ page: String?) -> URL {
        guard let page, var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        c.fragment = page
        return c.url ?? url
    }

    @objc func openDashboard() { withSigninLink { NSWorkspace.shared.open($0) } }
    @objc func openDashboardWindow() { openInWindow(page: nil) }

    private func openInWindow(page: String?) {
        withSigninLink(page: page) { url in
            if self.dashboard == nil {
                let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
                w.isReleasedWhenClosed = false
                w.title = "Feedback Graph Dashboard"
                w.center()
                let web = WKWebView(frame: w.contentView!.bounds, configuration: WKWebViewConfiguration())
                web.autoresizingMask = [.width, .height]
                w.contentView!.addSubview(web)
                self.webView = web; self.dashboard = w
            }
            self.webView?.load(URLRequest(url: url))
            self.dashboard?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // MARK: upgrade

    @objc func upgrade() {
        guard busy == nil, let dir = installDir else { return }
        busy = "Looking for updates…"
        applyState()
        showWindow()
        show("Looking for updates (git fetch)…")
        DispatchQueue.global(qos: .userInitiated).async {
            let git = { (args: [String]) in self.runner.run(["git"] + args, in: dir, timeout: 120) }
            let fetch = git(["fetch", "--tags", "--quiet"])
            let branchRun = git(["symbolic-ref", "-q", "--short", "HEAD"])
            let branch = branchRun.status == 0 ? branchRun.output.trimmingCharacters(in: .whitespacesAndNewlines) : nil
            var behind: Int?
            if branch != nil {
                let b = git(["rev-list", "--count", "HEAD..@{upstream}"])
                if b.status == 0 { behind = Int(b.output.trimmingCharacters(in: .whitespacesAndNewlines)) }
            }
            let tagRun = git(["describe", "--tags", "--exact-match", "HEAD"])
            let tag = tagRun.status == 0 ? tagRun.output.trimmingCharacters(in: .whitespacesAndNewlines) : nil
            let tags = git(["tag", "--list"]).output.split(whereSeparator: \.isNewline).map(String.init)
            let dirty = !git(["status", "--porcelain", "--untracked-files=no"]).output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            let plan = upgradePlan(branch: branch, behind: behind, tag: tag, tags: tags, dirty: dirty)
            DispatchQueue.main.async {
                self.busy = nil
                self.applyState()
                if fetch.status != 0 { self.show("git fetch did not work, so no update was looked for:\n\n" + fetch.all); return }
                switch plan {
                case let .refuse(why): self.show("Not upgrading: \(why).")
                case .upToDate: self.show("Feedback Graph is \(plan.summary). Nothing to upgrade.")
                case let .pull(branch, _):
                    self.runUpgrade(plan, step: ("git pull --ff-only", ["git", "pull", "--ff-only", "origin", branch]))
                case let .checkout(_, to):
                    self.runUpgrade(plan, step: ("git checkout \(to)", ["git", "-c", "advice.detachedHead=false", "checkout", to]))
                }
            }
        }
    }

    private func runUpgrade(_ plan: UpgradePlan, step: (String, [String])) {
        let detail = "This will:\n1. back up (./scripts/backup.sh; with Neo4j the stack stops for about a minute),\n2. \(plan.summary),\n3. run ./scripts/setup.sh --yes, which rebuilds and restarts Feedback Graph and reconnects your agents.\n\nRead CHANGELOG.md for steps a release needs. Your data stays."
        guard confirm("Upgrade Feedback Graph?", detail, "Upgrade") else { show("Upgrade cancelled."); return }
        act("Upgrading Feedback Graph…", status: true, steps: [
            ("./scripts/backup.sh", ["./scripts/backup.sh"], 3600),
            (step.0, step.1, 300),
            ("./scripts/setup.sh --yes", ["./scripts/setup.sh", "--yes"], 3600),
        ])
    }

    // MARK: install folder

    @objc func chooseFolder() {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.message = "Choose your Feedback Graph folder (it has docker-compose.yml and scripts/setup.sh)."
        panel.directoryURL = URL(fileURLWithPath: installDir ?? FileManager.default.homeDirectoryForCurrentUser.path)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard isInstallFolder(url.path, exists: FileManager.default.fileExists) else {
            show("\(url.path) is not a Feedback Graph folder: it needs docker-compose.yml and scripts/setup.sh. Choose another, or use Get Feedback Graph.")
            showWindow()
            return
        }
        defaults.set(url.path, forKey: "installFolder")
        lastLoopFetch = .distantPast
        snap = Snapshot()
        applyState()
        poll()
    }

    /// Clones Feedback Graph, then opens Terminal on its setup: setup asks its own questions there.
    @objc func cloneInstall() {
        NSApp.activate(ignoringOtherApps: true)
        var target = defaultInstall
        if FileManager.default.fileExists(atPath: target) {
            let panel = NSSavePanel()
            panel.message = "\(target) exists. Choose where to put Feedback Graph."
            panel.nameFieldStringValue = "feedback-graph"
            panel.directoryURL = URL(fileURLWithPath: (target as NSString).deletingLastPathComponent)
            guard panel.runModal() == .OK, let url = panel.url else { return }
            target = url.path
        }
        guard !FileManager.default.fileExists(atPath: target) else { show("\(target) exists already. Choose an empty place."); showWindow(); return }
        guard confirm("Get Feedback Graph?", "Clones \(repoURL) into \(target), then opens Terminal to run ./scripts/setup.sh there: answer its questions (project folders, models, starting it, connecting your agents). It needs a Docker engine (OrbStack, Docker Desktop or Colima) and Ollama.", "Clone") else { return }
        let parent = (target as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true)
        busy = "Cloning Feedback Graph…"
        applyState(); showWindow(); show("git clone \(repoURL) \(target)\n")
        DispatchQueue.global(qos: .userInitiated).async {
            let r = self.runner.run(["git", "clone", self.repoURL, target], in: parent, timeout: 900) { t in DispatchQueue.main.async { self.append(t) } }
            DispatchQueue.main.async {
                self.busy = nil
                guard r.status == 0 else { self.append("\nThe clone did not work (exit \(r.status)).\n"); self.applyState(); return }
                self.defaults.set(target, forKey: "installFolder")
                self.openSetupInTerminal(target)
                self.append("\nCloned. Terminal opens with ./scripts/setup.sh: answer its questions there. This window shows the stack once it starts.\n")
                self.applyState(); self.poll()
            }
        }
    }

    private func openSetupInTerminal(_ dir: String) {
        let script = FileManager.default.temporaryDirectory.appendingPathComponent("feedback-graph-setup.command")
        let body = "#!/bin/bash\ncd \(shellQuoted(dir)) || exit 1\nunset FEEDBACK_GRAPH_URL COMPOSE_PROJECT_NAME COMPOSE_FILE\n./scripts/setup.sh\necho\necho 'Setup finished. You can close this window.'\n"
        do {
            try body.write(to: script, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
            let terminal = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
            NSWorkspace.shared.open([script], withApplicationAt: terminal, configuration: NSWorkspace.OpenConfiguration())
        } catch { append("Could not open Terminal (\(error.localizedDescription)). Run ./scripts/setup.sh in \(dir) yourself.\n") }
    }

    // MARK: login and quit

    @objc func toggleLogin() {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled { try service.unregister() } else { try service.register() }
        } catch {
            show("Launch at login could not be changed: \(error.localizedDescription)")
            showWindow()
        }
        applyState()
    }

    @objc func quit() { NSApp.terminate(nil) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

private func + (a: NSAttributedString, b: NSAttributedString) -> NSAttributedString {
    let m = NSMutableAttributedString(attributedString: a); m.append(b); return m
}

/// The product mark (packages/ui's Mark: three linked nodes, one lit) as a menu bar template image: the rounded square
/// filled, the nodes and links cut out of it.
func markImage(size: CGFloat) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
        guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
        let s = rect.width / 20
        ctx.scaleBy(x: s, y: s)
        ctx.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: 20, height: 20), cornerWidth: 5, cornerHeight: 5, transform: nil))
        ctx.setFillColor(NSColor.black.cgColor); ctx.fillPath()
        ctx.setBlendMode(.clear)
        ctx.setLineWidth(1.6); ctx.setLineCap(.round); ctx.setLineJoin(.round)
        ctx.move(to: CGPoint(x: 6, y: 6.5)); ctx.addLine(to: CGPoint(x: 13.5, y: 9)); ctx.addLine(to: CGPoint(x: 7.5, y: 14)); ctx.strokePath()
        for (x, y, r) in [(6.0, 6.5, 2.1), (7.5, 14.0, 2.1), (13.5, 9.0, 2.8)] { ctx.fillEllipse(in: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r)) }
        return true
    }
    image.isTemplate = true
    return image
}
