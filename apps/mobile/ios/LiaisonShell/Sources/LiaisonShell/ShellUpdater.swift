// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FETCHING A SERVER'S NATIVE BUILD (S7).
//
// At launch (bounded, before the page loads), when the app comes back to the
// foreground and every 15 min while it is in front, the app asks the
// connected server which native build it ships (`GET /api/shell/info`, which
// also carries the operator's kill switch) and refreshes the fleet flags and
// the revocation list from Liaison's downloads host (`refreshLists`). When the
// build is new it fetches the build's signed statement from there and checks
// it, then fetches every listed file from the server under `/native/` and
// stores the build only when every sha256 matched. Bodies are streamed and cut
// off as soon as they pass their cap (one file, the whole build); at most
// `concurrency` files are in flight and the whole build has a deadline. The
// build is STAGED: the page loads it at the next document load, never under a
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

/// The bytes a whole build may still take, shared by its concurrent fetches:
/// each takes from it as its body arrives (review P6 #8, P7 #2).
public final class ByteBudget {
    private let lock = NSLock()
    private var remaining: Int

    public init(_ bytes: Int) { remaining = bytes }

    public var left: Int { lock.locked { remaining } }

    /// Takes `bytes`, or nothing and false when fewer are left.
    public func take(_ bytes: Int) -> Bool {
        lock.locked {
            guard bytes <= remaining else { return false }
            remaining -= bytes
            return true
        }
    }
}

/// One GET, no redirect followed, at most `limit` bytes (and what `budget`
/// still allows), cut off as soon as either is passed.
public protocol ShellHTTP {
    func get(_ url: URL, limit: Int, budget: ByteBudget?) async -> Result<Data, FetchError>
}

public extension ShellHTTP {
    func get(_ url: URL, limit: Int) async -> Result<Data, FetchError> {
        await get(url, limit: limit, budget: nil)
    }
}

public final class URLSessionShellHTTP: NSObject, ShellHTTP, URLSessionDataDelegate {
    public static let timeout: TimeInterval = 15

    /// One request in flight: its body so far and how it ends.
    final class Transfer {
        let limit: Int
        let budget: ByteBudget?
        var data = Data()
        var status = 0
        var failure: FetchError?
        let done: (Result<Data, FetchError>) -> Void

        init(limit: Int, budget: ByteBudget?, done: @escaping (Result<Data, FetchError>) -> Void) {
            self.limit = limit
            self.budget = budget
            self.done = done
        }
    }

    private let lock = NSLock()
    private var transfers: [Int: Transfer] = [:]
    private let protocolClasses: [AnyClass]?

    /// `protocolClasses`: a test's URLProtocol, in place of the network.
    public init(protocolClasses: [AnyClass]? = nil) {
        self.protocolClasses = protocolClasses
        super.init()
    }

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = URLSessionShellHTTP.timeout
        config.timeoutIntervalForResource = URLSessionShellHTTP.timeout
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil
        config.urlCache = nil
        if let classes = protocolClasses { config.protocolClasses = classes }
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    public func get(_ url: URL, limit: Int, budget: ByteBudget?) async -> Result<Data, FetchError> {
        var request = URLRequest(url: url)
        request.timeoutInterval = URLSessionShellHTTP.timeout
        let task = session.dataTask(with: request)
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Result<Data, FetchError>, Never>) in
                let transfer = Transfer(limit: limit, budget: budget) { continuation.resume(returning: $0) }
                lock.locked { transfers[task.taskIdentifier] = transfer }
                task.resume()
                if Task.isCancelled { task.cancel() }
            }
        } onCancel: {
            task.cancel()
        }
    }

    func transfer(_ task: URLSessionTask) -> Transfer? { lock.locked { transfers[task.taskIdentifier] } }

    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        transfer(task)?.failure = .redirect
        completionHandler(nil)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                           completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let transfer = transfer(dataTask), let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }
        transfer.status = http.statusCode
        if (300..<400).contains(http.statusCode) {
            transfer.failure = .redirect
        } else if http.statusCode == 404 {
            transfer.failure = .notFound
        } else if http.statusCode != 200 {
            transfer.failure = .status(http.statusCode)
        } else if response.expectedContentLength > Int64(transfer.limit)
                    || (http.value(forHTTPHeaderField: "Content-Length").flatMap { Int64($0) } ?? 0) > Int64(transfer.limit) {
            transfer.failure = .tooLarge
        }
        completionHandler(transfer.failure == nil ? .allow : .cancel)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let transfer = transfer(dataTask), transfer.failure == nil else { return }
        if transfer.data.count + data.count > transfer.limit || !(transfer.budget?.take(data.count) ?? true) {
            transfer.failure = .tooLarge
            dataTask.cancel()
            return
        }
        transfer.data.append(data)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let transfer = lock.locked({ transfers.removeValue(forKey: task.taskIdentifier) }) else { return }
        if let failure = transfer.failure {
            transfer.done(.failure(failure))
        } else if error != nil {
            transfer.done(.failure(.transport))
        } else if transfer.status == 200 {
            transfer.done(.success(transfer.data))
        } else {
            transfer.done(.failure(.transport))
        }
    }
}

public enum UpdateOutcome: Equatable {
    /// A new build was verified and stored; it runs from the next document load.
    case staged(String)
    /// The server ships the build already staged.
    case unchanged(String)
    /// The operator asked apps to keep their bundled shell.
    case serverOff
    /// The server ships no native build.
    case noBuild
    case refused(Refusal)
}

/// What the server said about its native build (`/api/shell/info`).
public struct ServerShellInfo: Equatable {
    public let nativeBuildId: String?
    public let servedShell: Bool
}

public final class ShellUpdater {
    public static let downloads = URL(string: "https://downloads.liaison.sh")!
    /// The whole build, every file together.
    public static let maxBuildBytes = 30 * 1024 * 1024
    /// One file of it (the largest chunk of the web build is a few MB).
    public static let maxFileBytes = 16 * 1024 * 1024
    static let maxSmallBytes = 2 * 1024 * 1024
    static let concurrency = 6
    /// The whole build fetch, all files (review P6 #8).
    public static let fetchDeadline: TimeInterval = 120

    let store: ShellStore
    let http: ShellHTTP
    let keys: [PinnedKey]
    let floor: [RevocationEntry]
    let bridgeVersion: Int
    let overlay: [String: Data]
    let downloads: URL
    let deadline: TimeInterval

    public init(store: ShellStore, http: ShellHTTP, keys: [PinnedKey], floor: [RevocationEntry],
                bridgeVersion: Int, overlay: [String: Data], downloads: URL = ShellUpdater.downloads,
                deadline: TimeInterval = ShellUpdater.fetchDeadline) {
        self.store = store
        self.http = http
        self.keys = keys
        self.floor = floor
        self.bridgeVersion = bridgeVersion
        self.overlay = overlay
        self.downloads = downloads
        self.deadline = deadline
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

    static func parseInfo(_ data: Data) -> ServerShellInfo? {
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
        return ServerShellInfo(nativeBuildId: buildId, servedShell: served.boolValue)
    }

    func signedPair(_ url: URL) async -> (Data, String)? {
        guard case let .success(doc) = await http.get(url, limit: ShellUpdater.maxSmallBytes),
              case let .success(sigData) = await http.get(URL(string: url.absoluteString + ".sig")!, limit: 4096),
              let sig = String(data: sigData, encoding: .utf8) else {
            return nil
        }
        return (doc, sig)
    }

    /// The server's switch and build id, kept on its pointer, then the fleet
    /// flags and the revocation list, kept when they verify and do not go
    /// back. The server's answer, or nil when it did not answer.
    @discardableResult
    public func refreshLists(address: String, now: Date = Date()) async -> ServerShellInfo? {
        guard let origin = ShellStore.origin(of: address) else { return nil }
        var info: ServerShellInfo?
        if case let .success(data) = await http.get(URL(string: origin + "/api/shell/info")!, limit: 65536),
           let parsed = ShellUpdater.parseInfo(data) {
            info = parsed
            store.updatePointer(origin) { pointer in pointer.serverOff = !parsed.servedShell }
        }
        if let (doc, sig) = await signedPair(downloads.appendingPathComponent("shell/flags.json")) {
            store.offerFlags(doc, sig: sig, keys: keys)
        }
        if let (doc, sig) = await signedPair(downloads.appendingPathComponent("apps/revocations.json")) {
            store.offerRevocations(doc, sig: sig, keys: keys, now: now)
        }
        return info
    }

    public func refresh(address: String, now: Date = Date()) async -> UpdateOutcome {
        guard let origin = ShellStore.origin(of: address) else { return .refused(.noServer) }
        guard let info = await refreshLists(address: address, now: now) else { return .refused(.fetch) }
        if !info.servedShell { return .serverOff }
        guard let buildId = info.nativeBuildId else { return .noBuild }
        let pointer = store.pointer(for: origin)
        if pointer.quarantined.contains(buildId) { return .refused(.quarantined) }
        let list = store.revocations(keys: keys)?.list
        let trust = Trust(keys: keys, floor: floor, list: list, bridgeVersion: bridgeVersion)
        // A copy already stored (another server's, an earlier download) that
        // still verifies is pointed to as it is: never rewritten under a page
        // that may be running from it (review P7 #10).
        if case .success = store.verifyStored(buildId, trust: trust, overlay: overlay) {
            let moved = store.updatePointer(origin) { pointer -> Bool in
                if pointer.quarantined.contains(buildId) || pointer.current == buildId { return false }
                pointer.current = buildId
                return true
            }
            return moved ? .staged(buildId) : .unchanged(buildId)
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
        if case let .failure(refusal) = store.checkNames(statement, overlay: overlay) { return .refused(refusal) }

        let files: [String: Data]
        switch await fetchFiles(origin: origin, statement: statement) {
        case let .failure(refusal): return .refused(refusal)
        case let .success(value): files = value
        }
        switch store.install(statementBytes: statementBytes, sig: sig, statement: statement, files: files, overlay: overlay) {
        case let .failure(refusal): return .refused(refusal)
        case .success: break
        }
        // Only `current` moves: a quarantine or a ready recorded while the
        // files were fetched stays (review P6 #4).
        let staged = store.updatePointer(origin) { pointer -> Bool in
            if pointer.quarantined.contains(buildId) { return false }
            pointer.current = buildId
            return true
        }
        store.gc()
        return staged ? .staged(buildId) : .refused(.quarantined)
    }

    /// Every listed file, `concurrency` at a time, each capped at
    /// maxFileBytes and all of them together at maxBuildBytes (streamed, cut
    /// off at the cap), within `deadline`; the first failure stops the rest.
    func fetchFiles(origin: String, statement: ShellStatement) async -> Result<[String: Data], Refusal> {
        var urls: [(String, URL)] = []
        for path in statement.files.keys.sorted() {
            guard let url = ShellUpdater.fileURL(server: origin, path: path) else { return .failure(.fetch) }
            urls.append((path, url))
        }
        let http = self.http
        let deadline = self.deadline
        let budget = ByteBudget(ShellUpdater.maxBuildBytes)
        let hashes = statement.files
        return await withTaskGroup(of: Result<[String: Data], Refusal>?.self) { outer in
            outer.addTask {
                await ShellUpdater.fetchAll(urls, hashes: hashes, http: http, budget: budget)
            }
            outer.addTask {
                try? await Task.sleep(nanoseconds: UInt64(deadline * 1_000_000_000))
                return Task.isCancelled ? nil : .failure(.fetch)
            }
            var result: Result<[String: Data], Refusal> = .failure(.fetch)
            for await item in outer {
                guard let item = item else { continue }
                result = item
                break
            }
            outer.cancelAll()
            return result
        }
    }

    static func fetchAll(_ urls: [(String, URL)], hashes: [String: String], http: ShellHTTP,
                         budget: ByteBudget) async -> Result<[String: Data], Refusal> {
        await withTaskGroup(of: (String, Result<Data, FetchError>).self) { group in
            var next = 0
            func launch() {
                guard next < urls.count else { return }
                let (path, url) = urls[next]
                next += 1
                group.addTask { (path, await http.get(url, limit: ShellUpdater.maxFileBytes, budget: budget)) }
            }
            for _ in 0..<min(ShellUpdater.concurrency, urls.count) { launch() }
            var files: [String: Data] = [:]
            while let (path, result) = await group.next() {
                let failure: Refusal?
                switch result {
                case let .success(data):
                    failure = sha256Hex(data) == hashes[path] ? nil : .fileHash
                    if failure == nil { files[path] = data }
                case .failure(.tooLarge): failure = .tooLarge
                case .failure(.notFound): failure = .missingFile
                case .failure: failure = .fetch
                }
                if let failure = failure {
                    group.cancelAll()
                    return .failure(failure)
                }
                launch()
            }
            if Task.isCancelled { return .failure(.fetch) }
            return .success(files)
        }
    }
}
