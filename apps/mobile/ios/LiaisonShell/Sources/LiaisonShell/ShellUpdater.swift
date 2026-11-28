// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FETCHING A SERVER'S NATIVE BUILD (S7).
//
// After a launch (and after a server switch) the app asks the connected
// server which native build it ships (`GET /api/shell/info`, which also
// carries the operator's kill switch), refreshes the fleet flags and the
// revocation list from Liaison's downloads host, fetches the build's signed
// statement from there and checks it, then fetches every listed file from the
// server under `/native/` (no redirect, 15 s per request, 30 MB for the build)
// and stores the build only when every sha256 matched. The build is STAGED:
// the page loads it at the next launch or server switch, never under a
// running page. Every failure leaves the pointer as it was, so the app keeps
// what it had, down to the bundled shell.

import Foundation

public enum FetchError: Error, Equatable {
    case notFound
    case redirect
    case tooLarge
    case status(Int)
    case transport
}

/// One GET, no redirect followed, at most `limit` bytes.
public protocol ShellHTTP {
    func get(_ url: URL, limit: Int) async -> Result<Data, FetchError>
}

public final class URLSessionShellHTTP: NSObject, ShellHTTP, URLSessionTaskDelegate {
    public static let timeout: TimeInterval = 15
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = URLSessionShellHTTP.timeout
        config.timeoutIntervalForResource = URLSessionShellHTTP.timeout
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    public func get(_ url: URL, limit: Int) async -> Result<Data, FetchError> {
        var request = URLRequest(url: url)
        request.timeoutInterval = URLSessionShellHTTP.timeout
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .failure(.transport) }
            if (300..<400).contains(http.statusCode) { return .failure(.redirect) }
            if http.statusCode == 404 { return .failure(.notFound) }
            guard http.statusCode == 200 else { return .failure(.status(http.statusCode)) }
            guard data.count <= limit else { return .failure(.tooLarge) }
            return .success(data)
        } catch {
            return .failure(.transport)
        }
    }
}

public enum UpdateOutcome: Equatable {
    /// A new build was verified and stored; it runs from the next launch.
    case staged(String)
    /// The server ships the build already staged.
    case unchanged(String)
    /// The operator asked apps to keep their bundled shell.
    case serverOff
    /// The server ships no native build.
    case noBuild
    case refused(Refusal)
}

public final class ShellUpdater {
    public static let downloads = URL(string: "https://downloads.liaison.sh")!
    public static let maxBuildBytes = 30 * 1024 * 1024
    static let maxSmallBytes = 2 * 1024 * 1024
    static let concurrency = 6

    let store: ShellStore
    let http: ShellHTTP
    let keys: [PinnedKey]
    let floor: [RevocationEntry]
    let bridgeVersion: Int
    let overlay: [String: Data]
    let downloads: URL

    public init(store: ShellStore, http: ShellHTTP, keys: [PinnedKey], floor: [RevocationEntry],
                bridgeVersion: Int, overlay: [String: Data], downloads: URL = ShellUpdater.downloads) {
        self.store = store
        self.http = http
        self.keys = keys
        self.floor = floor
        self.bridgeVersion = bridgeVersion
        self.overlay = overlay
        self.downloads = downloads
    }

    /// `server` + `/native/<path>`, each path segment percent-encoded.
    public static func fileURL(server: String, path: String) -> URL? {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        let segments = path.split(separator: "/", omittingEmptySubsequences: false).map {
            String($0).addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        }
        return URL(string: server + "/native/" + segments.joined(separator: "/"))
    }

    struct ShellInfo {
        let nativeBuildId: String?
        let servedShell: Bool
    }

    static func parseInfo(_ data: Data) -> ShellInfo? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let info = object["data"] as? [String: Any],
              let served = info["servedShell"] as? NSNumber, CanonicalJSON.isBool(served) else {
            return nil
        }
        var buildId: String?
        if let native = info["native"] as? [String: Any] {
            guard let id = Shape.hex(native["buildId"], length: 16) else { return nil }
            buildId = id
        }
        return ShellInfo(nativeBuildId: buildId, servedShell: served.boolValue)
    }

    func signedPair(_ url: URL) async -> (Data, String)? {
        guard case let .success(doc) = await http.get(url, limit: ShellUpdater.maxSmallBytes),
              case let .success(sigData) = await http.get(URL(string: url.absoluteString + ".sig")!, limit: 4096),
              let sig = String(data: sigData, encoding: .utf8) else {
            return nil
        }
        return (doc, sig)
    }

    public func refresh(address: String, now: Date = Date()) async -> UpdateOutcome {
        guard let origin = ShellStore.origin(of: address) else { return .refused(.noServer) }
        guard case let .success(infoData) = await http.get(URL(string: origin + "/api/shell/info")!, limit: 65536),
              let info = ShellUpdater.parseInfo(infoData) else {
            return .refused(.fetch)
        }
        var pointer = store.pointer(for: origin)
        if pointer.serverOff == info.servedShell {
            pointer.serverOff = !info.servedShell
            store.save(pointer, for: origin)
        }
        if !info.servedShell { return .serverOff }

        if let (doc, sig) = await signedPair(downloads.appendingPathComponent("shell/flags.json")) {
            store.offerFlags(doc, sig: sig, keys: keys)
        }
        if let (doc, sig) = await signedPair(downloads.appendingPathComponent("apps/revocations.json")) {
            store.offerRevocations(doc, sig: sig, keys: keys, now: now)
        }

        guard let buildId = info.nativeBuildId else { return .noBuild }
        if pointer.quarantined.contains(buildId) { return .refused(.quarantined) }
        let list = store.revocations(keys: keys)?.list
        let trust = Trust(keys: keys, floor: floor, list: list, bridgeVersion: bridgeVersion)
        if pointer.current == buildId, case .success = store.verifyStored(buildId, trust: trust, overlay: overlay) {
            return .unchanged(buildId)
        }

        let base = downloads.appendingPathComponent("shell/native/\(buildId)/statement.json")
        guard case let .success(statementBytes) = await http.get(base, limit: ShellUpdater.maxSmallBytes) else {
            return .refused(.noStatement)
        }
        guard case let .success(sigData) = await http.get(URL(string: base.absoluteString.replacingOccurrences(
            of: "statement.json", with: "statement.sig"))!, limit: 4096),
              let sig = String(data: sigData, encoding: .utf8) else {
            return .refused(.noStatement)
        }
        let statement: ShellStatement
        switch ShellVerifier.verify(statementBytes, sig: sig, trust: trust, buildId: buildId) {
        case let .failure(refusal): return .refused(refusal)
        case let .success(value): statement = value
        }

        let files: [String: Data]
        switch await fetchFiles(origin: origin, statement: statement) {
        case let .failure(refusal): return .refused(refusal)
        case let .success(value): files = value
        }
        switch store.install(statementBytes: statementBytes, sig: sig, statement: statement, files: files, overlay: overlay) {
        case let .failure(refusal): return .refused(refusal)
        case .success: break
        }
        pointer = store.pointer(for: origin)
        pointer.current = buildId
        store.save(pointer, for: origin)
        store.gc()
        return .staged(buildId)
    }

    func fetchFiles(origin: String, statement: ShellStatement) async -> Result<[String: Data], Refusal> {
        let paths = statement.files.keys.sorted()
        var urls: [(String, URL)] = []
        for path in paths {
            guard let url = ShellUpdater.fileURL(server: origin, path: path) else { return .failure(.fetch) }
            urls.append((path, url))
        }
        let http = self.http
        var files: [String: Data] = [:]
        var total = 0
        var index = 0
        while index < urls.count {
            let batch = urls[index..<min(index + ShellUpdater.concurrency, urls.count)]
            index += batch.count
            let results = await withTaskGroup(of: (String, Result<Data, FetchError>).self) { group in
                for (path, url) in batch {
                    group.addTask { (path, await http.get(url, limit: ShellUpdater.maxBuildBytes)) }
                }
                var out: [(String, Result<Data, FetchError>)] = []
                for await item in group { out.append(item) }
                return out
            }
            for (path, result) in results {
                switch result {
                case let .success(data):
                    total += data.count
                    if total > ShellUpdater.maxBuildBytes { return .failure(.tooLarge) }
                    if sha256Hex(data) != statement.files[path] { return .failure(.fileHash) }
                    files[path] = data
                case .failure(.tooLarge): return .failure(.tooLarge)
                case .failure(.notFound): return .failure(.missingFile)
                case .failure: return .failure(.fetch)
                }
            }
        }
        return .success(files)
    }
}
