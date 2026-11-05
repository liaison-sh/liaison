// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The status bar, following the app's own theme.
//
// It OVERLAYS the web view (`overlaysWebView: true` in capacitor.config.ts),
// because apps/web already pads its phone surfaces by the safe-area insets: a
// status bar that instead pushed the web view down would take that padding
// twice and leave a band of background above the app.
//
// Overlaying means the bar draws its clock and indicators over whatever the
// app painted there, so the CONTENT style has to follow the theme or the
// clock disappears: a dark app needs light glyphs and a light app dark ones.
// The web side pushes its resolved theme through the bridge on every change
// (`apps/web/src/lib/native-bridge.ts`), which is the only place that knows
// whether "system" resolved light or dark.

export type ResolvedTheme = "light" | "dark"

/** The values of Capacitor's `Style` enum, as the plugin serialises them. */
export type StatusBarStyleName = "DARK" | "LIGHT" | "DEFAULT"

/** Just enough of @capacitor/status-bar to be testable without a device. */
export interface StatusBarPlugin {
  setStyle: (options: { style: StatusBarStyleName }) => Promise<void>
  setOverlaysWebView: (options: { overlay: boolean }) => Promise<void>
}

/**
 * The style for a resolved theme. Capacitor names these after the BACKGROUND
 * they are for, not after the glyphs they draw: `DARK` means "light content,
 * for a dark background". A dark app therefore asks for `DARK`.
 */
export function statusBarStyleFor(theme: ResolvedTheme): StatusBarStyleName {
  return theme === "dark" ? "DARK" : "LIGHT"
}

export interface StatusBarController {
  /** Called by the bridge on every theme change the web app resolves. */
  setTheme: (theme: ResolvedTheme) => void
  /** Turns the overlay on. Awaited by nobody: a failure is cosmetic. */
  start: () => Promise<void>
}

/**
 * The controller the bridge's `setTheme` lands on. Every call is fire and
 * forget and every rejection is swallowed: a status bar plugin missing on a
 * platform (or refused by a webview) must never take down a theme change, and
 * there is nothing to retry.
 */
export function createStatusBarController(plugin: StatusBarPlugin): StatusBarController {
  let last: ResolvedTheme | null = null
  return {
    setTheme(theme: ResolvedTheme): void {
      // The web pushes on every resolve, including the ones that resolved to
      // the same value (an OS flip while the preference is a concrete
      // light/dark). One native call per ACTUAL change.
      if (theme === last) return
      last = theme
      void plugin.setStyle({ style: statusBarStyleFor(theme) }).catch(() => {})
    },
    async start(): Promise<void> {
      try {
        await plugin.setOverlaysWebView({ overlay: true })
      } catch {
        // Without the overlay the app simply sits below the bar.
      }
    },
  }
}
