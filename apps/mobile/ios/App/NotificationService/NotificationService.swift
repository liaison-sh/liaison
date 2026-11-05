import UserNotifications
import os

// Notification Service Extension: iOS hands it every alert push that carries
// `mutable-content: 1`, before the alert is shown, whether the app is in the
// foreground, in the background or not running at all. That is what lets a
// delivery receipt reach the server from a killed app (spec-push A3, A8).
//
// It posts the `received` receipt for the payload's `notificationId` to the
// payload's `server` origin, signed with the receipt-only credential the app
// stored for that origin (ReceiptStore, shared keychain group). A post that
// cannot land (offline, timeout, server error) is queued in the App Group and
// the app flushes it on its next launch or foreground (src/receipts.ts). The
// content is handed on unchanged once the post has settled, or when the
// system's time runs out, whichever comes first.
//
// In DEBUG builds it also tags the title with " [nse]" and appends one line
// to a marker file in the App Group container, which the simulator spike and
// the matrix runner read back with
// `simctl get_app_container <device> sh.liaison.mobile <group>`.
final class NotificationService: UNNotificationServiceExtension {
    static let appGroup = "group.sh.liaison.mobile"
    private static let log = Logger(subsystem: "sh.liaison.mobile.nse", category: "nse")

    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?
    /// The receipt still in flight, queued if the system stops us first.
    private var pendingReceipt: (origin: String, notificationId: String)?
    private let lock = NSLock()

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        bestAttempt = content
        let notificationId = request.content.userInfo["notificationId"] as? String ?? "-"
        Self.log.notice("nse didReceive id=\(request.identifier, privacy: .public) notificationId=\(notificationId, privacy: .public)")
        #if DEBUG
        content.title = content.title + " [nse]"
        Self.appendMarker("\(ISO8601DateFormatter().string(from: Date())) id=\(request.identifier) notificationId=\(notificationId)")
        #endif

        guard let id = request.content.userInfo["notificationId"] as? String, !id.isEmpty,
              let origin = ReceiptStore.origin(of: request.content.userInfo["server"] as? String) else {
            Self.log.notice("nse receipt skipped: no notificationId or server origin")
            deliver()
            return
        }
        lock.lock()
        pendingReceipt = (origin, id)
        lock.unlock()
        ReceiptStore.post(origin: origin, notificationId: id, outcome: "received", appState: "nse") { [weak self] result in
            guard let self = self else { return }
            self.lock.lock()
            let stillPending = self.pendingReceipt != nil
            self.pendingReceipt = nil
            self.lock.unlock()
            switch result {
            case .sent:
                Self.log.notice("nse receipt received sent notificationId=\(id, privacy: .public)")
            case .retry:
                if stillPending {
                    let queued = ReceiptStore.enqueue(origin: origin, notificationId: id, outcome: "received", appState: "nse")
                    Self.log.notice("nse receipt queued=\(queued) notificationId=\(id, privacy: .public)")
                }
            case .drop:
                Self.log.notice("nse receipt refused notificationId=\(id, privacy: .public)")
            case .noCredential:
                Self.log.notice("nse receipt skipped: no credential for this server")
            }
            self.deliver()
        }
    }

    /// Hands the content to the system, once.
    private func deliver() {
        lock.lock()
        let handler = contentHandler
        contentHandler = nil
        let content = bestAttempt
        lock.unlock()
        if let handler = handler, let content = content {
            handler(content)
        }
    }

    // The system gives the extension about 30 seconds; whatever we have by
    // then is shown as is, so a slow network never swallows the alert, and a
    // receipt still in flight is queued for the app to send.
    override func serviceExtensionTimeWillExpire() {
        lock.lock()
        let pending = pendingReceipt
        pendingReceipt = nil
        lock.unlock()
        if let pending = pending {
            ReceiptStore.enqueue(origin: pending.origin, notificationId: pending.notificationId,
                                 outcome: "received", appState: "nse")
        }
        deliver()
    }

    #if DEBUG
    private static func appendMarker(_ line: String) {
        guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
            log.error("nse marker: no app group container")
            return
        }
        let url = dir.appendingPathComponent("nse-marker.log")
        let data = Data((line + "\n").utf8)
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }
    #endif
}
