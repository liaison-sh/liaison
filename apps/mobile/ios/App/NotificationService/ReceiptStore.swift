import Foundation
import Security

/// Delivery receipt storage shared by the app and the Notification Service
/// Extension (compiled into both targets). It only moves bytes: every decision
/// about outcomes, retries and expiry lives in apps/mobile/src/receipts.ts,
/// except the one the extension has to make alone (post now or queue).
///
/// - Credentials: one generic password item per server origin in the keychain
///   access group `$(AppIdentifierPrefix)sh.liaison.mobile.shared`, which both
///   targets' entitlements claim. Accessible after first unlock, because the
///   extension runs for a push that arrives on a locked phone.
/// - Queue: one JSON file per receipt in the App Group container
///   (`group.sh.liaison.mobile`/receipt-queue/). A file per receipt, so the
///   extension appending and the app flushing never rewrite each other.
enum ReceiptStore {
    static let appGroup = "group.sh.liaison.mobile"
    /// The keychain group's suffix; Info.plist `LiaisonKeychainGroup` carries
    /// the full name with the team prefix the build was signed with.
    static let keychainGroupSuffix = "sh.liaison.mobile.shared"
    static let service = "sh.liaison.mobile.receipts"
    static let receiptsPath = "/api/notifications/receipts"
    static let queueDirectoryName = "receipt-queue"

    struct Credential {
        let credential: String
        let deviceId: String
    }

    enum PostResult {
        case sent
        /// Offline, timed out, or a server error: worth trying again later.
        case retry
        /// Refused for good (revoked credential, no such delivery).
        case drop
        case noCredential
    }

    // MARK: Keychain

    static func accessGroup() -> String? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "LiaisonKeychainGroup") as? String,
              group.hasSuffix(keychainGroupSuffix), !group.contains("$(") else {
            return nil
        }
        return group
    }

    private static func baseQuery(origin: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: origin,
        ]
        if let group = accessGroup() {
            query[kSecAttrAccessGroup as String] = group
        }
        return query
    }

    static func credential(for origin: String) -> Credential? {
        var query = baseQuery(origin: origin)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let credential = object["credential"], !credential.isEmpty,
              let deviceId = object["deviceId"] else {
            return nil
        }
        return Credential(credential: credential, deviceId: deviceId)
    }

    @discardableResult
    static func setCredential(_ value: Credential, for origin: String) -> OSStatus {
        guard let data = try? JSONSerialization.data(withJSONObject: [
            "credential": value.credential,
            "deviceId": value.deviceId,
        ]) else {
            return errSecParam
        }
        SecItemDelete(baseQuery(origin: origin) as CFDictionary)
        var query = baseQuery(origin: origin)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(query as CFDictionary, nil)
    }

    @discardableResult
    static func deleteCredential(for origin: String) -> OSStatus {
        SecItemDelete(baseQuery(origin: origin) as CFDictionary)
    }

    // MARK: App Group queue

    static func queueDirectory() -> URL? {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
            return nil
        }
        let dir = container.appendingPathComponent(queueDirectoryName, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Writes one receipt (already JSON) as its own file. Atomic, so a flush
    /// never reads half a file.
    @discardableResult
    static func enqueue(json: Data) -> Bool {
        guard let dir = queueDirectory() else { return false }
        let url = dir.appendingPathComponent("\(UUID().uuidString).json")
        return (try? json.write(to: url, options: .atomic)) != nil
    }

    /// The receipt shape apps/mobile/src/receipts.ts `QueuedReceipt` reads.
    @discardableResult
    static func enqueue(origin: String, notificationId: String, outcome: String, appState: String?) -> Bool {
        var receipt: [String: Any] = [
            "origin": origin,
            "notificationId": notificationId,
            "outcome": outcome,
            "queuedAt": Int64(Date().timeIntervalSince1970 * 1000),
        ]
        if let appState = appState { receipt["appState"] = appState }
        guard let data = try? JSONSerialization.data(withJSONObject: receipt) else { return false }
        return enqueue(json: data)
    }

    static func listQueue() -> [(key: String, json: String)] {
        guard let dir = queueDirectory(),
              let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else {
            return []
        }
        return names.filter { $0.hasSuffix(".json") }.sorted().compactMap { name in
            guard let data = FileManager.default.contents(atPath: dir.appendingPathComponent(name).path),
                  let json = String(data: data, encoding: .utf8) else {
                return nil
            }
            return (key: name, json: json)
        }
    }

    static func removeQueued(keys: [String]) {
        guard let dir = queueDirectory() else { return }
        for key in keys where !key.contains("/") && key.hasSuffix(".json") {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(key))
        }
    }

    // MARK: Posting (the extension's half)

    /// `scheme://host[:port]`, as the server's `new URL(BASE_URL).origin` and
    /// the app's `serverAddressOrigin` spell it. Nil for anything not http(s).
    static func origin(of server: String?) -> String? {
        guard let server = server, let components = URLComponents(string: server),
              let scheme = components.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = components.host?.lowercased(), !host.isEmpty else {
            return nil
        }
        var origin = "\(scheme)://\(host)"
        if let port = components.port, !(scheme == "https" && port == 443), !(scheme == "http" && port == 80) {
            origin += ":\(port)"
        }
        return origin
    }

    static func post(origin: String, notificationId: String, outcome: String, appState: String?,
                     completion: @escaping (PostResult) -> Void) {
        guard let stored = credential(for: origin) else {
            completion(.noCredential)
            return
        }
        guard let url = URL(string: origin + receiptsPath) else {
            completion(.drop)
            return
        }
        var body: [String: String] = [
            "notificationId": notificationId,
            "outcome": outcome,
            "deviceId": stored.deviceId,
        ]
        if let appState = appState { body["appState"] = appState }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(stored.credential)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 15
        let session = URLSession(configuration: config)
        session.dataTask(with: request) { _, response, error in
            guard error == nil, let http = response as? HTTPURLResponse else {
                completion(.retry)
                return
            }
            switch http.statusCode {
            case 200..<300: completion(.sent)
            case 408, 429, 500...: completion(.retry)
            default: completion(.drop)
            }
        }.resume()
        session.finishTasksAndInvalidate()
    }
}
