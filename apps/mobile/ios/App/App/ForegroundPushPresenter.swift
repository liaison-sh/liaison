import Capacitor
import UserNotifications

/// How a push that lands while the app is open is presented.
///
/// iOS asks the notification centre delegate (Capacitor's NotificationRouter)
/// for presentation options, and the router asks its push handler. Capacitor's
/// own handler answers from the static `presentationOptions` config, which can
/// say "always" or "never" but not "unless that conversation is on screen".
/// So this handler sits in front of it (LiaisonNativePlugin.load()):
///
///   - The INNER handler still runs first, so the web app still receives
///     `pushNotificationReceived` (the badge) exactly as before.
///   - The answer is ours: the system banner for anything that is not the
///     conversation or session on screen, nothing at all for the one the user
///     is reading.
///   - The decision is reported to the web app (`pushPresentation`), which
///     posts it as the delivery receipt. The receipt says what iOS was told
///     to do, not what the web app guessed (TestFlight build 17: `shown` was
///     posted for an in-app strip and no banner, 2026-10-12).
///
/// The rule is the same one the web app applies on Android
/// (apps/mobile/src/receipts.ts `presentationOutcome`).
final class ForegroundPushPresenter: NSObject, NotificationHandlerProtocol {
    /// Capacitor's push handler. Strong: the router only holds handlers weakly.
    private let inner: NotificationHandlerProtocol?
    private let report: (JSObject) -> Void

    /// The conversation or node session the web app has on screen, as it last
    /// said, or nil. Written and read on the main thread only.
    static var threadOnScreen: String?

    init(inner: NotificationHandlerProtocol?, report: @escaping (JSObject) -> Void) {
        self.inner = inner
        self.report = report
    }

    /// The decision, as data: no options at all means nothing is shown.
    static func decide(userInfo: [AnyHashable: Any], threadOnScreen: String?)
        -> (options: UNNotificationPresentationOptions, outcome: String, reason: String?) {
        // The slot holds a thread id or a node session id (P4); both are
        // UUIDs, so a push matches by whichever of the two it carries.
        if let onScreen = threadOnScreen, !onScreen.isEmpty {
            for key in ["threadId", "sessionId"] {
                if let id = userInfo[key] as? String, id == onScreen {
                    return ([], "suppressed", "on_screen")
                }
            }
        }
        return ([.banner, .list, .sound], "shown", nil)
    }

    func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        // Its answer (the config's presentationOptions) is not used: this one is.
        _ = inner?.willPresent(notification: notification)
        let userInfo = notification.request.content.userInfo
        let decision = ForegroundPushPresenter.decide(
            userInfo: userInfo,
            threadOnScreen: ForegroundPushPresenter.threadOnScreen
        )
        var event: JSObject = [
            "outcome": decision.outcome,
            "data": JSTypes.coerceDictionaryToJSObject(userInfo) ?? [:]
        ]
        if let reason = decision.reason { event["reason"] = reason }
        report(event)
        return decision.options
    }

    func didReceive(response: UNNotificationResponse) {
        inner?.didReceive(response: response)
    }
}
