// SPDX-License-Identifier: FSL-1.1-ALv2

import type { ThemePreference } from "@liaison/shared"
import { createRoot, createSignal, onCleanup } from "solid-js"
import { nativeSetTheme } from "~/lib/native-bridge"

const STORAGE_KEY = "liaison:theme"

function readStored(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === "light" || raw === "dark" || raw === "system") return raw
  } catch {
    /* private mode */
  }
  return "system"
}

function persist(value: ThemePreference) {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* private mode — best-effort */
  }
}

function applyDom(resolved: "light" | "dark") {
  document.documentElement.setAttribute("data-theme", resolved)
  // The native status bar OVERLAYS the web view, so its clock and indicators
  // are drawn over what the app painted there: they follow the theme or they
  // vanish against it. This is the only place that knows what "system"
  // actually resolved to. A no-op in a browser (lib/native-bridge.ts).
  nativeSetTheme(resolved)
}

export interface ThemeStore {
  preference: () => ThemePreference
  resolved: () => "light" | "dark"
  setPreference: (value: ThemePreference) => void
  hydrateFromServer: (value: ThemePreference) => void
}

export function createThemeStore(): ThemeStore {
  const [preference, setPreference_] = createSignal<ThemePreference>(readStored())
  const mql = window.matchMedia("(prefers-color-scheme: dark)")
  const [prefersDark, setPrefersDark] = createSignal(mql.matches)

  const resolved = (): "light" | "dark" => {
    const p = preference()
    if (p === "light" || p === "dark") return p
    return prefersDark() ? "dark" : "light"
  }

  const apply = () => applyDom(resolved())

  const onChange = (e: MediaQueryListEvent) => {
    setPrefersDark(e.matches)
    // Re-apply only if the resolved theme actually depends on OS pref (i.e.
    // preference is 'system'). Concrete 'light'/'dark' should ignore OS flips.
    apply()
  }
  mql.addEventListener("change", onChange)
  onCleanup(() => mql.removeEventListener("change", onChange))

  function setPreference(value: ThemePreference) {
    setPreference_(value)
    persist(value)
    apply()
  }

  function hydrateFromServer(value: ThemePreference) {
    // Server is source of truth across devices once user is authenticated.
    // Overwrites local preference (which may have been set pre-auth or on
    // another device) and re-applies the resolved theme.
    setPreference_(value)
    persist(value)
    apply()
  }

  apply()
  return { preference, resolved, setPreference, hydrateFromServer }
}

// Singleton accessor — keeps store reachable from ProfileSettings.
//
// The singleton lives in its OWN root, for the life of the page. Created
// under whichever component first asked for it (a settings screen), its
// matchMedia listener was disposed with that screen, and an OS appearance
// flip afterwards reached neither data-theme nor the native status bar.
let _store: ThemeStore | null = null
export function getThemeStore(): ThemeStore {
  if (!_store) _store = createRoot(() => createThemeStore())
  return _store
}

/**
 * Called once at boot, before the first render. The store is what pushes the
 * resolved theme to the native shell (`applyDom` -> `nativeSetTheme`), so
 * until it exists the status bar keeps the style the shell booted with (light
 * glyphs), which on a light theme is a white clock on a white page. Left to
 * the settings screens, that is exactly what happened after sign in, until the
 * first visit to one of them.
 */
export function startThemeSync(): void {
  getThemeStore()
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const ThemeStoreTestAccess = {
  /**
   * Reset the singleton between tests so state from one test
   * (e.g. `setPreference("dark")`) does not leak into the next.
   */
  reset(): void {
    _store = null
  },
}
