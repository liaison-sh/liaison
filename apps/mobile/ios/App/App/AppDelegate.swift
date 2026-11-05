import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        #if DEBUG
        // Debug builds only: the simulator push spike and the notification
        // matrix runner launch the app with
        // `SIMCTL_CHILD_LIAISON_DEBUG_SELF_REGISTER_PUSH=1 xcrun simctl launch ...`
        // to get an APNs device token without a signed-in web session (the
        // token is printed by the registration callback below).
        if ProcessInfo.processInfo.environment["LIAISON_DEBUG_SELF_REGISTER_PUSH"] == "1" {
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                NSLog("LIAISON_DEBUG_PUSH authorization granted=%@", granted ? "true" : "false")
                DispatchQueue.main.async { application.registerForRemoteNotifications() }
            }
        }
        #endif
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    // APNs answers registerForRemoteNotifications here, not in the plugin:
    // @capacitor/push-notifications listens for these two notifications, and
    // without them `register()` resolves and no `registration` event follows.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        #if DEBUG
        if ProcessInfo.processInfo.environment["LIAISON_DEBUG_SELF_REGISTER_PUSH"] == "1" {
            NSLog("LIAISON_DEBUG_PUSH token=%@", deviceToken.map { String(format: "%02x", $0) }.joined())
        }
        #endif
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        #if DEBUG
        NSLog("LIAISON_DEBUG_PUSH register failed: %@", error.localizedDescription)
        #endif
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
