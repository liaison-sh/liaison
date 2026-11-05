// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Connectivity, as the OS sees it.
//
// A webview's own `navigator.onLine` is the weakest possible answer on a
// handset: it reports whether an interface exists, so a phone holding a wifi
// association with no route, or one walking out of coverage, stays "online"
// until a request times out. The platform's reachability API knows sooner,
// which is the difference between a banner appearing when the user loses
// signal and a banner appearing after the next request has spent 30 s failing.
//
// So the shell publishes it, and the web app prefers it when it is there and
// falls back to `navigator.onLine` when it is not (browser, older shell).

export interface NetworkStatus {
  connected: boolean
}

/** Just enough of @capacitor/network to be testable without a device. */
export interface NetworkPlugin {
  getStatus: () => Promise<NetworkStatus>
  addListener: (
    event: "networkStatusChange",
    handler: (status: NetworkStatus) => void,
  ) => Promise<{ remove: () => Promise<void> }>
}

export interface Connectivity {
  /** Subscribes. Returns its own unsubscribe, synchronously. */
  onConnectivity: (handler: (online: boolean) => void) => () => void
  isOnline: () => Promise<boolean>
}

export function createConnectivity(plugin: NetworkPlugin): Connectivity {
  return {
    onConnectivity(handler: (online: boolean) => void): () => void {
      // THE UNSUBSCRIBE IS SYNCHRONOUS THOUGH THE SUBSCRIBE IS NOT. Capacitor
      // hands back the handle in a promise; a caller that unsubscribes before
      // that promise settles (a component mounted and torn down in the same
      // tick, which is what a tier change does) would otherwise leak a
      // listener that outlives it. The flag is checked on both sides, so an
      // early unsubscribe removes the handle the moment it arrives and the
      // handler never fires after it.
      let live = true
      let handle: { remove: () => Promise<void> } | null = null
      plugin
        .addListener("networkStatusChange", (status) => {
          if (!live) return
          handler(Boolean(status.connected))
        })
        .then((registered) => {
          if (!live) {
            void registered.remove().catch(() => {})
            return
          }
          handle = registered
        })
        .catch(() => {
          // No plugin on this platform: the web app's own fallback stands.
        })
      return () => {
        live = false
        void handle?.remove().catch(() => {})
        handle = null
      }
    },
    async isOnline(): Promise<boolean> {
      try {
        return Boolean((await plugin.getStatus()).connected)
      } catch {
        // Unknown is treated as ONLINE. A banner is an interruption, and one
        // shown because the shell could not answer is a worse failure than a
        // banner that is a second late.
        return true
      }
    },
  }
}
