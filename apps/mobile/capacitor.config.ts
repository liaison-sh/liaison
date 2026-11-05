// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One Capacitor build, pointed at the apps/web bundle the desktop shell also
// wraps, built in its `native` mode. `webDir` is apps/web's own Vite output and
// nothing else: there is no mobile frontend to build, and no `server.url`, so
// the shipped app loads the assets copied into the native project rather than
// a remote origin. The native mode differs from the desktop's `dist` in one
// module only: it leaves out the legacy Argon2id passphrase KDF, so the app
// carries only the cryptography the operating system provides
// (apps/web/vite.config.ts, STORE_CHECKLIST.md "Export compliance").
//
// `appId` is the store identity. It is separate from the desktop bundle id so
// the two can be signed and listed independently, and it never changes once a
// listing exists.

import type { CapacitorConfig } from "@capacitor/cli"
// Type-only: the enum's VALUES are the strings below, and a runtime import of
// a plugin into the config file would pull its web registration into the CLI.
import type { KeyboardResize } from "@capacitor/keyboard"

const config: CapacitorConfig = {
  appId: "sh.liaison.mobile",
  appName: "Liaison",
  webDir: "../web/dist-native",
  // THE BRIDGE PRINTS WHAT IT RETURNS. Capacitor's default logging echoes
  // every plugin call and its result to the device console, which on this app
  // means the stored refresh token in clear text in `simctl launch
  // --console-pty` output and in any device log anybody collects or shares.
  // Nothing the bridge carries is worth a line in that log, so it says
  // nothing, in every build and not only in release.
  loggingBehavior: "none",
  plugins: {
    // THE SPLASH IS HIDDEN BY THE APP, NOT BY A TIMER. `launchAutoHide` tears
    // the splash away on a schedule that knows nothing about the web bundle,
    // so the user watches the app assemble itself on a blank page. The boot
    // bundle hides it when the wrapped app calls `__LIAISON_NATIVE__.ready()`
    // after its first render, with a 3 s fallback so a bundle that never boots
    // cannot leave a splash on screen forever (src/native/splash.ts).
    SplashScreen: {
      launchAutoHide: false,
      // The app's own background, so the hand-off from splash to first paint
      // is one colour rather than a white flash between two dark screens.
      backgroundColor: "#111113",
      showSpinner: false,
      androidScaleType: "CENTER_CROP",
      splashFullScreen: false,
      splashImmersive: false,
    },
    // Overlaid, because apps/web already pads its phone surfaces by the
    // safe-area insets: a bar that pushed the web view down instead would take
    // that padding twice. The CONTENT style follows the app theme at runtime
    // (src/native/status-bar.ts); this is only the value before the web app
    // has resolved one.
    StatusBar: {
      overlaysWebView: true,
      style: "DARK",
      backgroundColor: "#111113",
    },
    // `none`, because apps/web lifts itself for the keyboard, from the
    // height this plugin reports in `keyboardWillShow` (src/native/keyboard.ts,
    // published as `onKeyboardInset`; apps/web/src/primitives/keyboardInset.ts).
    // NOT from `window.visualViewport`: the plugin takes the keyboard
    // notifications away from WKWebView, so the visual viewport never shrinks
    // in this app. Any other resize mode ALSO shrinks or offsets the web view
    // natively, and the two corrections stack: the composer lifts twice and
    // leaves a band of background under it. `native` alone would lift once,
    // but only after the keyboard has finished animating plus 0.2 s.
    //
    // It does not touch the composer's 16px floor either (ComposeBar.tsx),
    // which is a font-size that stops WKWebView zooming the page on focus:
    // a resize mode changes the viewport, never the type size.
    Keyboard: {
      resize: "none" as KeyboardResize,
    },
  },
  ios: {
    // The server address is entered on first launch, so the app talks to an
    // operator's own host over TLS. Cleartext stays off.
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    allowMixedContent: false,
  },
}

export default config
