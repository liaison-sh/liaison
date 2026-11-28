// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The browser wiring of lib/web-build.ts: one watcher for the page, fed by the
// API client's responses, by focus and visibility, and by SPA navigation.

import type { DesktopBridge } from "~/lib/desktop-shell-contract"
import { apiUrl } from "~/lib/env"
import { createServedShellUpdater, type ServedShellUpdater } from "~/lib/served-shell"
import {
  createWebBuildWatcher,
  insideAppShell,
  installWebBuildWatcher,
  isRealBuildId,
  pageHasUnsavedWork,
  pageWebBuildId,
  WEB_BUILD_ID_PATH,
  type WebBuildWatcher,
} from "~/lib/web-build"
import { inFlightUploadCount } from "~/modules/files/file-service"

let watcher: WebBuildWatcher | null = null

/** The page's watcher, or null before `startWebBuildWatch` ran (dev, tests). */
export function webBuildWatcher(): WebBuildWatcher | null {
  return watcher
}

function sessionStore(): Storage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

/** Starts watching for a newer deploy. A no-op in dev and inside a shell. */
export function startWebBuildWatch(): void {
  if (watcher !== null || typeof window === "undefined" || import.meta.env.DEV) return
  if (insideAppShell()) return
  // Outside a shell the page is served by its own API's origin, and
  // `build-id.txt` sits beside index.html at the site root.
  const idUrl = new URL(WEB_BUILD_ID_PATH, window.location.origin).href
  watcher = createWebBuildWatcher({
    compiledId: pageWebBuildId(),
    inShell: insideAppShell,
    hasUnsavedWork: () => pageHasUnsavedWork(inFlightUploadCount),
    reload: () => window.location.reload(),
    storage: sessionStore(),
    fetchServerId: async () => {
      const res = await fetch(idUrl, { cache: "no-store", credentials: "omit" })
      if (!res.ok) return null
      return (await res.text()).trim() || null
    },
  })
  installWebBuildWatcher(watcher)
  const w = watcher
  document.addEventListener("visibilitychange", () =>
    w.onVisibilityChange(document.visibilityState === "visible"),
  )
  window.addEventListener("focus", () => w.onFocus())
}

let served: ServedShellUpdater | null = null

/** The server's desktop build id, from its shell info (an API route, so CORS allows it). */
async function fetchServerDesktopBuild(): Promise<string | null> {
  const res = await fetch(apiUrl("/shell/info"), { cache: "no-store", credentials: "omit" })
  if (!res.ok) return null
  const body = (await res.json()) as { data?: { desktop?: { buildId?: unknown } } } | null
  const id = body?.data?.desktop?.buildId
  return typeof id === "string" ? id : null
}

/**
 * Inside a desktop window that runs a SERVED build (lib/served-shell.ts): the
 * same deploy check as a browser tab, routed to the shell. A newer server
 * build is fetched and verified by the shell (`refreshShell`) and runs at the
 * next load; the page reloads by itself only after 10 minutes without input
 * and with nothing unsaved.
 */
export function startServedShellWatch(bridge: DesktopBridge): void {
  if (served !== null || typeof window === "undefined" || import.meta.env.DEV) return
  const pageId = pageWebBuildId()
  if (!isRealBuildId(pageId) || typeof bridge.refreshShell !== "function") return
  const updater = createServedShellUpdater({
    pageBuildId: pageId,
    fetchServerBuildId: fetchServerDesktopBuild,
    refreshShell: async () => (await bridge.refreshShell?.()) ?? null,
    hasUnsavedWork: () => pageHasUnsavedWork(inFlightUploadCount),
    // The page's own reload keeps its tabs (they are restored from storage).
    reload: () => window.location.reload(),
  })
  served = updater
  const input = () => updater.noteInput()
  for (const event of ["keydown", "pointerdown", "wheel", "touchstart"]) {
    window.addEventListener(event, input, { capture: true, passive: true })
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void updater.check()
  })
  window.addEventListener("focus", () => void updater.check())
  window.setInterval(() => {
    void updater.check()
    updater.tick()
  }, 60_000)
  void updater.check()
}
