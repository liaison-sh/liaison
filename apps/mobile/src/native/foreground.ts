// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "The app came back to the foreground", for the web app's socket (S26). A
// suspended webview can wake with a socket that still reads open while the
// connection under it is gone; the page probes it on this signal.
import type { AppStatePlugin } from "./app-lock"

/** Subscribes `handler` to every return to the foreground. Returns its unsubscribe. */
export type OnForeground = (handler: () => void) => () => void

export function createForeground(plugin: AppStatePlugin): OnForeground {
  return (handler) => {
    // THE UNSUBSCRIBE IS SYNCHRONOUS THOUGH THE SUBSCRIBE IS NOT, as in
    // network.ts: an unsubscribe before Capacitor hands back the handle
    // removes it the moment it arrives, and the handler never fires after.
    let live = true
    let handle: { remove: () => Promise<void> } | null = null
    plugin
      .addListener("appStateChange", (state) => {
        if (live && state.isActive) handler()
      })
      .then((registered) => {
        if (!live) {
          void registered.remove().catch(() => {})
          return
        }
        handle = registered
      })
      .catch(() => {
        // No plugin on this platform: the page's own focus and visibility probes stand.
      })
    return () => {
      live = false
      void handle?.remove().catch(() => {})
      handle = null
    }
  }
}
