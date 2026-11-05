// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Some apps run in compatibility mode until you update Liaison."
//
// Shown in the desktop or phone app while at least one app runs in
// compatibility mode (framework/compat-mode.ts): a settings page uses a
// format this build cannot draw. It keys on what actually degraded, not on the
// server merely being newer: a deploy that changed no app says nothing.
//
// - Desktop: the shell's update check runs at once, quietly (nothing said when
//   there is nothing to install), once per set of apps and versions; "Check
//   for updates" runs it as the menu does. Nothing installs without a yes.
// - Phone: a sentence pointing at the app store.
// - "Not now" hides it until the set of apps or their versions changes,
//   remembered on this device.
// - A browser tab never shows it: it always runs the server's own build.

import { createSignal } from "solid-js"
import { type CompatApp, compatModeApps, compatModeKey } from "~/framework/compat-mode"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { isNativeShell } from "~/lib/native-bridge"
import { insideAppShell } from "~/lib/web-build"

/** Which app the page runs in. */
export type AppShellKind = "desktop" | "mobile"

/** Where "Not now" is remembered (per device: the set it was said to). */
export const COMPAT_DISMISSED_KEY = "liaison:compat-mode-dismissed"

export interface CompatNoticeEnv {
  /** The apps in compatibility mode now (reactive). */
  apps: () => CompatApp[]
  /** The app around the page, or null in a browser. */
  shell: () => AppShellKind | null
  /** The desktop shell's update check, or null where there is none. */
  updateCheck: () => ((manual: boolean) => void) | null
  storage?: Pick<Storage, "getItem" | "setItem">
}

export interface CompatNoticeState {
  shell: AppShellKind
  canCheck: boolean
}

export interface CompatNotice {
  /** What the notice shows, or null when it is not up. Reactive. */
  notice: () => CompatNoticeState | null
  /** Call whenever the set may have changed: runs the quiet desktop check once per set. */
  sync: () => void
  dismiss: () => void
  checkForUpdates: () => void
}

/** Which app the page is in: the phone app, the desktop app, or a browser (null). */
export function appShellKind(
  isPhone: () => boolean = isNativeShell,
  inShell: () => boolean = insideAppShell,
): AppShellKind | null {
  if (isPhone()) return "mobile"
  return inShell() ? "desktop" : null
}

export function createCompatNotice(env: CompatNoticeEnv): CompatNotice {
  const read = (): string | null => {
    try {
      return env.storage?.getItem(COMPAT_DISMISSED_KEY) ?? null
    } catch {
      return null
    }
  }
  const [dismissed, setDismissed] = createSignal<string | null>(read())
  let quietCheckFor: string | null = null
  const key = () => compatModeKey(env.apps())

  return {
    notice() {
      const shell = env.shell()
      if (shell === null || env.apps().length === 0 || dismissed() === key()) return null
      return { shell, canCheck: env.updateCheck() !== null }
    },
    sync() {
      const current = key()
      if (current === "" || env.shell() === null || quietCheckFor === current) return
      quietCheckFor = current
      try {
        env.updateCheck()?.(false)
      } catch {
        // The notice still says it; the shell's own schedule still runs.
      }
    },
    dismiss() {
      const current = key()
      setDismissed(current)
      try {
        env.storage?.setItem(COMPAT_DISMISSED_KEY, current)
      } catch {
        // Hidden for this session only.
      }
    },
    checkForUpdates() {
      try {
        env.updateCheck()?.(true)
      } catch {
        // The menu item is still there.
      }
    },
  }
}

function localStore(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}

let page: CompatNotice | null = null

/** The page's notice, created on first use. */
export function compatNotice(): CompatNotice {
  page ??= createCompatNotice({
    apps: compatModeApps,
    shell: () => appShellKind(),
    updateCheck: () => {
      const run = getDesktopBridge()?.checkForUpdates
      return typeof run === "function" ? (manual) => void run({ manual }) : null
    },
    storage: localStore(),
  })
  return page
}
