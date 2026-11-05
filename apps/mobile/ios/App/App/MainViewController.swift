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
