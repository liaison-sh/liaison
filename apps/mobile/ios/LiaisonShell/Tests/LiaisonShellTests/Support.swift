// SPDX-License-Identifier: FSL-1.1-ALv2

import CryptoKit
import Foundation
@testable import LiaisonShell

/// A throwaway signing key and the documents it signs.
struct Signer {
    let keyId: String
    let key = Curve25519.Signing.PrivateKey()

    init(_ keyId: String = "test-key") { self.keyId = keyId }

    var pinned: PinnedKey { PinnedKey(keyId: keyId, publicKey: key.publicKey) }

    func sign(_ bytes: Data) -> String {
        // swiftlint:disable:next force_try
        try! key.signature(for: bytes).base64EncodedString()
    }

    func canonical(_ value: [String: Any]) -> Data { Data(CanonicalJSON.encode(value)!.utf8) }
}

let indexHTML = """
<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="liaison-web-build" content="0123456789abcdef"><script>window.a=1</script><script type="module" src="/assets/app.js"></script></head><body></body></html>
"""

/// A web build: its files and a statement over them.
struct Build {
    var buildId = "0123456789abcdef"
    var files: [String: Data] = [
        "index.html": Data(indexHTML.utf8),
        "assets/app.js": Data("console.log('app')".utf8),
        "build-id.txt": Data("0123456789abcdef".utf8),
    ]
    var mode = "native"
    var ios = "^1"
    var seq: Int64 = 1_764_320_000
    var hashOverride: [String: String] = [:]

    func statementObject(keyId: String) -> [String: Any] {
        var hashes: [String: String] = [:]
        for (path, data) in files { hashes[path] = hashOverride[path] ?? sha256Hex(data) }
        return [
            "v": 1, "kind": "shell", "keyId": keyId, "mode": mode, "buildId": buildId,
            "commit": String(repeating: "c", count: 40), "seq": NSNumber(value: seq),
            "liaisonVersion": "nightly-20261128",
            "bridge": ["desktop": "^1", "ios": ios, "android": "^1"],
            "settingsSchema": 3, "files": hashes, "issuedAt": "2026-11-28T12:00:00.000Z",
        ]
    }

    func signed(by signer: Signer) -> (bytes: Data, sig: String) {
        let bytes = signer.canonical(statementObject(keyId: signer.keyId))
        return (bytes, signer.sign(bytes))
    }
}

let overlay: [String: Data] = [MobilePage.bootScriptName: Data("/* boot */".utf8)]

/// A temporary store, removed by the test's tearDown.
func tempStore() -> (ShellStore, URL) {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("liaison-shell-\(UUID().uuidString)")
    return (ShellStore(snapshots: root.appendingPathComponent("snapshots"), state: root.appendingPathComponent("state")), root)
}

func removeTemp(_ root: URL, _ store: ShellStore) {
    store.removeTree(root)
}

func revocationList(_ signer: Signer, seq: Int64 = 1, entries: [[String: Any]] = []) -> (Data, String) {
    let bytes = signer.canonical(["v": 1, "seq": NSNumber(value: seq), "issuedAt": "2026-11-28T00:00:00Z", "entries": entries])
    return (bytes, signer.sign(bytes))
}

func flagsDoc(_ signer: Signer, seq: Int64, native: Bool) -> (Data, String) {
    let bytes = signer.canonical([
        "v": 1, "seq": NSNumber(value: seq), "issuedAt": "2026-11-28T00:00:00Z",
        "servedShell": ["desktop": true, "native": native],
    ])
    return (bytes, signer.sign(bytes))
}

/// An in-memory server and downloads host.
final class FakeHTTP: ShellHTTP {
    var responses: [String: Result<Data, FetchError>] = [:]
    var requested: [String] = []
    private let lock = NSLock()

    func get(_ url: URL, limit: Int) async -> Result<Data, FetchError> {
        let response = lock.locked { () -> Result<Data, FetchError> in
            requested.append(url.absoluteString)
            return responses[url.absoluteString] ?? .failure(.notFound)
        }
        if case let .success(data) = response, data.count > limit { return .failure(.tooLarge) }
        return response
    }

    func set(_ url: String, _ data: Data) { responses[url] = .success(data) }
    func set(_ url: String, _ text: String) { responses[url] = .success(Data(text.utf8)) }
}

let server = "https://work.example.org"
let downloads = "https://downloads.liaison.sh"

/// A server shipping `build` under /native/, its statement on the downloads host.
func serve(_ http: FakeHTTP, _ build: Build, signer: Signer, servedShell: Bool = true) {
    http.set("\(server)/api/shell/info", """
    {"data":{"desktop":{"buildId":"fedcba9876543210"},"native":{"buildId":"\(build.buildId)"},"liaisonVersion":"nightly-20261128","settingsSchema":3,"servedShell":\(servedShell)}}
    """)
    let (bytes, sig) = build.signed(by: signer)
    http.set("\(downloads)/shell/native/\(build.buildId)/statement.json", bytes)
    http.set("\(downloads)/shell/native/\(build.buildId)/statement.sig", sig)
    for (path, data) in build.files { http.set("\(server)/native/\(path)", data) }
    let (list, listSig) = revocationList(signer)
    http.set("\(downloads)/apps/revocations.json", list)
    http.set("\(downloads)/apps/revocations.json.sig", listSig)
}
