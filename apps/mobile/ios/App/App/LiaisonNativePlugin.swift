import AuthenticationServices
import Capacitor
import UIKit

/// The app's own native plugin (JS: apps/mobile/src/native/liaison-native.ts).
///
/// A local plugin: it is compiled into the App target and registered by
/// MainViewController, not discovered from a package, so it needs no
/// npm module and no Package.swift entry.
@objc(LiaisonNativePlugin)
public class LiaisonNativePlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "LiaisonNativePlugin"
    public let jsName = "LiaisonNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "apsEnvironment", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "receiptCredentialGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "receiptCredentialSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "receiptCredentialDelete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "receiptQueueList", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "receiptQueueRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "receiptQueueAppend", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "debugConsumeForcedRegisterFailure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setThreadOnScreen", returnType: CAPPluginReturnPromise)
    ]

    /// Held until it completes: a session nobody retains is deallocated and
    /// its sheet never appears.
    private var session: ASWebAuthenticationSession?

    /// Held here: the notification router keeps its push handler weakly.
    private var presenter: ForegroundPushPresenter?

    // MARK: Foreground push presentation (ForegroundPushPresenter.swift)

    /// Registered after every packaged plugin has loaded (MainViewController),
    /// so Capacitor's push handler is already on the router and is wrapped
    /// rather than replaced.
    override public func load() {
        guard let router = bridge?.notificationRouter else { return }
        let presenter = ForegroundPushPresenter(inner: router.pushNotificationHandler) { [weak self] event in
            self?.notifyListeners("pushPresentation", data: event)
        }
        self.presenter = presenter
        router.pushNotificationHandler = presenter
    }

    /// The web app's report of the conversation on screen (src/native/thread-on-screen.ts).
    @objc func setThreadOnScreen(_ call: CAPPluginCall) {
        let raw = call.getString("threadId")
        let threadId = (raw?.isEmpty ?? true) ? nil : raw
        DispatchQueue.main.async {
            ForegroundPushPresenter.threadOnScreen = threadId
            call.resolve()
        }
    }

    // MARK: APNs environment

    /// Which APNs host this build's tokens belong to: `sandbox` or `production`.
    ///
    /// Read from the `aps-environment` entitlement of the provisioning profile
    /// the build carries (`embedded.mobileprovision`). A development profile
    /// says `development`, which is the sandbox. An App Store or TestFlight
    /// build carries no profile file at all, and is production. The simulator
    /// carries none either, but its tokens are sandbox tokens.
    @objc func apsEnvironment(_ call: CAPPluginCall) {
        call.resolve(["environment": LiaisonNativePlugin.currentApsEnvironment()])
    }

    static func currentApsEnvironment() -> String {
        #if targetEnvironment(simulator)
        return "sandbox"
        #else
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url) else {
            return "production"
        }
        return apsEnvironment(fromProfile: data) ?? "production"
        #endif
    }

    /// The profile is a signed CMS envelope around an XML plist: the plist is
    /// cut out by its markers rather than by verifying the signature, which
    /// the system already did when it installed the app.
    static func apsEnvironment(fromProfile data: Data) -> String? {
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex) else {
            return nil
        }
        let plistData = data.subdata(in: start.lowerBound..<end.upperBound)
        guard let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              let aps = entitlements["aps-environment"] as? String else {
            return nil
        }
        return aps == "development" ? "sandbox" : aps
    }

    // MARK: Delivery receipts (src/native/receipt-store.ts)

    /// The receipt credential for one server origin, or `{}`.
    @objc func receiptCredentialGet(_ call: CAPPluginCall) {
        guard let origin = call.getString("origin"), !origin.isEmpty else {
            call.reject("receiptCredentialGet needs an origin", "invalid")
            return
        }
        guard let stored = ReceiptStore.credential(for: origin) else {
            call.resolve([:])
            return
        }
        call.resolve(["credential": stored.credential, "deviceId": stored.deviceId])
    }

    @objc func receiptCredentialSet(_ call: CAPPluginCall) {
        guard let origin = call.getString("origin"), !origin.isEmpty,
              let credential = call.getString("credential"), !credential.isEmpty,
              let deviceId = call.getString("deviceId"), !deviceId.isEmpty else {
            call.reject("receiptCredentialSet needs origin, credential and deviceId", "invalid")
            return
        }
        let status = ReceiptStore.setCredential(.init(credential: credential, deviceId: deviceId), for: origin)
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("keychain write failed (\(status))", "keychain")
        }
    }

    @objc func receiptCredentialDelete(_ call: CAPPluginCall) {
        guard let origin = call.getString("origin"), !origin.isEmpty else {
            call.reject("receiptCredentialDelete needs an origin", "invalid")
            return
        }
        ReceiptStore.deleteCredential(for: origin)
        call.resolve()
    }

    @objc func receiptQueueList(_ call: CAPPluginCall) {
        let entries = ReceiptStore.listQueue().map { ["key": $0.key, "json": $0.json] }
        call.resolve(["entries": entries])
    }

    @objc func receiptQueueRemove(_ call: CAPPluginCall) {
        let keys = (call.getArray("keys") as? [String]) ?? []
        ReceiptStore.removeQueued(keys: keys)
        call.resolve()
    }

    @objc func receiptQueueAppend(_ call: CAPPluginCall) {
        guard let json = call.getString("json"), let data = json.data(using: .utf8) else {
            call.reject("receiptQueueAppend needs json", "invalid")
            return
        }
        if ReceiptStore.enqueue(json: data) {
            call.resolve()
        } else {
            call.reject("the App Group container is not available", "unavailable")
        }
    }

    #if DEBUG
    /// Launched with `LIAISON_DEBUG_FAIL_NEXT_REGISTER=1` (e.g.
    /// `SIMCTL_CHILD_LIAISON_DEBUG_FAIL_NEXT_REGISTER=1 xcrun simctl launch`),
    /// the first registration POST of the process fails without being sent,
    /// and the client's backoff retry has to register it (matrix case M5).
    private static var forcedRegisterFailures: Int =
        ProcessInfo.processInfo.environment["LIAISON_DEBUG_FAIL_NEXT_REGISTER"] == "1" ? 1 : 0
    #endif

    /// Debug builds only; a release build always answers false.
    @objc func debugConsumeForcedRegisterFailure(_ call: CAPPluginCall) {
        #if DEBUG
        let fail = LiaisonNativePlugin.forcedRegisterFailures > 0
        if fail {
            LiaisonNativePlugin.forcedRegisterFailures -= 1
            NSLog("LIAISON_DEBUG_PUSH forcing a register POST failure (M5)")
        }
        call.resolve(["fail": fail])
        #else
        call.resolve(["fail": false])
        #endif
    }

    // MARK: Web sign in

    /// Opens `url` in ASWebAuthenticationSession and resolves `{url}` with the
    /// callback URL once the page redirects to `callbackScheme://`. The
    /// callback goes to this session only, never through the system wide
    /// scheme dispatch. A dismissed sheet rejects with code `cancelled`.
    @objc func authenticate(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            call.reject("authenticate needs an http(s) url", "invalid")
            return
        }
        guard let callbackScheme = call.getString("callbackScheme"), !callbackScheme.isEmpty else {
            call.reject("authenticate needs a callbackScheme", "invalid")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if self.session != nil {
                call.reject("a sign in is already in progress", "busy")
                return
            }
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] callbackURL, error in
                self?.session = nil
                if let callbackURL = callbackURL {
                    call.resolve(["url": callbackURL.absoluteString])
                    return
                }
                if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
                    call.reject("The user cancelled the sign in", "cancelled", error)
                    return
                }
                call.reject(error?.localizedDescription ?? "the sign in failed", "failed", error)
            }
            // Shares cookies with Safari, so an account already signed in
            // there is offered without typing a password again.
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = self
            self.session = session
            if !session.start() {
                self.session = nil
                call.reject("the sign in sheet could not be shown", "unavailable")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
        return windows.first(where: { $0.isKeyWindow }) ?? windows.first ?? ASPresentationAnchor()
    }
}
