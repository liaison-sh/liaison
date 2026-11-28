// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SERVED SHELL ON DISK, AND THE CHOICE MADE AT EVERY LAUNCH (S7, S8, D9, D16, D17).
//
// Builds: `Library/NoCloud/ionic_built_snapshots/<buildId>/`, the folder
// Capacitor itself keeps web builds in (review O2), each file read-only once
// written. Only a build whose every file matched its signed sha256 is ever
// moved there, from a temporary folder beside it.
//
// State: `Application Support/LiaisonShell/`:
//   servers/<sha256 of the origin>.json   the pointer of one server: the build
//                                          staged for it (`current`), the last one
//                                          that signalled ready (`lastGood`), the
//                                          ones quarantined, the ready bookkeeping
//                                          and the server's own kill switch;
//   builds/<buildId>/                      the signed statement and signature and
//                                          the served index.html as signed;
//   flags.json, revocations.json           the last accepted fleet flags and
//                                          revocation list, with their signatures.
//
// Nothing here is trusted because it is on disk: every launch re-verifies the
// statement (signature, floor, revocations, the bridge range against THIS
// binary's NATIVE_BRIDGE_VERSION), re-hashes every file and re-derives the
// phone's page from the signed index.html, and any failure means the bundled
// shell. Capacitor's own persisted base path is never used: it is cleared on a
// new binary and has no fallback (review O2).

import CryptoKit
import Foundation

/// The bridge this host implements: what `__LIAISON_NATIVE__` offers the web
/// app, through the boot bundle compiled into this binary and its native
/// plugins. A shell statement names the range of it the build runs against
/// (`bridge.ios`, apps/web/src/lib/shell-bridge-range.ts). Raise it when a
/// release removes or changes something the web app may call; adding an
/// optional member does not need it.
public let NATIVE_BRIDGE_VERSION = 1

/// Why a served build does not run: logged, and reported to the page as the
/// bundled reason (`shell=bundled:<code>`), never shown in a dialog.
public enum Refusal: String, Error {
    case noKeys = "no_keys"
    case malformedStatement = "malformed_statement"
    case unknownKey = "unknown_key"
    case badSignature = "bad_signature"
    case wrongBuild = "wrong_build"
    case belowFloor = "below_floor"
    case revoked
    case bridge
    case noStatement = "no_statement"
    case fetch
    case tooLarge = "too_large"
    case fileHash = "file_hash"
    case missingFile = "missing_file"
    case extraFile = "extra_file"
    case overlayConflict = "overlay_conflict"
    case page
    case revocationsStale = "revocations_stale"
    case cache
    case noServer = "no_server"
    case noBuild = "no_build"
    case serverOff = "server_off"
    case fleetOff = "fleet_off"
    case quarantined
}

/// What a statement is checked against.
public struct Trust {
    public var keys: [PinnedKey]
    public var floor: [RevocationEntry]
    public var list: RevocationList?
    public var bridgeVersion: Int

    public init(keys: [PinnedKey], floor: [RevocationEntry], list: RevocationList?, bridgeVersion: Int) {
        self.keys = keys
        self.floor = floor
        self.list = list
        self.bridgeVersion = bridgeVersion
    }
}

public enum ShellVerifier {
    public static let mode = "native"

    /// The whole statement check, cheapest refusal first, in the desktop
    /// host's order; `buildId` is the one asked for (shell-statement.ts
    /// `verifyShellStatementFor`).
    public static func verify(_ bytes: Data, sig: String, trust: Trust, buildId: String) -> Result<ShellStatement, Refusal> {
        if trust.keys.isEmpty { return .failure(.noKeys) }
        guard let statement = ShellStatementParser.parse(bytes) else { return .failure(.malformedStatement) }
        guard let key = trust.keys.first(where: { $0.keyId == statement.keyId }) else { return .failure(.unknownKey) }
        guard key.signs(bytes, sig: sig) else { return .failure(.badSignature) }
        guard statement.mode == mode, statement.buildId == buildId else { return .failure(.wrongBuild) }
        if Revocations.belowShellFloor(trust.floor, mode: mode, seq: statement.seq) { return .failure(.belowFloor) }
        if let list = trust.list, Revocations.belowShellFloor(list.entries, mode: mode, seq: statement.seq) {
            return .failure(.revoked)
        }
        guard BridgeRange.allows(statement.bridgeIos, version: trust.bridgeVersion) else { return .failure(.bridge) }
        return .success(statement)
    }
}

public func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

/// One server's record.
public struct ShellPointer: Codable, Equatable {
    /// The newest verified build for this server, applied at the next launch.
    public var current: String?
    /// The last build that signalled ready on this install.
    public var lastGood: String?
    public var quarantined: [String] = []
    /// The build launched and not yet ready, with its misses so far.
    public var pending: String?
    public var misses: Int = 0
    /// Whether the miss of the launch now pending was already counted (by the ready timer).
    public var pendingCounted: Bool = false
    /// The server's own kill switch (`servedShell: false` in /api/shell/info), as last read.
    public var serverOff: Bool = false

    public init() {}
}

public enum Selection: Equatable {
    case served(buildId: String, root: URL)
    case bundled(reason: Refusal)

    public var buildId: String? {
        if case let .served(id, _) = self { return id }
        return nil
    }

    /// `served:<buildId>` or `bundled:<reason>`, the shell part of X-Liaison-Client.
    public var report: String {
        switch self {
        case let .served(id, _): return "served:\(id)"
        case let .bundled(reason): return "bundled:\(reason.rawValue)"
        }
    }
}

public final class ShellStore {
    public static let readyWithin: TimeInterval = 20
    public static let missesToQuarantine = 2
    /// A revocation list older than this means the bundled shell (A1, S5).
    public static let revocationsMaxAge: TimeInterval = 72 * 3600

    public let snapshots: URL
    public let state: URL
    let fm = FileManager.default

    public init(snapshots: URL, state: URL) {
        self.snapshots = snapshots
        self.state = state
    }

    /// The app's real folders.
    public static func standard() -> ShellStore {
        let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return ShellStore(
            snapshots: library.appendingPathComponent("NoCloud/ionic_built_snapshots", isDirectory: true),
            state: support.appendingPathComponent("LiaisonShell", isDirectory: true)
        )
    }

    // MARK: Small files

    func writeAtomically(_ data: Data, to url: URL) throws {
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: [.atomic])
    }

    /// The origin a server address names (`scheme://host[:port]`), lowercased, or nil.
    public static func origin(of address: String) -> String? {
        guard let url = URL(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host?.lowercased(), !host.isEmpty else {
            return nil
        }
        let port = url.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }

    func pointerURL(_ origin: String) -> URL {
        state.appendingPathComponent("servers/\(sha256Hex(Data(origin.utf8))).json")
    }

    public func pointer(for origin: String) -> ShellPointer {
        guard let data = try? Data(contentsOf: pointerURL(origin)),
              let pointer = try? JSONDecoder().decode(ShellPointer.self, from: data) else {
            return ShellPointer()
        }
        return pointer
    }

    public func save(_ pointer: ShellPointer, for origin: String) {
        guard let data = try? JSONEncoder().encode(pointer) else { return }
        try? writeAtomically(data, to: pointerURL(origin))
    }

    func recordDir(_ buildId: String) -> URL {
        state.appendingPathComponent("builds/\(buildId)", isDirectory: true)
    }

    /// The signed statement, its signature and the served index.html of a stored build.
    public func record(_ buildId: String) -> (statement: Data, sig: String, index: Data)? {
        guard ShellStore.isBuildId(buildId) else { return nil }
        let dir = recordDir(buildId)
        guard let statement = try? Data(contentsOf: dir.appendingPathComponent("statement.json")),
              let sigData = try? Data(contentsOf: dir.appendingPathComponent("statement.sig")),
              let sig = String(data: sigData, encoding: .utf8),
              let index = try? Data(contentsOf: dir.appendingPathComponent("index.original.html")) else {
            return nil
        }
        return (statement, sig, index)
    }

    static func isBuildId(_ id: String) -> Bool { Shape.hex(id, length: 16) != nil }

    // MARK: Fleet flags and revocations

    struct SignedDoc: Codable {
        var doc: String
        var sig: String
        var fetchedAt: Double?
    }

    func readSigned(_ name: String) -> SignedDoc? {
        guard let data = try? Data(contentsOf: state.appendingPathComponent(name)) else { return nil }
        return try? JSONDecoder().decode(SignedDoc.self, from: data)
    }

    func writeSigned(_ name: String, _ doc: SignedDoc) {
        guard let data = try? JSONEncoder().encode(doc) else { return }
        try? writeAtomically(data, to: state.appendingPathComponent(name))
    }

    /// The fleet flags last accepted, re-verified; nil when none (on).
    public func flags(keys: [PinnedKey]) -> FleetFlags? {
        guard let stored = readSigned("flags.json") else { return nil }
        return FleetFlags.verify(Data(stored.doc.utf8), sig: stored.sig, keys: keys)
    }

    /// Keeps newly read flags when they verify and do not go back in `seq`;
    /// answers the flags now in force.
    @discardableResult
    public func offerFlags(_ bytes: Data, sig: String, keys: [PinnedKey]) -> FleetFlags? {
        let stored = flags(keys: keys)
        guard let flags = FleetFlags.verify(bytes, sig: sig, keys: keys),
              let text = String(data: bytes, encoding: .utf8) else {
            return stored
        }
        if let stored = stored, flags.seq < stored.seq { return stored }
        writeSigned("flags.json", SignedDoc(doc: text, sig: sig.trimmingCharacters(in: .whitespacesAndNewlines)))
        return flags
    }

    /// The revocation list last accepted, re-verified, and when it was fetched.
    public func revocations(keys: [PinnedKey]) -> (list: RevocationList, fetchedAt: Date)? {
        guard let stored = readSigned("revocations.json"), let fetched = stored.fetchedAt,
              let list = Revocations.verify(Data(stored.doc.utf8), sig: stored.sig, keys: keys) else {
            return nil
        }
        return (list, Date(timeIntervalSince1970: fetched))
    }

    /// Keeps a newly fetched list when it verifies and its seq is not older
    /// (revocations.ts `acceptRevocationList`); a replayed older list is
    /// refused and does not refresh the age of the one held.
    @discardableResult
    public func offerRevocations(_ bytes: Data, sig: String, keys: [PinnedKey], now: Date) -> Bool {
        guard let list = Revocations.verify(bytes, sig: sig, keys: keys),
              let text = String(data: bytes, encoding: .utf8) else {
            return false
        }
        if let held = revocations(keys: keys), list.seq < held.list.seq { return false }
        writeSigned("revocations.json", SignedDoc(
            doc: text, sig: sig.trimmingCharacters(in: .whitespacesAndNewlines),
            fetchedAt: now.timeIntervalSince1970
        ))
        return true
    }

    // MARK: Build folders

    func buildDir(_ buildId: String) -> URL {
        snapshots.appendingPathComponent(buildId, isDirectory: true)
    }

    func setPermissions(_ root: URL, files: Int16, dirs: Int16) {
        try? fm.setAttributes([.posixPermissions: dirs], ofItemAtPath: root.path)
        guard let walker = fm.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey]) else { return }
        // Directories first opened (writable) before their content is touched.
        var items: [(URL, Bool)] = []
        for case let url as URL in walker {
            let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            if isDir { try? fm.setAttributes([.posixPermissions: dirs], ofItemAtPath: url.path) }
            items.append((url, isDir))
        }
        for (url, isDir) in items where !isDir {
            try? fm.setAttributes([.posixPermissions: files], ofItemAtPath: url.path)
        }
    }

    func unlock(_ root: URL) { setPermissions(root, files: 0o644, dirs: 0o755) }
    func lock(_ root: URL) { setPermissions(root, files: 0o444, dirs: 0o555) }

    func removeTree(_ url: URL) {
        guard fm.fileExists(atPath: url.path) else { return }
        unlock(url)
        try? fm.removeItem(at: url)
    }

    /// Every regular file under `root`, by its path relative to it.
    func relativeFiles(_ root: URL) -> Set<String>? {
        let base = root.standardizedFileURL.resolvingSymlinksInPath().path
        guard let walker = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey]) else {
            return nil
        }
        var out = Set<String>()
        for case let url as URL in walker {
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey])
            if values?.isDirectory == true { continue }
            let path = url.standardizedFileURL.resolvingSymlinksInPath().path
            guard values?.isRegularFile == true, path.hasPrefix(base + "/") else { return nil }
            out.insert(String(path.dropFirst(base.count + 1)))
        }
        return out
    }

    /// The files the phone's page adds to a build: the derived index.html, the
    /// scripts moved out of it, and the bundle's overlay.
    func derived(index: Data, statement: ShellStatement, overlay: [String: Data]) -> Result<[String: Data], Refusal> {
        for name in overlay.keys where statement.files[name] != nil { return .failure(.overlayConflict) }
        guard let html = String(data: index, encoding: .utf8), let page = try? MobilePage.make(html) else {
            return .failure(.page)
        }
        var out = overlay
        out["index.html"] = Data(page.html.utf8)
        for (name, body) in page.files {
            if statement.files[name] != nil || overlay[name] != nil { return .failure(.overlayConflict) }
            out[name] = Data(body.utf8)
        }
        return .success(out)
    }

    /// Writes a verified build: every listed file must be in `files` and match
    /// its signed sha256, then the phone's page is derived from the served
    /// index.html. Written in a temporary folder and moved into place only when
    /// complete, then made read-only. Answers the build's folder.
    public func install(statementBytes: Data, sig: String, statement: ShellStatement,
                        files: [String: Data], overlay: [String: Data]) -> Result<URL, Refusal> {
        guard ShellStore.isBuildId(statement.buildId) else { return .failure(.malformedStatement) }
        for (path, hash) in statement.files {
            guard let data = files[path] else { return .failure(.missingFile) }
            guard sha256Hex(data) == hash else { return .failure(.fileHash) }
        }
        guard files.count == statement.files.count else { return .failure(.extraFile) }
        guard let index = files["index.html"] else { return .failure(.missingFile) }
        let extra: [String: Data]
        switch derived(index: index, statement: statement, overlay: overlay) {
        case let .failure(refusal): return .failure(refusal)
        case let .success(value): extra = value
        }
        let token = UUID().uuidString
        let tmp = snapshots.appendingPathComponent(".tmp-\(token)", isDirectory: true)
        let recordTmp = state.appendingPathComponent("builds/.tmp-\(token)", isDirectory: true)
        do {
            var all = files
            for (name, data) in extra { all[name] = data }
            for (path, data) in all {
                let url = tmp.appendingPathComponent(path)
                try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: url)
            }
            try fm.createDirectory(at: recordTmp, withIntermediateDirectories: true)
            try statementBytes.write(to: recordTmp.appendingPathComponent("statement.json"))
            try Data(sig.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
                .write(to: recordTmp.appendingPathComponent("statement.sig"))
            try index.write(to: recordTmp.appendingPathComponent("index.original.html"))
            let record = recordDir(statement.buildId)
            removeTree(record)
            try fm.moveItem(at: recordTmp, to: record)
            let dir = buildDir(statement.buildId)
            removeTree(dir)
            try fm.moveItem(at: tmp, to: dir)
            lock(dir)
            var noBackup = URLResourceValues()
            noBackup.isExcludedFromBackup = true
            var root = snapshots
            try? root.setResourceValues(noBackup)
            return .success(dir)
        } catch {
            removeTree(tmp)
            removeTree(recordTmp)
            return .failure(.cache)
        }
    }

    /// The launch check of a stored build (D17): its statement against `trust`
    /// and the build id, every signed file re-hashed, the folder holding
    /// nothing else, and the derived files re-derived (rewritten when this
    /// binary derives them differently: a new boot bundle or policy).
    public func verifyStored(_ buildId: String, trust: Trust, overlay: [String: Data]) -> Result<URL, Refusal> {
        guard let record = record(buildId) else { return .failure(.cache) }
        let statement: ShellStatement
        switch ShellVerifier.verify(record.statement, sig: record.sig, trust: trust, buildId: buildId) {
        case let .failure(refusal): return .failure(refusal)
        case let .success(value): statement = value
        }
        guard let indexHash = statement.files["index.html"] else { return .failure(.missingFile) }
        guard sha256Hex(record.index) == indexHash else { return .failure(.fileHash) }
        let extra: [String: Data]
        switch derived(index: record.index, statement: statement, overlay: overlay) {
        case let .failure(refusal): return .failure(refusal)
        case let .success(value): extra = value
        }
        let dir = buildDir(buildId)
        guard let present = relativeFiles(dir) else { return .failure(.missingFile) }
        let expected = Set(statement.files.keys).union(extra.keys)
        let stale = present.subtracting(expected).filter(ShellStore.isDerivedName)
        if !present.subtracting(expected).subtracting(stale).isEmpty { return .failure(.extraFile) }
        for (path, hash) in statement.files where path != "index.html" {
            guard let data = try? Data(contentsOf: dir.appendingPathComponent(path)) else { return .failure(.missingFile) }
            guard sha256Hex(data) == hash else { return .failure(.fileHash) }
        }
        let drifted = extra.filter { name, data in
            (try? Data(contentsOf: dir.appendingPathComponent(name))) != data
        }
        if !drifted.isEmpty || !stale.isEmpty {
            unlock(dir)
            for name in stale { try? fm.removeItem(at: dir.appendingPathComponent(name)) }
            for (name, data) in drifted { try? data.write(to: dir.appendingPathComponent(name)) }
            lock(dir)
            for (name, data) in drifted where (try? Data(contentsOf: dir.appendingPathComponent(name))) != data {
                _ = name
                return .failure(.cache)
            }
        }
        return .success(dir)
    }

    /// A name only the phone's page derivation writes (top level).
    static func isDerivedName(_ path: String) -> Bool {
        !path.contains("/") && (MobilePage.overlayNames.contains(path) || (path.hasPrefix("liaison-inline-") && path.hasSuffix(".js")))
    }

    /// Drops every stored build no server's pointer names any more, and
    /// leftovers of an interrupted install.
    public func gc() {
        var keep = Set<String>()
        let servers = state.appendingPathComponent("servers", isDirectory: true)
        for url in (try? fm.contentsOfDirectory(at: servers, includingPropertiesForKeys: nil)) ?? [] {
            guard let data = try? Data(contentsOf: url),
                  let pointer = try? JSONDecoder().decode(ShellPointer.self, from: data) else { continue }
            for id in [pointer.current, pointer.lastGood, pointer.pending].compactMap({ $0 }) { keep.insert(id) }
        }
        for root in [snapshots, state.appendingPathComponent("builds", isDirectory: true)] {
            for url in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
                where !keep.contains(url.lastPathComponent) {
                removeTree(url)
            }
        }
    }

    // MARK: Launch selection and ready bookkeeping (D9, D16, D17, S8)

    /// The build the page loads for the server at `address`: the staged build,
    /// else the last good one, each re-verified now; anything wrong (no
    /// server, a kill switch, a stale revocation list, a quarantined or
    /// failing build) means the bundled shell. Records the chosen build as
    /// pending until it signals ready; a pending build the last run never
    /// confirmed counts as one miss.
    public func select(address: String?, keys: [PinnedKey], floor: [RevocationEntry], bridgeVersion: Int,
                       overlay: [String: Data], now: Date = Date()) -> Selection {
        guard let address = address, let origin = ShellStore.origin(of: address) else {
            return .bundled(reason: .noServer)
        }
        if let flags = flags(keys: keys), !flags.native { return .bundled(reason: .fleetOff) }
        var pointer = pointer(for: origin)
        if pointer.serverOff { return .bundled(reason: .serverOff) }
        guard let held = revocations(keys: keys) else { return .bundled(reason: .revocationsStale) }
        let age = now.timeIntervalSince(held.fetchedAt)
        if age > ShellStore.revocationsMaxAge || age < -ShellStore.revocationsMaxAge {
            return .bundled(reason: .revocationsStale)
        }
        if let pending = pointer.pending, !pointer.pendingCounted {
            pointer.misses += 1
            pointer.pendingCounted = true
            if pointer.misses >= ShellStore.missesToQuarantine { quarantine(pending, in: &pointer) }
        }
        let trust = Trust(keys: keys, floor: floor, list: held.list, bridgeVersion: bridgeVersion)
        var reason: Refusal = .noBuild
        var seen = Set<String>()
        for candidate in [pointer.current, pointer.lastGood].compactMap({ $0 }) where seen.insert(candidate).inserted {
            if pointer.quarantined.contains(candidate) {
                if reason == .noBuild { reason = .quarantined }
                continue
            }
            switch verifyStored(candidate, trust: trust, overlay: overlay) {
            case let .success(root):
                if pointer.pending != candidate {
                    pointer.pending = candidate
                    pointer.misses = 0
                }
                pointer.pendingCounted = false
                if pointer.lastGood == candidate {
                    // Already proven on this install: nothing to wait for.
                    pointer.pending = nil
                    pointer.misses = 0
                }
                save(pointer, for: origin)
                return .served(buildId: candidate, root: root)
            case let .failure(refusal):
                if reason == .noBuild || reason == .quarantined { reason = refusal }
            }
        }
        pointer.pending = nil
        pointer.misses = 0
        pointer.pendingCounted = false
        save(pointer, for: origin)
        return .bundled(reason: reason)
    }

    func quarantine(_ buildId: String, in pointer: inout ShellPointer) {
        if !pointer.quarantined.contains(buildId) { pointer.quarantined.append(buildId) }
        if pointer.lastGood == buildId { pointer.lastGood = nil }
        pointer.pending = nil
        pointer.misses = 0
        pointer.pendingCounted = false
    }

    /// The page of `buildId` signalled ready: it becomes the server's last good build.
    @discardableResult
    public func noteReady(address: String?, buildId: String) -> Bool {
        guard let address = address, let origin = ShellStore.origin(of: address) else { return false }
        var pointer = pointer(for: origin)
        guard pointer.pending == buildId || pointer.lastGood == buildId else { return false }
        pointer.lastGood = buildId
        pointer.pending = nil
        pointer.misses = 0
        pointer.pendingCounted = false
        save(pointer, for: origin)
        return true
    }

    public enum Miss: Equatable { case retry, quarantined, ignored }

    /// `buildId` did not signal ready in time: the first miss reloads it once,
    /// the second quarantines it on this install (S8).
    public func noteMissed(address: String?, buildId: String) -> Miss {
        guard let address = address, let origin = ShellStore.origin(of: address) else { return .ignored }
        var pointer = pointer(for: origin)
        guard pointer.pending == buildId else { return .ignored }
        if !pointer.pendingCounted { pointer.misses += 1 }
        pointer.pendingCounted = false
        if pointer.misses >= ShellStore.missesToQuarantine {
            quarantine(buildId, in: &pointer)
            save(pointer, for: origin)
            return .quarantined
        }
        // The reload that follows is a new attempt: its miss is not counted yet.
        save(pointer, for: origin)
        return .retry
    }
}
