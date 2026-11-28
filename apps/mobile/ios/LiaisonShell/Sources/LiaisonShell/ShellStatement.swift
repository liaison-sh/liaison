// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The signed documents the served shell reads, parsed exactly as
// packages/shared/src/app-signing/{shell-statement,revocations}.ts parse them
// (and as the desktop host does, apps/desktop/src-tauri/src/served_shell.rs):
//
//  - the SHELL STATEMENT of one web build (`shell/native/<buildId>/statement.json`
//    + `.sig` on Liaison's downloads host): canonical JSON, Ed25519 by a pinned key;
//  - the REVOCATION LIST (`apps/revocations.json` + `.sig`), whose
//    `{name: "shell:native", below: "<seq>"}` entry is the native shell floor;
//  - the FLEET FLAGS (`shell/flags.json` + `.sig`), the fleet-wide kill switch.

import CryptoKit
import Foundation

/// A pinned app-signing key (keys.json, compiled in as PinnedKeys.swift).
public struct PinnedKey {
    public let keyId: String
    public let publicKey: Curve25519.Signing.PublicKey

    public init?(keyId: String, base64: String) {
        guard let raw = Data(base64Encoded: base64), raw.count == 32,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: raw) else {
            return nil
        }
        self.keyId = keyId
        self.publicKey = key
    }

    public init(keyId: String, publicKey: Curve25519.Signing.PublicKey) {
        self.keyId = keyId
        self.publicKey = publicKey
    }

    /// Whether `sig` (the base64 `.sig` file, surrounding whitespace allowed)
    /// is this key's Ed25519 signature over exactly `bytes`.
    public func signs(_ bytes: Data, sig: String) -> Bool {
        let trimmed = sig.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let raw = Data(base64Encoded: trimmed), raw.count == 64 else { return false }
        return publicKey.isValidSignature(raw, for: bytes)
    }
}

/// One revocation entry (keys.ts `AppRevocationEntry`).
public struct RevocationEntry: Equatable {
    public let name: String
    public let below: String?
    public let versions: [String]?

    public init(name: String, below: String? = nil, versions: [String]? = nil) {
        self.name = name
        self.below = below
        self.versions = versions
    }
}

public struct ShellStatement: Equatable {
    public let keyId: String
    public let mode: String
    public let buildId: String
    public let commit: String
    public let seq: Int64
    public let liaisonVersion: String
    public let bridgeDesktop: String
    public let bridgeIos: String
    public let bridgeAndroid: String
    public let settingsSchema: Int64
    public let files: [String: String]
    public let issuedAt: String
}

enum Shape {
    static func exactKeys(_ object: [String: Any], _ keys: [String]) -> Bool {
        object.count == keys.count && keys.allSatisfy { object[$0] != nil }
    }

    static func nonEmpty(_ value: Any?) -> String? {
        guard let string = value as? String, !string.isEmpty else { return nil }
        return string
    }

    static func count(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber, let int = CanonicalJSON.safeInteger(number), int >= 0 else {
            return nil
        }
        return int
    }

    static func hex(_ value: Any?, length: Int) -> String? {
        guard let string = value as? String, string.utf8.count == length,
              string.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }) else {
            return nil
        }
        return string
    }
}

public enum ShellStatementParser {
    public static let modes = ["desktop", "native"]

    /// A path a shell file may have: relative, forward slashes, no empty, `.`
    /// or `..` segment (shell-statement.ts `isShellFilePath`).
    public static func isShellFilePath(_ path: String) -> Bool {
        if path.isEmpty || path.utf16.count > 512 || path.contains("\\") { return false }
        return path.split(separator: "/", omittingEmptySubsequences: false)
            .allSatisfy { $0 != "" && $0 != "." && $0 != ".." }
    }

    /// The shell statement these bytes hold, or nil when they are not exactly one.
    public static func parse(_ bytes: Data) -> ShellStatement? {
        guard let object = CanonicalJSON.value(bytes) as? [String: Any],
              Shape.exactKeys(object, [
                  "bridge", "buildId", "commit", "files", "issuedAt", "keyId", "kind",
                  "liaisonVersion", "mode", "seq", "settingsSchema", "v"
              ]),
              let v = object["v"] as? NSNumber, !CanonicalJSON.isBool(v), CanonicalJSON.safeInteger(v) == 1,
              object["kind"] as? String == "shell",
              let keyId = Shape.nonEmpty(object["keyId"]),
              let mode = object["mode"] as? String, modes.contains(mode),
              let liaisonVersion = Shape.nonEmpty(object["liaisonVersion"]),
              let issuedAt = Shape.nonEmpty(object["issuedAt"]),
              let buildId = Shape.hex(object["buildId"], length: 16),
              let commit = Shape.hex(object["commit"], length: 40),
              let seq = Shape.count(object["seq"]),
              let settingsSchema = Shape.count(object["settingsSchema"]),
              let bridge = object["bridge"] as? [String: Any],
              Shape.exactKeys(bridge, ["android", "desktop", "ios"]),
              let desktop = Shape.nonEmpty(bridge["desktop"]),
              let ios = Shape.nonEmpty(bridge["ios"]),
              let android = Shape.nonEmpty(bridge["android"]),
              let rawFiles = object["files"] as? [String: Any], !rawFiles.isEmpty else {
            return nil
        }
        var files: [String: String] = [:]
        for (path, hash) in rawFiles {
            guard isShellFilePath(path), let hex = Shape.hex(hash, length: 64) else { return nil }
            files[path] = hex
        }
        return ShellStatement(
            keyId: keyId, mode: mode, buildId: buildId, commit: commit, seq: seq,
            liaisonVersion: liaisonVersion, bridgeDesktop: desktop, bridgeIos: ios,
            bridgeAndroid: android, settingsSchema: settingsSchema, files: files, issuedAt: issuedAt
        )
    }
}

// MARK: Revocations

public struct RevocationList: Equatable {
    public let seq: Int64
    public let issuedAt: String
    public let entries: [RevocationEntry]
}

public enum Revocations {
    static let knownShellEntries: Set<String> = ["shell:desktop", "shell:native"]

    /// An entry, `.ignored` for a `shell:` entry this release does not know,
    /// nil when malformed (revocations.ts `parseEntry`).
    enum Parsed { case entry(RevocationEntry), ignored }

    static func parseEntry(_ raw: Any) -> Parsed? {
        guard let object = raw as? [String: Any] else { return nil }
        let name = object["name"]
        if let name = name as? String, !name.isEmpty, name.hasPrefix("shell:"),
           !knownShellEntries.contains(name) {
            return .ignored
        }
        let extra = Set(object.keys).subtracting(["name", "below", "versions"])
        guard extra.isEmpty, let named = Shape.nonEmpty(name) else { return nil }
        var below: String?
        if let rawBelow = object["below"] {
            guard let value = Shape.nonEmpty(rawBelow) else { return nil }
            below = value
        }
        var versions: [String]?
        if let rawVersions = object["versions"] {
            guard let list = rawVersions as? [Any] else { return nil }
            var out: [String] = []
            for item in list {
                guard let version = Shape.nonEmpty(item) else { return nil }
                out.append(version)
            }
            versions = out
        }
        if below == nil && versions == nil { return nil }
        if named.hasPrefix("shell:") {
            guard versions == nil, let floor = below, floor.utf8.count <= 15,
                  floor.utf8.allSatisfy({ (0x30...0x39).contains($0) }) else {
                return nil
            }
        }
        return .entry(RevocationEntry(name: named, below: below, versions: versions))
    }

    public static func parse(_ bytes: Data) -> RevocationList? {
        guard let object = CanonicalJSON.value(bytes) as? [String: Any],
              Shape.exactKeys(object, ["entries", "issuedAt", "seq", "v"]),
              let v = object["v"] as? NSNumber, !CanonicalJSON.isBool(v), CanonicalJSON.safeInteger(v) == 1,
              let issuedAt = Shape.nonEmpty(object["issuedAt"]),
              let seq = Shape.count(object["seq"]),
              let rawEntries = object["entries"] as? [Any] else {
            return nil
        }
        var entries: [RevocationEntry] = []
        for raw in rawEntries {
            switch parseEntry(raw) {
            case .none: return nil
            case .some(.ignored): continue
            case let .some(.entry(entry)): entries.append(entry)
            }
        }
        return RevocationList(seq: seq, issuedAt: issuedAt, entries: entries)
    }

    /// The list, when any pinned key signed it.
    public static func verify(_ bytes: Data, sig: String, keys: [PinnedKey]) -> RevocationList? {
        guard let list = parse(bytes), keys.contains(where: { $0.signs(bytes, sig: sig) }) else { return nil }
        return list
    }

    /// Whether `entries` hold a floor for `mode` above `seq`.
    public static func belowShellFloor(_ entries: [RevocationEntry], mode: String, seq: Int64) -> Bool {
        entries.contains { entry in
            guard entry.name == "shell:\(mode)", let below = entry.below, let floor = Int64(below) else {
                return false
            }
            return seq < floor
        }
    }
}

// MARK: Fleet flags

/// `shell/flags.json`: canonical `{v:1, seq, issuedAt, servedShell:{desktop, native}}`,
/// signed by any pinned key, `seq` never going back. Absent means on.
public struct FleetFlags: Equatable {
    public let seq: Int64
    public let desktop: Bool
    public let native: Bool

    public static func parse(_ bytes: Data) -> FleetFlags? {
        guard let object = CanonicalJSON.value(bytes) as? [String: Any],
              Shape.exactKeys(object, ["issuedAt", "seq", "servedShell", "v"]),
              let v = object["v"] as? NSNumber, !CanonicalJSON.isBool(v), CanonicalJSON.safeInteger(v) == 1,
              Shape.nonEmpty(object["issuedAt"]) != nil,
              let seq = Shape.count(object["seq"]),
              let served = object["servedShell"] as? [String: Any],
              Shape.exactKeys(served, ["desktop", "native"]),
              let desktop = served["desktop"] as? NSNumber, CanonicalJSON.isBool(desktop),
              let native = served["native"] as? NSNumber, CanonicalJSON.isBool(native) else {
            return nil
        }
        return FleetFlags(seq: seq, desktop: desktop.boolValue, native: native.boolValue)
    }

    public static func verify(_ bytes: Data, sig: String, keys: [PinnedKey]) -> FleetFlags? {
        guard let flags = parse(bytes), keys.contains(where: { $0.signs(bytes, sig: sig) }) else { return nil }
        return flags
    }
}

// MARK: Bridge range

public enum BridgeRange {
    /// Whether the integer bridge `version` satisfies `range`, in the grammar
    /// apps/web/src/lib/shell-bridge-range.ts and the desktop host share: sets
    /// joined by `||`, each a space-separated list of comparators that must all
    /// hold, a comparator `^N`, `~N`, `=N` or `N` (exactly N, N being a major
    /// version), `>=N`, `>N`, `<=N` or `<N`. Anything else allows nothing.
    public static func allows(_ range: String, version: Int) -> Bool {
        guard version >= 0 else { return false }
        var sets: [[(String, Int)]] = []
        for set in range.components(separatedBy: "||") {
            var comparators: [(String, Int)] = []
            for part in set.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" }) {
                guard let comparator = comparator(String(part)) else { return false }
                comparators.append(comparator)
            }
            if comparators.isEmpty { return false }
            sets.append(comparators)
        }
        return sets.contains { set in
            set.allSatisfy { op, n in
                switch op {
                case ">=": return version >= n
                case ">": return version > n
                case "<=": return version <= n
                case "<": return version < n
                default: return version == n
                }
            }
        }
    }

    static func comparator(_ part: String) -> (String, Int)? {
        var op = ""
        var digits = Substring(part)
        for candidate in [">=", "<=", ">", "<", "=", "^", "~"] where part.hasPrefix(candidate) {
            op = candidate
            digits = part.dropFirst(candidate.count)
            break
        }
        guard !digits.isEmpty, digits.count <= 9,
              digits.utf8.allSatisfy({ (0x30...0x39).contains($0) }),
              digits == "0" || !digits.hasPrefix("0"),
              let n = Int(digits) else {
            return nil
        }
        return (op, n)
    }
}
