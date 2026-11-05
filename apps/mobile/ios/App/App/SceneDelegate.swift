import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = MainViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)

        #if DEBUG
        // Debug builds only: the notification matrix runner launches the app
        // with `SIMCTL_CHILD_LIAISON_DEBUG_OPEN_ROUTE=/threads/<id>` to put a
        // conversation on screen (M2 "foreground on the same thread"). The
        // route becomes the app's own `liaison://thread/<id>` link and goes
        // through the ordinary URL-open path, so the web side's fail-closed
        // parser and launch queue handle it like a push tap.
        let debugRoutePrefix = "/threads/"
        if let route = ProcessInfo.processInfo.environment["LIAISON_DEBUG_OPEN_ROUTE"],
           route.hasPrefix(debugRoutePrefix),
           let url = URL(string: "liaison://thread/" + route.dropFirst(debugRoutePrefix.count)) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                NSLog("LIAISON_DEBUG_OPEN_ROUTE %@", url.absoluteString)
                _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: url, options: [:])
            }
        }
        #endif
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
