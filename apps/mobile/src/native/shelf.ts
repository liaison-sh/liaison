// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHERE THE CAPACITOR PLUGINS ARE BOUND TO THE BRIDGE, and the only file in
// this shelf that imports one.
//
// Every other module under `src/native/` takes its plugin as an argument, so
// its behaviour is testable in a bun process with no native runtime under it.
// This file is the wiring, and it runs from `boot-entry.ts` alone.
//
// It is installed BEFORE the wrapped app's module entry: apps/web reads the
// bridge as it boots, and the splash cannot be hidden by a `ready()` the app
// had no function to call.

import { BiometricAuth } from "@aparajita/capacitor-biometric-auth"
import { App } from "@capacitor/app"
import { Capacitor } from "@capacitor/core"
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics"
import { Keyboard } from "@capacitor/keyboard"
import { Network } from "@capacitor/network"
import { PushNotifications } from "@capacitor/push-notifications"
import { Share } from "@capacitor/share"
import { SplashScreen } from "@capacitor/splash-screen"
import { StatusBar, Style } from "@capacitor/status-bar"
import { publishNativeBridge } from "../bridge/native-bridge"
import { preferencesStorage } from "../main"
import { type AppStatePlugin, type BiometricPlugin, createAppLock } from "./app-lock"
import { createClientVersion } from "./client-version"
import { createForeground } from "./foreground"
import { createHaptics, type HapticsPlugin } from "./haptics"
import {
  createKeyboardInset,
  hideKeyboardAccessoryBar,
  type KeyboardEventsPlugin,
} from "./keyboard"
import { authenticate } from "./liaison-native"
import { createConnectivity, type NetworkPlugin } from "./network"
import { createPushPermission } from "./push-permission"
import { createShare } from "./share"
import { createSplashGate } from "./splash"
import { createStatusBarController, type StatusBarStyleName } from "./status-bar"
import { setThreadOnScreen } from "./thread-on-screen"

/**
 * The status bar plugin behind this shelf's own seam. Capacitor's `setStyle`
 * is typed on its `Style` enum, which no structural type can stand in for, so
 * the widening happens once, here — the same shape the push plugin's seam
 * takes in main.ts.
 */
const statusBarPlugin = {
  setStyle: (options: { style: StatusBarStyleName }) =>
    StatusBar.setStyle({ style: Style[options.style === "DARK" ? "Dark" : "Light"] }),
  setOverlaysWebView: (options: { overlay: boolean }) => StatusBar.setOverlaysWebView(options),
}

/** The app-state events behind this shelf's seam (app lock, foreground probe). */
const appStatePlugin: AppStatePlugin = App

/** Haptics behind the same seam: the plugin's enums, widened once. */
const hapticsPlugin: HapticsPlugin = {
  impact: ({ style }) =>
    Haptics.impact({
      style:
        style === "HEAVY"
          ? ImpactStyle.Heavy
          : style === "MEDIUM"
            ? ImpactStyle.Medium
            : ImpactStyle.Light,
    }),
  selectionChanged: () => Haptics.selectionChanged(),
  notification: ({ type }) =>
    Haptics.notification({
      type:
        type === "ERROR"
          ? NotificationType.Error
          : type === "WARNING"
            ? NotificationType.Warning
            : NotificationType.Success,
    }),
}

/** Publishes the bridge on `target` and arms the splash fallback. */
export function installNativeShelf(target: object): void {
  const statusBar = createStatusBarController(statusBarPlugin)
  const splash = createSplashGate({ plugin: SplashScreen })
  const connectivity = createConnectivity(Network as unknown as NetworkPlugin)

  publishNativeBridge(target, {
    ready: () => splash.ready(),
    setTheme: (resolved) => statusBar.setTheme(resolved),
    // Which conversation is on screen, so a push for it raises no in-app
    // notice while the user is reading it (push-client.ts).
    setThreadOnScreen,
    haptic: createHaptics(hapticsPlugin),
    onConnectivity: connectivity.onConnectivity,
    // The app came back to the foreground: the page probes its socket (S26).
    onForeground: createForeground(appStatePlugin),
    // What the keyboard covers, which the web view is never told: the plugin
    // takes the keyboard notifications away from it (src/native/keyboard.ts).
    onKeyboardInset: createKeyboardInset(Keyboard as unknown as KeyboardEventsPlugin),
    isOnline: connectivity.isOnline,
    share: createShare(Share),
    // Face ID in front of the app. It is a SCREEN, not a key: the refresh
    // token stays exactly where the shell already keeps it (src/native/
    // app-lock.ts).
    appLock: createAppLock({
      biometrics: BiometricAuth as unknown as BiometricPlugin,
      storage: preferencesStorage,
      appState: appStatePlugin,
    }),
    // A web sign in or an app connection in ASWebAuthenticationSession (iOS)
    // or the system browser (Android): the callback URL comes back to this
    // call, and apps/web redeems it with the verifier it kept (Login.tsx,
    // settings/oauth-connect.ts). Null on a build without the plugin, where
    // the page keeps its web navigation.
    authenticate: (options) => authenticate(options),
    // The push permission for Settings -> Notifications ("This device"): read
    // there, asked for there, and a grant registers the token (push-permission.ts).
    // Which app this is and its version, for the server's client policy
    // (native/client-version.ts).
    clientVersion: createClientVersion({ app: App, platform: () => Capacitor.getPlatform() }),
    pushPermission: createPushPermission({
      checkPermissions: () => PushNotifications.checkPermissions(),
      requestPermissions: () => PushNotifications.requestPermissions(),
      register: () => PushNotifications.register(),
    }),
  })

  // Armed AFTER the bridge exists, so a `ready()` that arrives in the same
  // tick still cancels it.
  splash.arm()
  void statusBar.start()
  void hideKeyboardAccessoryBar(Keyboard)
}
