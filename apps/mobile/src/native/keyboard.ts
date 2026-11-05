// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The software keyboard: how much of the screen it covers, and its accessory
// bar.
//
// THE KEYBOARD'S HEIGHT GOES ON THE BRIDGE, because the web view never learns
// it. @capacitor/keyboard takes the keyboard notifications away from WKWebView
// when it loads (Keyboard.m `load` removes the web view as an observer of
// UIKeyboardWillShow/WillHide/ChangeFrame), so with `resize: "none"` nothing
// in the page moves: `window.visualViewport` keeps its full height,
// `innerHeight` too, and the composer stays under the keyboard. An earlier
// version of this file relied on `visualViewport` and published nothing; on a
// device and in the Simulator that left every input on every screen covered.
//
// So the plugin's own `keyboardWillShow` height is the one source of truth in
// the native app. It arrives as the keyboard STARTS to animate, where the
// `native` resize mode only moves the web view once the animation has ended
// plus 0.2 s, so the content follows the keyboard instead of catching up with
// it. `resize` stays "none" (capacitor.config.ts): a native resize on top of
// this would lift everything twice.
//
// The accessory bar, the grey iOS strip with "Done" and the two chevrons over
// the keyboard, is dropped: the composer has its own send control right above
// it, so the strip is a second toolbar covering a thread and nothing else.

/** Just enough of @capacitor/keyboard to be testable without a device. */
export interface KeyboardPlugin {
  setAccessoryBarVisible: (options: { isVisible: boolean }) => Promise<void>
}

/** The listener half of @capacitor/keyboard, behind the same kind of seam. */
export interface KeyboardEventsPlugin {
  addListener(
    event: "keyboardWillShow",
    handler: (info: { keyboardHeight: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>
  addListener(
    event: "keyboardWillHide",
    handler: () => void,
  ): Promise<{ remove: () => Promise<void> }>
}

/**
 * Hides the accessory bar. Awaited by nobody and never throws: the plugin is
 * iOS only (Android has no such bar and the call rejects as unimplemented),
 * which is not a failure, it is the platform.
 */
export async function hideKeyboardAccessoryBar(plugin: KeyboardPlugin): Promise<void> {
  try {
    await plugin.setAccessoryBarVisible({ isVisible: false })
  } catch {
    // Unimplemented on this platform, or no keyboard at all.
  }
}

/**
 * `onKeyboardInset` for the bridge: the handler gets the pixels the keyboard
 * covers at the bottom of the web view, 0 once it is going away. The
 * unsubscribe is synchronous though Capacitor's handles arrive in promises,
 * for the same reason as the connectivity listener (network.ts).
 */
export function createKeyboardInset(
  plugin: KeyboardEventsPlugin,
): (handler: (inset: number) => void) => () => void {
  return (handler) => {
    let live = true
    const handles: Array<{ remove: () => Promise<void> }> = []
    const keep = (pending: Promise<{ remove: () => Promise<void> }>) => {
      pending
        .then((registered) => {
          if (!live) {
            void registered.remove().catch(() => {})
            return
          }
          handles.push(registered)
        })
        .catch(() => {
          // No plugin on this platform: nothing covers the page.
        })
    }
    keep(
      plugin.addListener("keyboardWillShow", (info) => {
        if (!live) return
        const height = Number(info?.keyboardHeight)
        handler(Number.isFinite(height) && height > 0 ? height : 0)
      }),
    )
    keep(
      plugin.addListener("keyboardWillHide", () => {
        if (live) handler(0)
      }),
    )
    return () => {
      live = false
      for (const handle of handles.splice(0)) void handle.remove().catch(() => {})
    }
  }
}
