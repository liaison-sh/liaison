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
    /// Foreground seconds the pending attempt has run so far: a launch that
    /// never confirmed counts as a miss at the next launch only when it ran
    /// the whole ready window in front (review P7 #3).
    public var pendingActive: Double = 0
    /// The server's own kill switch (`servedShell: false` in /api/shell/info), as last read.
    public var serverOff: Bool = false

    public init() {}

    enum CodingKeys: String, CodingKey {
        case current, lastGood, quarantined, pending, misses, pendingCounted, pendingActive, serverOff
    }

    /// Every field optional on disk, so a pointer written by an older build keeps its builds.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        current = try c.decodeIfPresent(String.self, forKey: .current)
        lastGood = try c.decodeIfPresent(String.self, forKey: .lastGood)
        quarantined = try c.decodeIfPresent([String].self, forKey: .quarantined) ?? []
        pending = try c.decodeIfPresent(String.self, forKey: .pending)
        misses = try c.decodeIfPresent(Int.self, forKey: .misses) ?? 0
        pendingCounted = try c.decodeIfPresent(Bool.self, forKey: .pendingCounted) ?? false
        pendingActive = try c.decodeIfPresent(Double.self, forKey: .pendingActive) ?? 0
        serverOff = try c.decodeIfPresent(Bool.self, forKey: .serverOff) ?? false
    }
}

/// The fleet flags as kept on disk.
public enum StoredFlags: Equatable {
    /// None ever read: on.
    case none
    case verified(FleetFlags)
    /// Kept flags no pinned key verifies any more (a key rotation dropped
    /// their key, or the file was altered): OFF until new flags verify, and a
    /// newer document must still beat their `seq`.
    case unverifiable(seq: Int64)
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
    /// The ready window, in foreground seconds (D9a): above the page's 30 s
    /// bounded session restore (apps/web auth-store.ts RESTORE_TIMEOUT_MS) plus
    /// 10 s, pinned by apps/mobile/shell-page-parity.test.ts.
    public static let readyWithin: TimeInterval = 45
    public static let missesToQuarantine = 2
    /// A revocation list older than this means the bundled shell (A1, S5).
    public static let revocationsMaxAge: TimeInterval = 72 * 3600

    public let snapshots: URL
    public let state: URL
    let fm = FileManager.default
    /// Every write of the store (pointers, flags, lists, builds, gc) runs under
    /// this one lock: the launch, the page's calls and the background refresh
    /// never interleave a read-modify-write (review P7 #10, P6 #4).
    let mutex = NSRecursiveLock()

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
        mutex.locked { try? writeAtomically(data, to: pointerURL(origin)) }
    }

    /// One locked read-modify-write of a server's pointer, saved when `body`
    /// changed it. Answers what `body` answered.
    @discardableResult
    public func updatePointer<T>(_ address: String, _ body: (inout ShellPointer) -> T) -> T {
        mutex.locked {
            let origin = ShellStore.origin(of: address) ?? address
            let before = pointer(for: origin)
            var pointer = before
            let out = body(&pointer)
            if pointer != before { save(pointer, for: origin) }
            return out
        }
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

    /// The fleet flags last accepted, re-verified against the keys pinned now.
    public func storedFlags(keys: [PinnedKey]) -> StoredFlags {
        guard let data = try? Data(contentsOf: state.appendingPathComponent("flags.json")) else { return .none }
        guard let stored = try? JSONDecoder().decode(SignedDoc.self, from: data) else { return .unverifiable(seq: 0) }
        if let flags = FleetFlags.verify(Data(stored.doc.utf8), sig: stored.sig, keys: keys) { return .verified(flags) }
        return .unverifiable(seq: FleetFlags.parse(Data(stored.doc.utf8))?.seq ?? 0)
    }

    /// The fleet flags last accepted, when they still verify.
    public func flags(keys: [PinnedKey]) -> FleetFlags? {
        if case let .verified(flags) = storedFlags(keys: keys) { return flags }
        return nil
    }

    /// Whether the fleet lets this host serve a native shell: on when no
    /// flags were ever read, OFF when the kept flags no longer verify.
    public func fleetEnabled(keys: [PinnedKey]) -> Bool {
        switch storedFlags(keys: keys) {
        case .none: return true
        case let .verified(flags): return flags.native
        case .unverifiable: return false
        }
    }

    /// Keeps newly read flags when they verify and do not go back in `seq`
    /// (not even behind kept flags that no longer verify); answers the
    /// flags now in force.
    @discardableResult
    public func offerFlags(_ bytes: Data, sig: String, keys: [PinnedKey]) -> FleetFlags? {
        mutex.locked {
            let stored = storedFlags(keys: keys)
            var held: FleetFlags?
            var heldSeq: Int64?
            switch stored {
            case .none: break
            case let .verified(flags): held = flags; heldSeq = flags.seq
            case let .unverifiable(seq): heldSeq = seq
            }
            guard let flags = FleetFlags.verify(bytes, sig: sig, keys: keys),
                  let text = String(data: bytes, encoding: .utf8) else {
                return held
            }
            if let heldSeq = heldSeq, flags.seq < heldSeq { return held }
            writeSigned("flags.json", SignedDoc(doc: text, sig: sig.trimmingCharacters(in: .whitespacesAndNewlines)))
            return flags
        }
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
        mutex.locked {
            guard let list = Revocations.verify(bytes, sig: sig, keys: keys),
                  let text = String(data: bytes, encoding: .utf8) else {
                return false
            }
            // The kept list's seq, verified or not: never go back behind it.
            if let kept = readSigned("revocations.json"),
               let keptSeq = Revocations.parse(Data(kept.doc.utf8))?.seq, list.seq < keptSeq {
                return false
            }
            writeSigned("revocations.json", SignedDoc(
                doc: text, sig: sig.trimmingCharacters(in: .whitespacesAndNewlines),
                fetchedAt: now.timeIntervalSince1970
            ))
            return true
        }
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
    /// How a file system that ignores case and Unicode form (the simulator's
    /// volume, APFS normalization) sees a path.
    static func folded(_ path: String) -> String {
        path.precomposedStringWithCanonicalMapping.folding(options: [.caseInsensitive], locale: nil)
            .precomposedStringWithCanonicalMapping
    }

    /// Refuses a statement two of whose paths are one file once case and
    /// Unicode form are ignored, or that names a file this binary adds (every
    /// overlay name, whether this bundle has it or not, and the derived
    /// script names) (review P7 #7).
    public func checkNames(_ statement: ShellStatement, overlay: [String: Data]) -> Result<Void, Refusal> {
        var seen = Set<String>()
        for path in statement.files.keys where !seen.insert(ShellStore.folded(path)).inserted {
            return .failure(.overlayConflict)
        }
        let reserved = Set((MobilePage.overlayNames + Array(overlay.keys)).map(ShellStore.folded))
        for path in statement.files.keys {
            let name = ShellStore.folded(path)
            if reserved.contains(name) || (!name.contains("/") && name.hasPrefix("liaison-inline-")) {
                return .failure(.overlayConflict)
            }
        }
        return .success(())
    }

    func derived(index: Data, statement: ShellStatement, overlay: [String: Data]) -> Result<[String: Data], Refusal> {
        if case let .failure(refusal) = checkNames(statement, overlay: overlay) { return .failure(refusal) }
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
        mutex.locked {
            installLocked(statementBytes: statementBytes, sig: sig, statement: statement, files: files, overlay: overlay)
        }
    }

    func installLocked(statementBytes: Data, sig: String, statement: ShellStatement,
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
            try swapIn(recordTmp, at: record, token: token)
            let dir = buildDir(statement.buildId)
            lock(tmp)
            try swapIn(tmp, at: dir, token: token)
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

    /// Moves `fresh` to `target`, a folder already there moved aside first and
    /// removed after, so `target` is missing only between two renames.
    func swapIn(_ fresh: URL, at target: URL, token: String) throws {
        if fm.fileExists(atPath: target.path) {
            let aside = target.deletingLastPathComponent().appendingPathComponent(".old-\(token)-\(target.lastPathComponent)")
            try fm.moveItem(at: target, to: aside)
            do {
                try fm.moveItem(at: fresh, to: target)
            } catch {
                try? fm.moveItem(at: aside, to: target)
                throw error
            }
            removeTree(aside)
        } else {
            try fm.moveItem(at: fresh, to: target)
        }
    }

    /// The launch check of a stored build (D17): its statement against `trust`
    /// and the build id, every signed file re-hashed, the folder holding
    /// nothing else, and the derived files re-derived (rewritten when this
    /// binary derives them differently: a new boot bundle or policy).
    public func verifyStored(_ buildId: String, trust: Trust, overlay: [String: Data]) -> Result<URL, Refusal> {
        mutex.locked { verifyStoredLocked(buildId, trust: trust, overlay: overlay) }
    }

    func verifyStoredLocked(_ buildId: String, trust: Trust, overlay: [String: Data]) -> Result<URL, Refusal> {
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
        mutex.locked { gcLocked() }
    }

    func gcLocked() {
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

    /// The trust a statement is checked against now, or why there is none
    /// (no server, a kill switch, no fresh revocation list).
    public func trust(address: String?, keys: [PinnedKey], floor: [RevocationEntry], bridgeVersion: Int,
                      now: Date = Date()) -> Result<(origin: String, trust: Trust), Refusal> {
        guard let address = address, let origin = ShellStore.origin(of: address) else { return .failure(.noServer) }
        if !fleetEnabled(keys: keys) { return .failure(.fleetOff) }
        if pointer(for: origin).serverOff { return .failure(.serverOff) }
        guard let held = revocations(keys: keys) else { return .failure(.revocationsStale) }
        let age = now.timeIntervalSince(held.fetchedAt)
        if age > ShellStore.revocationsMaxAge || age < -ShellStore.revocationsMaxAge {
            return .failure(.revocationsStale)
        }
        return .success((origin, Trust(keys: keys, floor: floor, list: held.list, bridgeVersion: bridgeVersion)))
    }

    /// The build the page would load for the server at `address`: the staged
    /// build, else the last good one, each re-verified now; anything wrong (no
    /// server, a kill switch, a stale revocation list, a quarantined or
    /// failing build) means the bundled shell. Records nothing about ready.
    public func choose(address: String?, keys: [PinnedKey], floor: [RevocationEntry], bridgeVersion: Int,
                       overlay: [String: Data], now: Date = Date()) -> Selection {
        mutex.locked {
            let origin: String
            let trust: Trust
            switch self.trust(address: address, keys: keys, floor: floor, bridgeVersion: bridgeVersion, now: now) {
            case let .failure(refusal): return .bundled(reason: refusal)
            case let .success(value): (origin, trust) = (value.origin, value.trust)
            }
            let pointer = pointer(for: origin)
            var reason: Refusal = .noBuild
            var seen = Set<String>()
            for candidate in [pointer.current, pointer.lastGood].compactMap({ $0 }) where seen.insert(candidate).inserted {
                if pointer.quarantined.contains(candidate) {
                    if reason == .noBuild { reason = .quarantined }
                    continue
                }
                switch verifyStoredLocked(candidate, trust: trust, overlay: overlay) {
                case let .success(root): return .served(buildId: candidate, root: root)
                case let .failure(refusal):
                    if reason == .noBuild || reason == .quarantined { reason = refusal }
                }
            }
            return .bundled(reason: reason)
        }
    }

    /// Why the RUNNING build `buildId` of `address` must stop at once (D16a:
    /// the fleet or the server switched it off, or its statement no longer
    /// verifies: revoked, below the floor, its key gone), or nil. A stale
    /// list or a newer build alone waits for the next document load.
    public func mustLeave(address: String, buildId: String, keys: [PinnedKey], floor: [RevocationEntry],
                          bridgeVersion: Int) -> Refusal? {
        if !fleetEnabled(keys: keys) { return .fleetOff }
        guard let origin = ShellStore.origin(of: address) else { return .noServer }
        if pointer(for: origin).serverOff { return .serverOff }
        guard let record = record(buildId) else { return nil }
        let trust = Trust(keys: keys, floor: floor, list: revocations(keys: keys)?.list, bridgeVersion: bridgeVersion)
        switch ShellVerifier.verify(record.statement, sig: record.sig, trust: trust, buildId: buildId) {
        case .success: return nil
        case let .failure(refusal):
            switch refusal {
            case .revoked, .belowFloor, .unknownKey, .badSignature, .noKeys, .malformedStatement, .wrongBuild:
                return refusal
            default: return nil
            }
        }
    }

    /// The choice made as the app starts: the attempt the last run left
    /// unconfirmed counts as one miss only when it ran the whole ready window
    /// in the foreground (review P7 #3), then `choose`, and the chosen build
    /// becomes the attempt now running.
    public func select(address: String?, keys: [PinnedKey], floor: [RevocationEntry], bridgeVersion: Int,
                       overlay: [String: Data], now: Date = Date()) -> Selection {
        mutex.locked {
            if let address = address, ShellStore.origin(of: address) != nil {
                updatePointer(address) { pointer in
                    if let pending = pointer.pending, !pointer.pendingCounted,
                       pointer.pendingActive >= ShellStore.readyWithin {
                        pointer.misses += 1
                        pointer.pendingCounted = true
                        if pointer.misses >= ShellStore.missesToQuarantine { quarantine(pending, in: &pointer) }
                    }
                    pointer.pendingActive = 0
                }
            }
            let chosen = choose(address: address, keys: keys, floor: floor, bridgeVersion: bridgeVersion,
                                overlay: overlay, now: now)
            if let address = address { beginAttempt(address: address, selection: chosen) }
            return chosen
        }
    }

    /// The page is about to load `selection` for `address` (a launch, a
    /// document load): a served build not yet proven on this install waits
    /// for its ready signal from now.
    public func beginAttempt(address: String, selection: Selection) {
        guard ShellStore.origin(of: address) != nil else { return }
        updatePointer(address) { pointer in
            guard let id = selection.buildId, pointer.lastGood != id else {
                pointer.pending = nil
                pointer.misses = 0
                pointer.pendingCounted = false
                pointer.pendingActive = 0
                return
            }
            if pointer.pending != id {
                pointer.pending = id
                pointer.misses = 0
            }
            pointer.pendingCounted = false
            pointer.pendingActive = 0
        }
    }

    /// The foreground time the attempt of `buildId` has run so far.
    public func noteProgress(address: String, buildId: String, activeSeconds: Double) {
        updatePointer(address) { pointer in
            if pointer.pending == buildId { pointer.pendingActive = activeSeconds }
        }
    }

    func quarantine(_ buildId: String, in pointer: inout ShellPointer) {
        if !pointer.quarantined.contains(buildId) { pointer.quarantined.append(buildId) }
        if pointer.lastGood == buildId { pointer.lastGood = nil }
        pointer.pending = nil
        pointer.misses = 0
        pointer.pendingCounted = false
        pointer.pendingActive = 0
    }

    /// The page of `buildId` signalled ready: it becomes the server's last good build.
    @discardableResult
    public func noteReady(address: String?, buildId: String) -> Bool {
        guard let address = address, ShellStore.origin(of: address) != nil else { return false }
        return updatePointer(address) { pointer -> Bool in
            guard pointer.pending == buildId || pointer.lastGood == buildId else { return false }
            pointer.lastGood = buildId
            pointer.pending = nil
            pointer.misses = 0
            pointer.pendingCounted = false
            pointer.pendingActive = 0
            return true
        }
    }

    public enum Miss: Equatable { case retry, quarantined, ignored }

    /// `buildId` did not signal ready within the window: the first miss
    /// reloads it once, the second quarantines it on this install (S8).
    public func noteMissed(address: String?, buildId: String) -> Miss {
        guard let address = address, ShellStore.origin(of: address) != nil else { return .ignored }
        return updatePointer(address) { pointer -> Miss in
            guard pointer.pending == buildId else { return .ignored }
            if !pointer.pendingCounted { pointer.misses += 1 }
            pointer.pendingCounted = false
            pointer.pendingActive = 0
            if pointer.misses >= ShellStore.missesToQuarantine {
                quarantine(buildId, in: &pointer)
                return .quarantined
            }
            // The reload that follows is a new attempt: its miss is not counted yet.
            return .retry
        }
    }
}

extension NSLocking {
    /// `withLock`, which needs iOS 16; this app supports iOS 15.
    func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
