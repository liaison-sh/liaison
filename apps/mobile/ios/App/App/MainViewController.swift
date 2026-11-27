import Capacitor
import UIKit
import WebKit

/// The bridge controller the window is rooted in. It exists to register the
/// app's local plugins, which no package manifest names, once the bridge is up,
/// and to keep every native call to the main frame.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(LiaisonNativePlugin())
        answerTheMainFrameOnly()
        paintBehindThePage()
        watchPageLoads()
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
