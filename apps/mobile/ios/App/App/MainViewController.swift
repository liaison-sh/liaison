import Capacitor
import LiaisonShell
import UIKit
import WebKit

/// The bridge controller the window is rooted in. It exists to register the
/// app's local plugins, which no package manifest names, once the bridge is up,
/// to keep every native call to the main frame, and to choose which web build
/// the page runs (the served shell, LiaisonShell package).
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(LiaisonNativePlugin())
        answerTheMainFrameOnly()
        paintBehindThePage()
        watchPageLoads()
        watchShellLifecycle()
        armShellReadyClock()
        refreshShell(force: true)
    }

    // MARK: Served shell (S7, S8, D9a, D16a, D17)

    /// Resolves every page request against the folder the host chose; only
    /// the host moves it (Capacitor's WebView.setServerBasePath cannot).
    private let shellBase = ShellBasePath()
    private lazy var shellRouter = ShellRouter(base: shellBase)
    private var readyTimer: Timer?
    private var readyClock: (buildId: String, origin: String, clock: ReadyClock)?
    private var refreshTimer: Timer?
    private var shellObservers: [NSObjectProtocol] = []

    override func router() -> Router {
        shellRouter
    }

    /// The page's folder, chosen on EVERY launch before the web view loads:
    /// the lists and the server's switch read first (3 s bound), then the
    /// current server's verified build re-verified against this binary
    /// (signature, floor, revocations, bridge range, every file hash, the kill
    /// switches), else the bundled `public` folder. Capacitor's own persisted
    /// base path is never used (review O2: cleared on a new binary, no
    /// fallback when its folder is missing).
    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        switch ServedShellHost.shared.launch() {
        case let .served(_, root): descriptor.appLocation = root
        case .bundled: descriptor.appLocation = bundledRoot
        }
        shellBase.move(to: descriptor.appLocation.path)
        return descriptor
    }

    private var bundledRoot: URL { InstanceDescriptor().appLocation }

    private func moveShellRoot() {
        shellBase.move(to: (ServedShellHost.shared.servedRoot ?? bundledRoot).path)
    }

    /// The app's own page (capacitor://localhost), as opposed to a link out.
    private func isAppDocument(_ url: URL?) -> Bool {
        guard let url = url, let local = bridge?.config.localURL else { return false }
        return url.scheme?.lowercased() == local.scheme?.lowercased() && url.host?.lowercased() == local.host?.lowercased()
    }

    /// A main-frame document load of the app is the ONLY moment the build
    /// changes under the page (a reselect or a refresh staged it); every such
    /// load also starts a new ready attempt. Capacitor posts the navigation
    /// before deciding it, on the main thread, so the router has moved
    /// before the first request of the new document.
    private func watchShellLifecycle() {
        let center = NotificationCenter.default
        shellObservers.append(center.addObserver(forName: .capacitorDecidePolicyForNavigationAction, object: nil,
                                                 queue: nil) { [weak self] note in
            guard let self = self, let action = note.object as? WKNavigationAction,
                  action.targetFrame?.isMainFrame == true, self.isAppDocument(action.request.url) else { return }
            // A fragment change stays in the same document.
            if action.navigationType != .reload, let now = self.webView?.url, let next = action.request.url,
               next.fragment != nil, ShellNavigation.sameDocument(now, next) {
                return
            }
            if ServedShellHost.shared.promote() != nil {
                self.moveShellRoot()
            } else {
                ServedShellHost.shared.restartAttempt()
            }
            self.armShellReadyClock()
        })
        shellObservers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil,
                                                 queue: .main) { [weak self] _ in
            self?.readyClockResume()
            self?.startRefreshTimer()
            self?.refreshShell(force: false, after: ServedShellHost.foregroundRefreshAfter)
        })
        shellObservers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil,
                                                 queue: .main) { [weak self] _ in
            self?.readyClockPause()
            self?.refreshTimer?.invalidate()
            self?.refreshTimer = nil
        })
        if UIApplication.shared.applicationState == .active { startRefreshTimer() }
    }

    /// Re-reads the lists every few minutes while the app is in front (a
    /// suspended app runs no timer; coming back re-reads them).
    private func startRefreshTimer() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            self?.refreshShell(force: false, after: ServedShellHost.refreshEvery)
        }
    }

    private func refreshShell(force: Bool, after: TimeInterval = 0) {
        let host = ServedShellHost.shared
        guard force || host.refreshDue(after: after) else { return }
        // The refresh itself runs off the main thread (a nonisolated async call).
        Task { @MainActor [weak self] in
            guard let decision = await host.refresh() else { return }
            self?.apply(decision)
        }
    }

    /// A build that must not run any more is left at once, whatever the page
    /// is doing (D16a); a newer or bundled choice waits for the next load.
    private func apply(_ decision: ServedShellHost.AfterRefresh) {
        guard case .leave = decision else { return }
        moveShellRoot()
        reloadPage()
    }

    private func reloadPage() {
        if let url = bridge?.config.serverURL {
            webView?.load(URLRequest(url: url))
        }
    }

    /// The page reported ready: no clock to run out.
    func shellSignalledReady() {
        if ServedShellHost.shared.awaitingReady == nil { disarmReadyClock() }
    }

    private func disarmReadyClock() {
        readyTimer?.invalidate()
        readyTimer = nil
        readyClock = nil
    }

    /// A served build that has not signalled ready after 45 s IN THE
    /// FOREGROUND is reloaded once; a second miss quarantines it and the page
    /// reloads on the last good build, else the bundled one (S8, D9a). Time
    /// in the background never counts (review P7 #3).
    private func armShellReadyClock() {
        disarmReadyClock()
        guard let awaiting = ServedShellHost.shared.awaitingReady else { return }
        let active = UIApplication.shared.applicationState == .active
        readyClock = (awaiting.buildId, awaiting.origin, ReadyClock(window: ShellStore.readyWithin, now: Date(), running: active))
        if active { scheduleReadyTimer() }
    }

    private func scheduleReadyTimer() {
        readyTimer?.invalidate()
        guard let armed = readyClock else { return }
        readyTimer = Timer.scheduledTimer(withTimeInterval: max(0.5, armed.clock.remaining(now: Date())),
                                          repeats: false) { [weak self] _ in
            self?.readyClockFired()
        }
    }

    private func readyClockPause() {
        guard var armed = readyClock else { return }
        armed.clock.pause(now: Date())
        readyClock = armed
        readyTimer?.invalidate()
        readyTimer = nil
        ServedShellHost.shared.progress(buildId: armed.buildId, activeSeconds: armed.clock.elapsed(now: Date()))
    }

    private func readyClockResume() {
        guard var armed = readyClock else { return }
        armed.clock.resume(now: Date())
        readyClock = armed
        scheduleReadyTimer()
    }

    private func readyClockFired() {
        guard let armed = readyClock else { return }
        if !armed.clock.expired(now: Date()) {
            scheduleReadyTimer()
            return
        }
        let host = ServedShellHost.shared
        guard let awaiting = host.awaitingReady, awaiting.buildId == armed.buildId else {
            disarmReadyClock()
            return
        }
        disarmReadyClock()
        if host.missed(buildId: armed.buildId, origin: armed.origin) == .ignored { return }
        moveShellRoot()
        reloadPage()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        publishWindowControlsInset()
    }

    // MARK: iPadOS windows

    /// Whatever shows around the page (a windowed iPad's top inset, a bounce)
    /// is the app's own background, never the default black: a resized or
    /// zoomed iPad window drew a solid black band above the app's light
    /// header. Until the page has said which theme it resolved, that is the
    /// system background; from then on it is the app's, light or dark as the
    /// APP is, which is not always the device's appearance (a member who chose
    /// the light theme on a dark iPad saw the dark system background there).
    func paintBehindThePage(theme: String? = nil) {
        let color: UIColor
        switch theme {
        case "light": color = MainViewController.lightBackdrop
        case "dark": color = MainViewController.darkBackdrop
        default: color = .systemBackground
        }
        view.window?.backgroundColor = color
        view.backgroundColor = color
        webView?.backgroundColor = color
        webView?.scrollView.backgroundColor = color
        webView?.underPageBackgroundColor = color
    }

    /// The page's `--color-bg` in each theme (apps/web/src/styles/theme.css).
    static let lightBackdrop = UIColor(red: 0xfa / 255.0, green: 0xfa / 255.0, blue: 0xfa / 255.0, alpha: 1)
    static let darkBackdrop = UIColor(red: 0x11 / 255.0, green: 0x11 / 255.0, blue: 0x13 / 255.0, alpha: 1)

    /// The height the iPadOS window controls (close, minimise, resize) take
    /// below the top safe area, in points; 0 everywhere else.
    private var publishedControlsTop: CGFloat = -1
    private var loadingObservation: NSKeyValueObservation?

    /// A windowed iPad app (iPadOS 26) has its window controls drawn over its
    /// top leading corner, and the safe area does not include them: the back
    /// control and the title sat under them. UIKit reports the room they need
    /// as the safe area adapted to the corner; the difference with the plain
    /// safe area goes to the page as `--window-controls-top`, which the shell
    /// adds to its top inset (apps/web/src/modules/shell/Shell.tsx).
    private func publishWindowControlsInset(force: Bool = false) {
        var top: CGFloat = 0
        if #available(iOS 26.0, *) {
            let adapted = view.edgeInsets(for: .safeArea(cornerAdaptation: .vertical))
            top = max(0, adapted.top - view.safeAreaInsets.top)
        }
        if !force && top == publishedControlsTop { return }
        publishedControlsTop = top
        let script = "document.documentElement.style.setProperty('--window-controls-top','\(Int(top.rounded()))px')"
        webView?.evaluateJavaScript(script, completionHandler: nil)
    }

    /// A reload (a server switch restarts the page) starts from a fresh
    /// document, so the inset is published again once each load finishes.
    private func watchPageLoads() {
        loadingObservation = webView?.observe(\.isLoading, options: [.new]) { [weak self] webView, _ in
            guard !webView.isLoading else { return }
            DispatchQueue.main.async { self?.publishWindowControlsInset(force: true) }
        }
    }

    /// WKWebView offers a script message handler to every frame of the page,
    /// and Capacitor's handler runs whatever call reaches it, whichever frame
    /// posted it. An installed app's UI runs in a sandboxed frame (apps/web
    /// framework/isolated-app.tsx), and nothing in it may reach a plugin (the
    /// secure storage holding the session among them). So the `bridge`
    /// handler is replaced by one that forwards the main frame's messages and
    /// drops every other, before the page's first script runs.
    private func answerTheMainFrameOnly() {
        guard let webView = webView,
              let inner = webView.navigationDelegate as? WKScriptMessageHandler else {
            return
        }
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "bridge")
        controller.add(MainFrameOnlyMessageHandler(inner: inner), name: "bridge")
    }
}

/// Forwards a script message only when the main frame posted it.
final class MainFrameOnlyMessageHandler: NSObject, WKScriptMessageHandler {
    /// Capacitor's own handler, kept alive by its bridge.
    private weak var inner: WKScriptMessageHandler?

    init(inner: WKScriptMessageHandler) {
        self.inner = inner
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        inner?.userContentController(userContentController, didReceive: message)
    }
}

/// Capacitor's router over the served shell's base folder (ShellBasePath):
/// a path without an extension is the SPA's index.html, nothing resolves
/// outside the folder, and a base path set from outside the host (the
/// WebView plugin's setServerBasePath) is ignored.
final class ShellRouter: Router {
    let base: ShellBasePath

    init(base: ShellBasePath) { self.base = base }

    var basePath: String {
        get { base.current }
        set {
            if !base.offer(newValue) { NSLog("LIAISON_SHELL ignored a base path the host did not choose") }
        }
    }

    func route(for path: String) -> String { base.route(for: path) }
}
