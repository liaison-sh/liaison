// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app's one served-shell controller: what MainViewController asks at
// launch (which folder the page loads from), what the LiaisonNative plugin
// reports to the page (`shellInfo`) and hears from it (`shellReady`,
// `shellReselect`), and the refreshes while the app runs. No Capacitor type
// here, so all of it stays testable in this package.
//
// Two selections: `current`, the build the page runs now, and `staged`, the
// one the NEXT main-frame document load gets (a reselect, a refresh). The
// router moves only on such a load (`promote`), never under a running page
// (review P7 #4). The one exception is a SECURITY LEAVE (D16a): a refresh that
// finds the running build revoked, below the floor, unkeyed or switched off
// promotes at once and the page is reloaded, whatever it is doing.

import Foundation
import os

public final class ServedShellHost {
    public static let shared = ServedShellHost(
        store: .standard(), http: URLSessionShellHTTP(), bundledPublic: Bundle.main.resourceURL?
            .appendingPathComponent("public", isDirectory: true),
        defaults: .standard
    )

    /// Where Capacitor Preferences keep the page's server address
    /// (apps/mobile/src/onboarding/server-address.ts `SERVER_ADDRESS_KEY`, group `CapacitorStorage`).
    public static let serverAddressDefaultsKey = "CapacitorStorage.liaison.serverAddress"
    /// How long the launch waits for the lists and the server's switch before
    /// choosing from the kept copies (review P7 #1a).
    public static let startDeadline: TimeInterval = 3
    /// Lists re-read this often while the app is in front.
    public static let refreshEvery: TimeInterval = 15 * 60
    /// Coming back to the foreground re-reads them when the last read is older.
    public static let foregroundRefreshAfter: TimeInterval = 60

    let store: ShellStore
    let http: ShellHTTP
    let bundledPublic: URL?
    let defaults: UserDefaults
    let keys: [PinnedKey]
    let floor: [RevocationEntry]
    let bridgeVersion: Int
    let downloads: URL
    let log = Logger(subsystem: "sh.liaison.mobile", category: "shell")
    private let lock = NSLock()
    private var selection: Selection = .bundled(reason: .noServer)
    /// The server the running selection was made for (ready and misses go to it).
    private var selectionOrigin: String?
    private var staged: (selection: Selection, origin: String?)?
    private var refreshing = false
    private var lastRefresh: Date?

    public init(store: ShellStore, http: ShellHTTP, bundledPublic: URL?, defaults: UserDefaults,
                keys: [PinnedKey] = PinnedKeys.keys, floor: [RevocationEntry] = PinnedKeys.revocationFloor,
                bridgeVersion: Int = NATIVE_BRIDGE_VERSION, downloads: URL = ShellUpdater.downloads) {
        self.store = store
        self.http = http
        self.bundledPublic = bundledPublic
        self.defaults = defaults
        self.keys = keys
        self.floor = floor
        self.bridgeVersion = bridgeVersion
        self.downloads = downloads
    }

    /// The overlay a served build takes from this binary (MobilePage.overlayNames).
    lazy var overlay: [String: Data] = {
        var out: [String: Data] = [:]
        guard let root = bundledPublic else { return out }
        for name in MobilePage.overlayNames {
            if let data = try? Data(contentsOf: root.appendingPathComponent(name)) { out[name] = data }
        }
        return out
    }()

    public var serverAddress: String? { defaults.string(forKey: ServedShellHost.serverAddressDefaultsKey) }

    var serverOrigin: String? { serverAddress.flatMap(ShellStore.origin(of:)) }

    /// The build the page runs now.
    public var current: Selection { lock.locked { selection } }

    /// The folder the page loads from: the running build's, or nil for the bundled one.
    public var servedRoot: URL? {
        if case let .served(_, root) = current { return root }
        return nil
    }

    /// What the next document load gets, when it differs from `current`.
    public var stagedSelection: Selection? { lock.locked { staged?.selection } }

    func updater() -> ShellUpdater {
        ShellUpdater(store: store, http: http, keys: keys, floor: floor, bridgeVersion: bridgeVersion,
                     overlay: overlay, downloads: downloads)
    }

    func choose() -> Selection {
        // No boot bundle in this binary means no bridge for a served page: bundled.
        guard overlay[MobilePage.bootScriptName] != nil else { return .bundled(reason: .page) }
        return store.choose(address: serverAddress, keys: keys, floor: floor, bridgeVersion: bridgeVersion,
                            overlay: overlay)
    }

    /// Runs `work` and waits for it at most `deadline` seconds (the launch is
    /// on the main thread and the network work never needs it).
    static func wait(_ deadline: TimeInterval, _ work: @escaping () async -> Void) {
        let done = DispatchSemaphore(value: 0)
        let task = Task.detached(priority: .userInitiated) {
            await work()
            done.signal()
        }
        if done.wait(timeout: .now() + deadline) == .timedOut {
            // Left to finish in the background: what it keeps applies from the next refresh.
            _ = task
        }
    }

    /// The choice made as the app starts (MainViewController.instanceDescriptor):
    /// the lists and the server's switch read first within `deadline`
    /// (offline: the kept copies), then the stored build re-verified.
    @discardableResult
    public func launch(deadline: TimeInterval = ServedShellHost.startDeadline) -> Selection {
        if let address = serverAddress, deadline > 0 {
            let updater = updater()
            ServedShellHost.wait(deadline) { await updater.refreshLists(address: address) }
            lock.locked { lastRefresh = Date() }
        }
        let chosen: Selection
        if overlay[MobilePage.bootScriptName] == nil {
            chosen = .bundled(reason: .page)
        } else {
            chosen = store.select(address: serverAddress, keys: keys, floor: floor, bridgeVersion: bridgeVersion,
                                  overlay: overlay)
        }
        let origin = serverOrigin
        lock.locked {
            selection = chosen
            selectionOrigin = origin
            staged = nil
        }
        log.notice("shell at launch: \(chosen.report, privacy: .public)")
        return chosen
    }

    /// Chooses again for the server now current (a server switch, the page
    /// asking whether a reload would change the build). Only records the
    /// choice for the next document load; true when that load will run
    /// another build.
    public func reselect() -> Bool {
        let chosen = choose()
        let origin = serverOrigin
        let changed = lock.locked { () -> Bool in
            let changed = chosen != selection || origin != selectionOrigin
            staged = changed ? (chosen, origin) : nil
            return changed
        }
        log.notice("shell reselected: \(chosen.report, privacy: .public) changed=\(changed, privacy: .public)")
        return changed
    }

    /// A main-frame document load of the app is starting: the staged choice
    /// becomes the running one (nil when nothing was staged) and its ready
    /// attempt starts.
    @discardableResult
    public func promote() -> Selection? {
        guard let next = lock.locked({ () -> (selection: Selection, origin: String?)? in
            guard let next = staged else { return nil }
            selection = next.selection
            selectionOrigin = next.origin
            staged = nil
            return next
        }) else { return nil }
        if let origin = next.origin { store.beginAttempt(address: origin, selection: next.selection) }
        log.notice("shell for this load: \(next.selection.report, privacy: .public)")
        return next.selection
    }

    /// A new document of the running build (a reload): a new ready attempt.
    public func restartAttempt() {
        let (chosen, origin) = lock.locked { (selection, selectionOrigin) }
        if let origin = origin { store.beginAttempt(address: origin, selection: chosen) }
    }

    /// The page signalled ready with `buildId`; only the running build's own
    /// id confirms it, for the server it was chosen for (review P7 #9).
    public func ready(buildId: String?) {
        let (chosen, origin) = lock.locked { (selection, selectionOrigin) }
        guard let served = chosen.buildId, let buildId = buildId, buildId == served, let origin = origin else { return }
        if store.noteReady(address: origin, buildId: served) {
            log.notice("shell ready: \(served, privacy: .public)")
        }
    }

    /// Foreground seconds the running attempt has used so far (kept for the next launch).
    public func progress(buildId: String, activeSeconds: Double) {
        guard let origin = lock.locked({ selectionOrigin }) else { return }
        store.noteProgress(address: origin, buildId: buildId, activeSeconds: activeSeconds)
    }

    /// The ready window ran out (in foreground time) on `buildId`, armed for
    /// `origin`. `.quarantined` means the page must reload on whatever is
    /// chosen now (last good or bundled), already promoted.
    public func missed(buildId: String, origin: String) -> ShellStore.Miss {
        let miss = store.noteMissed(address: origin, buildId: buildId)
        log.error("shell \(buildId, privacy: .public) not ready in \(Int(ShellStore.readyWithin))s: \(String(describing: miss), privacy: .public)")
        if miss == .quarantined {
            _ = reselect()
            promote()
        }
        return miss
    }

    /// Whether the running build still waits for its ready signal, and for which server.
    public var awaitingReady: (buildId: String, origin: String)? {
        let (chosen, origin) = lock.locked { (selection, selectionOrigin) }
        guard let id = chosen.buildId, let origin = origin else { return nil }
        return store.pointer(for: origin).pending == id ? (id, origin) : nil
    }

    // MARK: Refreshes while the app runs (review P7 #1)

    public enum AfterRefresh: Equatable {
        /// Nothing new for the running page.
        case none
        /// Another build is staged for the next document load (S6: no reload forced).
        case staged(Selection)
        /// The running build must not run any more: already promoted, reload now (D16a).
        case leave(Selection, reason: Refusal)
    }

    /// Whether a refresh is due: never read, or older than `after`.
    public func refreshDue(now: Date = Date(), after: TimeInterval) -> Bool {
        guard let last = lock.locked({ lastRefresh }) else { return true }
        return now.timeIntervalSince(last) >= after || now < last
    }

    /// Reads the lists and the server's build again, fetches a new build, then
    /// decides what the running page does (`after`). Nil when a refresh is
    /// already running.
    public func refresh(now: Date = Date()) async -> AfterRefresh? {
        guard let address = serverAddress else { return nil }
        let start = lock.locked { () -> Bool in
            if refreshing { return false }
            refreshing = true
            lastRefresh = now
            return true
        }
        guard start else { return nil }
        defer { lock.locked { refreshing = false } }
        let outcome = await updater().refresh(address: address, now: now)
        log.notice("shell refresh: \(String(describing: outcome), privacy: .public)")
        return after()
    }

    /// The decision after the lists changed: a running build that must leave
    /// is replaced at once; otherwise a different choice is staged.
    public func after() -> AfterRefresh {
        let (running, origin) = lock.locked { (selection, selectionOrigin) }
        if let id = running.buildId, let origin = origin,
           let reason = store.mustLeave(address: origin, buildId: id, keys: keys, floor: floor,
                                        bridgeVersion: bridgeVersion) {
            _ = reselect()
            let next = promote() ?? .bundled(reason: reason)
            log.error("shell \(id, privacy: .public) must leave (\(reason.rawValue, privacy: .public)): reloading on \(next.report, privacy: .public)")
            return .leave(next, reason: reason)
        }
        if reselect(), let next = stagedSelection { return .staged(next) }
        return .none
    }

    /// What the page is told: the host's bridge version and which shell runs.
    public var info: [String: Any] {
        let running = current
        var out: [String: Any] = ["bridgeVersion": bridgeVersion, "shell": running.report]
        switch running {
        case let .served(id, _):
            out["served"] = true
            out["buildId"] = id
        case let .bundled(reason):
            out["served"] = false
            out["reason"] = reason.rawValue
        }
        if let next = stagedSelection { out["staged"] = next.report }
        return out
    }
}

/// The page's base folder, which only the served-shell host moves (review
/// P7 #5): Capacitor's own `WebView.setServerBasePath`, callable from any page
/// script, sets the router's base path too, and is ignored here. Paths are
/// resolved inside the folder or refused (review P7 #8).
public final class ShellBasePath {
    private let lock = NSLock()
    private var path: String

    public init(_ path: String = "") { self.path = path }

    public var current: String { lock.locked { path } }

    /// The host's own move (a launch, a document load, a security leave).
    public func move(to newPath: String) { lock.locked { path = newPath } }

    /// A set from outside the host (Capacitor's asset handler at load, the
    /// WebView plugin): kept only when it names the folder already chosen.
    @discardableResult
    public func offer(_ newPath: String) -> Bool {
        lock.locked {
            URL(fileURLWithPath: newPath).standardizedFileURL.path == URL(fileURLWithPath: path).standardizedFileURL.path
        }
    }

    /// The file a page request for `path` (percent-decoded, as Capacitor
    /// passes it) reads: a path with no extension is the SPA's index.html;
    /// anything that resolves outside the folder is refused (a path that does
    /// not exist).
    public func route(for requestPath: String) -> String {
        let base = URL(fileURLWithPath: current, isDirectory: true).standardizedFileURL.path
        if URL(fileURLWithPath: requestPath).pathExtension.isEmpty {
            return base + "/index.html"
        }
        let resolved = URL(fileURLWithPath: base + "/" + requestPath).standardizedFileURL.path
        guard resolved.hasPrefix(base + "/") else { return base + "/.refused-outside-build" }
        return resolved
    }
}

/// The ready window counted in foreground time only (review P7 #3): paused
/// while the app is in the background, resumed when it comes back.
public struct ReadyClock: Equatable {
    public let window: TimeInterval
    private var used: TimeInterval = 0
    private var since: Date?

    public init(window: TimeInterval, now: Date, running: Bool) {
        self.window = window
        since = running ? now : nil
    }

    public mutating func pause(now: Date) {
        if let since = since { used += max(0, now.timeIntervalSince(since)) }
        since = nil
    }

    public mutating func resume(now: Date) {
        if since == nil { since = now }
    }

    public func elapsed(now: Date) -> TimeInterval {
        used + (since.map { max(0, now.timeIntervalSince($0)) } ?? 0)
    }

    public func remaining(now: Date) -> TimeInterval { max(0, window - elapsed(now: now)) }

    public func expired(now: Date) -> Bool { elapsed(now: now) >= window }
}

public enum ShellNavigation {
    /// Whether `next` only changes the fragment of `now` (same document).
    public static func sameDocument(_ now: URL, _ next: URL) -> Bool {
        func base(_ url: URL) -> String? {
            guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
            parts.fragment = nil
            return parts.string
        }
        guard let a = base(now), let b = base(next) else { return false }
        return a == b
    }
}
