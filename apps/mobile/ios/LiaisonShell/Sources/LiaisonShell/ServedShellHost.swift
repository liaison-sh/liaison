// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app's one served-shell controller: what MainViewController asks at
// launch (which folder the page loads from), what the LiaisonNative plugin
// reports to the page (`shellInfo`) and hears from it (`shellReady`,
// `shellReselect`), and the background refresh after a launch. No Capacitor
// type here, so all of it stays testable in this package.

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

    let store: ShellStore
    let http: ShellHTTP
    let bundledPublic: URL?
    let defaults: UserDefaults
    let keys: [PinnedKey]
    let floor: [RevocationEntry]
    let bridgeVersion: Int
    let log = Logger(subsystem: "sh.liaison.mobile", category: "shell")
    private let lock = NSLock()
    private var selection: Selection = .bundled(reason: .noServer)
    private var refreshing = false

    public init(store: ShellStore, http: ShellHTTP, bundledPublic: URL?, defaults: UserDefaults,
                keys: [PinnedKey] = PinnedKeys.keys, floor: [RevocationEntry] = PinnedKeys.revocationFloor,
                bridgeVersion: Int = NATIVE_BRIDGE_VERSION) {
        self.store = store
        self.http = http
        self.bundledPublic = bundledPublic
        self.defaults = defaults
        self.keys = keys
        self.floor = floor
        self.bridgeVersion = bridgeVersion
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

    public var current: Selection { lock.locked { selection } }

    /// The folder the page loads from: the selected build's, or nil for the bundled one.
    public var servedRoot: URL? {
        if case let .served(_, root) = current { return root }
        return nil
    }

    func choose() -> Selection {
        // No boot bundle in this binary means no bridge for a served page: bundled.
        guard overlay[MobilePage.bootScriptName] != nil else { return .bundled(reason: .page) }
        return store.select(address: serverAddress, keys: keys, floor: floor, bridgeVersion: bridgeVersion, overlay: overlay)
    }

    /// The choice made as the app starts (MainViewController.instanceDescriptor).
    @discardableResult
    public func launch() -> Selection {
        let chosen = choose()
        lock.locked { selection = chosen }
        log.notice("shell at launch: \(chosen.report, privacy: .public)")
        return chosen
    }

    /// Chooses again for the server now current (a server switch, a refresh
    /// the page asked for). True when the page must reload to get it.
    public func reselect() -> Bool {
        let chosen = choose()
        let changed = lock.locked { () -> Bool in
            let changed = selection.buildId != chosen.buildId
            selection = chosen
            return changed
        }
        log.notice("shell reselected: \(chosen.report, privacy: .public) changed=\(changed, privacy: .public)")
        return changed
    }

    /// The page signalled ready with `buildId` (null for a page without one).
    public func ready(buildId: String?) {
        guard let served = current.buildId, buildId == nil || buildId == served else { return }
        if store.noteReady(address: serverAddress, buildId: served) {
            log.notice("shell ready: \(served, privacy: .public)")
        }
    }

    /// The ready timer ran out on `buildId`. `.quarantined` means the page
    /// must reload on whatever is chosen now (last good or bundled).
    public func missed(buildId: String) -> ShellStore.Miss {
        let miss = store.noteMissed(address: serverAddress, buildId: buildId)
        log.error("shell \(buildId, privacy: .public) not ready in \(Int(ShellStore.readyWithin))s: \(String(describing: miss), privacy: .public)")
        if miss == .quarantined { _ = reselect() }
        return miss
    }

    /// Whether the selected build still waits for its ready signal.
    public var awaitingReady: Bool {
        guard let id = current.buildId, let address = serverAddress, let origin = ShellStore.origin(of: address) else {
            return false
        }
        return store.pointer(for: origin).pending == id
    }

    /// Fetches the current server's native build in the background; a new
    /// verified build applies at the next launch or server switch.
    public func refreshInBackground() {
        guard let address = serverAddress else { return }
        let start = lock.locked { () -> Bool in
            if refreshing { return false }
            refreshing = true
            return true
        }
        guard start else { return }
        let updater = ShellUpdater(store: store, http: http, keys: keys, floor: floor,
                                   bridgeVersion: bridgeVersion, overlay: overlay)
        Task.detached(priority: .utility) { [weak self] in
            let outcome = await updater.refresh(address: address)
            self?.log.notice("shell refresh: \(String(describing: outcome), privacy: .public)")
            self?.lock.locked { self?.refreshing = false }
        }
    }

    /// What the page is told: the host's bridge version and which shell runs.
    public var info: [String: Any] {
        var out: [String: Any] = ["bridgeVersion": bridgeVersion, "shell": current.report]
        switch current {
        case let .served(id, _):
            out["served"] = true
            out["buildId"] = id
        case let .bundled(reason):
            out["served"] = false
            out["reason"] = reason.rawValue
        }
        return out
    }
}

extension NSLock {
    /// `withLock`, which needs iOS 16; this app supports iOS 15.
    func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
