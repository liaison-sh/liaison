// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The splash screen, hidden when the app has actually painted.
//
// `launchAutoHide` is OFF in capacitor.config.ts. The automatic hide fires on
// a timer that knows nothing about the app: the web bundle is still parsing,
// the server address is still coming back from Preferences and the auth
// roundtrip has not resolved, so the splash tears away onto an empty page and
// the user watches the app assemble itself. The web app calls
// `__LIAISON_NATIVE__.ready()` after its first render instead
// (apps/web/src/index.tsx).
//
// A THREE SECOND FALLBACK, because `ready()` is a promise the shell does not
// control: a web bundle that fails to boot, an exception before the first
// render, or a shell wrapping an older build that never calls it, would
// otherwise leave the splash on screen forever, and a frozen splash is the one
// failure a user cannot get past. The fallback hides regardless, and whatever
// state the app is in is at least visible.

/** How long the splash may stay up without the app saying it has painted. */
export const SPLASH_FALLBACK_MS = 3000

/** Just enough of @capacitor/splash-screen to be testable without a device. */
export interface SplashPlugin {
  hide: (options?: { fadeOutDuration?: number }) => Promise<void>
}

export interface SplashGateOptions {
  plugin: SplashPlugin
  /** Injected so the fallback's timing is testable without waiting 3 s. */
  setTimer?: (handler: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  fallbackMs?: number
}

export interface SplashGate {
  /** The app has painted. Hides the splash. Idempotent. */
  ready: () => void
  /** Starts the fallback timer. Called once, at boot. */
  arm: () => void
  /** Whether the splash has been hidden, by either route. Test read. */
  hidden: () => boolean
}

/**
 * Hides the splash EXACTLY ONCE, on whichever of the two routes comes first.
 * A second hide is not merely wasteful: on iOS it resolves against a view that
 * is already gone and rejects, which is noise in a log this app deliberately
 * keeps silent (`loggingBehavior: "none"`).
 */
export function createSplashGate(options: SplashGateOptions): SplashGate {
  const fallbackMs = options.fallbackMs ?? SPLASH_FALLBACK_MS
  const setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never))
  let done = false
  let timer: unknown

  function hide(): void {
    if (done) return
    done = true
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    void options.plugin.hide().catch(() => {})
  }

  return {
    ready: hide,
    arm(): void {
      if (done || timer !== undefined) return
      timer = setTimer(hide, fallbackMs)
    },
    hidden: () => done,
  }
}
