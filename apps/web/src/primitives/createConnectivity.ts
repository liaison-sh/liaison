// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Whether the app can reach its server, as a signal.
//
// TWO SOURCES, ONE ANSWER. Inside the native shell the platform's reachability
// API answers (`__LIAISON_NATIVE__.onConnectivity`), because a webview's
// `navigator.onLine` on a handset reports only that an interface exists: a
// phone holding a wifi association with no route stays "online" until a
// request has spent half a minute timing out. In a browser there is nothing
// better than `navigator.onLine` and its two events, so that is what runs.
//
// IT FAILS TOWARDS ONLINE. Every unknown, an absent `navigator`, a bridge that
// throws, a status that never answers, resolves to online. The only thing this
// signal drives is a banner, and a banner shown to somebody whose connection
// is fine is worse than one that is a second late.
import { type Accessor, createSignal, onCleanup } from "solid-js"
import { nativeBridge } from "~/lib/native-bridge"

/** `navigator.onLine`, defaulting to online wherever it cannot be read. */
export function browserOnline(): boolean {
  if (typeof navigator === "undefined") return true
  const value = (navigator as Navigator).onLine
  return typeof value === "boolean" ? value : true
}

export interface ConnectivitySource {
  /** The state to start from. */
  initial: boolean
  /** Subscribes to changes. Returns its own unsubscribe. */
  subscribe: (handler: (online: boolean) => void) => () => void
}

/**
 * The source for this page: the shell's if it published one, the browser's
 * otherwise. Exported so both halves are testable without a shell and without
 * a DOM event round trip.
 */
export function connectivitySource(): ConnectivitySource {
  const bridge = nativeBridge()
  const onConnectivity = bridge?.onConnectivity
  if (typeof onConnectivity === "function") {
    return {
      // The shell's `isOnline` is a promise, and this signal has to have a
      // value in the same tick as the component that reads it. So it starts
      // from the browser's answer and the first native event corrects it,
      // which on a phone that is genuinely offline is immediate.
      initial: browserOnline(),
      subscribe(handler) {
        try {
          const off = onConnectivity.call(bridge, handler)
          return typeof off === "function" ? off : () => {}
        } catch {
          return () => {}
        }
      },
    }
  }
  return {
    initial: browserOnline(),
    subscribe(handler) {
      if (typeof window === "undefined") return () => {}
      const online = () => handler(true)
      const offline = () => handler(false)
      window.addEventListener("online", online)
      window.addEventListener("offline", offline)
      return () => {
        window.removeEventListener("online", online)
        window.removeEventListener("offline", offline)
      }
    },
  }
}

/**
 * Reactive connectivity. Call inside a reactive root: the subscription is
 * dropped through `onCleanup` with the owner.
 */
export function createConnectivity(
  source: ConnectivitySource = connectivitySource(),
): Accessor<boolean> {
  const [online, setOnline] = createSignal(source.initial)
  const off = source.subscribe((next) => setOnline(next))
  onCleanup(() => off())
  return online
}
